// node --test tests/hub-auth.test.mjs
// Runs the real hub-auth.js in a fake page and checks which header goes where.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../hub-auth.js'), 'utf8');
const HUBS = 'https://hubs.sabelcustomersuccess.com';
const OLD = 'https://sabel-intercom.github.io/Intake-forms/';
const W = 'https://sabel-webhook.vercel.app/api/';
const TRACKER = W + 'tracker?key=x-v1';

// href: the page's full address. trackerStatus: what sabel-webhook answers.
function page({ attrs, href = HUBS + '/SabelTaskHub', tokenReply = { ok: true, token: 'tok' }, tokenStatus = 200, trackerStatus = 200, formsStatus = 200 }) {
  const calls = [];
  let replaced = null;
  const loc = new URL(href);
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    calls.push({ url, headers });
    if (url.startsWith('/api/')) return new Response(JSON.stringify(tokenReply), { status: tokenStatus });
    if (url.startsWith('/c/')) return new Response('', { status: formsStatus });
    if (url.startsWith(W + 'tracker')) return new Response('{}', { status: trackerStatus });
    return new Response('{}', { status: 200 });
  };
  // A stand-in for the browser's iframe: `src` is an accessor on the prototype.
  class HTMLIFrameElement {}
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
    configurable: true, enumerable: true,
    get() { return this._src; }, set(v) { this._src = v; },
  });
  const window = { fetch };
  const ctx = vm.createContext({
    window, Headers, Request, Object, URL, URLSearchParams, String, encodeURIComponent, HTMLIFrameElement,
    document: { currentScript: { getAttribute: (n) => (n in attrs ? attrs[n] : null), hasAttribute: (n) => n in attrs } },
    location: { href: loc.href, origin: loc.origin, hostname: loc.hostname, pathname: loc.pathname, search: loc.search, hash: loc.hash, replace: (u) => { replaced = u; } },
  });
  vm.runInContext(SRC, ctx);
  const frame = async (src) => { const f = new HTMLIFrameElement(); f.src = src; if (window.__hubAuth) await window.__hubAuth.formsReady; await null; return f.src; };
  return { window, calls, replaced: () => replaced, frame, tokenCall: () => calls.find(c => c.url.startsWith('/api/')) };
}

const TEAM_ONLY = [TRACKER, W + 'notion?kind=projects', W + 'notion', W + 'motion?since=2026-11-01', W + 'feedback?key=sabel-feedback-v1'];
const NEVER = [
  // other endpoints on our own service
  W + 'testimonial', W + 'webhook', W + 'readiness?token=x', W + 'tracker-lock', W + 'notionx', W + 'tracker/extra', W + 'tracker.json',
  // another site carrying our address in its query, path or fragment
  'https://example.com/api/tracker?key=x',
  'https://example.com/?u=sabel-webhook.vercel.app/api/tracker',
  'https://example.com/?u=https://sabel-webhook.vercel.app/api/tracker?key=x',
  'https://example.com/sabel-webhook.vercel.app/api/tracker',
  'https://example.com/#sabel-webhook.vercel.app/api/tracker',
  // look-alike hosts, credentials trick, other port, plain http
  'https://evil-sabel-webhook.vercel.app/api/tracker',
  'https://sabel-webhook.vercel.app.example.com/api/tracker',
  'https://sabel-webhookXvercel.app/api/tracker',
  'https://sabel-webhook.vercel.app@example.com/api/tracker',
  'https://user:pw@sabel-webhook.vercel.app/api/tracker',
  'https://sabel-webhook.vercel.app:8443/api/tracker',
  'http://sabel-webhook.vercel.app/api/tracker',
  // relative (resolves to this site) or not an address at all
  'api/tracker?key=x', 'not a url',
];

test('team mode: sends X-Team-Token to the team-only endpoints and nowhere else', async () => {
  const p = page({ attrs: { 'data-team': '' } });
  for (const u of [...TEAM_ONLY, ...NEVER]) await p.window.fetch(u);
  assert.equal(p.calls[0].url, '/api/team-token');
  for (const u of TEAM_ONLY) {
    const c = p.calls.find(c => c.url === u);
    assert.equal(c.headers['x-team-token'], 'tok', u);
    assert.equal(c.headers['x-client-token'], undefined, u);
  }
  for (const u of NEVER) assert.deepEqual(p.calls.find(c => c.url === u).headers, {}, u);
});

test('client mode: the client token goes to the tracker only, never to team endpoints', async () => {
  const p = page({ attrs: { 'data-client': 'cookaborough' }, href: HUBS + '/CookaboroughTracker' });
  for (const u of [...TEAM_ONLY, ...NEVER]) await p.window.fetch(u);
  assert.equal(p.calls.find(c => c.url === TRACKER).headers['x-client-token'], 'tok');
  for (const u of [...TEAM_ONLY.slice(1), ...NEVER]) assert.deepEqual(p.calls.find(c => c.url === u).headers, {}, u);
});

test('team mode: a passcode the page already sends is kept', async () => {
  const p = page({ attrs: { 'data-team': '' } });
  await p.window.fetch(TRACKER, { headers: { 'X-Team-Token': 'typed-by-hand' } });
  assert.equal(p.calls.find(c => c.url === TRACKER).headers['x-team-token'], 'typed-by-hand');
});

test('client mode: sends X-Client-Token from /api/hub-token/<client>, keeps the page\'s own headers', async () => {
  const p = page({ attrs: { 'data-client': 'cookaborough' }, href: HUBS + '/CookaboroughTracker' });
  await p.window.fetch(TRACKER, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  assert.equal(p.calls[0].url, '/api/hub-token/cookaborough');
  const c = p.calls.find(c => c.url === TRACKER);
  assert.equal(c.headers['x-client-token'], 'tok');
  assert.equal(c.headers['x-team-token'], undefined);
  assert.equal(c.headers['content-type'], 'application/json');
});

test('no token (not signed in): request goes out untouched', async () => {
  const p = page({ attrs: { 'data-team': '' }, tokenStatus: 401, tokenReply: { ok: false } });
  await p.window.fetch(TRACKER);
  assert.deepEqual(p.calls.find(c => c.url === TRACKER).headers, {});
});

test('old github.io copy of a hub or internal page forwards, keeping file, query and hash', () => {
  const p = page({ attrs: { 'data-team': '' }, href: OLD + 'SabelTaskHub.html?a=1#t' });
  assert.equal(p.replaced(), HUBS + '/SabelTaskHub.html?a=1#t');
  assert.equal(p.calls.length, 0);
  const c = page({ attrs: { 'data-client': 'cookaborough' }, href: OLD + 'CookaboroughTracker.html#home' });
  assert.equal(c.replaced(), HUBS + '/CookaboroughTracker.html#home');
});

test('no attribute: does nothing', () => {
  const p = page({ attrs: {} });
  assert.equal(p.calls.length, 0);
  assert.equal(p.window.__hubAuth, undefined);
});

// ---- shared forms ---------------------------------------------------------

test('shared form at /c/<client>/: that client\'s token, tracker only', async () => {
  const p = page({ attrs: { 'data-form': '' }, href: HUBS + '/c/kinatico/SabelReadinessCheck?client=kinatico&embed=1' });
  for (const u of TEAM_ONLY) await p.window.fetch(u);
  assert.equal(p.tokenCall().url, '/api/hub-token/kinatico');
  assert.equal(p.calls.find(c => c.url === TRACKER).headers['x-client-token'], 'tok');
  for (const u of TEAM_ONLY.slice(1)) assert.deepEqual(p.calls.find(c => c.url === u).headers, {}, u);
  assert.equal(p.window.__hubAuth.client, 'kinatico');
  assert.equal(p.window.__hubAuth.team, false);
});

test('shared form: ?client= in the address never chooses the token, the path does', async () => {
  const p = page({ attrs: { 'data-form': '' }, href: HUBS + '/c/kinatico/SabelReadinessCheck?client=elmo' });
  await p.window.fetch(TRACKER);
  assert.equal(p.tokenCall().url, '/api/hub-token/kinatico');
});

test('shared form at its plain, staff-only address: team mode', async () => {
  const p = page({ attrs: { 'data-form': '' }, href: HUBS + '/SabelReadinessCheck?client=kinatico' });
  await p.window.fetch(TRACKER);
  assert.equal(p.tokenCall().url, '/api/team-token');
  assert.equal(p.calls.find(c => c.url === TRACKER).headers['x-team-token'], 'tok');
  assert.equal(p.window.__hubAuth.client, null);
});

test('client\'s own form page: client at /c/<client>/, team at its plain address', async () => {
  const attrs = { 'data-form': '', 'data-client': 'smokeball' };
  const c = page({ attrs, href: HUBS + '/c/smokeball/SabelMigrationIntake_Smokeball' });
  await c.window.fetch(TRACKER);
  assert.equal(c.tokenCall().url, '/api/hub-token/smokeball');
  const t = page({ attrs, href: HUBS + '/SabelMigrationIntake_Smokeball' });
  await t.window.fetch(TRACKER);
  assert.equal(t.tokenCall().url, '/api/team-token');
});

test('shared form on github.io: keeps working for a client who has not moved (no forward, nothing added)', async () => {
  const p = page({ attrs: { 'data-form': '' }, href: OLD + 'SabelReadinessCheck.html?client=Kinatico&name=Kinatico', trackerStatus: 200 });
  const r = await p.window.fetch(W + 'tracker?key=readiness-kinatico-v1');
  assert.equal(r.status, 200);
  await p.window.fetch(W + 'readiness', { method: 'POST' });
  assert.equal(p.replaced(), null);
  assert.equal(p.tokenCall(), undefined);
  for (const c of p.calls) assert.deepEqual(c.headers, {});
});

test('shared form on github.io: forwards to the client\'s own address once their answers are locked', async () => {
  const p = page({ attrs: { 'data-form': '' }, href: OLD + 'SabelReadinessCheck.html?client=RMS&name=RMS%20Cloud#s2', trackerStatus: 401 });
  await p.window.fetch('https://example.com/x');
  assert.equal(p.replaced(), null);
  await p.window.fetch(W + 'tracker?key=readiness-rms-v1');
  assert.equal(p.replaced(), HUBS + '/c/rms/SabelReadinessCheck.html?client=RMS&name=RMS%20Cloud#s2');

  const own = page({ attrs: { 'data-form': '', 'data-client': 'smokeball' }, href: OLD + 'SabelMigrationIntake_Smokeball.html', trackerStatus: 401 });
  await own.window.fetch(W + 'tracker?key=migration-intake-smokeball-v1');
  assert.equal(own.replaced(), HUBS + '/c/smokeball/SabelMigrationIntake_Smokeball.html');

  const none = page({ attrs: { 'data-form': '' }, href: OLD + 'SabelMigrationIntake.html', trackerStatus: 401 });
  await none.window.fetch(TRACKER);
  assert.equal(none.replaced(), HUBS + '/SabelMigrationIntake.html');
});

test('shared form on github.io: the combined inputs key going staff-only never forwards a client who has not moved', async () => {
  const p = page({ attrs: { 'data-form': '' }, href: OLD + 'SabelReadinessCheck.html?client=RMS&name=RMS%20Cloud', trackerStatus: 401 });
  const r = await p.window.fetch(W + 'tracker?key=readiness-inputs-v1&_t=1');
  assert.equal(r.status, 401);
  assert.equal(p.replaced(), null);
  // the client's OWN inputs key locked does mean they have moved
  await p.window.fetch(W + 'tracker?key=readiness-inputs-rms-v1&_t=1');
  assert.equal(p.replaced(), HUBS + '/c/rms/SabelReadinessCheck.html?client=RMS&name=RMS%20Cloud');
});

test('client hub: forms shown in a frame load from the client\'s own address', async () => {
  const p = page({ attrs: { 'data-client': 'rms' }, href: HUBS + '/RMSCloudTracker' });
  const C = HUBS + '/c/rms/';
  assert.equal(p.calls.find(c => c.url.startsWith('/c/')).url, '/c/rms/hub-auth.js');
  assert.equal(await p.frame(OLD + 'SabelReadinessCheck.html?client=RMS&embed=1&theme=dark'), C + 'SabelReadinessCheck?client=RMS&embed=1&theme=dark');
  assert.equal(await p.frame(OLD + 'SabelKickoff_RMSCloud.html?client=rms&k=ea2c08a55b3877bd&rdy=rms&embed=1'), C + 'SabelKickoff_RMSCloud?client=rms&k=ea2c08a55b3877bd&rdy=rms&embed=1');
  assert.equal(await p.frame(OLD + 'SabelMigrationIntake.html?client=rms#admin'), C + 'SabelMigrationIntake?client=rms#admin');
  assert.equal(await p.frame(HUBS + '/SabelReadinessCheck.html?client=rms'), C + 'SabelReadinessCheck?client=rms');
  assert.equal(await p.frame('SabelKickoff.html?client=rms'), C + 'SabelKickoff?client=rms');
});

test('client hub: frames that are not forms are left exactly as given', async () => {
  const p = page({ attrs: { 'data-client': 'rms' }, href: HUBS + '/RMSCloudTracker' });
  for (const src of [
    'https://www.youtube.com/embed/abc', 'https://www.loom.com/embed/abc', 'about:blank',
    OLD + 'ELMOTracker.html', OLD + 'SabelInternalOps.html', HUBS + '/SabelTaskHub',
    'https://sabel-intercom.github.io/Other-repo/SabelReadinessCheck.html',
    'https://evil.example/Intake-forms/SabelReadinessCheck.html',
    OLD + 'sub/SabelReadinessCheck.html',
  ]) assert.equal(await p.frame(src), src, src);
});

test('frames are only rewritten on a client hub, never on internal or form pages', async () => {
  const src = OLD + 'SabelReadinessCheck.html?client=rms';
  assert.equal(await page({ attrs: { 'data-team': '' } }).frame(src), src);
  assert.equal(await page({ attrs: { 'data-form': '' }, href: HUBS + '/c/rms/SabelKickoff' }).frame(src), src);
  assert.equal(await page({ attrs: { 'data-form': '' }, href: HUBS + '/SabelKickoff' }).frame(src), src);
});

test('client hub onboarded before /c/ existed: form links are left as they were', async () => {
  const src = OLD + 'SabelReadinessCheck.html?client=Cookaborough&embed=1';
  for (const formsStatus of [403, 404, 302, 401, 500]) {
    const p = page({ attrs: { 'data-client': 'cookaborough' }, href: HUBS + '/CookaboroughTracker', formsStatus });
    assert.equal(await p.frame(src), src, String(formsStatus));
  }
});

test('a client name that is not a plain slug is refused outright', () => {
  const p = page({ attrs: { 'data-client': '../team-token' }, href: HUBS + '/X' });
  assert.equal(p.calls.length, 0);
  assert.equal(p.window.__hubAuth, undefined);
});
