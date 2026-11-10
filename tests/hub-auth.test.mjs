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

test('team mode: fetches api/team-token and sends X-Team-Token to the tracker only', async () => {
  const p = page({ attrs: { 'data-team': '' } });
  await p.window.fetch(TRACKER);
  await p.window.fetch('https://sabel-webhook.vercel.app/api/notion?x=1');
  await p.window.fetch('https://example.com/api/tracker?key=x');
  assert.equal(p.calls[0].url, 'api/team-token');
  assert.equal(p.calls.find(c => c.url === TRACKER).headers['x-team-token'], 'tok');
  assert.equal(p.calls.find(c => c.url === TRACKER).headers['x-client-token'], undefined);
  for (const c of p.calls.filter(c => c.url !== TRACKER)) assert.equal(c.headers['x-team-token'], undefined, c.url);
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
