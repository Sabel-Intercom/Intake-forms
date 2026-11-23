// node --test tests/build-brief.test.mjs
//
// The build brief in Internal Ops reads a client's saved readiness answers and
// sorts them into build order. Two things can quietly break it:
//   1. a question is added or reworded in the form, and the copy of the question
//      list inside Internal Ops is not regenerated;
//   2. the code that turns saved answers into brief lines stops matching how the
//      form saves them.
// This runs the REAL code from the page: the blocks between BRIEF-FORM:BEGIN/END
// and BUILD-BRIEF:BEGIN/END in SabelInternalOps.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FORM, OPS, BEGIN, END, block } from '../scripts/build-brief-map.mjs';

const ops = fs.readFileSync(OPS, 'utf8');
const form = fs.readFileSync(FORM, 'utf8');
const between = (a, b) => { const i = ops.indexOf(a), j = ops.indexOf(b); assert.ok(i > -1 && j > i, 'markers present: ' + a); return ops.slice(i, j + b.length); };
const code = between(BEGIN, END) + '\n' + between('/* BUILD-BRIEF:BEGIN', '/* BUILD-BRIEF:END */');
const { briefModel, briefText, briefInputId, BRIEF_FORM, BRIEF_LABEL, BRIEF_Q_AREA, BRIEF_HINT, BRIEF_FEEDS_TITLE, BRIEF_FEEDS_WORDS, briefFeedsFor, briefTaskLines, briefFeedSummary } =
  new Function(code + '\nreturn {briefModel, briefText, briefInputId, BRIEF_FORM, BRIEF_LABEL, BRIEF_Q_AREA, BRIEF_HINT, BRIEF_FEEDS_TITLE, BRIEF_FEEDS_WORDS, briefFeedsFor, briefTaskLines, briefFeedSummary};')();

test('the question list in Internal Ops matches the readiness form (run: node scripts/build-brief-map.mjs --write)', () => {
  assert.equal(between(BEGIN, END), block(form));
});

test('every short label, area override and hint points at a question that exists', () => {
  const ids = new Set(BRIEF_FORM.sections.flatMap(s => s.items.map(i => i.id)));
  for (const map of [BRIEF_LABEL, BRIEF_Q_AREA, BRIEF_HINT]) for (const id of Object.keys(map)) assert.ok(ids.has(id), 'unknown question id ' + id);
});

test('Section J ids are worked out the same way the form does it', () => {
  const src = (form.match(/function inputId\(txt\)\{[^\n]+\}/) || [])[0];
  assert.ok(src, 'inputId found in the form');
  const inputId = new Function(src + '\nreturn inputId;')();
  for (const t of ['Brand assets for each brand', 'Pre kickoff: Help centre article export', 'Zendesk admin — access']) assert.equal(briefInputId(t), inputId(t));
});

const SNAP = {
  v: BRIEF_FORM.v, savedAt: 1794441600000, projectType: 'full', submittedAt: null,
  data: {
    f_client: 'Northwind Outdoor', f_name: 'Priya Raman', f_role: 'Head of Support',
    a0: 'An online store|Subscriptions',
    s_a2: 'good::Access granted',
    s_ax_dns: 'warn::Invite sent or in progress', ax_dns_own: 'Tom Aldous', ax_dns_by: '2026-11-19',
    s_ax_shop: 'bad::Not started yet',
    s_a3: 'warn::Not sure, I will ask IT',
    b4a: 'Tom Aldous, IT', b4b: '2 days',
    c10a: 'Installed, but we plan to remove it',
    e2a: 'Everything since 2021',
    h4a: 'English, German, French',
    i1a: 'Ecommerce or retail', ie1a: 'Shopify', ie1c: 'Recharge',
    ['s_' + briefInputId('Brand assets for each brand')]: 'warn::Being sorted',
  },
  reps: {
    b1r: [{ addr: 'help@northwind.example', dest: 'Support', kind: 'Mailbox' }, { addr: '', dest: '', kind: '' }],
    g6r: [{ sys: 'Shopify', env: 'None yet' }, { sys: 'Klaviyo', env: '' }],
  },
};
const CTX = { name: 'Northwind Outdoor', type: 'full', lead: 'Chris', sowInputs: ['Brand assets for each brand'], scopeText: 'Fin procedures for Shopify and Recharge. English only.' };

test('saved answers become brief lines, in the right area, with the right status', () => {
  const m = briefModel(SNAP, CTX);
  const by = id => m.lines.find(l => l.id === id);
  assert.equal(by('a2').st, 'g');
  assert.deepEqual([by('ax_dns').st, by('ax_dns').area, by('ax_dns').owner, by('ax_dns').due], ['a', 'email', 'Tom Aldous', '2026-11-19']);
  assert.ok(by('ax_dns').hint, 'a waiting DNS row carries its pointer');
  assert.equal(by('ax_shop').st, 'r');
  assert.equal(by('b4').text, 'Who manages it: Tom Aldous, IT\nHow long a change usually takes: 2 days');
  assert.equal(by('c10').text, 'Installed, but we plan to remove it');
  assert.equal(by('b1').text, 'help@northwind.example · Support · Mailbox');
  assert.equal(by('ie1').area, 'connect');
  assert.equal(by(briefInputId('Brand assets for each brand')).area, 'sow');
  // Shown only when ticked in a0, or for that industry.
  assert.ok(by('ax_shop') && !by('ax_crm') && !by('ax_phone'));
  assert.ok(by('ie1') && !by('ig1'));
});

test('the three lists: blocked has owners, "not sure" goes to the kick-off list, not the blocked list', () => {
  const m = briefModel(SNAP, CTX);
  const ids = a => a.map(l => l.id);
  assert.ok(ids(m.blocked).includes('ax_dns') && ids(m.blocked).includes('ax_shop'));
  assert.ok(!ids(m.blocked).includes('a3') && ids(m.ask).includes('a3'));
  assert.ok(ids(m.ask).includes('g1'), 'a blank question is one to ask');
  assert.equal(m.counts.blocked, m.blocked.length);
  assert.equal(m.counts.answered + m.lines.filter(l => l.st === 'u').length, m.counts.total);
});

test('owners: migration is Richard, connectors are Greg, the rest is the project lead', () => {
  const m = briefModel(SNAP, CTX);
  const who = id => m.areas.find(a => a.id === id).who;
  assert.deepEqual([who('mig'), who('connect'), who('email')], ['Richard', 'Greg', 'Chris']);
});

test('project type decides which questions count', () => {
  const build = briefModel({ ...SNAP, projectType: 'build' }, CTX);
  assert.ok(!build.areas.some(a => a.id === 'mig'), 'no migration area on a build');
  const mig = briefModel({ ...SNAP, projectType: 'migration' }, CTX);
  assert.ok(!mig.lines.some(l => l.id === 'c2' || l.id === 'i5'), 'no build-only questions on a migration');
});

test('scope check names systems missing from the scope text, and says so when no scope is held', () => {
  const m = briefModel(SNAP, CTX);
  assert.deepEqual(m.scope.missing.map(s => s.name), ['Klaviyo']);
  assert.ok(m.scope.facts.some(f => f[0] === 'How far back' && f[1] === 'Everything since 2021'));
  const none = briefModel(SNAP, { ...CTX, scopeText: '' });
  assert.equal(none.scope.held, false);
  assert.equal(none.scope.missing.length, 0);
});

test('nothing saved gives an empty brief, not an error', () => {
  for (const s of [null, undefined, {}, { data: null, reps: null }]) {
    const m = briefModel(s, { name: 'X' });
    assert.equal(m.empty, true);
    assert.equal(m.counts.answered, 0);
  }
});

test('the plain text copy carries the blocked list and the scope check', () => {
  const t = briefText(briefModel(SNAP, CTX));
  assert.match(t, /^# Build brief: Northwind Outdoor/);
  assert.match(t, /## Blocked on the client\n(.*\n)*- DNS records added .*Owner: Tom Aldous · expected 19 Nov 2026/);
  assert.match(t, /## Check against the SOW\n.*\n- Klaviyo/);
});

// ---- Send to Task Hub (13 Nov 2026) ----
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i > -1 && j > i, 'found ' + a); return src.slice(i, j); };
const briefTask = new Function(cut(ops, 'function briefTask(', 'function sendBrief(') + '\nreturn briefTask;')();
const CLIENT = { id: 'nw1', name: 'Northwind Outdoor', owner: 'Chris', hub: { kickoffDate: '2026-11-23' } };

test('the task is due the working day before kick-off, or three working days out when there is none', () => {
  const m = briefModel(SNAP, CTX);
  // Kick-off Monday 23 Nov 2026: the working day before is Friday 20 Nov.
  assert.equal(briefTask(m, CLIENT, new Date(2026, 10, 13)).d, '2026-11-20');
  assert.match(briefTask(m, CLIENT, new Date(2026, 10, 13)).t, /before kick-off$/);
  // No kick-off date, sent on Friday 13 Nov: Wednesday 18 Nov.
  const none = briefTask(m, { ...CLIENT, hub: {} }, new Date(2026, 10, 13));
  assert.equal(none.d, '2026-11-18');
  assert.doesNotMatch(none.t, /kick-off/);
  // Kick-off already gone: same fallback, never a date in the past.
  assert.equal(briefTask(m, { ...CLIENT, hub: { kickoffDate: '2026-11-02' } }, new Date(2026, 10, 13)).d, '2026-11-18');
});

test('it goes to the lead, plus Richard on a migration and Greg when systems are named', () => {
  assert.equal(briefTask(briefModel(SNAP, CTX), CLIENT, new Date(2026, 10, 13)).to, 'Chris,Richard,Greg');
  const build = briefModel({ ...SNAP, projectType: 'build', data: { s_a2: 'good::Access granted' }, reps: {} }, CTX);
  assert.equal(briefTask(build, CLIENT, new Date(2026, 10, 13)).to, 'Chris');
  assert.equal(briefTask(build, { ...CLIENT, owner: '' }, new Date(2026, 10, 13)).to, '');
});

test('the Task Hub reads the hand-off: several people, a due date, and only a link back to Internal Ops', () => {
  const hub = fs.readFileSync(new URL('../SabelTaskHub.html', import.meta.url), 'utf8');
  const oneChase = new Function('TEAM', 'BASE', cut(hub, 'function oneChase(', "if(hashWho())") + '\nreturn oneChase;')(['Chris', 'Richard', 'Greg'], 'https://hubs.sabelcustomersuccess.com/');
  const sent = { ...briefTask(briefModel(SNAP, CTX), CLIENT, new Date(2026, 10, 13)), u: 'https://hubs.sabelcustomersuccess.com/SabelInternalOps.html#c=nw1&brief=1' };
  const r = oneChase(JSON.parse(JSON.stringify(sent)));
  assert.deepEqual([r.kind, r.due, r.to, r.client, r.sk, r.url], ['brief', '2026-11-20', ['Chris', 'Richard', 'Greg'], 'Northwind Outdoor', 'brief:nw1', sent.u]);
  assert.equal(oneChase({ ...sent, u: 'https://evil.example/SabelInternalOps.html#c=nw1' }).url, '', 'any other link is dropped');
  assert.equal(oneChase({ ...sent, d: 'tomorrow' }).due, '');
  // An ordinary chase is unchanged: one person, no due date.
  const chase = oneChase({ t: 'Reply to Acme', to: 'Chris,Greg', c: 'Acme' });
  assert.deepEqual([chase.kind, chase.to, chase.due], ['chase', ['Chris'], '']);
});

/* Readiness feeds: which questions a tracker task needs. */
test('every feed id in the title map and the word map is a question in the form', () => {
  const ids = new Set(BRIEF_FORM.sections.flatMap(s => s.items.map(i => i.id)));
  for (const [t, l] of Object.entries(BRIEF_FEEDS_TITLE)) for (const id of l) assert.ok(ids.has(id), 'unknown question id ' + id + ' on "' + t + '"');
  for (const [re, l] of BRIEF_FEEDS_WORDS) for (const id of l) assert.ok(ids.has(id), 'unknown question id ' + id + ' for ' + re);
});

test('seeded feeds win, then the standard title, then words; a form task feeds nothing', () => {
  assert.deepEqual(briefFeedsFor({ t: 'Anything at all', feeds: ['ax_dns', 'b4', 'ax_dns'] }), { ids: ['ax_dns', 'b4'], via: 'seeded' });
  assert.deepEqual(briefFeedsFor({ t: 'Check Intercom can send email from your domain' }), { ids: ['b1', 'b2', 'b3', 'b4', 'ax_dns', 'b5'], via: 'title' });
  // Punctuation and case do not matter for the title match.
  assert.equal(briefFeedsFor({ t: "Write Fin’s guidance from your tone of voice and example replies" }).via, 'title');
  const w = briefFeedsFor({ t: 'Set up email channels and keep alert email out of support' });
  assert.equal(w.via, 'words'); assert.ok(w.ids.includes('b1') && w.ids.includes('ax_dns'));
  assert.equal(briefFeedsFor({ t: 'Complete the readiness check', form: 'readiness' }), null);
  assert.equal(briefFeedsFor({ t: 'Review revised statement of work for completeness' }), null);
});

test('task lines come worst first and a summary names what the client still owes', () => {
  const m = briefModel(SNAP, CTX);
  const lines = briefTaskLines(m, ['b1', 'b2', 'b3', 'b4', 'ax_dns', 'b5']);
  // b2 and b3 were never answered in SNAP (u); ax_dns is amber; b1 and b4 are given; b5 is a migration question, shown for a full project.
  assert.equal(lines[0].id, 'ax_dns');
  assert.ok(lines.every((l, i) => i === 0 || ({ r: 0, a: 1, u: 2, g: 3, n: 4 })[l.st] >= ({ r: 0, a: 1, u: 2, g: 3, n: 4 })[lines[i - 1].st]));
  const sum = briefFeedSummary(lines);
  assert.equal(sum.tone, 'amber'); assert.ok(sum.label.startsWith('Waiting on readiness · DNS records added'));
  // Not shown to this client (hidden by a0) means not in the list, even when seeded.
  assert.deepEqual(briefTaskLines(m, ['ax_phone']), []);
  assert.equal(briefFeedSummary([]), null);
  // Everything in: green, with the count.
  const ready = briefTaskLines(m, ['b1', 'b4']);
  assert.deepEqual([briefFeedSummary(ready).tone, briefFeedSummary(ready).label], ['green', 'Readiness answers provided · 2']);
});
