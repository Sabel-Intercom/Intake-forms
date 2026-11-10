// node --test tests/readiness-inputs.test.mjs
//
// One client's project inputs (Section J of the readiness check) and confirmed
// access rows live in that client's own key, readiness-inputs-<slug>-v1.
//
// Runs the REAL code from the pages: the block between READINESS-INPUTS:BEGIN
// and :END in SabelReadinessCheck.html (the reader) and between
// READINESS-INPUTS-WRITE:BEGIN and :END in SabelInternalOps.html and
// SabelReadinessAdmin.html (the writer), against a small fake of sabel-webhook
// that enforces locks and team-only writes the way the real one does. The
// backfill script runs as a child process with fetch replaced (mock-fetch.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceFor, slugForEntry, plan, inputsKeyFor, inputsKeyForFormKey, sameSlice, slugify as libSlugify } from '../scripts/readiness-inputs-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const W = 'https://sabel-webhook.vercel.app/api/tracker';
const ALL = 'readiness-inputs-v1';
// The pattern sabel-webhook allows (api/tracker.js READINESS_INPUTS_CLIENT_KEY).
const WEBHOOK_PATTERN = /^readiness-inputs-[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?-v1$/;

function block(file, name) {
  const m = new RegExp(`/\\* ${name}:BEGIN[^\\n]*\\*/\\n([\\s\\S]*?)\\n/\\* ${name}:END \\*/`).exec(read(file));
  assert.ok(m, `${file} has no ${name} block`);
  return m[1];
}
const FORM = read('SabelReadinessCheck.html');
const FORM_SLUGIFY = /^function slugify\(v\)\{.*\}$/m.exec(FORM)[0];
const READER = block('SabelReadinessCheck.html', 'READINESS-INPUTS');
const WRITER = block('SabelInternalOps.html', 'READINESS-INPUTS-WRITE');

// ---- a fake sabel-webhook /api/tracker ------------------------------------
// locks: { key: '<client token>' } or { key: 'STAFF' } (locked, no client token).
// `as` is who is asking: { team: true }, { client: '<token>' } or {} (nobody),
// i.e. what hub-auth.js would have added to the request.
function webhook({ data = {}, locks = {}, perClient = true, down = false } = {}) {
  const store = new Map(Object.entries(structuredClone(data)));
  const calls = [];
  const known = (k) => k === ALL || /^readiness-[a-z0-9-]+-v1$/.test(k) && !/^readiness-inputs-/.test(k) || (perClient && WEBHOOK_PATTERN.test(k));
  const fetchAs = (as = {}) => async (url, init = {}) => {
    const u = new URL(url);
    const key = u.searchParams.get('key');
    const method = init.method || 'GET';
    calls.push({ method, key, as, body: init.body ? JSON.parse(init.body) : null });
    if (down) throw new TypeError('fetch failed');
    const reply = (status, body) => new Response(JSON.stringify(body), { status });
    if (u.origin + u.pathname !== W || !known(key)) return reply(404, { ok: false });
    if (key in locks && !as.team && !(locks[key] !== 'STAFF' && as.client === locks[key])) return reply(401, { ok: false, locked: true });
    if (method === 'POST') {
      if (WEBHOOK_PATTERN.test(key) && !as.team) return reply(401, { ok: false, error: 'Team passcode required' });
      store.set(key, JSON.parse(init.body).data);
      return reply(200, { ok: true });
    }
    return reply(200, { ok: true, data: store.has(key) ? structuredClone(store.get(key)) : null });
  };
  return { store, calls, fetchAs, keysAsked: () => calls.map(c => c.key) };
}
function reader(fetch) {
  const ctx = vm.createContext({ fetch, Date, Object, Array, String, JSON });
  vm.runInContext(`${FORM_SLUGIFY}\n${READER}\nthis.api = { fetchInputs, inputsKeyFor, pickInputs, slugify };`, ctx);
  return ctx.api;
}
function writer(fetch, src = WRITER) {
  const ctx = vm.createContext({ fetch, Date, Object, Array, String, JSON, Error });
  vm.runInContext(`${src}\nthis.api = { riPublish, riSliceFor, riKeyFor, riSlug };`, ctx);
  return ctx.api;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

// Two clients. Kinatico's list was published with its slug; ELMO's is an older
// entry with no slug, found by company name.
const KIN = { name: 'Kinatico', slug: 'kinatico', items: ['Kinatico item one', 'Kinatico item two'], updated: '2026-11-10T00:00:00Z' };
const ELMO = { name: 'ELMO Software', items: ['ELMO item one'], updated: '2026-10-07T00:00:00Z' };
const COMBINED = { clients: { kinatico: KIN, 'elmo software': ELMO }, access: { kinatico: { a2: { at: '2026-11-09T00:00:00Z', by: 'Sabel' } } } };
const OWN_KIN = { v: 1, slug: 'kinatico', name: 'Kinatico', items: KIN.items, access: COMBINED.access.kinatico, updated: 'x' };
const OWN_ELMO = { v: 1, slug: 'elmo', name: 'ELMO Software', items: ELMO.items, access: {}, updated: 'x' };
const K = 'readiness-inputs-kinatico-v1', E = 'readiness-inputs-elmo-v1';
// Everything moved over and locked: each client's key with their token, the combined key staff only.
const LOCKED = { data: { [ALL]: COMBINED, [K]: OWN_KIN, [E]: OWN_ELMO }, locks: { [K]: 'kin-token', [E]: 'elmo-token', [ALL]: 'STAFF' } };

// ---- the key name ------------------------------------------------------------

test('key name: the form, the internal pages, the scripts and sabel-webhook agree', () => {
  const r = reader(async () => new Response('{}')), w = writer(async () => new Response('{}'));
  for (const raw of ['kinatico', 'Kinatico', 'A Co', 'ELMO Software', 'rms', 'a', 'a1-b2', 'x'.repeat(60), ' Sky  City! ']) {
    const slug = r.slugify(raw);
    const key = r.inputsKeyFor(slug);
    assert.match(key, WEBHOOK_PATTERN, raw);
    assert.equal(key, `readiness-inputs-${slug}-v1`);
    assert.equal(w.riKeyFor(w.riSlug(raw)), key, raw);
    assert.equal(inputsKeyFor(libSlugify(raw)), key, raw);
    // same slug as the form's saved answers, which is the key onboard-hub finds
    assert.equal(inputsKeyForFormKey(`readiness-${slug}-v1`), key, raw);
  }
  // the form's own key line still reads readiness-<SLUG>-v1 from slugify(?client=)
  assert.match(FORM, /const SLUG = slugify\(CLIENT_PARAM\);/);
  assert.match(FORM, /const SERVER_KEY = SLUG \? 'readiness-'\+SLUG\+'-v1' : '';/);
});

test('key name: nothing usable gives no key, and never the combined key', () => {
  const r = reader(async () => new Response('{}')), w = writer(async () => new Response('{}'));
  for (const bad of ['', null, undefined, '-', 'a--', '-a', 'A', 'a b', 'a/b', 'a_b', 'x'.repeat(61), '../x', 'v1']) {
    const k = r.inputsKeyFor(bad);
    assert.ok(k === '' || WEBHOOK_PATTERN.test(k), String(bad));
    assert.notEqual(k, ALL);
    assert.equal(w.riKeyFor(bad), k, String(bad));
    assert.equal(inputsKeyFor(bad), k, String(bad));
  }
  assert.equal(r.inputsKeyFor(''), '');
  assert.equal(r.inputsKeyFor('a b'), '');
  for (const k of [ALL, K, 'readiness-inputs-inputs-v1', 'kinatico-tracker-v1', 'migration-intake-a-v1', '']) assert.equal(inputsKeyForFormKey(k), null, k);
});

// ---- the form ------------------------------------------------------------------

test('form: an onboarded client reads their own list and confirmed rows, and never asks for the combined key', async () => {
  const s = webhook(LOCKED);
  const got = await reader(s.fetchAs({ client: 'kin-token' })).fetchInputs('kinatico', ['Kinatico', 'kinatico']);
  assert.deepEqual(plain(got), { items: KIN.items, confirmed: COMBINED.access.kinatico, from: 'own' });
  assert.deepEqual(s.keysAsked(), [K]);
});

test('form: changing ?client= to another client reads nothing, by slug or by company name', async () => {
  for (const [slug, wants] of [['elmo', ['elmo']], ['elmo', ['ELMO Software', 'elmo']], ['elmo-software', ['ELMO Software']]]) {
    const s = webhook(LOCKED);
    const got = await reader(s.fetchAs({ client: 'kin-token' })).fetchInputs(slug, wants);
    assert.deepEqual(plain(got).items, [], slug);
    assert.deepEqual(plain(got).confirmed, {}, slug);
    assert.ok(!JSON.stringify(got).includes('ELMO item'), slug);
  }
  // their token does not open the combined key either, asked for directly
  const s = webhook(LOCKED);
  const direct = await s.fetchAs({ client: 'kin-token' })(`${W}?key=${ALL}`);
  assert.equal(direct.status, 401);
  assert.equal((await s.fetchAs({ client: 'kin-token' })(`${W}?key=${E}`)).status, 401);
});

test('form: a locked key that is not theirs stops there, with no fall back to the combined key', async () => {
  // combined still open (mid-rollout): the form must not go and read it for someone else's slug
  const s = webhook({ ...LOCKED, locks: { [K]: 'kin-token', [E]: 'elmo-token' } });
  const got = await reader(s.fetchAs({ client: 'kin-token' })).fetchInputs('elmo', ['ELMO Software', 'elmo']);
  assert.deepEqual(plain(got), { items: [], confirmed: {}, from: 'none' });
  assert.deepEqual(s.keysAsked(), [E]);
});

test('form: with the combined key locked staff-only an onboarded client still gets Section J', async () => {
  const s = webhook(LOCKED);
  const got = await reader(s.fetchAs({ client: 'elmo-token' })).fetchInputs('elmo', ['ELMO Software', 'elmo']);
  assert.deepEqual(plain(got).items, ELMO.items);
  assert.equal(got.from, 'own');
});

test('form: a client not onboarded (nothing locked, no token) reads their own copy', async () => {
  const s = webhook({ data: LOCKED.data });
  const got = await reader(s.fetchAs({})).fetchInputs('kinatico', ['Kinatico']);
  assert.deepEqual(plain(got), { items: KIN.items, confirmed: COMBINED.access.kinatico, from: 'own' });
  assert.deepEqual(s.keysAsked(), [K]);
});

test('form: no copy of their own yet: falls back to the combined key, by short name or by company name', async () => {
  const s = webhook({ data: { [ALL]: COMBINED } });
  const r = reader(s.fetchAs({}));
  let got = await r.fetchInputs('kinatico', ['kinatico']);
  assert.deepEqual(plain(got), { items: KIN.items, confirmed: COMBINED.access.kinatico, from: 'combined' });
  got = await r.fetchInputs('elmo', ['ELMO Software', 'elmo']);
  assert.deepEqual(plain(got).items, ELMO.items);
  // old style link: ?client=ELMO%20Software
  got = await r.fetchInputs('elmo-software', ['ELMO Software']);
  assert.deepEqual(plain(got).items, ELMO.items);
  // a client with no list
  got = await r.fetchInputs('nobody', ['Nobody Ltd', 'nobody']);
  assert.deepEqual(plain(got), { items: [], confirmed: {}, from: 'combined' });
  assert.deepEqual(s.keysAsked().slice(0, 2), [K, ALL]);
});

test('form: a sabel-webhook from before per-client keys (404) still shows Section J from the combined key', async () => {
  const s = webhook({ data: { [ALL]: COMBINED }, perClient: false });
  const got = await reader(s.fetchAs({})).fetchInputs('kinatico', ['Kinatico', 'kinatico']);
  assert.deepEqual(plain(got).items, KIN.items);
  assert.equal(got.from, 'combined');
});

test('form: a link with a company name only (no ?client=) reads the combined key only', async () => {
  const s = webhook({ data: { [ALL]: COMBINED } });
  const got = await reader(s.fetchAs({})).fetchInputs('', ['ELMO Software']);
  assert.deepEqual(plain(got).items, ELMO.items);
  assert.deepEqual(s.keysAsked(), [ALL]);
});

test('form: their copy holds confirmed rows but no list: rows kept, list from the combined key when it can be read', async () => {
  const rowsOnly = { v: 1, slug: 'kinatico', access: { a1: { at: 't', by: 'Sabel' } } };
  let s = webhook({ data: { [ALL]: COMBINED, [K]: rowsOnly } });
  let got = await reader(s.fetchAs({})).fetchInputs('kinatico', ['Kinatico']);
  assert.deepEqual(plain(got), { items: KIN.items, confirmed: rowsOnly.access, from: 'combined' });
  s = webhook({ data: { [ALL]: COMBINED, [K]: rowsOnly }, locks: { [K]: 'kin-token', [ALL]: 'STAFF' } });
  got = await reader(s.fetchAs({ client: 'kin-token' })).fetchInputs('kinatico', ['Kinatico']);
  assert.deepEqual(plain(got), { items: [], confirmed: rowsOnly.access, from: 'own' });
});

test('form: an empty list in their copy is an answer (no Section J), not a reason to read the combined key', async () => {
  const s = webhook({ data: { [ALL]: COMBINED, [K]: { ...OWN_KIN, items: [] } } });
  const got = await reader(s.fetchAs({})).fetchInputs('kinatico', ['Kinatico']);
  assert.deepEqual(plain(got).items, []);
  assert.deepEqual(s.keysAsked(), [K]);
});

test('form: nothing readable, or the service down, gives no Section J and never throws', async () => {
  let s = webhook({ data: { [ALL]: COMBINED }, locks: { [ALL]: 'STAFF' } });
  assert.deepEqual(plain(await reader(s.fetchAs({})).fetchInputs('kinatico', ['Kinatico'])), { items: [], confirmed: {}, from: 'none' });
  s = webhook({ down: true });
  assert.deepEqual(plain(await reader(s.fetchAs({})).fetchInputs('kinatico', ['Kinatico'])), { items: [], confirmed: {}, from: 'none' });
  const junk = reader(async () => new Response('not json', { status: 200 }));
  assert.deepEqual(plain(await junk.fetchInputs('kinatico', ['Kinatico'])), { items: [], confirmed: {}, from: 'none' });
});

test('form: staff at the plain address (team passcode) read any client\'s copy', async () => {
  const s = webhook(LOCKED);
  const r = reader(s.fetchAs({ team: true }));
  assert.deepEqual(plain(await r.fetchInputs('kinatico', ['Kinatico'])).items, KIN.items);
  assert.deepEqual(plain(await r.fetchInputs('elmo', ['elmo'])).items, ELMO.items);
});

test('form: the page loads Section J through fetchInputs and no longer reads the combined key itself', () => {
  assert.match(FORM, /const got=await fetchInputs\(SLUG, \[NAME_PARAM, CLIENT_PARAM\]\.filter\(Boolean\)\);/);
  assert.match(FORM, /CONFIRMED=got\.confirmed;/);
  assert.equal(FORM.split('readiness-inputs-v1').length - 1, READER.split('readiness-inputs-v1').length - 1 + 1, 'combined key named outside the tested block (one comment allowed)');
  assert.ok(!FORM.includes('INPUTS_URL'));
});

// ---- the internal pages -----------------------------------------------------

test('internal pages: Internal Ops and the Readiness admin page carry the same writer, and call it after saving the combined key', () => {
  assert.equal(block('SabelReadinessAdmin.html', 'READINESS-INPUTS-WRITE'), WRITER);
  const ops = read('SabelInternalOps.html'), admin = read('SabelReadinessAdmin.html');
  assert.match(ops, /await riPublish\(store, riSlug\(formSlugOf\(c\)\), \[c\.name\]\); S\.inputsStatus\[c\.id\]="published";/);
  assert.ok(ops.indexOf('fetch(API+"?key="+INPUTS_KEY, {method:"POST"') < ops.indexOf('await riPublish(store,'), 'combined save comes first');
  assert.match(admin, /await riPublish\(st, riSlug\(slug\), \[sub\.client\]\);/);
  assert.ok(admin.indexOf("fetch(INPUTS,{method:'POST'") < admin.indexOf('await riPublish(st,'));
  // both are internal pages: hub-auth adds the team passcode the write needs
  for (const html of [ops, admin]) assert.match(html, /<script src="hub-auth\.js" data-team><\/script>/);
});

test('internal pages: publishing writes that client\'s part only, to their own key, with the team passcode', async () => {
  const s = webhook({ data: { [ALL]: COMBINED } });
  const w = writer(s.fetchAs({ team: true }));
  assert.equal(await w.riPublish(COMBINED, 'kinatico', ['Kinatico']), 'saved');
  const saved = s.store.get(K);
  assert.deepEqual({ ...saved, updated: 'x' }, { v: 1, slug: 'kinatico', updated: 'x', access: COMBINED.access.kinatico, name: 'Kinatico', items: KIN.items });
  assert.ok(!JSON.stringify(saved).includes('ELMO'), 'another client\'s data in this client\'s copy');
  assert.deepEqual(s.calls.map(c => `${c.method} ${c.key}`), [`GET ${K}`, `POST ${K}`]);
  assert.deepEqual(s.store.get(ALL), COMBINED, 'the combined key is not this function\'s to write');
});

test('internal pages: what Internal Ops publishes is what the client\'s form then reads', async () => {
  const s = webhook({ data: { [ALL]: COMBINED }, locks: { [K]: 'kin-token', [ALL]: 'STAFF' } });
  await writer(s.fetchAs({ team: true })).riPublish(COMBINED, 'kinatico', ['Kinatico']);
  // the hub link carries ?client=Kinatico or ?client=kinatico: one slug, one key
  for (const link of ['Kinatico', 'kinatico']) {
    const r = reader(s.fetchAs({ client: 'kin-token' }));
    const got = await r.fetchInputs(r.slugify(link), ['Kinatico', link]);
    assert.deepEqual(plain(got), { items: KIN.items, confirmed: COMBINED.access.kinatico, from: 'own' });
  }
});

test('internal pages: an older list with no slug is found by name; a list carrying another slug is never used', () => {
  const w = writer(async () => new Response('{}'));
  assert.deepEqual(plain(w.riSliceFor(COMBINED, 'elmo', ['ELMO Software'])).items, ELMO.items);
  assert.deepEqual(plain(w.riSliceFor(COMBINED, 'elmo-software', [])).items, ELMO.items);
  // "Kinatico" by name, but its list says slug kinatico: not for slug kin
  const out = plain(w.riSliceFor(COMBINED, 'kin', ['Kinatico']));
  assert.equal(out.items, undefined);
  assert.deepEqual(out.access, {});
});

test('internal pages: two lists for one slug (a rename): the newest wins', () => {
  const store = { clients: { old: { name: 'Old Name', slug: 'acme', items: ['old'], updated: '2026-10-01T00:00:00Z' }, 'new name': { name: 'New Name', slug: 'acme', items: ['new'], updated: '2026-11-01T00:00:00Z' } } };
  const out = plain(writer(async () => new Response('{}')).riSliceFor(store, 'acme', ['Old Name']));
  assert.deepEqual([out.name, out.items], ['New Name', ['new']]);
});

test('internal pages: confirming access rows for a client with no list keeps the list already in their copy', async () => {
  const s = webhook({ data: { [E]: OWN_ELMO } });
  const store = { clients: {}, access: { elmo: { a2: { at: 't', by: 'Sabel' } } } };
  await writer(s.fetchAs({ team: true })).riPublish(store, 'elmo', ['Someone Else']);
  assert.deepEqual(s.store.get(E).items, ELMO.items);
  assert.deepEqual(s.store.get(E).access, store.access.elmo);
  // and with nothing there before, a copy with rows and no list
  const fresh = webhook();
  await writer(fresh.fetchAs({ team: true })).riPublish(store, 'elmo', []);
  assert.equal('items' in fresh.store.get(E), false);
});

test('internal pages: a sabel-webhook from before per-client keys is not an error; no passcode is', async () => {
  const old = webhook({ perClient: false });
  assert.equal(await writer(old.fetchAs({ team: true })).riPublish(COMBINED, 'kinatico', ['Kinatico']), 'no-key');
  assert.deepEqual(old.calls.map(c => c.method), ['GET']);
  assert.equal(await writer(old.fetchAs({ team: true })).riPublish(COMBINED, '', ['Kinatico']), 'no-key');
  // not signed in on the hubs site: the write is refused and nothing lands
  const s = webhook({ data: { [ALL]: COMBINED } });
  await assert.rejects(writer(s.fetchAs({})).riPublish(COMBINED, 'kinatico', ['Kinatico']), /HTTP 401/);
  assert.equal(s.store.has(K), false);
  // a client token cannot write its own copy either
  const locked = webhook(LOCKED);
  await assert.rejects(writer(locked.fetchAs({ client: 'kin-token' })).riPublish({ clients: { k: { ...KIN, items: ['changed'] } } }, 'kinatico', []), /HTTP 401/);
  assert.deepEqual(locked.store.get(K), OWN_KIN);
});

test('scripts and pages build the same copy from the same store', () => {
  const w = writer(async () => new Response('{}'));
  const stores = [
    COMBINED,
    { clients: { a: { name: 'A Co', slug: 'a', items: [' x ', '', 'y'], updated: '1' }, b: { name: 'A Co', items: ['legacy'], updated: '2' } }, access: { a: { r: { at: 't' } } } },
    { clients: {}, access: { kinatico: {} } },
    {},
  ];
  for (const store of stores) {
    for (const [slug, names, prev] of [['kinatico', ['Kinatico']], ['elmo', ['ELMO Software']], ['a', ['A Co']], ['a-co', ['A Co']], ['none', [], { name: 'P', items: ['kept'] }], ['none', []]]) {
      const page = plain(w.riSliceFor(store, slug, names, prev));
      const lib = sliceFor(store, slug, names, prev, page.updated);
      assert.deepEqual(plain(lib), page, `${slug} ${JSON.stringify(store).slice(0, 40)}`);
    }
  }
});

// ---- which slug a list belongs to (backfill) ------------------------------------

test('backfill: slug of a list: --map, then its own slug, then the roster, then the name', () => {
  const roster = [{ name: 'ELMO Software', key: 'elmo-tracker-v1' }, { name: 'BTS', key: 'bts-usa-june-tracker-v1' }, { name: 'No Key' }];
  assert.deepEqual(slugForEntry(KIN, roster), { slug: 'kinatico', via: 'entry' });
  assert.deepEqual(slugForEntry(ELMO, roster), { slug: 'elmo', via: 'roster' });
  assert.deepEqual(slugForEntry({ name: 'bts ' }, roster), { slug: 'bts-usa-june', via: 'roster' });
  assert.deepEqual(slugForEntry({ name: 'Acme Ltd' }, roster), { slug: 'acme-ltd', via: 'name' });
  assert.deepEqual(slugForEntry({ name: 'No Key' }, roster), { slug: 'no-key', via: 'name' });
  assert.deepEqual(slugForEntry({ name: 'Acme Ltd' }, roster, { 'acme-ltd': 'acme' }), { slug: 'acme', via: 'map' });
  assert.deepEqual(slugForEntry({ name: 'Kinatico', slug: 'kinatico' }, roster, { kinatico: 'kin' }), { slug: 'kin', via: 'map' });
});

test('backfill: one row per slug, lists and access-only clients, in a steady order', () => {
  const store = { clients: { kinatico: KIN, 'elmo software': ELMO, dup: { name: 'Kinatico Pty', slug: 'kinatico', items: ['z'], updated: '2026-01-01' } }, access: { kinatico: {}, rms: { a1: {} } } };
  const rows = plan(store, [{ name: 'ELMO Software', key: 'elmo-tracker-v1' }]);
  assert.deepEqual(rows.map(r => [r.slug, r.key, r.via, r.entries]), [
    ['elmo', E, 'roster', 1], ['kinatico', K, 'entry', 2], ['rms', 'readiness-inputs-rms-v1', 'access', 0],
  ]);
  assert.equal(sameSlice({ ...OWN_KIN, updated: '1' }, { ...OWN_KIN, updated: '2', v: 1 }), true);
  assert.equal(sameSlice(OWN_KIN, { ...OWN_KIN, items: ['other'] }), false);
  assert.equal(sameSlice(null, OWN_KIN), false);
});

// ---- scripts/backfill-readiness-inputs.mjs as a child process -------------------

const PASS = 'team-secret-value';
// A roster row whose tracker short name is not simply its name as a slug, so
// the roster rule is what finds it.
const ROSTER = JSON.parse(read('trackers.json'));
const ROW = ROSTER.find(t => t && t.name && /-tracker-v\d+$/.test(t.key || '') && libSlugify(t.name) !== t.key.replace(/-tracker-v\d+$/, ''));
const ROW_SLUG = ROW.key.replace(/-tracker-v\d+$/, '');
const BF_STORE = {
  clients: {
    kinatico: KIN,
    [ROW.name.toLowerCase().trim()]: { name: ROW.name, items: ['Legacy item A', 'Legacy item B'], updated: '2026-10-01T00:00:00Z' },
    'stray co': { name: 'Stray Co', items: ['Stray item'], updated: '2026-10-02T00:00:00Z' },
  },
  access: { kinatico: COMBINED.access.kinatico },
};
const BF_ALLOWED = ['kinatico-tracker-v1', 'readiness-kinatico-v1', `readiness-${ROW_SLUG}-v1`, ALL];
const BF_STATE = { teamToken: PASS, allowedKeys: BF_ALLOWED, lockedKeys: [ALL, { key: K, label: 'Kinatico hub' }], data: { [ALL]: BF_STORE } };

function backfill(args, { token = PASS, state = BF_STATE } = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'bf-')), 'calls.jsonl');
  const env = { PATH: process.env.PATH, MOCK_LOG: log, MOCK_STATE: JSON.stringify(state), SABEL_NO_KEYCHAIN: '1' };
  if (token) env.SABEL_TEAM_TOKEN = token;
  const r = spawnSync(process.execPath, ['--import', './tests/mock-fetch.mjs', 'scripts/backfill-readiness-inputs.mjs', ...args], { cwd: ROOT, env, encoding: 'utf8' });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { code: r.status, out: r.stdout + r.stderr, calls, writes: calls.filter(c => c.method !== 'GET') };
}
// Nothing from a client's list, and no passcode, may reach the terminal.
const quiet = (out) => {
  for (const secret of [PASS, 'item one', 'item two', 'Legacy item', 'Stray item', '2026-11-09T00:00:00Z']) assert.ok(!out.includes(secret), `printed: ${secret}`);
};

test('backfill: the default is a dry run that writes nothing and prints key names and counts only', () => {
  const r = backfill([]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.writes.length, 0);
  assert.match(r.out, /DRY RUN/);
  assert.match(r.out, new RegExp(`${K}  would create: 2 item\\(s\\), 1 confirmed row\\(s\\) \\(slug from entry; locked \\(Kinatico hub\\)\\)`));
  assert.match(r.out, new RegExp(`readiness-inputs-${ROW_SLUG}-v1  would create: 2 item\\(s\\), 0 confirmed row\\(s\\) \\(slug from roster; not locked yet\\)`));
  assert.match(r.out, /readiness-inputs-stray-co-v1  skipped: no form key readiness-stray-co-v1/);
  assert.match(r.out, /2 to create, 0 to update, 0 already up to date, 1 skipped\./);
  assert.match(r.out, /Dry run: nothing was written/);
  assert.ok(r.calls.every(c => c.team === PASS));
  quiet(r.out);
});

test('backfill: --apply writes each client\'s part to their own key, team passcode sent, combined key only read', () => {
  const r = backfill(['--apply']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.writes.map(c => `${c.method} ${new URL(c.url).pathname}?key=${new URL(c.url).searchParams.get('key')}`).sort(),
    [`POST /api/tracker?key=${K}`, `POST /api/tracker?key=readiness-inputs-${ROW_SLUG}-v1`].sort());
  const kin = r.writes.find(c => c.url.includes(K)).body.data;
  assert.deepEqual({ ...kin, updated: 'x' }, { v: 1, slug: 'kinatico', updated: 'x', access: COMBINED.access.kinatico, name: 'Kinatico', items: KIN.items });
  const legacy = r.writes.find(c => c.url.includes(ROW_SLUG)).body.data;
  assert.deepEqual([legacy.slug, legacy.name, legacy.items], [ROW_SLUG, ROW.name, ['Legacy item A', 'Legacy item B']]);
  for (const w of r.writes) {
    assert.equal(w.team, PASS);
    assert.ok(!w.url.includes('tracker-lock'), 'the backfill never changes a lock');
    const mine = JSON.stringify(w.body);
    assert.equal(['Kinatico item', 'Legacy item', 'Stray item'].filter(t => mine.includes(t)).length, 1, 'one client per key');
  }
  assert.match(r.out, /2 written and read back\./);
  quiet(r.out);
});

test('backfill: running it again writes nothing; a changed list is an update', () => {
  const done = { [K]: { ...OWN_KIN, updated: 'earlier' }, [`readiness-inputs-${ROW_SLUG}-v1`]: { v: 1, slug: ROW_SLUG, name: ROW.name, items: ['Legacy item A'], access: {} } };
  const r = backfill(['--apply'], { state: { ...BF_STATE, data: { ...BF_STATE.data, ...done } } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`${K}  already up to date`));
  assert.match(r.out, new RegExp(`readiness-inputs-${ROW_SLUG}-v1  update: 2 item`));
  assert.deepEqual(r.writes.map(c => new URL(c.url).searchParams.get('key')), [`readiness-inputs-${ROW_SLUG}-v1`]);
  quiet(r.out);
});

test('backfill: a list with no form key is skipped unless mapped to its short name or asked for', () => {
  const mapped = backfill(['--apply', '--map', 'stray-co=kinatico', '--only', 'kinatico']);
  assert.equal(mapped.code, 0, mapped.out);
  assert.match(mapped.out, /2 lists point at this slug, the newest is used/);
  assert.deepEqual(mapped.writes.map(c => new URL(c.url).searchParams.get('key')), [K]);
  assert.deepEqual(mapped.writes[0].body.data.items, KIN.items);

  const asked = backfill(['--apply', '--include-unregistered', '--only', 'stray-co']);
  assert.equal(asked.code, 0, asked.out);
  assert.deepEqual(asked.writes.map(c => new URL(c.url).searchParams.get('key')), ['readiness-inputs-stray-co-v1']);
  assert.deepEqual(asked.writes[0].body.data.items, ['Stray item']);
  for (const r of [mapped, asked]) quiet(r.out);
});

test('backfill: no passcode, or a wrong one, stops before anything is read or written', () => {
  const none = backfill(['--apply'], { token: null });
  assert.notEqual(none.code, 0);
  assert.match(none.out, /No team passcode on this Mac/);
  assert.equal(none.calls.length, 0);
  const wrong = backfill(['--apply'], { token: 'old-passcode' });
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.out, /was refused/);
  assert.equal(wrong.writes.length, 0);
  assert.ok(!wrong.calls.some(c => c.url.includes('/api/tracker?key=')), 'read data with a refused passcode');
  assert.ok(!wrong.out.includes('old-passcode'));
});

test('backfill: a sabel-webhook from before per-client keys stops with a clear message and writes nothing', () => {
  const r = backfill(['--apply'], { state: { ...BF_STATE, noInputsPattern: true } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /does not know per-client inputs keys yet.*deploy sabel-webhook first/);
  assert.equal(r.writes.length, 0);
});

test('backfill: a failed write stops and says how many landed', () => {
  const r = backfill(['--apply'], { state: { ...BF_STATE, failWrites: true } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /write failed on readiness-inputs-[a-z0-9-]+-v1: 500 .*\(0 written before this\)/);
  quiet(r.out);
});

test('backfill: unknown or malformed arguments are refused before any call', () => {
  for (const bad of [['--aply'], ['--only'], ['--only', 'Not A Slug'], ['--map', 'a=b=c'], ['--map', 'A=b'], ['extra']]) {
    const r = backfill(bad);
    assert.notEqual(r.code, 0, bad.join(' '));
    assert.equal(r.calls.length, 0, bad.join(' '));
  }
  const missing = backfill(['--only', 'nobody']);
  assert.notEqual(missing.code, 0);
  assert.match(missing.out, /nothing in readiness-inputs-v1 belongs to that slug/);
  assert.equal(missing.writes.length, 0);
});
