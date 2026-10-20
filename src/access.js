// Cloudflare Access JWT verification.
// Access puts a signed JWT in the Cf-Access-Jwt-Assertion header of every request it lets through.
// We verify it here instead of trusting that the route is behind Access: wrong signature, wrong
// audience, wrong issuer, or an expired token all fail closed.

const CERTS_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_S = 60;
let certsCache = { url: "", keys: null, fetchedAt: 0 };

export class AccessError extends Error {
  constructor(message, status = 403) { super(message); this.status = status; }
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

function normalizeTeamDomain(team) {
  return String(team || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function getSigningKeys(teamDomain, fetchImpl, forceRefresh = false) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const fresh = certsCache.url === url && certsCache.keys && Date.now() - certsCache.fetchedAt < CERTS_TTL_MS;
  if (fresh && !forceRefresh) return certsCache.keys;
  const res = await fetchImpl(url);
  if (!res.ok) throw new AccessError(`Could not load Access signing keys (${res.status})`, 503);
  const body = await res.json();
  if (!Array.isArray(body.keys)) throw new AccessError("Access signing keys response is malformed", 503);
  certsCache = { url, keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

/**
 * Verify an Access JWT. Returns the payload ({ email, sub, ... }) or throws AccessError.
 * @param {string} token value of Cf-Access-Jwt-Assertion
 * @param {{teamDomain: string, aud: string, fetchImpl?: typeof fetch, now?: number}} opts
 */
export async function verifyAccessJwt(token, { teamDomain, aud, fetchImpl = fetch, now = Date.now() }) {
  const team = normalizeTeamDomain(teamDomain);
  if (!team || !aud) throw new AccessError("Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)", 503);
  if (!token) throw new AccessError("Missing Cf-Access-Jwt-Assertion", 401);

  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("Malformed Access token", 401);
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); }
  catch { throw new AccessError("Malformed Access token", 401); }
  if (header.alg !== "RS256" || !header.kid) throw new AccessError("Unexpected Access token algorithm", 401);

  let keys = await getSigningKeys(team, fetchImpl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { // keys rotate; refetch once before giving up
    keys = await getSigningKeys(team, fetchImpl, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new AccessError("Access token signed with an unknown key", 401);

  const key = await crypto.subtle.importKey(
    "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) throw new AccessError("Access token signature is invalid", 401);

  const nowS = Math.floor(now / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new AccessError("Access token audience mismatch", 403);
  if (payload.iss !== `https://${team}`) throw new AccessError("Access token issuer mismatch", 403);
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < nowS) throw new AccessError("Access token expired", 401);
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > nowS) throw new AccessError("Access token not yet valid", 401);
  return payload;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Gate for /admin and /api/admin/*. Returns { email } or throws AccessError.
 * ACCESS_DEV_BYPASS only works on localhost (wrangler dev); a deployed Worker never sees those hosts.
 */
export async function requireAdmin(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (env.ACCESS_DEV_BYPASS === "true" && LOCAL_HOSTS.has(url.hostname)) {
    return { email: "dev@localhost", dev: true };
  }
  const payload = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), {
    teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, fetchImpl,
  });
  const email = String(payload.email || "").toLowerCase();
  const allow = String(env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(email)) throw new AccessError("This account is not on the admin list", 403);
  return { email: email || payload.sub || "unknown" };
}

export function _resetCertsCacheForTests() { certsCache = { url: "", keys: null, fetchedAt: 0 }; }
