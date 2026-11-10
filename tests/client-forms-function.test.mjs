// node --test tests/client-forms-function.test.mjs
// functions/c/[client]/[[path]].js run for real against a generated RSA key.
// The static site (env.ASSETS) and the Cloudflare certs fetch are replaced.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { onRequestGet as serve, assetFor, ownPages } from '../functions/c/[client]/[[path]].js';

const ISS = 'https://sabel.cloudflareaccess.com';
const AUD = { smokeball: 'aud-smokeball', kinatico: 'aud-kinatico', staff: 'aud-staff' };
let good, other, fetched;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function keypair(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}
function jwt(aud, { key = good, email = 'nick@smokeball.com' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT' });
  const body = b64({ iss: ISS, iat: now, exp: now + 600, aud: [aud], email });
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(key.privateKey).toString('base64url')}`;
}
function env(extra = {}) {
  return {
    HUB_AUD_SMOKEBALL: AUD.smokeball, HUB_AUD_KINATICO: AUD.kinatico,
    HUB_PAGES_SMOKEBALL: 'SabelMigrationIntake_Smokeball,SabelKickoff_Smokeball',
    ASSETS: { fetch: async (req) => { fetched.push(new URL(req.url).pathname + new URL(req.url).search); return new Response('<html>page</html>', { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=600' } }); } },
    ...extra,
  };
}
async function get(client, path, token, e = env()) {
  fetched = [];
  const request = new Request(`https://hubs.example/c/${client}/${path}`, { headers: token ? { 'cf-access-jwt-assertion': token } : {} });
  const [pathname] = path.split('?');
  const r = await serve({ request, env: e, params: { client, path: pathname.split('/') } });
  return { status: r.status, text: await r.text(), cache: r.headers.get('Cache-Control'), fetched };
}

before(() => {
  good = keypair('kid-good');
  other = keypair('kid-good');
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [good.jwk] }), { status: 200 });
});

test('a client signed in to their hub gets the shared forms at their own address', async () => {
  for (const page of ['SabelReadinessCheck', 'SabelReadinessCheck.html', 'SabelMigrationIntake', 'SabelKickoff']) {
    const r = await get('smokeball', page + '?client=smokeball&embed=1', jwt(AUD.smokeball));
    assert.equal(r.status, 200, page);
    assert.equal(r.text, '<html>page</html>');
    assert.deepEqual(r.fetched, ['/' + page.replace('.html', '') + '?client=smokeball&embed=1']);
    assert.equal(r.cache, 'private, no-store');
  }
});

test('the include and assets load from the client address too', async () => {
  assert.deepEqual((await get('smokeball', 'hub-auth.js', jwt(AUD.smokeball))).fetched, ['/hub-auth.js']);
  assert.deepEqual((await get('smokeball', 'assets/logos/aftership.svg', jwt(AUD.smokeball))).fetched, ['/assets/logos/aftership.svg']);
});

test('their own form pages are served; another client\'s are not', async () => {
  const own = await get('smokeball', 'SabelMigrationIntake_Smokeball', jwt(AUD.smokeball));
  assert.equal(own.status, 200);
  assert.deepEqual(own.fetched, ['/SabelMigrationIntake_Smokeball']);
  // Kinatico has no own pages listed, and Smokeball's are not theirs.
  for (const page of ['SabelMigrationIntake_Smokeball', 'SabelKickoff_Smokeball', 'SabelMigrationIntake_ELMO']) {
    const r = await get('kinatico', page, jwt(AUD.kinatico));
    assert.equal(r.status, 404, page);
    assert.deepEqual(r.fetched, []);
  }
  assert.equal((await get('smokeball', 'SabelMigrationIntake_ELMO', jwt(AUD.smokeball))).status, 404);
});

test('never a side door: hubs, internal pages, functions and odd paths are 404 and never fetched', async () => {
  for (const path of [
    'SmokeballTracker', 'KinaticoTracker.html', 'SabelInternalOps', 'SabelTaskHub', 'SabelHoursTracker', 'index.html', 'trackers.json',
    'api/team-token', 'api/hub-token/kinatico', 'scripts/onboard-hub.mjs', 'functions/api/team-token.js',
    '../SabelInternalOps', 'assets/../SabelInternalOps', 'assets//x', 'assets/..%2fSabelInternalOps', 'hub-auth.js/extra', '',
  ]) {
    const r = await get('smokeball', path, jwt(AUD.smokeball));
    assert.equal(r.status, 404, path);
    assert.deepEqual(r.fetched, [], path);
  }
});

test('signed in to another client, or as staff on the staff app, is refused', async () => {
  for (const aud of [AUD.kinatico, AUD.staff, 'aud-unknown']) {
    const r = await get('smokeball', 'SabelReadinessCheck', jwt(aud, { email: 'a@sabelcustomersuccess.com' }));
    assert.equal(r.status, 403);
    assert.deepEqual(r.fetched, []);
  }
});

test('no sign-in, forged sign-in, client not onboarded, bad client name: refused, nothing fetched', async () => {
  assert.equal((await get('smokeball', 'SabelReadinessCheck', null)).status, 401);
  assert.equal((await get('smokeball', 'SabelReadinessCheck', jwt(AUD.smokeball, { key: other }))).status, 401);
  assert.equal((await get('elmo', 'SabelReadinessCheck', jwt(AUD.smokeball))).status, 404);
  assert.equal((await get('Smoke_Ball', 'SabelReadinessCheck', jwt(AUD.smokeball))).status, 404);
  assert.deepEqual(fetched, []);
});

test('a redirect from the static site is never passed on', async () => {
  const e = env({ ASSETS: { fetch: async () => new Response(null, { status: 308, headers: { Location: '/SabelInternalOps' } }) } });
  assert.equal((await get('smokeball', 'SabelReadinessCheck', jwt(AUD.smokeball), e)).status, 404);
  const e304 = env({ ASSETS: { fetch: async () => new Response(null, { status: 304 }) } });
  assert.equal((await get('smokeball', 'SabelReadinessCheck', jwt(AUD.smokeball), e304)).status, 304);
});

test('helpers', () => {
  assert.equal(assetFor('SabelKickoff.html'), '/SabelKickoff');
  assert.equal(assetFor('Own_Page', ['Own_Page']), '/Own_Page');
  assert.equal(assetFor('Own_Page'), null);
  assert.deepEqual(ownPages(' A_1.html, B ,../x, ,C-D,' + 'x'.repeat(81)), ['A_1', 'B']);
  assert.deepEqual(ownPages(undefined), []);
});
