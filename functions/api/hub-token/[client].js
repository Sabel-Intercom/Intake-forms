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
//   ACCESS_TEAM_DOMAIN       optional  default "sabel" (sabel.cloudflareaccess.com)

const SLUG = /^[a-z0-9-]{1,40}$/;
let certCache = { at: 0, keys: null };

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(b64url) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(b64url)));
}

async function teamKeys(teamDomain) {
  const now = Date.now();
  if (certCache.keys && now - certCache.at < 10 * 60 * 1000) return certCache.keys;
  const r = await fetch(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`, { cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error(`certs fetch ${r.status}`);
  const j = await r.json();
  certCache = { at: now, keys: j.keys || [] };
  return certCache.keys;
}

// Verify a Cloudflare Access JWT. Returns the payload, or null.
async function verifyAccessJwt(jwt, teamDomain) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = decodeJson(parts[0]); payload = decodeJson(parts[1]); } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const keys = await teamKeys(teamDomain);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]),
  );
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
  if (payload.iss !== `https://${teamDomain}.cloudflareaccess.com`) return null;
  return payload;
}

export async function onRequestGet({ request, env, params }) {
  const client = String(params.client || '').toLowerCase();
  if (!SLUG.test(client)) return json(404, { ok: false, error: 'Unknown client' });
  const envKey = client.toUpperCase().replace(/-/g, '_');

  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) return json(401, { ok: false, error: 'Sign in required' });

  const teamDomain = env.ACCESS_TEAM_DOMAIN || 'sabel';
  let claims;
  try { claims = await verifyAccessJwt(jwt, teamDomain); } catch (e) { return json(503, { ok: false, error: 'Could not verify sign-in' }); }
  if (!claims) return json(401, { ok: false, error: 'Sign in required' });

  // The JWT must have been issued for THIS client's Access application. Without
  // this, a person signed in to any other Sabel hub could fetch this token if
  // the path were ever left out of the app's destinations. Fail closed: no
  // audience configured = no token.
  const token = env[`HUB_TOKEN_${envKey}`];
  const aud = env[`HUB_AUD_${envKey}`];
  if (!token || !aud) return json(404, { ok: false, error: `Hub token or audience not configured for ${client}` });
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return json(403, { ok: false, error: 'Not signed in to this hub' });
  return json(200, { ok: true, token, email: claims.email || null });
}
