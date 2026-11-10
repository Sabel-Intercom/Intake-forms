// Preloaded with `node --import ./tests/mock-fetch.mjs scripts/<script>.mjs`.
// Replaces fetch with a tiny fake of Cloudflare, sabel-webhook and the raw
// ALLOWED_KEYS file, and appends every call to MOCK_LOG (one JSON per line).
// MOCK_STATE (JSON): { apps: [...], lockedKeys: [...], pagesVars: [...], allowedKeys: [...],
//   data: { <key>: <saved value> },   what /api/tracker holds (default: { savedFor: key })
//   noInputsPattern: true }           a sabel-webhook from before per-client inputs keys
// Per-client inputs keys (readiness-inputs-<slug>-v1) are known by pattern, hold
// nothing until written, and take writes from the team only, as on the real service.
import { appendFileSync } from 'node:fs';

const state = JSON.parse(process.env.MOCK_STATE || '{}');
const apps = state.apps || [];
// lockedKeys: key names, or { key, label } to say who locked it.
const labels = new Map((state.lockedKeys || []).map(k => (typeof k === 'string' ? [k, 'someone'] : [k.key, k.label])));
const locked = { has: (k) => labels.has(k), add: (k, label) => labels.set(k, label || 'someone'), [Symbol.iterator]: () => labels.keys() };
const pagesVars = new Set(state.pagesVars || []);
const allowed = state.allowedKeys || ['a-tracker-v1', 'b-tracker-v1', 'sabel-hours-v1'];
const INPUTS_KEY = /^readiness-inputs-[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?-v1$/;
const isInputsKey = (k) => !state.noInputsPattern && INPUTS_KEY.test(k || '');
const known = (k) => allowed.includes(k) || isInputsKey(k);
const data = new Map(Object.entries(state.data || {}));
let n = 0;

const reply = (status, body) => new Response(JSON.stringify(body), { status });

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  appendFileSync(process.env.MOCK_LOG, JSON.stringify({ method, url, body, team: headers['x-team-token'] || null }) + '\n');

  if (url.startsWith('https://raw.githubusercontent.com/')) {
    return new Response(`export const ALLOWED_KEYS = [\n${allowed.map(k => `  '${k}', // note 'not-a-key'`).join('\n')}\n];`, { status: 200 });
  }
  // state.teamToken set: the team passcode is enforced, as on the real service.
  const isTeam = !state.teamToken || headers['x-team-token'] === state.teamToken;
  if (/\/api\/tracker\?key=/.test(url)) {
    const key = new URL(url).searchParams.get('key');
    if (!known(key)) return reply(404, { ok: false, error: `Unknown tracker key: ${key}` });
    if (locked.has(key) && !isTeam) return reply(401, { ok: false, locked: true, error: 'This hub is locked. Open it from its live link.' });
    if (method === 'POST') {
      if (isInputsKey(key) && !(state.teamToken && isTeam)) return reply(401, { ok: false, error: 'Team passcode required' });
      if (state.failWrites) return reply(500, { ok: false, error: 'mock: write failed' });
      data.set(key, body.data);
      return reply(200, { ok: true });
    }
    const saved = data.has(key) ? data.get(key) : isInputsKey(key) ? null : { savedFor: key };
    return reply(200, { ok: true, data: saved, value: saved == null ? null : JSON.stringify(saved) });
  }
  if (url.includes('/api/notion')) {
    if (!isTeam) return reply(401, { ok: false, error: 'Team passcode required' });
    const q = new URL(url).searchParams;
    if (q.get('kind') === 'projects') return reply(200, { ok: true, count: 1, projects: [{ name: 'Acme', hours: 40 }] });
    return reply(200, { ok: true, since: q.get('since') || 'default', count: 1, tasks: [{ title: 'Done thing' }] });
  }
  if (url.includes('/api/tracker-lock') && !isTeam) return reply(401, { ok: false, error: 'Team passcode required' });
  if (url.includes('/api/tracker-lock')) {
    const key = new URL(url).searchParams.get('key') || (body && body.key);
    if (method === 'GET' && !key) return reply(200, { ok: true, locks: [...locked].map(k => ({ key: k, locked: true })) });
    if (!known(key)) return reply(404, { ok: false, error: 'Unknown tracker key' });
    if (method === 'GET') return reply(200, locked.has(key) ? { ok: true, key, locked: true, setAt: 't0', label: labels.get(key) } : { ok: true, key, locked: false });
    if (method === 'POST') {
      const replaced = locked.has(key);
      locked.add(key, body.label);
      const out = { ok: true, key, locked: true, setAt: 't1', replaced };
      if (!body.token) out.token = `generated-token-${++n}`;
      return reply(200, out);
    }
  }
  if (url.includes('/access/apps')) {
    if (method === 'GET') return reply(200, { success: true, result: apps });
    const app = { id: `app-${++n}`, aud: `aud-${body.name}`, ...body };
    if (method === 'POST') apps.push(app);
    return reply(200, { success: true, result: app });
  }
  if (url.includes('/pages/projects/')) {
    if (method === 'GET') {
      return reply(200, { success: true, result: { deployment_configs: { production: { env_vars: Object.fromEntries([...pagesVars].map(k => [k, { type: 'secret_text' }])) } } } });
    }
    return reply(200, { success: true, result: { id: `dep-${++n}` } });
  }
  return reply(500, { ok: false, error: `mock: unexpected ${method} ${url}` });
};
