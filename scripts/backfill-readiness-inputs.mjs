#!/usr/bin/env node
// backfill-readiness-inputs: copy each client's part of the combined
// readiness-inputs-v1 store into that client's own key, readiness-inputs-<slug>-v1.
//
//   node scripts/backfill-readiness-inputs.mjs            show what would be written (default: writes nothing)
//   node scripts/backfill-readiness-inputs.mjs --apply    write it
//
// Options:
//   --apply                    write (without it, a dry run)
//   --only "elmo,smokeball"    only these slugs
//   --map "acme-ltd=acme"      this client's short name, for a list whose slug
//                              cannot be worked out (name as a slug = slug)
//   --include-unregistered     also write for a slug with no form key
//                              readiness-<slug>-v1 in sabel-webhook
//
// Why: the readiness form reads its last section (the project inputs) and the
// access rows Sabel has confirmed from the client's own key, which onboard-hub
// locks with that client's token. Internal Ops and the Readiness admin page
// write that key from now on; this carries over what was published before.
//
// The slug of each list, in order: --map, the slug stored with the list, the
// roster (trackers.json: same client name -> <slug>-tracker-v1), the client
// name as a slug. A slug with no form key readiness-<slug>-v1 is skipped,
// because no form would read it and nothing would ever lock it: give the
// right short name with --map.
//
// Safe to run again: a key that already holds the same content is left alone.
// The combined store is only read, never written.
//
// The team passcode is read as scripts/tracker.mjs reads it: SABEL_TEAM_TOKEN
// (or KICKOFF_TEAM_TOKEN) in the environment, else the macOS Keychain item
// "sabel-team-token". It is sent as X-Team-Token and never printed. Nothing
// from any client's list is printed either: key names and counts only.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUTS_ALL, slugify, plan, sliceFor, sameSlice, teamToken, ADD_HINT } from './readiness-inputs-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.TRACKER_API || 'https://sabel-webhook.vercel.app').replace(/\/$/, '');

function die(msg) { console.error('\n✖ ' + msg); process.exit(1); }
const log = (m) => console.log(m);

// ---------- args ----------
const argv = process.argv.slice(2);
const VALUE_OPTS = ['--only', '--map'];
const FLAGS = ['--apply', '--include-unregistered'];
for (let i = 0; i < argv.length; i++) {
  if (VALUE_OPTS.includes(argv[i])) { if (argv[i + 1] === undefined) die(`${argv[i]} needs a value`); i++; continue; }
  if (!FLAGS.includes(argv[i])) die(`unknown argument: ${argv[i]}`);
}
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const list = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const APPLY = argv.includes('--apply');
const UNREGISTERED = argv.includes('--include-unregistered');
const ONLY = new Set(list(opt('--only')));
for (const s of ONLY) if (slugify(s) !== s) die(`--only takes slugs (lower case, digits, hyphens): ${s}`);
const MAP = {};
for (const pair of list(opt('--map'))) {
  const [from, to, extra] = pair.split('=');
  if (!from || !to || extra !== undefined || slugify(from) !== from || slugify(to) !== to) die(`--map takes name-as-a-slug=slug pairs: ${pair}`);
  MAP[from] = to;
}

// ---------- http ----------
const { token } = teamToken();
if (!token) die(`No team passcode on this Mac, and this script reads and writes team-only data. Store it once:\n  ${ADD_HINT}`);

async function call(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'X-Team-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
const q = encodeURIComponent;

function roster() {
  try {
    const rows = JSON.parse(readFileSync(resolve(ROOT, 'trackers.json'), 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

// ---------- run ----------
log(`backfill-readiness-inputs ${APPLY ? '(APPLY)' : '(DRY RUN, add --apply to write)'}: ${API}`);

const check = await call('GET', '/api/tracker-lock');
if (check.status === 401) die(`The team passcode on this Mac was refused by sabel-webhook. Store the current one:\n  ${ADD_HINT}`);
if (check.status !== 200 || !check.ok) die(`could not reach sabel-webhook: ${check.status} ${check.error || ''}`);

const all = await call('GET', `/api/tracker?key=${INPUTS_ALL}`);
if (all.status !== 200 || !all.ok) die(`could not read ${INPUTS_ALL}: ${all.status} ${all.error || ''}`);
const store = all.data && typeof all.data === 'object' ? all.data : {};
let rows = plan(store, roster(), MAP);
log(`${INPUTS_ALL}: ${Object.keys(store.clients || {}).length} list(s), ${Object.keys(store.access || {}).length} client(s) with confirmed access rows`);
if (ONLY.size) {
  for (const s of ONLY) if (!rows.some(r => r.slug === s)) die(`--only ${s}: nothing in ${INPUTS_ALL} belongs to that slug`);
  rows = rows.filter(r => ONLY.has(r.slug));
}
if (!rows.length) { log('Nothing to copy.'); process.exit(0); }

const count = { create: 0, update: 0, same: 0, skipped: 0 };
const todo = [];
for (const row of rows) {
  if (!row.key) { count.skipped++; log(`  (no usable slug)  skipped: one list has a name that makes no slug`); continue; }
  const lockInfo = await call('GET', `/api/tracker-lock?key=${q(row.key)}`);
  if (lockInfo.status === 404) die('sabel-webhook does not know per-client inputs keys yet (readiness-inputs-<slug>-v1). Merge and deploy sabel-webhook first, then run this again. Nothing was written.');
  if (!lockInfo.ok) die(`could not check ${row.key}: ${lockInfo.status} ${lockInfo.error || ''}`);
  const form = await call('GET', `/api/tracker-lock?key=${q(`readiness-${row.slug}-v1`)}`);
  if (form.status !== 404 && !form.ok) die(`could not check readiness-${row.slug}-v1: ${form.status} ${form.error || ''}`);
  const registered = form.status !== 404;
  const cur = await call('GET', `/api/tracker?key=${q(row.key)}`);
  if (cur.status !== 200 || !cur.ok) die(`could not read ${row.key}: ${cur.status} ${cur.error || ''}`);
  const existing = cur.data && typeof cur.data === 'object' ? cur.data : null;
  const slice = sliceFor(store, row.slug, row.names, existing);
  const what = `${Array.isArray(slice.items) ? `${slice.items.length} item(s)` : 'no list'}, ${Object.keys(slice.access || {}).length} confirmed row(s)`;
  const about = `slug from ${row.via}; ${lockInfo.locked ? `locked (${lockInfo.label || 'no label'})` : 'not locked yet'}`;
  const twice = row.entries > 1 ? `; ${row.entries} lists point at this slug, the newest is used` : '';
  if (!registered && !UNREGISTERED) {
    count.skipped++;
    log(`  ${row.key}  skipped: no form key readiness-${row.slug}-v1 in sabel-webhook, so no form reads it. Give the short name with --map, or --include-unregistered. (${what}; slug from ${row.via})`);
    continue;
  }
  const action = !existing ? 'create' : sameSlice(existing, slice) ? 'same' : 'update';
  count[action]++;
  log(`  ${row.key}  ${action === 'same' ? 'already up to date' : APPLY ? action : `would ${action}`}: ${what} (${about}${twice})`);
  if (action !== 'same') todo.push({ row, slice });
}

let written = 0;
if (APPLY) {
  for (const { row, slice } of todo) {
    const r = await call('POST', `/api/tracker?key=${q(row.key)}`, { data: slice });
    if (r.status !== 200 || !r.ok) die(`write failed on ${row.key}: ${r.status} ${r.error || ''} (${written} written before this)`);
    const back = await call('GET', `/api/tracker?key=${q(row.key)}`);
    if (back.status !== 200 || !sameSlice(back.data, slice)) die(`${row.key} was written but did not read back the same (${written} written before this)`);
    written++;
  }
}

log(`\n${count.create} to create, ${count.update} to update, ${count.same} already up to date, ${count.skipped} skipped.`);
log(APPLY ? `${written} written and read back.` : 'Dry run: nothing was written. Add --apply to write.');
const open = todo.length || count.same;
if (open) log('A key that is "not locked yet" is locked when that client is onboarded (scripts/onboard-hub.mjs), or by scripts/lock-down.mjs --lock-keys.');
