// GET /api/hub-token/<client>   (Cloudflare Pages Function, 8 Nov 2026)
//
// Hands a signed-in person the client token for that client's tracker keys,
// so the hub page can send it as X-Client-Token to sabel-webhook /api/tracker.
// The token never lives in this repo: it is a Pages environment variable,
// HUB_TOKEN_<CLIENT> (client slug upper-cased, dashes to underscores).
//
// Two gates, both required:
//   1. This path must be a destination of the client's Cloudflare Access
//      application, so only people that app's policy admits ever reach it.
//   2. The request's Cf-Access-Jwt-Assertion is verified here against the
//      team's public keys (signature, issuer, expiry), so a forged header on
//      an unprotected path is still refused, and its audience must be this
//      client's Access application (HUB_AUD_<CLIENT>), so a sign-in to some
//      other Sabel hub never unlocks this one. Both env vars are required.
//
// Env (Pages > Settings > Variables and Secrets, Production):
//   HUB_TOKEN_COOKABOROUGH   secret    the client token from /api/tracker-lock
//   HUB_AUD_COOKABOROUGH     required  the Access app's Application Audience (AUD) tag
//   ACCESS_TEAM_DOMAINS      optional  comma list of accepted team names, default
//                                      "sabel,delicate-sea-8e24" (<name>.cloudflareaccess.com)

import { json, signedIn, audiences } from '../../_lib/access-jwt.js';

const SLUG = /^[a-z0-9-]{1,40}$/;

export async function onRequestGet({ request, env, params }) {
  const client = String(params.client || '').toLowerCase();
  if (!SLUG.test(client)) return json(404, { ok: false, error: 'Unknown client' });
  const envKey = client.toUpperCase().replace(/-/g, '_');

  const { claims, response } = await signedIn(request, env);
  if (response) return response;

  // The JWT must have been issued for THIS client's Access application. Without
  // this, a person signed in to any other Sabel hub could fetch this token if
  // the path were ever left out of the app's destinations. Fail closed: no
  // audience configured = no token.
  const token = env[`HUB_TOKEN_${envKey}`];
  const aud = env[`HUB_AUD_${envKey}`];
  if (!token || !aud) {
    // Setup aid: the AUD tag is hard to find in the dashboard, so until
    // HUB_AUD_<CLIENT> is set, show the audience this (verified) sign-in
    // carries. It is the app's public identifier, not a secret.
    return json(404, {
      ok: false,
      error: `Hub token or audience not configured for ${client}`,
      missing: [!token && `HUB_TOKEN_${envKey}`, !aud && `HUB_AUD_${envKey}`].filter(Boolean),
      seenAud: claims.aud,
      seenIss: claims.iss,
    });
  }
  if (!audiences(claims).includes(aud)) return json(403, { ok: false, error: 'Not signed in to this hub' });
  return json(200, { ok: true, token, email: claims.email || null });
}
