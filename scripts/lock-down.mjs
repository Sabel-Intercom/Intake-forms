#!/usr/bin/env node
// lock-down: make the whole hubs domain staff-only by default.
//
//   node scripts/lock-down.mjs                 show what would change (default: changes nothing)
//   node scripts/lock-down.mjs --apply         do steps 1 to 3
//   node scripts/lock-down.mjs --apply --lock-keys [--skip key1,key2] [--only key1,key2]
//                                              also lock every tracker key that is still open
//
// Options:
//   --public "A.html,B.html"   pages anyone may open (default: the two below)
//   --apply                    make the changes (without it, a dry run)
//   --lock-keys                step 4, see the warning there
//   --skip / --only            narrow step 4
//
// Env (required with --apply):
//   CLOUDFLARE_API_TOKEN     Account > Access: Apps and Policies: Edit, Cloudflare Pages: Edit
//   CLOUDFLARE_ACCOUNT_ID    the Sabel account id
//   KICKOFF_TEAM_TOKEN       the team passcode (X-Team-Token on sabel-webhook)
// Optional: HUBS_DOMAIN, PAGES_PROJECT, TRACKER_API, TEAM_EMAIL_DOMAIN, ALLOWED_KEYS_URL
//
// Steps, each idempotent:
//   1. Access application "Sabel hubs: open files" with a Bypass policy for
//      the files every visitor must be able to load: hub-auth.js, assets/*,
//      and the public pages. Created FIRST, so an onboarded client hub never
//      loses hub-auth.js when step 2 lands.
//   2. Access application "Sabel hubs: staff only" over the WHOLE hubs domain,
//      one Allow policy: emails ending in the Sabel domain. A client's own
//      application (scripts/onboard-hub.mjs) covers more specific paths and so
//      wins on those paths; everything else is staff only.
//   3. Pages variables TEAM_AUD and TEAM_TOKEN (secret) so /api/team-token
//      can hand the team passcode to signed-in Sabel staff; redeploys.
//   4. (--lock-keys) Locks every key in sabel-webhook's ALLOWED_KEYS that has
//      no lock yet. The generated client token is thrown away, so a key locked
//      here opens ONLY with the team passcode until onboard-hub gives the
//      client a token. Anything that reads a key without the team passcode
//      stops working the moment it is locked: an un-onboarded client's hub or
//      form, and any script or widget that does not send X-Team-Token.
//      For every form key readiness-<slug>-v1 it also locks that client's own
//      inputs key readiness-inputs-<slug>-v1, which sabel-webhook matches by
//      pattern and so is not in ALLOWED_KEYS.

import { inputsKeyForFormKey } from './readiness-inputs-lib.mjs';

const CF = 'https://api.cloudflare.com/client/v4';
const DEFAULT_PUBLIC = 'Migr8Now_Rate_Calculator.html,SabelFeedbackForm.html';

const argv = process.argv.slice(2);
const VALUE_OPTS = ['--public', '--skip', '--only'];
const has = (f) => argv.includes(f);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const list = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_OPTS.includes(a)) { i++; continue; }
  if (!['--apply', '--lock-keys'].includes(a)) die(`unknown argument: ${a}`);
}

const APPLY = has('--apply');
const DRY = !APPLY;
const LOCK_KEYS = has('--lock-keys');
const SKIP = new Set(list(opt('--skip')));
const ONLY = new Set(list(opt('--only')));
const publicPages = list(opt('--public') ?? DEFAULT_PUBLIC);
for (const p of publicPages) if (!/^[A-Za-z0-9_.-]+\.html$/.test(p)) die(`--public takes .html file names: ${p}`);

const env = process.env;
const HUBS = env.HUBS_DOMAIN || 'hubs.sabelcustomersuccess.com';
const PROJECT = env.PAGES_PROJECT || 'sabel-hubs';
const TRACKER = (env.TRACKER_API || 'https://sabel-webhook.vercel.app').replace(/\/$/, '');
const TEAM_DOMAIN = env.TEAM_EMAIL_DOMAIN || 'sabelcustomersuccess.com';
const KEYS_URL = env.ALLOWED_KEYS_URL || 'https://raw.githubusercontent.com/Sabel-Intercom/sabel-webhook/main/api/tracker.js';
const STAFF_APP = 'Sabel hubs: staff only';
const OPEN_APP = 'Sabel hubs: open files';

function die(msg) { console.error('\n✖ ' + msg); process.exit(1); }
if (APPLY) for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'KICKOFF_TEAM_TOKEN']) if (!env[k]) die(`${k} is not set`);
const ACCOUNT = env.CLOUDFLARE_ACCOUNT_ID || '<account-id>';
const CAN_READ_CF = Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);
const CAN_READ_LOCKS = Boolean(env.KICKOFF_TEAM_TOKEN);

const log = (m) => console.log(m);
const step = (n, m) => console.log(`\n[${n}] ${m}`);

// Reads always run when credentials are present, so a dry run shows the real
// difference. Writes run only with --apply.
async function cf(method, path, body) {
  const url = `${CF}/accounts/${ACCOUNT}${path}`;
  const write = method !== 'GET';
  if ((write && DRY) || !CAN_READ_CF) {
    log(`   DRY ${method} ${url}` + (body ? `\n   ${JSON.stringify(redact(body)).slice(0, 400)}` : ''));
    return { result: null, dry: true };
  }
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

// Never print a secret value, even in a dry run.
function redact(body) {
  return JSON.parse(JSON.stringify(body, (k, v) => (v && v.type === 'secret_text' ? { type: 'secret_text', value: '(hidden)' } : v)));
}

async function tracker(method, path, body) {
  const r = await fetch(`${TRACKER}${path}`, {
    method,
    headers: { 'X-Team-Token': env.KICKOFF_TEAM_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

async function ensureApp(name, destinations, policy) {
  const body = {
    name,
    type: 'self_hosted',
    domain: destinations[0],
    self_hosted_domains: destinations,
    destinations: destinations.map(uri => ({ type: 'public', uri })),
    session_duration: '24h',
    allowed_idps: [],
    auto_redirect_to_identity: false,
    app_launcher_visible: false,
    policies: [{ ...policy, precedence: 1 }],
  };
  const apps = await cf('GET', '/access/apps?per_page=100');
  const existing = (apps.result || []).find(a => a.name === name);
  if (existing) {
    log(`   exists (${existing.id}), ${DRY ? 'would update' : 'updating'} destinations and policy`);
    const r = await cf('PUT', `/access/apps/${existing.id}`, body);
    return r.result || existing;
  }
  const r = await cf('POST', '/access/apps', body);
  if (r.result) log(`   created (${r.result.id})`);
  return r.result;
}

async function staffApp() {
  step(2, `Access application "${STAFF_APP}" over all of ${HUBS}`);
  const app = await ensureApp(STAFF_APP, [HUBS], {
    name: `${STAFF_APP}: Sabel emails`,
    decision: 'allow',
    include: [{ email_domain: { domain: TEAM_DOMAIN } }],
  });
  log(`   policy: emails ending in @${TEAM_DOMAIN}`);
  if (APPLY && !(app && app.aud)) die('Access API returned no AUD for the staff application.');
  log(`   AUD ${(app && app.aud) || '(not created yet)'}`);
  return app && app.aud;
}

async function openApp() {
  const destinations = [`${HUBS}/hub-auth.js`, `${HUBS}/assets/*`];
  for (const p of publicPages) destinations.push(`${HUBS}/${p.replace(/\.html$/, '')}`, `${HUBS}/${p}`);
  step(1, `Access application "${OPEN_APP}" (no sign-in) on ${destinations.length} destinations`);
  for (const d of destinations) log(`   ${d}`);
  await ensureApp(OPEN_APP, destinations, {
    name: `${OPEN_APP}: everyone`,
    decision: 'bypass',
    include: [{ everyone: {} }],
  });
}

async function pagesVars(aud) {
  step(3, `Pages project ${PROJECT}: TEAM_AUD + TEAM_TOKEN`);
  const env_vars = {
    TEAM_AUD: { type: 'plain_text', value: aud || 'AUD_FROM_STEP_2' },
    TEAM_TOKEN: { type: 'secret_text', value: env.KICKOFF_TEAM_TOKEN || '' },
  };
  await cf('PATCH', `/pages/projects/${PROJECT}`, { deployment_configs: { production: { env_vars } } });
  if (APPLY) log('   variables saved');
  const d = await cf('POST', `/pages/projects/${PROJECT}/deployments`);
  if (APPLY) log(`   production deployment started${d.result && d.result.id ? ` (${d.result.id})` : ''}`);
}

async function allowedKeys() {
  const r = await fetch(KEYS_URL);
  if (!r.ok) die(`could not read ALLOWED_KEYS from ${KEYS_URL} (${r.status})`);
  const src = await r.text();
  const m = /export const ALLOWED_KEYS = \[([\s\S]*?)\];/.exec(src);
  if (!m) die('ALLOWED_KEYS not found in sabel-webhook api/tracker.js');
  const keys = [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([a-z0-9-]+)'/g)].map(x => x[1]);
  if (!keys.length) die('ALLOWED_KEYS parsed as empty; refusing to continue');
  return keys;
}

async function lockKeys() {
  step(4, 'Lock every tracker key that is still open');
  let keys = await allowedKeys();
  log(`   ${keys.length} keys in ALLOWED_KEYS`);
  // Each client's own inputs key, next to their readiness form key.
  const derived = new Set(keys.map(inputsKeyForFormKey).filter(k => k && !keys.includes(k)));
  keys = [...keys, ...derived];
  if (derived.size) log(`   ${derived.size} per-client inputs keys (readiness-inputs-<slug>-v1), one for each readiness form key`);
  if (ONLY.size) keys = keys.filter(k => ONLY.has(k));
  keys = keys.filter(k => !SKIP.has(k));
  let locked = new Set();
  if (CAN_READ_LOCKS) {
    const r = await tracker('GET', '/api/tracker-lock');
    if (r.status === 401) die('KICKOFF_TEAM_TOKEN was refused by sabel-webhook.');
    if (!r.ok) die(`could not list locks: ${r.status} ${r.error || ''}`);
    locked = new Set((r.locks || []).map(l => l.key));
    log(`   ${locked.size} already locked`);
  } else {
    log('   KICKOFF_TEAM_TOKEN not set: cannot see which are already locked');
  }
  const todo = keys.filter(k => !locked.has(k));
  if (!todo.length) { log('   nothing to lock'); return; }
  let done = 0;
  for (const key of todo) {
    if (DRY) { log(`   would lock ${key}`); continue; }
    const r = await tracker('POST', '/api/tracker-lock', { key, label: 'staff only (lock-down)' });
    if (r.status === 404 && derived.has(key)) { log(`   ${key}: sabel-webhook does not know per-client inputs keys yet, skipped`); continue; }
    if (!r.ok) die(`lock failed on ${key}: ${r.status} ${r.error || ''} (${done} locked before this)`);
    done++;
    log(`   locked ${key}`);
  }
  log(DRY ? `   ${todo.length} would be locked` : `   ${done} locked. Each opens only with the team passcode until onboard-hub issues a client token.`);
}

(async () => {
  log(`lock-down ${DRY ? '(DRY RUN, add --apply to change anything)' : '(APPLY)'}: ${HUBS}`);
  await openApp();
  const aud = await staffApp();
  await pagesVars(aud);
  if (LOCK_KEYS) await lockKeys();
  else log('\n[4] Key locks: skipped (add --lock-keys).');
  log(`\nDone.${DRY ? ' Dry run: nothing was changed.' : ''}`);
  if (APPLY) {
    log(`Check: a private window on https://${HUBS}/SabelOpsHub shows the Cloudflare sign-in page,`);
    log(`       https://${HUBS}/${publicPages[0] ? publicPages[0].replace(/\.html$/, '') : 'hub-auth.js'} opens with no sign-in,`);
    log('       and an onboarded client hub still loads live data.');
  }
})().catch(e => die(e.message));
