// node --test tests/team-pages-signin.test.mjs
// Kick-off Desk and Feedback Dashboard: signed in through Cloudflare Access
// they open with nothing to type; the passcode box is only the fallback.
// The real start-up code is sliced out of each page and run with stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');
function slice(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `markers not found: ${from} ... ${to}`);
  return src.slice(a, b);
}
const settle = () => new Promise(r => setTimeout(r, 20));
const hubAuth = (has, team = true) => ({ team, ready: Promise.resolve(), hasToken: () => has });

// ---- Kick-off Desk ---------------------------------------------------------
const DESK = slice(read('SabelKickoffDesk.html'), 'function signedIn(){', 'function stageOf(');

// storeReplies: what each successive read of the store does ('ok' | '401' | 'down').
async function desk({ auth, typed = '', storeReplies = ['ok'] }) {
  const log = { gates: [], opens: 0, sentTokens: [], rendered: 0 };
  let tok = typed, n = 0;
  const ctx = vm.createContext({
    window: { __hubAuth: auth }, Promise, Error, Date, console,
    API: 'https://x/api/tracker', BASE: 'https://x/', KEY: 'sabel-kickoff-v1',
    token: () => tok, setToken: (t) => { tok = t; },
    gate: (m) => log.gates.push(m || ''), render: () => { log.rendered++; },
    fetch: async () => ({ json: async () => ({}) }),
    getStore: () => {
      log.opens++; log.sentTokens.push(tok);
      const r = storeReplies[Math.min(n++, storeReplies.length - 1)];
      if (r === 'ok') return Promise.resolve({ data: { clients: {} } });
      const e = new Error(r); if (r === '401') e.auth = true; return Promise.reject(e);
    },
  });
  vm.runInContext(DESK + '\nstart();', ctx);
  await settle();
  return { ...log, tokenNow: tok };
}

test('Kick-off Desk: signed in, nothing typed: opens, no passcode box', async () => {
  const r = await desk({ auth: hubAuth(true) });
  assert.equal(r.opens, 1);
  assert.deepEqual(r.gates, []);
  assert.ok(r.rendered >= 1);
});

test('Kick-off Desk: not signed in (no include, client mode, or no token): passcode box', async () => {
  for (const auth of [undefined, hubAuth(false), hubAuth(true, false), { team: true }]) {
    const r = await desk({ auth });
    assert.equal(r.opens, 0);
    assert.deepEqual(r.gates, ['']);
  }
});

test('Kick-off Desk: a typed passcode still works without sign-in', async () => {
  const r = await desk({ auth: undefined, typed: 'typed-pass' });
  assert.equal(r.opens, 1);
  assert.deepEqual(r.sentTokens, ['typed-pass']);
  assert.deepEqual(r.gates, []);
});

test('Kick-off Desk: a saved passcode that stopped working is dropped and the sign-in is used', async () => {
  const r = await desk({ auth: hubAuth(true), typed: 'old-pass', storeReplies: ['401', 'ok'] });
  assert.deepEqual(r.sentTokens, ['old-pass', '']);
  assert.equal(r.tokenNow, '');
  assert.deepEqual(r.gates, []);
});

test('Kick-off Desk: wrong passcode and not signed in: box says so, once, no loop', async () => {
  const r = await desk({ auth: undefined, typed: 'wrong', storeReplies: ['401'] });
  assert.equal(r.opens, 1);
  assert.deepEqual(r.gates, ['That passcode was not accepted.']);
});

test('Kick-off Desk: signed in but refused: asks for the passcode, no loop', async () => {
  const r = await desk({ auth: hubAuth(true), storeReplies: ['401'] });
  assert.equal(r.opens, 1);
  assert.deepEqual(r.gates, ['Your sign-in was not accepted here. Enter the team passcode.']);
});

test('Kick-off Desk: store unreachable is reported as that, not as a bad passcode', async () => {
  const r = await desk({ auth: hubAuth(true), storeReplies: ['down'] });
  assert.deepEqual(r.gates, ['Could not reach the store. Try again in a minute.']);
});

// ---- Feedback Dashboard ----------------------------------------------------
const DASH_SRC = read('SabelFeedbackDashboard.html');
const DASH = slice(DASH_SRC, 'async function load(){', '</script>\n</body>');

async function dash({ auth, typed = '', status = 200 }) {
  const log = { calls: [], gate: [], app: 0, gateHiddenFirst: false };
  const gateEl = { style: { display: 'flex' } }, appEl = { style: { display: 'none' } };
  const ctx = vm.createContext({
    window: { __hubAuth: auth }, Promise, console, encodeURIComponent,
    API: 'https://sabel-webhook.vercel.app/api/feedback?key=sabel-feedback-v1',
    TOKEN: typed, ENTRIES: [],
    document: { getElementById: (id) => (id === 'gate' ? gateEl : id === 'app' ? appEl : { innerHTML: '' }) },
    sessionStorage: { setItem() {}, removeItem() {} },
    showApp: () => { log.app++; }, showGate: (m) => log.gate.push(m || ''), render: () => {},
    fetch: async (url, init) => {
      log.gateHiddenFirst = gateEl.style.display === 'none';
      log.calls.push({ url, headers: (init && init.headers) || {} });
      return { status, json: async () => (status === 200 ? { ok: true, entries: [] } : { ok: false }) };
    },
  });
  vm.runInContext(DASH, ctx);
  await settle();
  return log;
}

test('Feedback Dashboard: signed in: loads straight away, box hidden, no passcode in the address', async () => {
  const r = await dash({ auth: hubAuth(true) });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, 'https://sabel-webhook.vercel.app/api/feedback?key=sabel-feedback-v1');
  assert.deepEqual(r.calls[0].headers, {});
  assert.equal(r.app, 1);
  assert.deepEqual(r.gate, []);
  assert.equal(r.gateHiddenFirst, true);
});

test('Feedback Dashboard: not signed in and nothing typed: passcode box, no request', async () => {
  for (const auth of [undefined, hubAuth(false), hubAuth(true, false)]) {
    const r = await dash({ auth });
    assert.equal(r.calls.length, 0);
    assert.deepEqual(r.gate, ['']);
  }
});

test('Feedback Dashboard: a typed passcode goes in the header, never in the address', async () => {
  const r = await dash({ auth: undefined, typed: 'typed pass&x=1' });
  assert.equal(r.calls.length, 1);
  assert.ok(!r.calls[0].url.includes('token='));
  assert.ok(!r.calls[0].url.includes('typed'));
  assert.equal(JSON.stringify(r.calls[0].headers), JSON.stringify({ 'X-Team-Token': 'typed pass&x=1' }));
});

test('Feedback Dashboard: refused by the server: back to the box', async () => {
  const r = await dash({ auth: hubAuth(true), status: 401 });
  assert.equal(r.app, 0);
  assert.deepEqual(r.gate, ['Not quite, try again.']);
});

test('neither page puts a passcode in a request address', () => {
  assert.ok(!/[?&]token=/.test(DASH_SRC.replace(/\/\/[^\n]*/g, '')));
  assert.ok(!/[?&]token=/.test(read('SabelKickoffDesk.html')));
});

test('_headers: the include is revalidated on every load', () => {
  const h = read('_headers').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  assert.deepEqual(h, ['/hub-auth.js', '  Cache-Control: private, no-cache']);
});
