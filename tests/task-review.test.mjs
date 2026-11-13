// node --test tests/task-review.test.mjs
//
// The Done tab in the Task Hub is Nikki's review list: every task marked
// complete waits there until she presses Reviewed. This runs the REAL rules
// from the page (the block between REVIEW:BEGIN and REVIEW:END in
// SabelTaskHub.html) and the merge that carries the reviewed list between browsers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const hub = fs.readFileSync(new URL('../SabelTaskHub.html', import.meta.url), 'utf8');
const cut = (a, b) => { const i = hub.indexOf(a), j = hub.indexOf(b, i); assert.ok(i > -1 && j > i, 'found ' + a); return hub.slice(i, j); };
const { isReviewed, needsReview, trackerState, REVIEW_FROM } =
  new Function(cut('/* REVIEW:BEGIN', '/* REVIEW:END */') + '\nreturn {isReviewed, needsReview, trackerState, REVIEW_FROM};')();
const mergeOv = new Function(cut('function mergeOv(', 'async function readRemoteOv(') + '\nreturn mergeOv;')();

const done = (o) => ({ id: 't1', status: 'Complete', doneAt: '2026-11-12', sAt: 0, ...o });

test('a completed task waits for review until it is marked, then leaves the list', () => {
  assert.equal(needsReview(done(), {}, REVIEW_FROM), true);
  const rv = { t1: { at: 1000, by: 'Nikki', d: '2026-11-12' } };
  assert.equal(isReviewed(done(), rv), true);
  assert.equal(needsReview(done(), rv, REVIEW_FROM), false);
  assert.equal(needsReview(done({ status: 'In Progress' }), {}, REVIEW_FROM), false, 'only completed tasks');
});

test('anything completed before the start date, or with no date, starts out as already reviewed', () => {
  assert.equal(needsReview(done({ doneAt: '2026-10-20' }), {}, REVIEW_FROM), false);
  assert.equal(needsReview(done({ doneAt: '' }), {}, REVIEW_FROM), false);
  assert.equal(needsReview(done({ doneAt: REVIEW_FROM }), {}, REVIEW_FROM), true);
});

test('undo puts it back, and so does completing it again after a review', () => {
  assert.equal(needsReview(done(), { t1: { at: 2000, off: true } }, REVIEW_FROM), true);
  const rv = { t1: { at: 1000, by: 'Nikki', d: '2026-11-12' } };
  assert.equal(needsReview(done({ doneAt: '2026-11-13' }), rv, REVIEW_FROM), true, 'ticked again on the tracker, later');
  assert.equal(needsReview(done({ sAt: 5000 }), rv, REVIEW_FROM), true, 'status changed in the Task Hub after the review');
  assert.equal(needsReview(done({ doneAt: '2026-10-01' }), { t1: { at: 2000, off: true } }, REVIEW_FROM), true, 'an old task she asked to review again');
});

test('the tracker label says what the client tracker itself shows', () => {
  const c = { key: 'x' };
  assert.deepEqual(trackerState(done({ srcSt: 'Complete' }), c), ['green', 'Tracker updated', false]);
  assert.deepEqual(trackerState(done({ srcSt: 'In Progress' }), c), ['red', 'Tracker not updated', true]);
  assert.equal(trackerState(done({ srcSt: 'Pending', stages: [{}] }), c)[2], false, 'a staged task is ticked on the tracker, not from here');
  assert.equal(trackerState(done({ src: 'Notion only' }), c)[1], 'Not a tracker task');
  assert.equal(trackerState(done({ srcSt: 'Complete' }), { seeded: true })[1], 'No live tracker');
  assert.equal(trackerState(done({ srcSt: 'Complete' }), undefined)[1], 'No live tracker');
});

test('the reviewed list survives a merge between two browsers, newest change wins', () => {
  const a = { v: 1, tasks: {}, reviewed: { t1: { at: 1000, d: '2026-11-12' }, t2: { at: 1000, d: '1' } } };
  const b = { v: 1, tasks: {}, reviewed: { t1: { at: 3000, off: true }, t3: { at: 500, d: '1' } } };
  const m = mergeOv(a, b);
  assert.deepEqual(Object.keys(m.reviewed).sort(), ['t1', 't2', 't3']);
  assert.equal(m.reviewed.t1.off, true);
  assert.equal(mergeOv({ v: 1, tasks: {} }, { v: 1, tasks: {} }).reviewed, undefined);
});
