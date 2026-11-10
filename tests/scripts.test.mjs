// node --test tests/
// Runs the real scripts as child processes with fetch replaced (mock-fetch.mjs)
// and asserts on the exact calls they make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CREDS = { CLOUDFLARE_API_TOKEN: 'cf-secret-value', CLOUDFLARE_ACCOUNT_ID: 'acct', KICKOFF_TEAM_TOKEN: 'team-secret-value' };

function run(script, args, { state = {}, creds = CREDS } = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'hubtest-')), 'calls.jsonl');
  const env = { PATH: process.env.PATH, MOCK_LOG: log, MOCK_STATE: JSON.stringify(state), ...creds };
  const r = spawnSync(process.execPath, ['--import', './tests/mock-fetch.mjs', `scripts/${script}`, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const short = calls.map(c => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, '').replace('/client/v4/accounts/acct', '')}`);
  return { code: r.status, out: r.stdout + r.stderr, calls, short, writes: calls.filter(c => c.method !== 'GET') };
}
const noSecrets = (out) => {
  assert.ok(!out.includes('cf-secret-value'), 'Cloudflare token printed');
  assert.ok(!out.includes('team-secret-value'), 'team passcode printed');
  assert.ok(!out.includes('generated-token-'), 'client token printed');
};

test('lock-down: default is a dry run that writes nothing, even with credentials', () => {
  const r = run('lock-down.mjs', ['--lock-keys']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.writes.length, 0);
  assert.match(r.out, /would lock a-tracker-v1/);
  noSecrets(r.out);
});

test('lock-down: --apply creates open-files app BEFORE the staff app, sets vars, locks nothing', () => {
  const r = run('lock-down.mjs', ['--apply']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.short, [
    'GET /access/apps?per_page=100', 'POST /access/apps',
    'GET /access/apps?per_page=100', 'POST /access/apps',
    'PATCH /pages/projects/sabel-hubs', 'POST /pages/projects/sabel-hubs/deployments',
  ]);
  const [open, staff] = r.writes;
  assert.equal(open.body.name, 'Sabel hubs: open files');
  assert.equal(open.body.policies[0].decision, 'bypass');
  assert.ok(open.body.self_hosted_domains.includes('hubs.sabelcustomersuccess.com/hub-auth.js'));
  assert.ok(open.body.self_hosted_domains.includes('hubs.sabelcustomersuccess.com/assets/*'));
  assert.ok(!open.body.self_hosted_domains.includes('hubs.sabelcustomersuccess.com'), 'bypass must never cover the whole domain');
  assert.equal(staff.body.name, 'Sabel hubs: staff only');
  assert.deepEqual(staff.body.self_hosted_domains, ['hubs.sabelcustomersuccess.com']);
  assert.equal(staff.body.policies[0].decision, 'allow');
  assert.deepEqual(staff.body.policies[0].include, [{ email_domain: { domain: 'sabelcustomersuccess.com' } }]);
  const vars = r.writes[2].body.deployment_configs.production.env_vars;
  assert.deepEqual(vars.TEAM_AUD, { type: 'plain_text', value: 'aud-Sabel hubs: staff only' });
  assert.deepEqual(vars.TEAM_TOKEN, { type: 'secret_text', value: 'team-secret-value' });
  noSecrets(r.out);
});

test('lock-down: re-run updates the existing apps instead of duplicating', () => {
  const state = { apps: [{ id: 'open1', name: 'Sabel hubs: open files', aud: 'x' }, { id: 'staff1', name: 'Sabel hubs: staff only', aud: 'aud-existing' }] };
  const r = run('lock-down.mjs', ['--apply'], { state });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.writes.slice(0, 2).map(c => `${c.method} ${c.url.split('/access/')[1]}`), ['PUT apps/open1', 'PUT apps/staff1']);
});

test('lock-down: --lock-keys locks only open keys, honours --skip, sends the team passcode', () => {
  const r = run('lock-down.mjs', ['--apply', '--lock-keys', '--skip', 'sabel-hours-v1'], { state: { lockedKeys: ['a-tracker-v1'] } });
  assert.equal(r.code, 0, r.out);
  const locks = r.calls.filter(c => c.method === 'POST' && c.url.includes('/api/tracker-lock'));
  assert.deepEqual(locks.map(c => c.body.key), ['b-tracker-v1']);
  assert.equal(locks[0].team, 'team-secret-value');
  assert.equal(locks[0].body.token, undefined);
  noSecrets(r.out);
});

test('lock-down: --apply without credentials stops before any call', () => {
  const r = run('lock-down.mjs', ['--apply'], { creds: {} });
  assert.notEqual(r.code, 0);
  assert.equal(r.calls.length, 0);
});

test('lock-down: unknown argument is refused', () => {
  const r = run('lock-down.mjs', ['--aply']);
  assert.notEqual(r.code, 0);
  assert.equal(r.calls.length, 0);
});

const ONBOARD = ['a', 'NoSuchHub.html', 'a.com', '--no-patch'];

test('onboard-hub: open key gets locked and its token stored', () => {
  const r = run('onboard-hub.mjs', ONBOARD);
  assert.equal(r.code, 0, r.out);
  const lock = r.calls.find(c => c.method === 'POST' && c.url.includes('/api/tracker-lock'));
  assert.deepEqual(lock.body, { key: 'a-tracker-v1', label: 'A hub' });
  const vars = r.calls.find(c => c.method === 'PATCH').body.deployment_configs.production.env_vars;
  assert.equal(vars.HUB_TOKEN_A.value, 'generated-token-2');
  noSecrets(r.out);
});

test('onboard-hub: locked key with its token already on Pages is left alone', () => {
  const r = run('onboard-hub.mjs', ONBOARD, { state: { lockedKeys: ['a-tracker-v1'], pagesVars: ['HUB_TOKEN_A'] } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.filter(c => c.method === 'POST' && c.url.includes('/api/tracker-lock')).length, 0);
  const vars = r.calls.find(c => c.method === 'PATCH').body.deployment_configs.production.env_vars;
  assert.equal(vars.HUB_TOKEN_A, undefined);
});

test('onboard-hub: key locked by lock-down (no token on Pages) gets a client token', () => {
  const r = run('onboard-hub.mjs', ONBOARD, { state: { lockedKeys: ['a-tracker-v1'] } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.filter(c => c.method === 'POST' && c.url.includes('/api/tracker-lock')).length, 1);
  const vars = r.calls.find(c => c.method === 'PATCH').body.deployment_configs.production.env_vars;
  assert.match(vars.HUB_TOKEN_A.value, /^generated-token-/);
  noSecrets(r.out);
});

test('onboard-hub: --also adds destinations, --keys locks extra keys with the same token', () => {
  const r = run('onboard-hub.mjs', [...ONBOARD, '--also', 'Intake_A.html,A.js', '--keys', 'b-tracker-v1'], { state: { lockedKeys: ['a-tracker-v1'], pagesVars: ['HUB_TOKEN_A'] } });
  assert.equal(r.code, 0, r.out);
  const app = r.calls.find(c => c.method === 'POST' && c.url.includes('/access/apps')).body;
  const H = 'hubs.sabelcustomersuccess.com';
  assert.deepEqual(app.self_hosted_domains, [`${H}/NoSuchHub`, `${H}/NoSuchHub.html`, `${H}/api/hub-token/a`, `${H}/Intake_A`, `${H}/Intake_A.html`, `${H}/A.js`]);
  const locks = r.calls.filter(c => c.method === 'POST' && c.url.includes('/api/tracker-lock'));
  assert.deepEqual(locks.map(c => c.body.key), ['a-tracker-v1', 'b-tracker-v1']);
  assert.equal(locks[0].body.token, undefined);
  const stored = r.calls.find(c => c.method === 'PATCH').body.deployment_configs.production.env_vars.HUB_TOKEN_A.value;
  assert.equal(locks[1].body.token, stored);
  noSecrets(r.out);
});

test('onboard-hub: unknown extra key stops with a clear message', () => {
  const r = run('onboard-hub.mjs', [...ONBOARD, '--keys', 'nope-v1']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /nope-v1 is not in ALLOWED_KEYS/);
});
