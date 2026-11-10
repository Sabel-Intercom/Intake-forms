// Shared by the Pages Functions under functions/api: verify a Cloudflare
// Access sign-in (Cf-Access-Jwt-Assertion). No route is generated for this
// file because it exports no onRequest handler.

const TEAM = /^[a-z0-9-]{1,63}$/;
export const DEFAULT_TEAM_DOMAINS = 'sabel,delicate-sea-8e24'; // current name, original name
const certCache = new Map(); // teamDomain -> { at, keys }

export function json(status, body) {
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
  const c = certCache.get(teamDomain);
  if (c && now - c.at < 10 * 60 * 1000) return c.keys;
  const r = await fetch(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`, { cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error(`certs fetch ${r.status}`);
  const j = await r.json();
  const keys = j.keys || [];
  certCache.set(teamDomain, { at: now, keys });
  return keys;
}

export function teamDomainsFrom(env) {
  return String((env && env.ACCESS_TEAM_DOMAINS) || DEFAULT_TEAM_DOMAINS)
    .split(',').map(s => s.trim()).filter(s => TEAM.test(s));
}

// Verify a Cloudflare Access JWT. Returns the payload, or null. The issuer
// must be one of our team domains (a renamed team keeps answering on its
// original name), and the signature is checked against THAT issuer's certs.
export async function verifyAccessJwt(jwt, teamDomains) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = decodeJson(parts[0]); payload = decodeJson(parts[1]); } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const m = /^https:\/\/([a-z0-9-]{1,63})\.cloudflareaccess\.com$/.exec(String(payload.iss || ''));
  if (!m || !teamDomains.includes(m[1])) return null;
  const keys = await teamKeys(m[1]);
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
  return payload;
}

// Read and verify the sign-in on a request. Returns { claims } or { response }
// (the refusal to send back).
export async function signedIn(request, env) {
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) return { response: json(401, { ok: false, error: 'Sign in required' }) };
  let claims;
  try { claims = await verifyAccessJwt(jwt, teamDomainsFrom(env)); }
  catch (e) { return { response: json(503, { ok: false, error: 'Could not verify sign-in' }) }; }
  if (!claims) return { response: json(401, { ok: false, error: 'Sign in required' }) };
  return { claims };
}

export function audiences(claims) {
  return Array.isArray(claims.aud) ? claims.aud : [claims.aud];
}
