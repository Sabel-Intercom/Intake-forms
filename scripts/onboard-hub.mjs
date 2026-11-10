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
//   --also "A.html,B.html"       this client's other pages (their own intake or
//                                kick-off form, a .js file the hub loads): same
//                                sign-in, same include
//   --keys "k1,k2"               this client's other tracker keys (e.g.
//                                migration-intake-<slug>-v1): locked with the
//                                SAME client token. Always issues a new token.
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
//   1. Checks the tracker key <slug>-tracker-v1 is known to sabel-webhook.
//   2. Creates or updates the Access application "<label>" with three
//      destinations (hub, hub.html, api/hub-token/<slug>) and one Allow policy
//      for the client's email domain(s) plus the Sabel domain. Reads its AUD.
//   3. Locks the key (or keeps the existing lock unless --rotate). A key that
//      is locked but has no HUB_TOKEN_<SLUG> on the Pages project (locked by
//      scripts/lock-down.mjs) gets a new client token automatically.
//   4. Sets HUB_TOKEN_<SLUG> (secret) and HUB_AUD_<SLUG> on the Pages project
//      and starts a production deployment.
//   5. Adds <script src="hub-auth.js" data-client="<slug>"> to the hub file if
//      missing (commit and push that yourself, or let the GitHub Action do it).
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
const alsoFiles = csv(opt('--also'));
for (const f of alsoFiles) if (!/^[A-Za-z0-9_.-]+\.(html|js)$/.test(f)) die(`--also takes .html or .js file names: ${f}`);
const extraKeys = csv(opt('--keys'));
for (const k of extraKeys) if (!/^[a-z0-9-]{1,80}$/.test(k)) die(`--keys takes tracker key names: ${k}`);
const destinations = [`${HUBS}/${hubBase}`, `${HUBS}/${hubFile}`, `${HUBS}/api/hub-token/${slug}`];
for (const f of alsoFiles) {
  if (f.endsWith('.html')) destinations.push(`${HUBS}/${f.replace(/\.html$/, '')}`);
  destinations.push(`${HUBS}/${f}`);
}

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

async function lockKey(state) {
  step(3, `Lock on ${[KEY, ...extraKeys].join(', ')}`);
  let fresh = !state.locked || ROTATE;
  if (!fresh && extraKeys.length) { fresh = true; log('   --keys given: issuing one new client token for all of this client\'s keys'); }
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
  step(4, `Pages project ${PROJECT}: HUB_AUD_${ENV_SUFFIX}${token ? ` + HUB_TOKEN_${ENV_SUFFIX}` : ''}`);
  const env_vars = { [`HUB_AUD_${ENV_SUFFIX}`]: { type: 'plain_text', value: aud } };
  if (token) env_vars[`HUB_TOKEN_${ENV_SUFFIX}`] = { type: 'secret_text', value: token };
  await cf('PATCH', `/pages/projects/${PROJECT}`, { deployment_configs: { production: { env_vars } } });
  log('   variables saved');
  const d = await cf('POST', `/pages/projects/${PROJECT}/deployments`);
  log(`   production deployment started${d.result && d.result.id ? ` (${d.result.id})` : ''}`);
}

function patchHub(hubFile) {
  step(5, `hub-auth include in ${hubFile}`);
  const p = resolve(ROOT, hubFile);
  if (!existsSync(p)) { log(`   ${hubFile} not found in this checkout; add the include by hand:\n   <script src="hub-auth.js" data-client="${slug}"></script>`); return false; }
  const html = readFileSync(p, 'utf8');
  if (/<script[^>]+src="hub-auth\.js"/.test(html)) { log('   already present'); return false; }
  const tag = `<script src="hub-auth.js" data-client="${slug}"></script>`;
  let out;
  if (/<\/head>/i.test(html)) out = html.replace(/<\/head>/i, `${tag}\n</head>`);
  else if (/<script/i.test(html)) out = html.replace(/<script/i, `${tag}\n<script`);
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
  const { aud } = await ensureAccessApp();
  const { token } = await lockKey(state);
  await setPagesVars({ aud, token });
  const changed = [hubFile, ...alsoFiles.filter(f => f.endsWith('.html'))].filter(f => patchHub(f));
  step(6, 'Done. Send the client this link:');
  log(`\n   https://${HUBS}/${hubBase}\n`);
  log(`   They type their @${clientDomains[0]} address, enter the emailed code, and the hub opens.`);
  log(`   The old github.io link now forwards here. Anyone not on ${[...clientDomains, TEAM_DOMAIN].map(d => '@' + d).join(' / ')} is refused.`);
  if (changed.length) log(`\n   Remember: commit and push ${changed.join(', ')}.`);
  if (DRY) log('\n   Dry run: nothing was changed.');
})().catch(e => die(e.message));
