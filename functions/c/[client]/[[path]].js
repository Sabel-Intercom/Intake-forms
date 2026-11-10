// GET /c/<client>/<shared form or its assets>   (Cloudflare Pages Function, 10 Nov 2026)
//
// The readiness check, the migration intake and the kick-off form are ONE page
// each, shared by every client (?client=<slug> picks the saved answers). A
// path can belong to only one Cloudflare Access application, so the shared
// page itself stays staff only. This gives every client their own address for
// the same pages:
//
//   /c/cookaborough/SabelReadinessCheck?client=cookaborough
//
// The client's Access application (scripts/onboard-hub.mjs) covers
// /c/<slug>/*, so only that client's people, and Sabel, reach it.
//
// Two gates, as for hub-token:
//   1. Access admits only that application's policy to this path.
//   2. The Access JWT is verified here and its audience must be THIS client's
//      application (HUB_AUD_<CLIENT>). A sign-in to another hub, or to the
//      staff application, is refused.
//
// Only the files below are served, plus the client's own form pages named in
// HUB_PAGES_<CLIENT>. Everything else under /c/ is a 404, so this is never a
// side door to another client's hub or form, or to an internal page.
//
// The saved answers are protected separately: each form key is locked with the
// client's token (sabel-webhook /api/tracker), which the page gets from
// /api/hub-token/<client> through hub-auth.js. Changing ?client= in the
// address to another client's name reads nothing: the token does not fit.

import { json, signedIn, audiences } from '../../_lib/access-jwt.js';

const SLUG = /^[a-z0-9-]{1,40}$/;
export const SHARED_FORMS = ['SabelReadinessCheck', 'SabelMigrationIntake', 'SabelKickoff'];
const ASSET = /^(hub-auth\.js|assets\/[A-Za-z0-9_.\/-]{1,120})$/;

const PAGE = /^[A-Za-z0-9_]{1,80}$/;

// The client's OWN form pages (e.g. SabelMigrationIntake_Smokeball), from the
// Pages variable HUB_PAGES_<CLIENT>, a comma list set by onboard-hub. They are
// listed per client because such a page carries that client's details: one
// client must never be able to open another's through their own /c/ address.
export function ownPages(value) {
  return String(value || '').split(',').map(s => s.trim().replace(/\.html$/, '')).filter(s => PAGE.test(s));
}

// What to fetch from the static site for a requested sub-path, or null.
export function assetFor(sub, own = []) {
  if (sub.includes('..') || sub.includes('//')) return null;
  const page = sub.replace(/\.html$/, '');
  if (SHARED_FORMS.includes(page) || own.includes(page)) return '/' + page; // Pages serves pages without .html
  if (ASSET.test(sub)) return '/' + sub;
  return null;
}

export async function onRequestGet({ request, env, params }) {
  const client = String(params.client || '');
  if (!SLUG.test(client)) return json(404, { ok: false, error: 'Not found' });
  const envKey = client.toUpperCase().replace(/-/g, '_');
  const sub = (Array.isArray(params.path) ? params.path : [params.path || '']).join('/');
  const target = assetFor(sub, ownPages(env[`HUB_PAGES_${envKey}`]));
  if (!target) return json(404, { ok: false, error: 'Not found' });

  const { claims, response } = await signedIn(request, env);
  if (response) return response;
  const aud = env[`HUB_AUD_${envKey}`];
  if (!aud) return json(404, { ok: false, error: 'Not found' });
  if (!audiences(claims).includes(aud)) return json(403, { ok: false, error: 'Not signed in to this hub' });

  const url = new URL(request.url);
  const res = await env.ASSETS.fetch(new Request(new URL(target + url.search, url.origin), { method: 'GET', headers: request.headers }));
  // Never let a redirect from the static site walk the visitor out of /c/<client>/.
  if ([301, 302, 303, 307, 308].includes(res.status)) return json(404, { ok: false, error: 'Not found' });
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'private, no-store');
  return out;
}
