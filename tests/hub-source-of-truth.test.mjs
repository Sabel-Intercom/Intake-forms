// node --test tests/hub-source-of-truth.test.mjs
//
// 16 Nov 2026: the client hub is the one place the kick-off, readiness check and
// migration forms live. These check the pieces that keep it that way:
//   1. Internal Ops reads which forms a hub carries from the hub page, and links there;
//   2. the Kick-off Desk is retired (it creates and edits nothing) and Internal Ops no longer links to it;
//   3. the old one-client kick-off page is closed for clients whose hub has the form;
//   4. the readiness check's "Download my answers" builds a tidy summary (PDF, or print page);
//   5. the Task Hub shows, per client, what their readiness check has provided and what is still
//      to come (never guessed per task), from an exact copy of the build brief code in Internal Ops.
// All of it runs the REAL code cut from the pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FORM, OPS, HUB, COPY_BEGIN, COPY_END, copyBlock } from '../scripts/build-brief-map.mjs';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const ops = fs.readFileSync(OPS, 'utf8'), form = fs.readFileSync(FORM, 'utf8'), hub = fs.readFileSync(HUB, 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i > -1 && j > i, 'found ' + a); return src.slice(i, j); };

// ---- 1. Internal Ops: forms come from the hub page ----
const opsFns = new Function(cut(ops, 'function hubFormsIn(', '/* One balanced {...} literal') + cut(ops, 'function kickoffFromHub(', 'function hubForms(') + '\nreturn {hubFormsIn, kickoffFromHub};')();
const HUB_PAGE = [
  'const FORMS=[{"id": "kickoff", "l": "Kick-off", "file": "SabelKickoff_Acme.html", "key": "kickoff-acme-0123456789abcdef-v1"}, {"id": "readiness", "l": "Readiness check", "file": "SabelReadinessCheck.html", "key": "readiness-{slug}-v1", "slugMode": "hyphen"}, {"id": "migration", "l": "Migration details", "file": "SabelMigrationIntake.html", "key": "migration-intake-{slug}-v1"}];',
  "const TRACKER_SLUG='acme';",
  'const T={"setup": {"sabel": [], "client": [{"t": "Complete the readiness check", "form": "readiness"}, {"t": "Agree your kick-off with us", "form": "kickoff"}]}};',
].join('\n');

test('Internal Ops lists a hub form only when the hub has a task for it, with its real key', () => {
  const f = opsFns.hubFormsIn(HUB_PAGE);
  assert.deepEqual(Object.keys(f), ['kickoff', 'readiness']);           // no migration task, so no migration form
  assert.equal(f.kickoff.key, 'kickoff-acme-0123456789abcdef-v1');
  assert.equal(f.readiness.key, 'readiness-acme-v1');
  assert.deepEqual(opsFns.hubFormsIn('no forms here'), {});
  assert.deepEqual(opsFns.hubFormsIn('const FORMS=[not json];\n'), {});
});

test('a kick-off agreed in the hub is reshaped for the Scope panel, hours and all', () => {
  const k = opsFns.kickoffFromHub({ v: 2, name: 'Acme', summary: 'Moving to Intercom.', scopeNote: 'One inbox.', out: ['Phone'],
    pillars: [{ n: 'Foundations', items: [{ t: 'Inboxes', h: 16, d: 'Support inboxes' }, { t: 'Email', h: 4 }] }] });
  assert.equal(k.hub, true);
  assert.deepEqual(k.scope.inScope, [{ t: 'Inboxes', hours: 16, note: 'Support inboxes', pillar: 'Foundations' }, { t: 'Email', hours: 4, note: '', pillar: 'Foundations' }]);
  assert.deepEqual(k.scope.outScope, [{ t: 'Phone' }]);
  assert.match(k.scope.summary, /Moving to Intercom\.\n\nAgreed at kick-off: One inbox\./);
});

// ---- 2. the Desk is retired ----
test('nothing links to the Kick-off Desk, and the Desk page creates and edits nothing', () => {
  assert.ok(!/SabelKickoffDesk\.html/.test(ops), 'Internal Ops has no link to the Desk');
  assert.ok(!/SabelKickoffDesk/.test(read('SabelOpsHub.html')), 'the Ops Hub has no Desk tab');
  const desk = read('SabelKickoffDesk.html');
  assert.ok(!/createForm|Create kick-off form|method:'POST'|oninput=/.test(desk), 'the Desk page cannot create or save');
  assert.match(desk, /Kick-offs have moved into the client hubs/);
});

// ---- 3. the old one-client page is closed where the hub has the form ----
test('the old kick-off page is closed for RMS Cloud and Smokeball, and open for records that stand alone', () => {
  const src = read('SabelKickoff.html');
  const { MOVED_TO_HUB, slugHash } = new Function(cut(src, 'var MOVED_TO_HUB=', 'if(VALID&&MOVED_TO_HUB') + '\nreturn {MOVED_TO_HUB, slugHash};')();
  for (const s of ['rmscloud', 'smokeball']) assert.ok(MOVED_TO_HUB.includes(slugHash(s)), s);
  for (const s of ['raiz', 'released2', 'kinatico', 'elmosoftware', 'soundingboard']) assert.ok(!MOVED_TO_HUB.includes(slugHash(s)), s);
  assert.ok(!/rmscloud|smokeball/i.test(cut(src, 'var MOVED_TO_HUB=', 'if(VALID&&MOVED_TO_HUB')), 'the shared page names no client');
});

// ---- 4. Download my answers ----
const pdfFns = new Function(cut(form, 'ANSWER-PDF:BEGIN', '/* ANSWER-PDF:END */').replace(/^[^\n]*\n/, '') + '\nreturn {answerDoc, pdfSafe, pdfPlain, answerHTML, buildPdf, pdfDay};')();
const PAYLOAD = {
  client: 'Northwind Outdoor', projectType: 'A full project', contactName: 'Priya Raman', contactRole: 'Head of Support', contactEmail: 'priya@northwind.example',
  backupContact: '', copyTo: '', otherNotes: 'We close 24 Dec to 2 Jan.', summary: { green: 1, amber: 1, red: 0, na: 0, unanswered: 1 },
  sections: {
    A: [{ id: 'a2', question: 'Intercom: add Sabel as a full admin teammate', type: 'status', status: 'green', answer: 'Access granted', owner: '', dueBy: '', note: '' },
        { id: 'ax_dns', question: 'Your email domain: add the records we send', type: 'status', status: 'amber', answer: 'In progress', owner: 'Tom Aldous', dueBy: '2026-11-19', note: 'Waiting on IT' },
        { id: 'a3', question: 'Single sign-on?', type: 'status', status: '', answer: '', owner: '', dueBy: '', note: '' }],
    B: [{ id: 'b1', question: 'Which addresses do customers write to?', type: 'answer', answers: { Entries: 'help@northwind.example  ·  Support\nsales@northwind.example  ·  Sales' } },
        { id: 'b4', question: 'Who looks after your DNS settings?', type: 'answer', answers: { 'Who manages it': 'Tom Aldous, IT', 'How long a change usually takes': '' } },
        { id: 'b7', question: 'How should your emails look?', type: 'answer', answers: { 'Sender name': '', Entries: '(none given)' } }],
  },
};

test('the summary carries who, the totals, what is still to sort, and every section in order', () => {
  const A = pdfFns.answerDoc(PAYLOAD, { A: 'Access and getting set up', B: 'Your email' }, new Date('2026-11-16T03:00:00Z'));
  assert.equal(A.by, 'Priya Raman, Head of Support  ·  priya@northwind.example');
  assert.deepEqual(A.tiles.map(t => t[1]), [1, 1, 0, 0, 1]);
  assert.deepEqual(A.open.map(o => o.q), ['Your email domain: add the records we send']);
  assert.match(A.open[0].meta, /Owner: Tom Aldous .* Expected by 19 Nov 2026/);
  assert.deepEqual(A.sections.map(s => [s.id, s.title, s.answered, s.items.length]), [['A', 'Access and getting set up', 2, 3], ['B', 'Your email', 2, 3]]);
  const [a2, dns, sso] = A.sections[0].items;
  assert.deepEqual([a2.state, a2.lines], ['Ready', [['', 'Access granted']]]);
  assert.deepEqual([dns.state, dns.lines, dns.note], ['In progress', [], 'Waiting on IT']);   // the answer repeats the state, so it is not printed twice
  assert.equal(sso.state, 'Not answered');
  const [b1, b4, b7] = A.sections[1].items;
  assert.deepEqual(b1.lines, [['', 'help@northwind.example  ·  Support\nsales@northwind.example  ·  Sales']]);
  assert.deepEqual(b4.lines, [['Who manages it', 'Tom Aldous, IT']]);                          // a blank field is left out
  assert.deepEqual([b7.state, b7.lines], ['Not answered', []]);
  assert.equal(A.stamp, '16 Nov 2026');
});

test('letters the PDF font cannot draw send the download to the print page instead', () => {
  const A = pdfFns.answerDoc(PAYLOAD, {});
  assert.equal(pdfFns.pdfSafe(A), true);
  assert.equal(pdfFns.pdfPlain('“Fin’s” plan – step → done…'), '"Fin\'s" plan - step -> done...');
  for (const txt of ['Łukasz Żak', '日本語', 'ok 👍']) {
    const B = pdfFns.answerDoc({ ...PAYLOAD, otherNotes: txt }, {});
    assert.equal(pdfFns.pdfSafe(B), false, txt);
  }
  assert.equal(pdfFns.pdfSafe(pdfFns.answerDoc({ ...PAYLOAD, otherNotes: 'Zoë Müller, Señor Peña, café' }, {})), true);
});

test('the print page shows the same content and escapes what the client typed', () => {
  const A = pdfFns.answerDoc({ ...PAYLOAD, client: 'A & B <Ltd>', otherNotes: '<script>x</script>' }, { A: 'Access', B: 'Email' });
  const h = pdfFns.answerHTML(A);
  assert.match(h, /<h1>A &amp; B &lt;Ltd&gt;<\/h1>/);
  assert.ok(!h.includes('<script>x</script>'));
  assert.match(h, /Still to sort/); assert.match(h, /SECTION A/); assert.match(h, /help@northwind\.example {2}· {2}Support<br>sales@/);
});

test('the PDF is laid out without running off the page', () => {
  // A stand-in for the PDF library that records every piece of text and where it lands.
  const calls = { text: [], pages: 1 };
  class Fake {
    constructor() { this.size = 10; }
    setFont() {} setTextColor() {} setFillColor() {} setDrawColor() {} setLineWidth() {} rect() {} roundedRect() {} circle() {} line() {}
    setFontSize(s) { this.size = s; }
    getTextWidth(t) { return String(t).length * this.size * 0.3528 * 0.5; }
    splitTextToSize(t, w) { const per = Math.max(1, Math.floor(w / (this.size * 0.3528 * 0.5))), out = []; let s = String(t); while (s.length > per) { out.push(s.slice(0, per)); s = s.slice(per); } out.push(s); return out; }
    text(t, x, y) { calls.text.push({ t, x, y, page: calls.pages }); }
    addPage() { calls.pages++; } getNumberOfPages() { return calls.pages; } setPage() {}
  }
  const long = { ...PAYLOAD, sections: { ...PAYLOAD.sections, C: Array.from({ length: 60 }, (_, i) => ({ id: 'c' + i, question: 'Question ' + i + ' '.repeat(1) + 'word '.repeat(30), type: 'answer', answers: { Detail: 'answer '.repeat(40) } })) } };
  pdfFns.buildPdf(Fake, pdfFns.answerDoc(long, { A: 'Access', B: 'Email', C: 'Customers' }));
  assert.ok(calls.pages > 3, 'a long form runs to several pages');
  for (const c of calls.text) { assert.ok(c.y > 10 && c.y < 292, 'text at y=' + c.y + ' is on the page'); assert.ok(c.x >= 17 && c.x <= 193, 'text at x=' + c.x); }
});

// ---- 5. readiness answers on tasks ----
test('the Task Hub copy of the build brief code matches Internal Ops (run: node scripts/build-brief-map.mjs --write)', () => {
  const i = hub.indexOf(COPY_BEGIN), j = hub.indexOf(COPY_END);
  assert.ok(i > -1 && j > i, 'READINESS-COPY markers present');
  assert.equal(hub.slice(i, j + COPY_END.length), copyBlock(form, ops));
});

const rt = new Function(cut(hub, COPY_BEGIN, COPY_END) + '\n' + cut(hub, '/* READINESS-CLIENT:BEGIN', '/* READINESS-CLIENT:END */') + '\nreturn {briefModel, BRIEF_FORM, rtClient, rtOwed};')();
const SNAP = { v: rt.BRIEF_FORM.v, projectType: 'full', submittedAt: 1794441600000, data: {
  s_a2: 'good::Access granted', s_ax_slack: 'good::Done, access given',
  s_ax_dns: 'bad::Not started yet', ax_dns_own: 'Tom Aldous', ax_dns_by: '2026-11-19', ax_dns_note: 'Waiting on IT', b4a: 'Tom Aldous, IT',
  c1a: 'Their email address', s_c2: 'warn::Probably, needs checking', s_c5: 'warn::Not sure, I will ask',
  f3a: 'help.northwind.example' }, reps: {} };
const model = rt.briefModel(SNAP, { name: 'Northwind', lead: 'Chris' });

test('the Task Hub never guesses which task an answer belongs to', () => {
  assert.ok(!/RT_TOPICS|rtLink|matched on this task/.test(hub), 'no wording match left in the Task Hub');
});

test('one summary per client: what is to come, what is not answered, what is provided', () => {
  const c = rt.rtClient(model);
  assert.deepEqual(c.toCome.map(l => l.id), ['ax_dns', 'c2']);
  assert.ok(c.open.some(l => l.id === 'c5'), '"not sure" is a question to ask, not something owed');
  assert.ok(!c.toCome.some(l => l.id === 'c5'));
  const given = c.provided.flatMap(a => a.lines.map(l => l.id));
  for (const id of ['a2', 'ax_slack', 'b4', 'c1', 'f3']) assert.ok(given.includes(id), id);
  assert.equal(c.counts.provided, given.length);
  assert.deepEqual([c.label, c.tone], ['2 to come from client', 'red']);
  assert.equal(c.sent, 1794441600000);
});

test('the summary label follows what is left', () => {
  const only = d => rt.rtClient(rt.briefModel({ projectType: 'full', data: d, reps: {} }, {}));
  assert.deepEqual([only({ s_a2: 'warn::Invite sent' }).tone, only({ s_a2: 'warn::Invite sent' }).label], ['amber', '1 to come from client']);
  assert.match(only({ s_a2: 'good::Access granted' }).label, /^1 provided, \d+ not answered$/);
});

test('each item the client marked in progress or not started is owed, in their own words', () => {
  const owed = rt.rtOwed(model, 'northwind-tracker-v1', 'Northwind');
  assert.deepEqual(owed.map(o => o.id), ['northwind-tracker-v1:rdy:ax_dns', 'northwind-tracker-v1:rdy:c2']);
  const [dns, c2] = owed;
  assert.deepEqual([dns.owner, dns.due, dns.status, dns.card, dns.readiness], ['Tom Aldous', '2026-11-19', 'Pending', 'Waiting on IT', true]);
  assert.match(dns.title, /email domain/i);                              // the question as the client read it
  assert.deepEqual([c2.owner, c2.due, c2.status, c2.said], ['Northwind', '', 'In Progress', 'Probably, needs checking']);   // no owner given: the client
});

test('no readiness answers yet means no summary and nothing owed', () => {
  assert.equal(rt.rtClient(rt.briefModel({}, {})), null);
  assert.equal(rt.rtClient(null), null);
  assert.deepEqual(rt.rtOwed(rt.briefModel({}, {}), 'x-tracker-v1', 'X'), []);
});
