// Shared by scripts/backfill-readiness-inputs.mjs and scripts/lock-down.mjs.
//
// The readiness form's project inputs and confirmed access rows live in two
// places in sabel-webhook /api/tracker:
//
//   readiness-inputs-v1          every client, keyed by client name, plus
//                                access[<slug>]. For Sabel's pages only.
//   readiness-inputs-<slug>-v1   one client's part. The copy their form reads,
//                                locked with their client token by onboard-hub.
//
// <slug> is the slug in the client's form key readiness-<slug>-v1: what the
// form makes of ?client= (lower case, anything but a-z 0-9 becomes a hyphen).
//
// sliceFor() here must build exactly what riSliceFor() builds in
// SabelInternalOps.html and SabelReadinessAdmin.html. tests/readiness-inputs.test.mjs
// runs both on the same stores and compares.

import { execFileSync } from 'node:child_process';

export const INPUTS_ALL = 'readiness-inputs-v1';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

export function slugify(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function inputsKeyFor(slug) {
  return SLUG.test(slug || '') ? `readiness-inputs-${slug}-v1` : '';
}

// readiness-<slug>-v1 -> readiness-inputs-<slug>-v1. Null for anything else,
// including the combined key and any per-client inputs key itself.
export function inputsKeyForFormKey(formKey) {
  const m = /^readiness-([a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)-v1$/.exec(formKey || '');
  if (!m || /^inputs(-|$)/.test(m[1])) return null;
  return `readiness-inputs-${m[1]}-v1`;
}

const newest = (a, b) => String(b.updated || '').localeCompare(String(a.updated || ''));

export function sliceFor(store, slug, names, prev, now = new Date().toISOString()) {
  const all = (store && store.clients) || {};
  const vals = Object.values(all).filter(Boolean);
  let hit = vals.filter(x => x.slug && slugify(x.slug) === slug).sort(newest)[0] || null;
  if (!hit) {
    const free = vals.filter(x => !x.slug);
    // `names` are staff-controlled names only (see riSliceFor in the pages).
    // The slug is never tried as a name: a slug can come from a submission.
    for (const w of (names || []).filter(Boolean)) {
      const lc = String(w).toLowerCase().trim(), sl = slugify(w);
      hit = free.filter(x => String(x.name || '').toLowerCase().trim() === lc || slugify(x.name) === sl).sort(newest)[0] || null;
      if (hit) break;
    }
  }
  const out = { v: 1, slug, updated: now, access: ((store && store.access) || {})[slug] || {} };
  if (hit) { out.name = hit.name; out.items = (Array.isArray(hit.items) ? hit.items : []).map(x => String(x).trim()).filter(Boolean); }
  else if (prev && Array.isArray(prev.items)) { out.name = prev.name; out.items = prev.items; }
  return out;
}

// Which slug does a combined-store entry belong to? In order:
//   1. a name the caller mapped by hand (--map "<name as a slug>=<slug>")
//   2. the slug stored on the entry (every list published since Oct 2026)
//   3. the roster (trackers.json): same client name -> <slug>-tracker-v1
//   4. the client name as a slug
// Returns { slug, via }.
export function slugForEntry(entry, roster = [], map = {}) {
  const byName = slugify(entry && entry.name);
  if (map[byName]) return { slug: slugify(map[byName]), via: 'map' };
  if (entry && entry.slug && slugify(entry.slug)) return { slug: slugify(entry.slug), via: 'entry' };
  const lc = String((entry && entry.name) || '').toLowerCase().trim();
  const row = (Array.isArray(roster) ? roster : []).find(t => t && t.key && /-tracker-v\d+$/.test(t.key)
    && (String(t.name || '').toLowerCase().trim() === lc || slugify(t.name) === byName));
  if (row) return { slug: slugify(row.key.replace(/-tracker-v\d+$/, '')), via: 'roster' };
  return { slug: byName, via: 'name' };
}

// Every per-client copy the combined store calls for:
//   [{ slug, key, via, names, entries }]   entries = how many lists point at this slug
// One row per slug: each list, plus any access[<slug>] with no list.
export function plan(store, roster = [], map = {}) {
  const rows = new Map();
  const row = (slug, via) => {
    if (!rows.has(slug)) rows.set(slug, { slug, key: inputsKeyFor(slug), via, names: [], entries: 0 });
    return rows.get(slug);
  };
  const entries = Object.values((store && store.clients) || {}).filter(Boolean).sort(newest);
  for (const e of entries) {
    const { slug, via } = slugForEntry(e, roster, map);
    const r = row(slug, via);
    r.entries++;
    if (e.name) r.names.push(e.name);
  }
  for (const slug of Object.keys((store && store.access) || {})) row(slugify(slug), 'access');
  return [...rows.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

// Same content, whatever the write time? Then there is nothing to write.
export function sameSlice(a, b) {
  const strip = (s) => (s && typeof s === 'object' ? { name: s.name, slug: s.slug, items: s.items, access: s.access || {} } : null);
  return JSON.stringify(sortKeys(strip(a))) === JSON.stringify(sortKeys(strip(b)));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}

// The team passcode, read exactly as scripts/tracker.mjs reads it:
//   1. the environment variable SABEL_TEAM_TOKEN (or KICKOFF_TEAM_TOKEN)
//   2. the macOS Keychain item "sabel-team-token"
// Never print the value.
export const KEYCHAIN_ITEM = 'sabel-team-token';
export const ADD_HINT = `security add-generic-password -U -s ${KEYCHAIN_ITEM} -a sabel -w`;
export function teamToken(env = process.env) {
  const fromEnv = env.SABEL_TEAM_TOKEN || env.KICKOFF_TEAM_TOKEN;
  if (fromEnv) return { token: fromEnv.trim(), source: 'environment' };
  if (env.SABEL_NO_KEYCHAIN || process.platform !== 'darwin') return { token: null, source: null };
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_ITEM, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const token = out.trim();
    return token ? { token, source: 'Keychain' } : { token: null, source: null };
  } catch { return { token: null, source: null }; }
}
