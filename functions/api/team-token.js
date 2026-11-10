// GET /api/team-token   (Cloudflare Pages Function, 10 Nov 2026)
//
// Hands a signed-in SABEL teammate the team passcode, so internal pages can
// send it as X-Team-Token to sabel-webhook /api/tracker and read locked keys
// without anyone typing a passcode. hub-auth.js (data-team) calls this.
//
// Three gates, all required:
//   1. The whole hubs domain sits behind the staff-only Access application
//      (scripts/lock-down.mjs creates it), so only Sabel sign-ins reach here.
//   2. The Access JWT is verified here (signature, issuer, expiry) and its
//      audience must be that staff-only application (TEAM_AUD). A client
//      signed in to their own hub carries a different audience: refused.
//   3. The signed-in email must end in the Sabel domain. Belt and braces in
//      case the staff app's policy is ever widened by mistake.
//
// Env (Pages > Settings > Variables and Secrets, Production):
//   TEAM_TOKEN           secret    same value as KICKOFF_TEAM_TOKEN in Vercel
//   TEAM_AUD             required  the staff-only Access app's AUD tag
//   TEAM_EMAIL_DOMAIN    optional  default sabelcustomersuccess.com
//   ACCESS_TEAM_DOMAINS  optional  see hub-token/[client].js

import { json, signedIn, audiences } from '../_lib/access-jwt.js';

export async function onRequestGet({ request, env }) {
  const { claims, response } = await signedIn(request, env);
  if (response) return response;

  const token = env.TEAM_TOKEN;
  const aud = env.TEAM_AUD;
  if (!token || !aud) {
    // Fail closed. Names only: unlike the client function this does not echo
    // the audience, because any signed-in client could reach this path.
    return json(404, {
      ok: false,
      error: 'Team token or audience not configured',
      missing: [!token && 'TEAM_TOKEN', !aud && 'TEAM_AUD'].filter(Boolean),
    });
  }
  if (!audiences(claims).includes(aud)) return json(403, { ok: false, error: 'Not a team sign-in' });

  const domain = String(env.TEAM_EMAIL_DOMAIN || 'sabelcustomersuccess.com').toLowerCase();
  const email = String(claims.email || '').toLowerCase();
  if (!email.endsWith('@' + domain)) return json(403, { ok: false, error: 'Not a team sign-in' });

  return json(200, { ok: true, token, email });
}
