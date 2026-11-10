// node --test tests/
// The two Pages Functions, run for real against a locally generated RSA key.
// Only the Cloudflare certs fetch is replaced.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { onRequestGet as teamToken } from '../functions/api/team-token.js';
import { onRequestGet as hubToken } from '../functions/api/hub-token/[client].js';

const ISS = 'https://sabel.cloudflareaccess.com';
const TEAM_AUD = 'aud-staff-app';
const CLIENT_AUD = 'aud-cookaborough-app';
const env = {
  TEAM_TOKEN: 'team-secret', TEAM_AUD,
  HUB_TOKEN_COOKABOROUGH: 'client-secret', HUB_AUD_COOKABOROUGH: CLIENT_AUD,
};

let good, other;
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function keypair(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}
function jwt(claims, { key = good, alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg, kid: key.kid, typ: 'JWT' });
  const body = b64({ iss: ISS, iat: now, exp: now + 600, ...claims });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const req = (token) => new Request('https://hubs.example/api/x', { headers: token ? { 'cf-access-jwt-assertion': token } : {} });
const call = async (fn, token, e = env, params = {}) => {
  const r = await fn({ request: req(token), env: e, params });
  return { status: r.status, body: await r.json() };
};

before(() => {
  good = keypair('kid-good');
  other = keypair('kid-good'); // same kid, different key: a forged signature
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^https:\/\/sabel\.cloudflareaccess\.com\/cdn-cgi\/access\/certs$/);
    return new Response(JSON.stringify({ keys: [good.jwk] }), { status: 200 });
  };
});

test('team-token: Sabel sign-in to the staff app gets the passcode', async () => {
  const r = await call(teamToken, jwt({ aud: [TEAM_AUD], email: 'Nikki@SabelCustomerSuccess.com' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.token, 'team-secret');
});

test('team-token: no sign-in is refused', async () => {
  assert.equal((await call(teamToken, null)).status, 401);
});

test('team-token: a client signed in to their own hub is refused', async () => {
  const r = await call(teamToken, jwt({ aud: [CLIENT_AUD], email: 'nick@cookaborough.com' }));
  assert.equal(r.status, 403);
  assert.equal(r.body.token, undefined);
});

test('team-token: staff-app audience with a non-Sabel email is refused', async () => {
  for (const email of ['nick@cookaborough.com', 'x@evil-sabelcustomersuccess.com', 'x@sabelcustomersuccess.com.evil.io', '']) {
    const r = await call(teamToken, jwt({ aud: [TEAM_AUD], email }));
    assert.equal(r.status, 403, email);
    assert.equal(r.body.token, undefined);
  }
});

test('team-token: forged signature, expired, wrong issuer, wrong alg are refused', async () => {
  const claims = { aud: [TEAM_AUD], email: 'a@sabelcustomersuccess.com' };
  assert.equal((await call(teamToken, jwt(claims, { key: other }))).status, 401);
  assert.equal((await call(teamToken, jwt({ ...claims, exp: Math.floor(Date.now() / 1000) - 5 }))).status, 401);
  assert.equal((await call(teamToken, jwt({ ...claims, iss: 'https://attacker.cloudflareaccess.com' }))).status, 401);
  assert.equal((await call(teamToken, jwt(claims, { alg: 'none' }))).status, 401);
  assert.equal((await call(teamToken, 'not.a.jwt')).status, 401);
});

test('team-token: unconfigured fails closed and does not echo the audience', async () => {
  const token = jwt({ aud: [TEAM_AUD], email: 'a@sabelcustomersuccess.com' });
  for (const e of [{ TEAM_AUD }, { TEAM_TOKEN: 'team-secret' }, {}]) {
    const r = await call(teamToken, token, e);
    assert.equal(r.status, 404);
    assert.equal(r.body.token, undefined);
    assert.equal(r.body.seenAud, undefined);
  }
});

test('hub-token: unchanged behaviour after the shared-module refactor', async () => {
  const p = { client: 'cookaborough' };
  const ok = await call(hubToken, jwt({ aud: [CLIENT_AUD], email: 'nick@cookaborough.com' }), env, p);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.token, 'client-secret');
  assert.equal(ok.body.email, 'nick@cookaborough.com');

  assert.equal((await call(hubToken, null, env, p)).status, 401);
  // signed in to the staff app, or to another client's hub: not this hub
  assert.equal((await call(hubToken, jwt({ aud: [TEAM_AUD], email: 'a@sabelcustomersuccess.com' }), env, p)).status, 403);
  assert.equal((await call(hubToken, jwt({ aud: ['aud-other-client'] }), env, p)).status, 403);
  assert.equal((await call(hubToken, jwt({ aud: [CLIENT_AUD] }, { key: other }), env, p)).status, 401);

  const unset = await call(hubToken, jwt({ aud: [CLIENT_AUD] }), {}, p);
  assert.equal(unset.status, 404);
  assert.deepEqual(unset.body.missing, ['HUB_TOKEN_COOKABOROUGH', 'HUB_AUD_COOKABOROUGH']);
  assert.deepEqual(unset.body.seenAud, [CLIENT_AUD]);

  assert.equal((await call(hubToken, jwt({ aud: [CLIENT_AUD] }), env, { client: '../etc' })).status, 404);
});
