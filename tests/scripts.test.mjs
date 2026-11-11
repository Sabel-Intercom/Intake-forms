// node --test tests/
// Runs the real scripts as child processes with fetch replaced (mock-fetch.mjs)
// and asserts on the exact calls they make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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

// Per-client inputs keys are not in ALLOWED_KEYS (sabel-webhook matches them by
// pattern), so the sweep works them out from the readiness form keys.
const SWEEP_KEYS = ['a-tracker-v1', 'readiness-a-v1', 'readiness-b-co-v1', 'readiness-inputs-v1', 'migration-intake-a-v1'];
const swept = (r) => r.calls.filter(c => c.method === 'POST' && c.url.includes('/api/tracker-lock')).map(c => c.body.key);

test('lock-down: --lock-keys also locks each client\'s own inputs key, staff only', () => {
  const r = run('lock-down.mjs', ['--apply', '--lock-keys'], { state: { allowedKeys: SWEEP_KEYS, lockedKeys: ['readiness-inputs-b-co-v1'] } });
  assert.equal(r.code, 0, r.out);
  // every listed key, the combined one included, then the per-client key still open
  assert.deepEqual(swept(r), [...SWEEP_KEYS, 'readiness-inputs-a-v1']);
  const locks = r.calls.filter(c => c.method === 'POST' && c.url.includes('/api/tracker-lock'));
  assert.ok(locks.every(c => c.body.token === undefined && c.body.label === 'staff only (lock-down)'));
  // never a key made from the combined key or from another inputs key
  assert.ok(!r.out.includes('readiness-inputs-inputs'));
  noSecrets(r.out);
});

test('lock-down: per-client inputs keys honour --skip and --only, and show in a dry run', () => {
  const state = { allowedKeys: SWEEP_KEYS };
  let r = run('lock-down.mjs', ['--apply', '--lock-keys', '--only', 'readiness-inputs-a-v1,readiness-inputs-v1'], { state });
  assert.deepEqual(swept(r), ['readiness-inputs-v1', 'readiness-inputs-a-v1']);
  r = run('lock-down.mjs', ['--apply', '--lock-keys', '--skip', 'readiness-inputs-a-v1,readiness-inputs-b-co-v1'], { state });
  assert.deepEqual(swept(r), SWEEP_KEYS);
  r = run('lock-down.mjs', ['--lock-keys'], { state });
  assert.equal(r.writes.length, 0);
  assert.match(r.out, /would lock readiness-inputs-a-v1/);
  assert.match(r.out, /would lock readiness-inputs-b-co-v1/);
});

test('lock-down: a sabel-webhook from before per-client inputs keys: those are skipped, the rest still lock', () => {
  const r = run('lock-down.mjs', ['--apply', '--lock-keys'], { state: { allowedKeys: SWEEP_KEYS, noInputsPattern: true } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /readiness-inputs-a-v1: sabel-webhook does not know per-client inputs keys yet, skipped/);
  assert.match(r.out, /5 locked/);
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

const H = 'hubs.sabelcustomersuccess.com';
const lockPosts = (r) => r.calls.filter(c => c.method === 'POST' && c.url.includes('/api/tracker-lock'));
const pagesVars = (r) => r.calls.find(c => c.method === 'PATCH').body.deployment_configs.production.env_vars;

test('onboard-hub: always four destinations, including the client\'s own form address', () => {
  const r = run('onboard-hub.mjs', ONBOARD);
  const app = r.calls.find(c => c.method === 'POST' && c.url.includes('/access/apps')).body;
  assert.deepEqual(app.self_hosted_domains, [`${H}/NoSuchHub`, `${H}/NoSuchHub.html`, `${H}/api/hub-token/a`, `${H}/c/a/*`]);
  assert.equal(pagesVars(r).HUB_PAGES_A, undefined);
});

test('onboard-hub: --also lists own pages for /c/, --keys locks extra keys with the same token', () => {
  const r = run('onboard-hub.mjs', [...ONBOARD, '--also', 'Intake_A.html', '--keys', 'b-tracker-v1'], { state: { lockedKeys: ['a-tracker-v1'], pagesVars: ['HUB_TOKEN_A'] } });
  assert.equal(r.code, 0, r.out);
  const app = r.calls.find(c => c.method === 'POST' && c.url.includes('/access/apps')).body;
  assert.equal(app.self_hosted_domains.length, 4);
  assert.deepEqual(lockPosts(r).map(c => c.body.key), ['a-tracker-v1', 'b-tracker-v1']);
  assert.equal(lockPosts(r)[0].body.token, undefined);
  assert.equal(lockPosts(r)[1].body.token, pagesVars(r).HUB_TOKEN_A.value);
  assert.deepEqual(pagesVars(r).HUB_PAGES_A, { type: 'plain_text', value: 'Intake_A' });
  assert.notEqual(run('onboard-hub.mjs', [...ONBOARD, '--also', 'A.js']).code, 0);
  assert.notEqual(run('onboard-hub.mjs', [...ONBOARD, '--also', '../x.html']).code, 0);
  noSecrets(r.out);
});

// A hub that shows a kick-off, the readiness check and the client's own intake page.
const KICK = 'kickoff-a-0123456789abcdef-v1';
const FORM_KEYS = ['a-tracker-v1', KICK, 'readiness-a-co-v1', 'migration-intake-a-v1'];
// The readiness form's own inputs key: same slug as the form key, known to
// sabel-webhook by pattern, so never listed in ALLOWED_KEYS.
const INPUTS_OWN = 'readiness-inputs-a-co-v1';
function withFormHub(fn) {
  const own = `SabelMigrationIntake_T${process.pid}${Math.random().toString(36).slice(2, 8)}.html`;
  writeFileSync(join(ROOT, own), "<html><head><script>const DEFAULT_SLUG='a';</script></head></html>");
  const hub = '<html><head><script>const FORMS=[{"id":"kickoff","key":"' + KICK + '"},{"id":"readiness","file":"SabelReadinessCheck.html","key":"readiness-{slug}-v1"},{"id":"migration","file":"' + own + '","key":"migration-intake-{slug}-v1"}];' +
    'const T={"link":"https://sabel-intercom.github.io/Intake-forms/SabelReadinessCheck.html?client=A%20Co&name=A%20Co","other":"https://sabel-intercom.github.io/Intake-forms/' + own + '","not":"SabelMigrationIntake_NoSuchFile.html"};</script></head></html>';
  try { return withHub(hub, (name, read) => fn(name, read, own, () => readFileSync(join(ROOT, own), 'utf8'))); } finally { rmSync(join(ROOT, own), { force: true }); }
}

test('onboard-hub: finds the hub\'s forms itself: own pages, form keys, one token for all', () => {
  withFormHub((hubName, readHub, own, readOwn) => {
    const r = run('onboard-hub.mjs', ['a', hubName, 'a.com'], { state: { allowedKeys: FORM_KEYS } });
    assert.equal(r.code, 0, r.out);
    // readiness slug comes from ?client=A%20Co (the form's own rule), not from the hub slug
    // and the client's own inputs key follows the readiness key, same slug
    assert.deepEqual(lockPosts(r).map(c => c.body.key), ['a-tracker-v1', KICK, 'readiness-a-co-v1', 'migration-intake-a-v1', INPUTS_OWN]);
    const token = pagesVars(r).HUB_TOKEN_A.value;
    for (const c of lockPosts(r).slice(1)) assert.equal(c.body.token, token);
    assert.equal(pagesVars(r).HUB_PAGES_A.value, own.replace('.html', ''));
    assert.match(r.out, /readiness-a-v1: not registered in sabel-webhook, skipped/);
    // no inputs key for the unregistered guess readiness-a-v1, and never the combined key
    const asked = r.calls.map(c => c.url + JSON.stringify(c.body || ''));
    assert.ok(!asked.some(u => u.includes('readiness-inputs-a-v1')), 'inputs key made from an unregistered form key');
    assert.ok(!asked.some(u => /readiness-inputs-v1/.test(u)), 'the combined key was touched');
    assert.ok(readHub().includes('<script src="hub-auth.js" data-client="a"></script>\n<script>const FORMS'));
    assert.ok(readOwn().includes('<script src="hub-auth.js" data-form data-client="a"></script>\n<script>const DEFAULT_SLUG'));
    noSecrets(r.out);
  });
});

test('onboard-hub: second run changes no token when every key already answers to this client', () => {
  withFormHub((hubName) => {
    const lockedKeys = [...FORM_KEYS, INPUTS_OWN].map(key => ({ key, label: 'A hub' }));
    const r = run('onboard-hub.mjs', ['a', hubName, 'a.com'], { state: { allowedKeys: FORM_KEYS, lockedKeys, pagesVars: ['HUB_TOKEN_A'] } });
    assert.equal(r.code, 0, r.out);
    assert.equal(lockPosts(r).length, 0);
    assert.equal(pagesVars(r).HUB_TOKEN_A, undefined);
  });
});

test('onboard-hub: a client onboarded before per-client inputs keys gets theirs on the next run, one new token for all', () => {
  for (const inputs of [null, { key: INPUTS_OWN, label: 'staff only (lock-down)' }]) {
    withFormHub((hubName) => {
      const lockedKeys = FORM_KEYS.map(key => ({ key, label: 'A hub' }));
      if (inputs) lockedKeys.push(inputs);
      const r = run('onboard-hub.mjs', ['a', hubName, 'a.com'], { state: { allowedKeys: FORM_KEYS, lockedKeys, pagesVars: ['HUB_TOKEN_A'] } });
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(lockPosts(r).map(c => c.body.key), [...FORM_KEYS, INPUTS_OWN]);
      const token = pagesVars(r).HUB_TOKEN_A.value;
      assert.match(token, /^generated-token-/);
      assert.equal(lockPosts(r).at(-1).body.token, token);
      assert.equal(lockPosts(r).at(-1).body.label, 'A hub');
      noSecrets(r.out);
    });
  }
});

test('onboard-hub: a sabel-webhook from before per-client inputs keys: the key is skipped, onboarding still completes', () => {
  withFormHub((hubName) => {
    const r = run('onboard-hub.mjs', ['a', hubName, 'a.com'], { state: { allowedKeys: FORM_KEYS, noInputsPattern: true } });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(lockPosts(r).map(c => c.body.key), FORM_KEYS);
    assert.match(r.out, /readiness-inputs-a-co-v1: sabel-webhook does not know per-client inputs keys yet, skipped/);
  });
});

test('onboard-hub: the combined inputs key never gets a client token', () => {
  // given by hand
  const byHand = run('onboard-hub.mjs', [...ONBOARD, '--keys', 'readiness-inputs-v1'], { state: { allowedKeys: ['a-tracker-v1', 'readiness-inputs-v1'] } });
  assert.notEqual(byHand.code, 0);
  assert.match(byHand.out, /never locked with one client's token/);
  assert.equal(byHand.calls.length, 0);
  // a hub whose readiness link says ?client=inputs would spell the combined key
  const hub = '<html><head><script>const T="SabelReadinessCheck.html?client=inputs&name=X";</script></head></html>';
  withHub(hub, (name) => {
    const r = run('onboard-hub.mjs', ['a', name, 'a.com', '--no-patch'], { state: { allowedKeys: ['a-tracker-v1', 'readiness-inputs-v1'] } });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(lockPosts(r).map(c => c.body.key), ['a-tracker-v1']);
  });
  // a readiness key given with --keys brings its own inputs key, not one made from an inputs key
  withHub('<html><head><script>x()</script></head></html>', (name) => {
    const args = ['a', name, 'a.com', '--no-patch', '--keys', 'readiness-a-v1,readiness-inputs-zed-v1'];
    const state = { allowedKeys: ['a-tracker-v1', 'readiness-a-v1'] };
    const r = run('onboard-hub.mjs', args, { state });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(lockPosts(r).map(c => c.body.key), ['a-tracker-v1', 'readiness-a-v1', 'readiness-inputs-zed-v1', 'readiness-inputs-a-v1']);
    // --no-detect: only what was given, nothing worked out
    const given = run('onboard-hub.mjs', [...args, '--no-detect'], { state });
    assert.deepEqual(lockPosts(given).map(c => c.body.key), ['a-tracker-v1', 'readiness-a-v1', 'readiness-inputs-zed-v1']);
  });
});

test('onboard-hub: a form key that is open, or was locked by the lock-down sweep, gets the client token', () => {
  for (const readiness of [null, { key: 'readiness-a-co-v1', label: 'staff only (lock-down)' }]) {
    withFormHub((hubName) => {
      const lockedKeys = FORM_KEYS.filter(k => k !== 'readiness-a-co-v1').map(key => ({ key, label: 'A hub' }));
      if (readiness) lockedKeys.push(readiness);
      const r = run('onboard-hub.mjs', ['a', hubName, 'a.com'], { state: { allowedKeys: FORM_KEYS, lockedKeys, pagesVars: ['HUB_TOKEN_A'] } });
      assert.equal(r.code, 0, r.out);
      assert.equal(lockPosts(r).length, 5);
      assert.match(pagesVars(r).HUB_TOKEN_A.value, /^generated-token-/);
    });
  }
});

test('onboard-hub: --no-detect uses only what was given', () => {
  withFormHub((hubName) => {
    const r = run('onboard-hub.mjs', ['a', hubName, 'a.com', '--no-detect'], { state: { allowedKeys: FORM_KEYS } });
    assert.deepEqual(lockPosts(r).map(c => c.body.key), ['a-tracker-v1']);
    assert.equal(pagesVars(r).HUB_PAGES_A, undefined);
  });
});

// The include: written into a throwaway hub file in the repo root.
function withHub(html, fn) {
  const name = `__test_hub_${process.pid}_${Math.random().toString(36).slice(2)}.html`;
  const p = join(ROOT, name);
  writeFileSync(p, html);
  try { return fn(name, () => readFileSync(p, 'utf8')); } finally { rmSync(p, { force: true }); }
}
const TAG = '<script src="hub-auth.js" data-client="a"></script>';

test('onboard-hub: include goes immediately before the first script', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8">\n<script>early()</script>\n</head><body><script>late()</script></body></html>';
  withHub(html, (name, read) => {
    const r = run('onboard-hub.mjs', ['a', name, 'a.com']);
    assert.equal(r.code, 0, r.out);
    const out = read();
    assert.equal(out, html.replace('<script>early()', `${TAG}\n<script>early()`));
    assert.ok(out.indexOf(TAG) < out.indexOf('early()'));
    // second run changes nothing
    run('onboard-hub.mjs', ['a', name, 'a.com'], { state: { lockedKeys: ['a-tracker-v1'], pagesVars: ['HUB_TOKEN_A'] } });
    assert.equal(read(), out);
  });
});

// A throwaway client list in the repo root, named to the script by TRACKERS_FILE.
function withList(entries, fn) {
  const name = `__test_list_${process.pid}_${Math.random().toString(36).slice(2)}.json`;
  const p = join(ROOT, name);
  writeFileSync(p, JSON.stringify(entries, null, 2) + '\n');
  try { return fn({ ...CREDS, TRACKERS_FILE: name }, () => readFileSync(p, 'utf8')); } finally { rmSync(p, { force: true }); }
}

test('onboard-hub: publishing switches the hub\'s own link and names the hub in the client list, one line each', () => {
  withHub('', (name, read) => {
    const html = `<html><head><script>x()</script></head><body><script>\nconst PROG_URL="https://sabel-intercom.github.io/Intake-forms/${name}";  // live address\n</script></body></html>`;
    writeFileSync(join(ROOT, name), html);
    const entries = [{ name: 'Other', key: 'o-tracker-v1', file: 'OtherTracker.html', active: true }, { name: 'A', key: 'a-tracker-v1', file: name, sowHours: 4, active: true }];
    withList(entries, (creds, readList) => {
      const before = readList();
      // dry run and --no-patch write nothing
      for (const flag of ['--dry-run', '--no-patch']) {
        assert.equal(run('onboard-hub.mjs', ['a', name, 'a.com', flag], { creds }).code, 0);
        assert.equal(read(), html); assert.equal(readList(), before);
      }
      const r = run('onboard-hub.mjs', ['a', name, 'a.com'], { creds });
      assert.equal(r.code, 0, r.out);
      const base = name.replace(/\.html$/, '');
      assert.ok(read().includes(`const PROG_URL="https://hubs.sabelcustomersuccess.com/${base}";  // live address`));
      assert.ok(!read().includes('github.io'));
      assert.equal(readList(), before.replace(`"file": "${name}",`, `"file": "${name}",\n    "hub": "a",`));
      assert.deepEqual(JSON.parse(readList()).map(t => t.hub), [undefined, 'a']);
      assert.match(r.out, new RegExp(`Remember: commit and push ${name.replace(/\./g, '\\.')}, ${creds.TRACKERS_FILE.replace(/\./g, '\\.')}`));
      // second run changes nothing
      const out = read(), list = readList();
      const again = run('onboard-hub.mjs', ['a', name, 'a.com'], { creds, state: { lockedKeys: ['a-tracker-v1'], pagesVars: ['HUB_TOKEN_A'] } });
      assert.equal(again.code, 0, again.out);
      assert.equal(read(), out); assert.equal(readList(), list);
      // the list naming another hub for this file stops the run
      writeFileSync(join(ROOT, creds.TRACKERS_FILE), list.replace('"hub": "a"', '"hub": "zed"'));
      const clash = run('onboard-hub.mjs', ['a', name, 'a.com'], { creds, state: { lockedKeys: ['a-tracker-v1'], pagesVars: ['HUB_TOKEN_A'] } });
      assert.notEqual(clash.code, 0);
      assert.match(clash.out, /already has "hub": "zed"/);
    });
  });
});

test('onboard-hub: a hub that is not in the client list, or is there twice, leaves the list alone', () => {
  withHub('<html><head><script>x()</script></head></html>', (name) => {
    for (const entries of [[{ name: 'Other', file: 'OtherTracker.html' }], [{ name: 'A', file: name }, { name: 'A2', file: name }]]) {
      withList(entries, (creds, readList) => {
        const before = readList();
        const r = run('onboard-hub.mjs', ['a', name, 'a.com'], { creds, state: { lockedKeys: ['a-tracker-v1'], pagesVars: ['HUB_TOKEN_A'] } });
        assert.equal(r.code, 0, r.out);
        assert.equal(readList(), before);
      });
    }
  });
});

test('trackers.json: every "hub" is a plain slug, used once, and its page carries that include', () => {
  const list = JSON.parse(readFileSync(join(ROOT, 'trackers.json'), 'utf8'));
  const hubs = list.filter(t => t.hub);
  assert.ok(hubs.some(t => t.hub === 'cookaborough'));
  assert.equal(new Set(hubs.map(t => t.hub)).size, hubs.length);
  for (const t of hubs) {
    assert.match(t.hub, /^[a-z0-9-]{1,40}$/);
    assert.ok(readFileSync(join(ROOT, t.file), 'utf8').includes(`<script src="hub-auth.js" data-client="${t.hub}"></script>`), t.file);
  }
});

test('onboard-hub: page with no script gets the include at the end of head', () => {
  withHub('<html><head><title>x</title></head><body></body></html>', (name, read) => {
    assert.equal(run('onboard-hub.mjs', ['a', name, 'a.com']).code, 0);
    assert.equal(read(), `<html><head><title>x</title>${TAG}\n</head><body></body></html>`);
  });
});

test('onboard-hub: --dry-run and --no-patch leave the file alone', () => {
  const html = '<html><head><script>x()</script></head></html>';
  withHub(html, (name, read) => {
    run('onboard-hub.mjs', ['a', name, 'a.com', '--dry-run']);
    run('onboard-hub.mjs', ['a', name, 'a.com', '--no-patch']);
    assert.equal(read(), html);
  });
});

test('onboard-hub: a page wired to another client or to team mode is refused, untouched', () => {
  for (const other of ['<script src="hub-auth.js" data-client="b"></script>', '<script src="hub-auth.js" data-team></script>']) {
    const html = `<html><head>${other}</head></html>`;
    withHub(html, (name, read) => {
      const r = run('onboard-hub.mjs', ['a', name, 'a.com']);
      assert.notEqual(r.code, 0);
      assert.match(r.out, /different hub-auth include/);
      assert.equal(read(), html);
    });
  }
});

test('onboard-hub: first script inside an HTML comment is refused, untouched', () => {
  const html = '<html><head><!-- <script>old()</script> --></head><body><script>x()</script></body></html>';
  withHub(html, (name, read) => {
    assert.notEqual(run('onboard-hub.mjs', ['a', name, 'a.com']).code, 0);
    assert.equal(read(), html);
  });
});

test('onboard-hub: unknown extra key stops with a clear message', () => {
  const r = run('onboard-hub.mjs', [...ONBOARD, '--keys', 'nope-v1']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /nope-v1 is not in ALLOWED_KEYS/);
});
