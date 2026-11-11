// GET /api/hub-file/<Page>.html   (Cloudflare Pages Function, 11 Nov 2026)
//
// Hands a signed-in SABEL teammate the source of a page on this site, so the
// internal pages (Task Hub, Portfolio Dashboard, Internal Ops) can read a
// client's tracker file.
//
// Why it exists: once a client's hub is published, its address
// /<Hub>.html belongs to that client's own Access application. A teammate
// signed in to the staff application is not signed in to that one, so a
// plain request for the file from an internal page is sent to a sign-in
// screen and fails. This path stays under the staff application.
//
// Same three gates as /api/team-token: behind the staff-only application,
// JWT verified with the staff audience (TEAM_AUD), Sabel email. A client
// signed in to their own hub carries a different audience: refused.
//
// Env: TEAM_AUD required; TEAM_EMAIL_DOMAIN, ACCESS_TEAM_DOMAINS optional
// (see team-token.js).

import { json, signedIn, audiences } from '../../_lib/access-jwt.js';

// One page in the site root. No folders, no dots but the extension.
const PAGE = /^[A-Za-z0-9_]{1,80}\.html$/;

export async function onRequestGet({ request, env, params }) {
  const { claims, response } = await signedIn(request, env);
  if (response) return response;

  const aud = env.TEAM_AUD;
  if (!aud) return json(404, { ok: false, error: 'Team audience not configured', missing: ['TEAM_AUD'] });
  if (!audiences(claims).includes(aud)) return json(403, { ok: false, error: 'Not a team sign-in' });
  const domain = String(env.TEAM_EMAIL_DOMAIN || 'sabelcustomersuccess.com').toLowerCase();
  if (!String(claims.email || '').toLowerCase().endsWith('@' + domain)) return json(403, { ok: false, error: 'Not a team sign-in' });

  const name = String(params.name || '');
  if (!PAGE.test(name)) return json(404, { ok: false, error: 'Not found' });

  // Pages serves pages without .html. Asked from the static site directly,
  // which sits behind this function, not behind Access.
  const url = new URL(request.url);
  const res = await env.ASSETS.fetch(new Request(new URL('/' + name.replace(/\.html$/, ''), url.origin), { method: 'GET' }));
  if (res.status !== 200) return json(404, { ok: false, error: 'Not found' });
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'private, no-store');
  return out;
}
