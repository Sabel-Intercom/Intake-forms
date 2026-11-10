#!/usr/bin/env node
// tracker: read tracker data and the client list from a script or from Claude,
// now that tracker keys are being locked.
//
//   node scripts/tracker.mjs roster [--active]      the client list (trackers.json in this checkout)
//   node scripts/tracker.mjs get <key> [<key> ...]  saved state for each key, as JSON
//   node scripts/tracker.mjs tasks [--since <date>] tasks completed in Notion (default: last 7 days)
//   node scripts/tracker.mjs contracts              contract / SOW detail per client, from Notion
//   node scripts/tracker.mjs check                  is the team passcode on this Mac, and accepted?
//
// The team passcode is read from, in order:
//   1. the environment variable SABEL_TEAM_TOKEN (or KICKOFF_TEAM_TOKEN)
//   2. the macOS Keychain item "sabel-team-token"
// Store it once per Mac. Type this, press return, then paste the passcode at
// the hidden prompt (it never appears on screen or in shell history):
//
//   security add-generic-password -U -s sabel-team-token -a sabel -w
//
// The passcode is sent as X-Team-Token and is never printed. An unlocked key
// still reads without one.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.TRACKER_API || 'https://sabel-webhook.vercel.app').replace(/\/$/, '');
const KEYCHAIN_ITEM = 'sabel-team-token';
const ADD_HINT = `security add-generic-password -U -s ${KEYCHAIN_ITEM} -a sabel -w`;

function die(msg, code = 1) { console.error('✖ ' + msg); process.exit(code); }

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

async function call(path, token) {
  const r = await fetch(`${API}${path}`, { headers: token ? { 'X-Team-Token': token } : {} });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

function roster(activeOnly) {
  let list;
  try { list = JSON.parse(readFileSync(resolve(ROOT, 'trackers.json'), 'utf8')); }
  catch (e) { die(`could not read trackers.json in ${ROOT}: ${e.message}`); }
  if (!Array.isArray(list)) die('trackers.json is not a list');
  return activeOnly ? list.filter(t => t && t.active === true) : list;
}

async function get(keys) {
  const { token } = teamToken();
  const out = {};
  let failed = 0;
  for (const key of keys) {
    if (!/^[a-z0-9-]{1,90}$/.test(key)) die(`not a tracker key: ${key}`);
    const r = await call(`/api/tracker?key=${encodeURIComponent(key)}`, token);
    if (r.status === 200 && r.ok) { out[key] = { ok: true, data: r.data ?? null }; continue; }
    failed++;
    let error = r.error || `HTTP ${r.status}`;
    if (r.status === 401) {
      error = token
        ? 'locked, and the team passcode on this Mac was refused. It may have been changed; store the current one again: ' + ADD_HINT
        : 'locked, and no team passcode is stored on this Mac. Store it once: ' + ADD_HINT;
    }
    out[key] = { ok: false, status: r.status, error };
  }
  console.log(JSON.stringify(out, null, 2));
  if (failed) process.exitCode = 2;
}

async function check() {
  const { token, source } = teamToken();
  if (!token) die(`No team passcode on this Mac. Store it once:\n  ${ADD_HINT}`);
  const r = await call('/api/tracker-lock', token);
  if (r.status === 401) die(`A team passcode was found (${source}) but sabel-webhook refused it. Store the current one:\n  ${ADD_HINT}`);
  if (r.status !== 200 || !r.ok) die(`Could not check the passcode: ${r.status} ${r.error || ''}`);
  console.log(`Team passcode found (${source}) and accepted. ${(r.locks || []).length} tracker key(s) are locked.`);
}

// /api/notion is team only: completed tasks, or contract detail per client.
async function notion(query, what) {
  const { token } = teamToken();
  const r = await call(`/api/notion${query}`, token);
  if (r.status === 401) {
    die(token
      ? `${what}: the team passcode on this Mac was refused. Store the current one:\n  ${ADD_HINT}`
      : `${what}: team only, and no team passcode is stored on this Mac. Store it once:\n  ${ADD_HINT}`);
  }
  if (r.status !== 200 || !r.ok) die(`${what}: ${r.status} ${r.error || ''}`);
  const { status, ...body } = r;
  console.log(JSON.stringify(body, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'roster') {
  const unknown = rest.filter(a => a !== '--active');
  if (unknown.length) die(`unknown argument: ${unknown[0]}`);
  console.log(JSON.stringify(roster(rest.includes('--active')), null, 2));
} else if (cmd === 'get') {
  if (!rest.length) die('usage: tracker.mjs get <key> [<key> ...]');
  await get(rest);
} else if (cmd === 'check') {
  await check();
} else if (cmd === 'tasks') {
  let since = '';
  if (rest.length) {
    if (rest[0] !== '--since' || rest.length !== 2 || Number.isNaN(Date.parse(rest[1]))) die('usage: tracker.mjs tasks [--since 2026-11-03]');
    since = `?since=${encodeURIComponent(rest[1])}`;
  }
  await notion(since, 'tasks');
} else if (cmd === 'contracts') {
  if (rest.length) die('usage: tracker.mjs contracts');
  await notion('?kind=projects', 'contracts');
} else {
  die('usage: tracker.mjs roster [--active] | get <key> [<key> ...] | tasks [--since <date>] | contracts | check');
}
