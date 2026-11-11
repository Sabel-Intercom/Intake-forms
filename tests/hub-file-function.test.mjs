// node --test tests/hub-file-function.test.mjs
// /api/hub-file/<Page>.html: a Sabel teammate reads a tracker file whose own
// address belongs to a client's sign-in. Nobody else gets anything.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet as hubFile } from '../functions/api/hub-file/[name].js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ISS = 'https://sabel.cloudflareaccess.com';
const TEAM_AUD = 'aud-staff-app', CLIENT_AUD = 'aud-gps-app';
const STAFF = { aud: [TEAM_AUD], email: 'nikki@sabelcustomersuccess.com' };

let good;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: good.kid, typ: 'JWT' });
  const body = b64({ iss: ISS, iat: now, exp: now + 600, ...claims });
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(good.privateKey).toString('base64url')}`;
}
// The static site: one tracker page; anything else is missing or a redirect.
function site(asked) {
  return { fetch: async (r) => {
    const u = new URL(r.url); asked.push({ path: u.pathname, headers: [...r.headers.keys()] });
    if (u.pathname === '/GPSInsightTracker_v2') return new Response('<html>tracker</html>', { status: 200, headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=0' } });
    if (u.pathname === '/Moved') return new Response('', { status: 308, headers: { location: '/Elsewhere' } });
    return new Response('nope', { status: 404 });
  } };
}
async function call(claims, name, env = { TEAM_AUD }) {
  const asked = [];
  const request = new Request('https://hubs.example/api/hub-file/' + encodeURIComponent(name), { headers: claims ? { 'cf-access-jwt-assertion': jwt(claims), cookie: 'CF_Authorization=x' } : {} });
  const r = await hubFile({ request, env: { ...env, ASSETS: site(asked) }, params: { name } });
  return { status: r.status, text: await r.text(), cache: r.headers.get('cache-control'), asked };
}

before(() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  good = { kid: 'kid-good', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'kid-good', alg: 'RS256', use: 'sig' } };
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [good.jwk] }), { status: 200 });
});

test('hub-file: a Sabel teammate gets the tracker file, never cached', async () => {
  const r = await call(STAFF, 'GPSInsightTracker_v2.html');
  assert.equal(r.status, 200);
  assert.equal(r.text, '<html>tracker</html>');
  assert.equal(r.cache, 'private, no-store');
  assert.deepEqual(r.asked.map(a => a.path), ['/GPSInsightTracker_v2']);
  // the visitor's cookies and sign-in are not passed on to the static site
  assert.ok(!r.asked[0].headers.includes('cookie') && !r.asked[0].headers.includes('cf-access-jwt-assertion'));
});

test('hub-file: no sign-in, a client sign-in, or a non-Sabel email gets nothing and the site is never asked', async () => {
  for (const claims of [null, { aud: [CLIENT_AUD], email: 'a@gpsinsight.com' }, { aud: [CLIENT_AUD], email: 'x@sabelcustomersuccess.com' },
    { aud: [TEAM_AUD], email: 'a@gpsinsight.com' }, { aud: [TEAM_AUD], email: 'x@evil-sabelcustomersuccess.com' }, { aud: [TEAM_AUD], email: 'x@sabelcustomersuccess.com.evil.io' }, { aud: [TEAM_AUD] }]) {
    const r = await call(claims, 'GPSInsightTracker_v2.html');
    assert.ok([401, 403].includes(r.status), JSON.stringify(claims) + ' ' + r.status);
    assert.ok(!r.text.includes('tracker</html>'));
    assert.equal(r.asked.length, 0);
  }
});

test('hub-file: only a page in the site root; anything else is not found', async () => {
  for (const name of ['', 'GPSInsightTracker_v2', '../secrets.html', 'a/b.html', 'api/team-token', 'x.json', 'hub-auth.js', '.html', 'a b.html', 'x.html.html', 'x%2e.html']) {
    const r = await call(STAFF, name);
    assert.equal(r.status, 404, name);
    assert.equal(r.asked.length, 0, name);
  }
  // a page that is missing, or that the site answers with a redirect
  for (const name of ['Missing.html', 'Moved.html']) assert.equal((await call(STAFF, name)).status, 404, name);
});

test('hub-file: unconfigured fails closed', async () => {
  const r = await call(STAFF, 'GPSInsightTracker_v2.html', {});
  assert.equal(r.status, 404);
  assert.equal(r.asked.length, 0);
});

// The three internal pages that read tracker files all go through it.
test('internal pages read tracker files through /api/hub-file/, falling back to the plain address', async () => {
  for (const [file, base] of [['SabelPortfolioDashboard_v2.html', 'BASE'], ['SabelTaskHub.html', 'BASE'], ['SabelInternalOps.html', 'PAGES']]) {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    assert.ok(!new RegExp(`fetch\\(${base}\\+(tr\\.)?file`).test(src.replace(/function hubFile[\s\S]*?\n}/, '')), `${file} still fetches a tracker file directly`);
    const a = src.indexOf('function hubFile(file){'), code = src.slice(a, src.indexOf('\n}', a) + 2);
    const run = async (reply) => {
      const calls = [];
      const fetch = async (url) => { calls.push(url); const r = reply(url, calls.length); if (r instanceof Error) throw r; return r; };
      const ctx = vm.createContext({ fetch, encodeURIComponent, [base]: 'https://hubs.example/' });
      const res = await vm.runInContext(code + '\nhubFile("GPSInsightTracker_v2.html")', ctx);
      return { calls, res };
    };
    const viaFn = await run(() => ({ ok: true, via: 'fn' }));
    assert.deepEqual(viaFn.calls, ['https://hubs.example/api/hub-file/GPSInsightTracker_v2.html'], file);
    const local = await run((u, n) => (n === 1 ? { ok: false } : { ok: true, via: 'plain' }));
    assert.deepEqual(local.calls, ['https://hubs.example/api/hub-file/GPSInsightTracker_v2.html', 'https://hubs.example/GPSInsightTracker_v2.html'], file);
    assert.equal(local.res.via, 'plain');
    const down = await run((u, n) => (n === 1 ? new Error('network') : { ok: true, via: 'plain' }));
    assert.equal(down.res.via, 'plain', file);
  }
});
