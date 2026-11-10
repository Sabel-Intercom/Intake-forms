#!/usr/bin/env node
// onboard-hub: put one client hub behind Cloudflare Access and lock its key.
//
//   node scripts/onboard-hub.mjs <client-slug> <HubFile.html> <email-domain[,domain2]> [options]
//
//   node scripts/onboard-hub.mjs cookaborough CookaboroughTracker.html cookaborough.com
//
// Options:
//   --label "Cookaborough hub"   Access app name and lock label (default from the slug)
//   --rotate                     replace an existing lock with a new client token
//   --dry-run                    print every call, change nothing
//   --no-patch                   do not add the hub-auth include to the hub file
//   --also "A.html,B.html"       more of this client's OWN form pages, on top of
//                                the ones found in the hub file
//   --keys "k1,k2"               more of this client's tracker keys, on top of
//                                the ones found in the hub file
//   --no-detect                  do not read the hub file for forms; use only
//                                --also and --keys
//
// Forms. A hub shows forms in a frame: the shared readiness check, migration
// intake and kick-off, and sometimes the client's own copy of one. The script
// reads the hub file, finds them and their storage keys, locks every key with
// the SAME client token, and lists the own pages in HUB_PAGES_<SLUG>. All of
// them are then served to this client at /c/<slug>/<Form> (functions/c).
//
// A readiness form also reads its client's project inputs and confirmed access
// rows from a key of its own, readiness-inputs-<slug>-v1, with the same slug as
// the form key readiness-<slug>-v1. It is locked with the same client token.
// The combined readiness-inputs-v1 (every client's list) is never given a
// client token: it is for Sabel's pages only.
//
// Env (all required unless --dry-run):
//   CLOUDFLARE_API_TOKEN     Account > Access: Apps and Policies: Edit, Cloudflare Pages: Edit
//   CLOUDFLARE_ACCOUNT_ID    the Sabel account id
//   KICKOFF_TEAM_TOKEN       the team passcode (X-Team-Token on sabel-webhook)
// Optional:
//   HUBS_DOMAIN              default hubs.sabelcustomersuccess.com
//   PAGES_PROJECT            default sabel-hubs
//   TRACKER_API              default https://sabel-webhook.vercel.app
//   TEAM_EMAIL_DOMAIN        default sabelcustomersuccess.com (always allowed)
//
// What it does, in order, each step idempotent:
//   1. Checks the tracker key <slug>-tracker-v1 is known to sabel-webhook, then
//      reads the hub file for its forms and keeps the keys that are registered.
//   2. Creates or updates the Access application "<label>" with four
//      destinations (hub, hub.html, api/hub-token/<slug>, c/<slug>/*) and one
//      Allow policy for the client's email domain(s) plus the Sabel domain.
//   3. Locks the keys. An existing client token is kept unless --rotate, or a
//      form key does not answer to it yet (open, or locked by
//      scripts/lock-down.mjs), or the Pages project has no HUB_TOKEN_<SLUG>:
//      then ONE new token is issued and set on every key.
//   4. Sets HUB_TOKEN_<SLUG> (secret), HUB_AUD_<SLUG> and HUB_PAGES_<SLUG> on
//      the Pages project and starts a production deployment.
//   5. Adds the hub-auth include to the hub file (data-client) and to the
//      client's own form pages (data-form data-client) if missing. Commit and
//      push those yourself, or let the GitHub Action do it.
//   6. Prints the link to send the client.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CF = 'https://api.cloudflare.com/client/v4';

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--') && !a.includes('=')));
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const VALUE_OPTS = ['--label', '--also', '--keys'];
const csv = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.includes(argv[i - 1]));
const [slug, hubFile, domainsArg] = positional;
const DRY = flags.has('--dry-run');
const ROTATE = flags.has('--rotate');
const PATCH = !flags.has('--no-patch');

function die(msg) { console.error('\n✖ ' + msg); process.exit(1); }
if (!slug || !hubFile || !domainsArg) {
  die('usage: onboard-hub.mjs <client-slug> <HubFile.html> <email-domain[,domain2]> [--label "..."] [--rotate] [--dry-run] [--no-patch]');
}
if (!/^[a-z0-9-]{1,40}$/.test(slug)) die(`slug must be lower-case letters, digits, dashes: ${slug}`);
if (!/^[A-Za-z0-9_.-]+\.html$/.test(hubFile)) die(`hub file must be a .html file name: ${hubFile}`);
const clientDomains = domainsArg.split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
for (const d of clientDomains) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) die(`not an email domain: ${d}`);

const env = process.env;
const HUBS = env.HUBS_DOMAIN || 'hubs.sabelcustomersuccess.com';
const PROJECT = env.PAGES_PROJECT || 'sabel-hubs';
const TRACKER = (env.TRACKER_API || 'https://sabel-webhook.vercel.app').replace(/\/$/, '');
const TEAM_DOMAIN = env.TEAM_EMAIL_DOMAIN || 'sabelcustomersuccess.com';
const LABEL = opt('--label') || `${slug.charAt(0).toUpperCase()}${slug.slice(1).replace(/-/g, ' ')} hub`;
const KEY = `${slug}-tracker-v1`;
const ENV_SUFFIX = slug.toUpperCase().replace(/-/g, '_');
const hubBase = hubFile.replace(/\.html$/, '');
const DETECT = !flags.has('--no-detect');
// The client's own form pages (served at /c/<slug>/<Page>) and other keys.
// Given with --also / --keys, and found in the hub file by detect().
const ownPages = csv(opt('--also'));
for (const f of ownPages) if (!/^[A-Za-z0-9_]+\.html$/.test(f)) die(`--also takes .html page names: ${f}`);
const extraKeys = csv(opt('--keys'));
for (const k of extraKeys) if (!/^[a-z0-9-]{1,80}$/.test(k)) die(`--keys takes tracker key names: ${k}`);
// Every client's inputs list in one key: Sabel's pages only, never one client's token.
const INPUTS_ALL = 'readiness-inputs-v1';
if (extraKeys.includes(INPUTS_ALL)) die(`${INPUTS_ALL} holds every client's list and is never locked with one client's token. This client's own key is readiness-inputs-<slug>-v1, found from their readiness form.`);
// Always the same four, however many forms the client has: the hub, the token,
// and /c/<slug>/* for every form the hub shows.
const destinations = [`${HUBS}/${hubBase}`, `${HUBS}/${hubFile}`, `${HUBS}/api/hub-token/${slug}`, `${HUBS}/c/${slug}/*`];

if (!DRY) {
  for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'KICKOFF_TEAM_TOKEN']) if (!env[k]) die(`${k} is not set`);
}
const ACCOUNT = env.CLOUDFLARE_ACCOUNT_ID || '<account-id>';

const log = (m) => console.log(m);
const step = (n, m) => console.log(`\n[${n}] ${m}`);

// ---------- http ----------
async function cf(method, path, body) {
  const url = `${CF}/accounts/${ACCOUNT}${path}`;
  if (DRY) { log(`   DRY ${method} ${url}` + (body ? `\n   ${JSON.stringify(body).slice(0, 300)}` : '')); return { result: null, dry: true }; }
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const errs = (j.errors || []).map(e => `${e.code} ${e.message}`).join('; ');
    throw new Error(`${method} ${path} -> ${r.status} ${errs || JSON.stringify(j).slice(0, 200)}`);
  }
  return j;
}

async function tracker(method, path, body) {
  const url = `${TRACKER}${path}`;
  if (DRY) { log(`   DRY ${method} ${url}` + (body ? ` ${JSON.stringify(body)}` : '')); return { dry: true }; }
  const r = await fetch(url, {
    method,
    headers: { 'X-Team-Token': env.KICKOFF_TEAM_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

// ---------- steps ----------
async function checkKey() {
  step(1, `Checking sabel-webhook knows the key ${KEY}`);
  const r = await tracker('GET', `/api/tracker-lock?key=${encodeURIComponent(KEY)}`);
  if (r.dry) return { locked: false };
  if (r.status === 401) die('KICKOFF_TEAM_TOKEN was refused by sabel-webhook. Check the value (Vercel > sabel-webhook > Environment Variables).');
  if (r.status === 503) die('sabel-webhook has no KICKOFF_TEAM_TOKEN set. Add it in Vercel first.');
  if (r.status === 404) die(`${KEY} is not in ALLOWED_KEYS in sabel-webhook api/tracker.js. Add it there and deploy, then re-run.`);
  if (!r.ok) die(`unexpected reply from sabel-webhook: ${r.status} ${r.error || ''}`);
  log(`   ok, key known${r.locked ? `, already locked (${r.setAt})` : ', not locked yet'}`);
  return r;
}

// Same rules the forms use to turn ?client= into the slug in their key.
const hyphenSlug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const stripSlug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9-]/g, '');

// Read the hub file for the forms it shows: the client's own form pages and
// the keys those forms save to. Every key found is checked with sabel-webhook
// and dropped if it is not registered, so a guess can never lock anything
// that does not exist. A key is only ever derived from this hub's own file.
async function detect() {
  step('1b', `Forms ${hubFile} shows`);
  const p = resolve(ROOT, hubFile);
  if (!DETECT) { log('   --no-detect: using --also / --keys only'); return; }
  if (!existsSync(p)) { log(`   ${hubFile} not in this checkout; using --also / --keys only`); return; }
  const html = readFileSync(p, 'utf8');
  const add = (list, v) => { if (v && !list.includes(v)) list.push(v); };

  for (const m of html.matchAll(/\bSabel(?:MigrationIntake|Kickoff)_[A-Za-z0-9]+\.html/g)) {
    if (existsSync(resolve(ROOT, m[0]))) add(ownPages, m[0]);
  }
  const candidates = [];
  for (const m of html.matchAll(/\bkickoff-[a-z0-9-]{1,60}-[a-f0-9]{16}-v1\b/g)) add(candidates, m[0]);
  for (const m of html.matchAll(/SabelReadinessCheck(?:\.html)?\?[^"'\s<>\\]*?\bclient=([^&"'\s<>\\#]+)/g)) {
    add(candidates, `readiness-${hyphenSlug(decodeURIComponent(m[1]))}-v1`);
  }
  for (const m of html.matchAll(/SabelMigrationIntake(?:\.html)?\?[^"'\s<>\\]*?\bclient=([^&"'\s<>\\#]+)/g)) {
    add(candidates, `migration-intake-${stripSlug(decodeURIComponent(m[1]))}-v1`);
  }
  if (/readiness-\{slug\}-v1/.test(html)) add(candidates, `readiness-${slug}-v1`);
  if (/migration-intake-\{slug\}-v1/.test(html)) add(candidates, `migration-intake-${slug}-v1`);
  // A client's own intake page names its slug inside the page.
  for (const page of ownPages) {
    const own = readFileSync(resolve(ROOT, page), 'utf8');
    const d = /const DEFAULT_SLUG='([a-z0-9-]{1,60})'/.exec(own);
    if (d && /^SabelMigrationIntake_/.test(page)) add(candidates, `migration-intake-${d[1]}-v1`);
  }

  for (const k of candidates) {
    if (extraKeys.includes(k) || k === KEY || k === INPUTS_ALL || !/^[a-z0-9-]{1,80}$/.test(k)) continue;
    const r = await tracker('GET', `/api/tracker-lock?key=${encodeURIComponent(k)}`);
    if (r.dry) { extraKeys.push(k); continue; }
    if (r.status === 404) { log(`   ${k}: not registered in sabel-webhook, skipped`); continue; }
    if (!r.ok) die(`could not check ${k}: ${r.status} ${r.error || ''}`);
    extraKeys.push(k);
  }
  // Each readiness form reads this client's project inputs from a key of its
  // own: readiness-inputs-<slug>-v1, same slug as the form key. Taken only from
  // a readiness key that is already on the list (registered, or given with
  // --keys), so a guess never locks anything. sabel-webhook matches these keys
  // by pattern; a 404 means it has not been deployed with that pattern yet.
  for (const k of [...extraKeys]) {
    const m = /^readiness-([a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)-v1$/.exec(k);
    if (!m || /^inputs(-|$)/.test(m[1])) continue;
    const own = `readiness-inputs-${m[1]}-v1`;
    if (extraKeys.includes(own)) continue;
    const r = await tracker('GET', `/api/tracker-lock?key=${encodeURIComponent(own)}`);
    if (r.dry) { extraKeys.push(own); continue; }
    if (r.status === 404) { log(`   ${own}: sabel-webhook does not know per-client inputs keys yet, skipped. Run this again once it does.`); continue; }
    if (!r.ok) die(`could not check ${own}: ${r.status} ${r.error || ''}`);
    extraKeys.push(own);
  }
  log(`   own form pages: ${ownPages.join(', ') || 'none'}`);
  log(`   form keys:      ${extraKeys.join(', ') || 'none'}`);
}

async function ensureAccessApp() {
  step(2, `Access application "${LABEL}" on ${destinations.length} destinations`);
  const policy = {
    name: `${LABEL}: client and Sabel`,
    decision: 'allow',
    include: [...clientDomains, TEAM_DOMAIN].map(d => ({ email_domain: { domain: d } })),
  };
  const body = {
    name: LABEL,
    type: 'self_hosted',
    domain: destinations[0],
    self_hosted_domains: destinations,
    destinations: destinations.map(uri => ({ type: 'public', uri })),
    session_duration: '24h',
    allowed_idps: [],
    auto_redirect_to_identity: false,
    app_launcher_visible: true,
    policies: [{ ...policy, precedence: 1 }],
  };
  const list = await cf('GET', '/access/apps?per_page=100');
  const existing = (list.result || []).find(a => a.name === LABEL || a.domain === destinations[0]);
  let app;
  if (existing) {
    log(`   exists (${existing.id}), updating destinations and policy`);
    const r = await cf('PUT', `/access/apps/${existing.id}`, body);
    app = r.result || existing;
  } else {
    const r = await cf('POST', '/access/apps', body);
    app = r.result;
    log(`   created${app ? ` (${app.id})` : ''}`);
  }
  const aud = app && app.aud;
  if (!DRY && !aud) die('Access API returned no AUD for the application.');
  log(`   policy: emails ending in ${[...clientDomains, TEAM_DOMAIN].map(d => '@' + d).join(', ')}`);
  log(`   AUD ${aud || '(dry run)'}`);
  return { aud: aud || 'DRY_RUN_AUD' };
}

// Does the Pages project already hold this client's token? Secret values are
// never returned by the API, only the variable names.
async function pagesHasToken() {
  const r = await cf('GET', `/pages/projects/${PROJECT}`);
  if (r.dry) return true;
  const vars = (((r.result || {}).deployment_configs || {}).production || {}).env_vars || {};
  return Object.prototype.hasOwnProperty.call(vars, `HUB_TOKEN_${ENV_SUFFIX}`);
}

// One client token opens all of this client's keys. A form key that is open,
// or was locked by something other than this client's onboarding (the
// lock-down sweep labels its locks differently), does not yet answer to it.
async function extraKeysNeedToken() {
  for (const k of extraKeys) {
    const r = await tracker('GET', `/api/tracker-lock?key=${encodeURIComponent(k)}`);
    if (r.dry) return false;
    if (r.status === 404) die(`${k} is not in ALLOWED_KEYS in sabel-webhook api/tracker.js. Add it there and deploy, then re-run.`);
    if (!r.ok) die(`could not check ${k}: ${r.status} ${r.error || ''}`);
    if (!r.locked || r.label !== LABEL) return k;
  }
  return false;
}

async function lockKey(state) {
  step(3, `Lock on ${[KEY, ...extraKeys].join(', ')}`);
  let fresh = !state.locked || ROTATE;
  if (!fresh) {
    const k = await extraKeysNeedToken();
    if (k) { fresh = true; log(`   ${k} does not answer to this client's token yet: issuing one new token for all of their keys`); }
  }
  if (!fresh && !(await pagesHasToken())) { fresh = true; log(`   locked, but Pages has no HUB_TOKEN_${ENV_SUFFIX}: issuing a client token`); }
  if (!fresh) {
    log('   already locked; keeping the existing client token (use --rotate to replace it)');
    return { token: null };
  }
  const r = await tracker('POST', '/api/tracker-lock', { key: KEY, label: LABEL });
  if (r.dry) {
    for (const k of extraKeys) await tracker('POST', '/api/tracker-lock', { key: k, label: LABEL, token: '(same client token)' });
    return { token: 'DRY_RUN_TOKEN' };
  }
  if (!r.ok || !r.token) die(`lock failed: ${r.status} ${r.error || ''}`);
  log(`   ${KEY}: ${r.replaced ? 'replaced' : 'set'} at ${r.setAt}; new client token received (not printed)`);
  for (const k of extraKeys) {
    const x = await tracker('POST', '/api/tracker-lock', { key: k, label: LABEL, token: r.token });
    if (x.status === 404) die(`${k} is not in ALLOWED_KEYS in sabel-webhook api/tracker.js. Add it there and deploy, then re-run.`);
    if (!x.ok) die(`lock failed on ${k}: ${x.status} ${x.error || ''}`);
    log(`   ${k}: ${x.replaced ? 'replaced' : 'set'}, same client token`);
  }
  return { token: r.token };
}

async function setPagesVars({ aud, token }) {
  const pages = ownPages.map(f => f.replace(/\.html$/, '')).join(',');
  step(4, `Pages project ${PROJECT}: HUB_AUD_${ENV_SUFFIX}${token ? ` + HUB_TOKEN_${ENV_SUFFIX}` : ''}${pages ? ` + HUB_PAGES_${ENV_SUFFIX}` : ''}`);
  const env_vars = { [`HUB_AUD_${ENV_SUFFIX}`]: { type: 'plain_text', value: aud } };
  if (token) env_vars[`HUB_TOKEN_${ENV_SUFFIX}`] = { type: 'secret_text', value: token };
  // Which of the client's own form pages /c/<slug>/ may serve. See functions/c.
  if (pages) env_vars[`HUB_PAGES_${ENV_SUFFIX}`] = { type: 'plain_text', value: pages };
  await cf('PATCH', `/pages/projects/${PROJECT}`, { deployment_configs: { production: { env_vars } } });
  log('   variables saved');
  const d = await cf('POST', `/pages/projects/${PROJECT}/deployments`);
  log(`   production deployment started${d.result && d.result.id ? ` (${d.result.id})` : ''}`);
}

// The hub carries data-client; the client's own form pages carry data-form too,
// so they behave as the client's page at /c/<slug>/ and as an internal page at
// their plain, staff-only address.
function patchHub(hubFile, isForm = false) {
  step(5, `hub-auth include in ${hubFile}`);
  const p = resolve(ROOT, hubFile);
  const tag = `<script src="hub-auth.js" ${isForm ? 'data-form ' : ''}data-client="${slug}"></script>`;
  if (!existsSync(p)) { log(`   ${hubFile} not found in this checkout; add the include by hand:\n   ${tag}`); return false; }
  const html = readFileSync(p, 'utf8');
  const have = /<script[^>]+src="hub-auth\.js"[^>]*><\/script>/.exec(html);
  if (have) {
    if (have[0] !== tag) die(`${hubFile} already carries a different hub-auth include: ${have[0]}\n  Expected ${tag}. Fix the file by hand, then re-run.`);
    log('   already present');
    return false;
  }
  // Immediately before the page's first <script>, so the include always runs
  // before any page code can call fetch. No script at all: end of <head>.
  let out;
  const i = html.search(/<script/i);
  if (i >= 0) {
    const before = html.slice(0, i);
    if (before.lastIndexOf('<!--') > before.lastIndexOf('-->')) die(`${hubFile}: the first <script> is inside an HTML comment; add the include by hand:\n  ${tag}`);
    out = `${before}${tag}\n${html.slice(i)}`;
  } else if (/<\/head>/i.test(html)) out = html.replace(/<\/head>/i, `${tag}\n</head>`);
  else die(`${hubFile} has no <head> or <script>; cannot place the include`);
  if (DRY) { log('   DRY would insert the include'); return false; }
  if (!PATCH) { log('   --no-patch: not written. Add this line to <head>:\n   ' + tag); return false; }
  writeFileSync(p, out);
  log('   inserted; commit and push this file so Pages deploys it');
  return true;
}

// ---------- run ----------
(async () => {
  log(`onboard-hub ${DRY ? '(DRY RUN) ' : ''}: ${slug} / ${hubFile} / @${clientDomains.join(', @')}`);
  const state = await checkKey();
  await detect();
  const { aud } = await ensureAccessApp();
  const { token } = await lockKey(state);
  await setPagesVars({ aud, token });
  const changed = [hubFile, ...ownPages].filter((f, i) => patchHub(f, i > 0));
  step(6, 'Done. Send the client this link:');
  log(`\n   https://${HUBS}/${hubBase}\n`);
  log(`   They type their @${clientDomains[0]} address, enter the emailed code, and the hub opens.`);
  log(`   The old github.io link now forwards here. Anyone not on ${[...clientDomains, TEAM_DOMAIN].map(d => '@' + d).join(' / ')} is refused.`);
  if (changed.length) log(`\n   Remember: commit and push ${changed.join(', ')}.`);
  if (DRY) log('\n   Dry run: nothing was changed.');
})().catch(e => die(e.message));
