// node --test tests/tracker-cli.test.mjs
// scripts/tracker.mjs as a child process, fetch replaced, Keychain never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PASS = 'team-secret-value';
const STATE = { teamToken: PASS, lockedKeys: ['a-tracker-v1'] };

function run(args, { token, state = STATE } = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'trk-')), 'calls.jsonl');
  const env = { PATH: process.env.PATH, MOCK_LOG: log, MOCK_STATE: JSON.stringify(state), SABEL_NO_KEYCHAIN: '1' };
  if (token) env.SABEL_TEAM_TOKEN = token;
  const r = spawnSync(process.execPath, ['--import', './tests/mock-fetch.mjs', 'scripts/tracker.mjs', ...args], { cwd: ROOT, env, encoding: 'utf8' });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { code: r.status, out: r.stdout, err: r.stderr, calls };
}

test('get: locked key reads with the passcode, which is sent but never printed', () => {
  const r = run(['get', 'a-tracker-v1', 'b-tracker-v1'], { token: PASS });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(j['a-tracker-v1'], { ok: true, data: { savedFor: 'a-tracker-v1' } });
  assert.equal(j['b-tracker-v1'].ok, true);
  assert.ok(r.calls.every(c => c.team === PASS));
  assert.ok(!(r.out + r.err).includes(PASS));
});

test('get: no passcode: open key still reads, locked key says how to store one', () => {
  const r = run(['get', 'b-tracker-v1', 'a-tracker-v1']);
  assert.equal(r.code, 2);
  const j = JSON.parse(r.out);
  assert.equal(j['b-tracker-v1'].ok, true);
  assert.equal(j['a-tracker-v1'].ok, false);
  assert.match(j['a-tracker-v1'].error, /no team passcode is stored.*security add-generic-password/);
  assert.ok(r.calls.every(c => c.team === null));
});

test('get: wrong passcode is reported as refused, not as missing', () => {
  const r = run(['get', 'a-tracker-v1'], { token: 'old-passcode' });
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.out)['a-tracker-v1'].error, /was refused/);
  assert.ok(!(r.out + r.err).includes('old-passcode'));
});

test('get: unknown or malformed key', () => {
  assert.equal(JSON.parse(run(['get', 'nope-v1'], { token: PASS }).out)['nope-v1'].status, 404);
  const bad = run(['get', 'A B'], { token: PASS });
  assert.notEqual(bad.code, 0);
  assert.equal(bad.calls.length, 0);
});

test('check: accepted, refused, missing', () => {
  const ok = run(['check'], { token: PASS });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /found \(environment\) and accepted\. 1 tracker key\(s\) are locked/);
  const refused = run(['check'], { token: 'old-passcode' });
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /refused it/);
  const missing = run(['check']);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /No team passcode on this Mac/);
  assert.equal(missing.calls.length, 0);
  for (const r of [ok, refused, missing]) assert.ok(!(r.out + r.err).includes(PASS));
});

test('roster: reads trackers.json from the checkout, no network', () => {
  const all = run(['roster']);
  assert.equal(all.code, 0, all.err);
  const list = JSON.parse(all.out);
  const committed = JSON.parse(readFileSync(join(ROOT, 'trackers.json'), 'utf8'));
  assert.deepEqual(list, committed);
  const active = JSON.parse(run(['roster', '--active']).out);
  assert.deepEqual(active, committed.filter(t => t.active === true));
  assert.ok(active.length > 0 && active.length < list.length);
  assert.equal(all.calls.length, 0);
});

test('unknown command or argument prints usage', () => {
  assert.notEqual(run([]).code, 0);
  assert.notEqual(run(['roster', '--activ']).code, 0);
});
