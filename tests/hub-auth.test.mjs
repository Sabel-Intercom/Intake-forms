// node --test tests/hub-auth.test.mjs
// Runs the real hub-auth.js in a fake page and checks which header goes where.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../hub-auth.js'), 'utf8');
const TRACKER = 'https://sabel-webhook.vercel.app/api/tracker?key=x-v1';

function page({ attrs, host = 'hubs.sabelcustomersuccess.com', tokenReply = { ok: true, token: 'tok' }, tokenStatus = 200 }) {
  const calls = [];
  let replaced = null;
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    calls.push({ url, headers });
    if (url.startsWith('api/')) return new Response(JSON.stringify(tokenReply), { status: tokenStatus });
    return new Response('{}', { status: 200 });
  };
  const window = { fetch };
  const ctx = vm.createContext({
    window, Headers, Request, Object, encodeURIComponent,
    document: { currentScript: { getAttribute: (n) => (n in attrs ? attrs[n] : null), hasAttribute: (n) => n in attrs } },
    location: { hostname: host, pathname: '/Intake-forms/SabelTaskHub.html', search: '?a=1', hash: '#t', replace: (u) => { replaced = u; } },
  });
  vm.runInContext(SRC, ctx);
  return { window, calls, replaced: () => replaced };
}

const W = 'https://sabel-webhook.vercel.app/api/';
const TEAM_ONLY = [TRACKER, W + 'notion?kind=projects', W + 'notion', W + 'motion?since=2026-11-01', W + 'feedback?key=sabel-feedback-v1'];
const NEVER = [W + 'testimonial', W + 'webhook', W + 'readiness?token=x', W + 'tracker-lock', W + 'notionx', 'https://example.com/api/tracker?key=x', 'https://example.com/?u=sabel-webhook.vercel.app/api/trackerx'];

test('team mode: sends X-Team-Token to the team-only endpoints and nowhere else', async () => {
  const p = page({ attrs: { 'data-team': '' } });
  for (const u of [...TEAM_ONLY, ...NEVER]) await p.window.fetch(u);
  assert.equal(p.calls[0].url, 'api/team-token');
  for (const u of TEAM_ONLY) {
    const c = p.calls.find(c => c.url === u);
    assert.equal(c.headers['x-team-token'], 'tok', u);
    assert.equal(c.headers['x-client-token'], undefined, u);
  }
  for (const u of NEVER) assert.deepEqual(p.calls.find(c => c.url === u).headers, {}, u);
});

test('client mode: the client token goes to the tracker only, never to team endpoints', async () => {
  const p = page({ attrs: { 'data-client': 'cookaborough' } });
  for (const u of [...TEAM_ONLY, ...NEVER]) await p.window.fetch(u);
  assert.equal(p.calls.find(c => c.url === TRACKER).headers['x-client-token'], 'tok');
  for (const u of [...TEAM_ONLY.slice(1), ...NEVER]) assert.deepEqual(p.calls.find(c => c.url === u).headers, {}, u);
});

test('team mode: a passcode the page already sends is kept', async () => {
  const p = page({ attrs: { 'data-team': '' } });
  await p.window.fetch(TRACKER, { headers: { 'X-Team-Token': 'typed-by-hand' } });
  assert.equal(p.calls.find(c => c.url === TRACKER).headers['x-team-token'], 'typed-by-hand');
});

test('client mode: unchanged, sends X-Client-Token from api/hub-token/<client>', async () => {
  const p = page({ attrs: { 'data-client': 'cookaborough' } });
  await p.window.fetch(TRACKER, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  assert.equal(p.calls[0].url, 'api/hub-token/cookaborough');
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

test('old github.io copy forwards to the hubs domain, keeping file, query and hash', () => {
  const p = page({ attrs: { 'data-team': '' }, host: 'sabel-intercom.github.io' });
  assert.equal(p.replaced(), 'https://hubs.sabelcustomersuccess.com/SabelTaskHub.html?a=1#t');
  assert.equal(p.calls.length, 0);
});

test('no attribute: does nothing', () => {
  const p = page({ attrs: {} });
  assert.equal(p.calls.length, 0);
  assert.equal(p.window.__hubAuth, undefined);
});
