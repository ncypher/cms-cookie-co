// Run: npm test   (node --test, no Cloudflare account needed)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt, _resetCertsCacheForTests } from "../src/access.js";
import worker from "../src/worker.js";

const TEAM = "cmscookie.cloudflareaccess.com";
const AUD = "test-aud-1234";

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" } };
}
async function sign(key, payload, header = {}) {
  const h = enc({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = enc(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
const goodClaims = (extra = {}) => ({ aud: [AUD], iss: `https://${TEAM}`, email: "cmscookieco3more@gmail.com", sub: "u1", iat: now(), nbf: now(), exp: now() + 3600, ...extra });

let key, otherKey, certFetches;
const fetchImpl = async (url) => {
  certFetches++;
  assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [key.jwk] }), { headers: { "Content-Type": "application/json" } });
};

beforeEach(async () => {
  _resetCertsCacheForTests();
  certFetches = 0;
  key ??= await makeKey("k1");
  otherKey ??= await makeKey("k1"); // same kid, different key: simulates a forged token
});

const opts = () => ({ teamDomain: TEAM, aud: AUD, fetchImpl });

test("accepts a valid Access token", async () => {
  const p = await verifyAccessJwt(await sign(key, goodClaims()), opts());
  assert.equal(p.email, "cmscookieco3more@gmail.com");
});

test("caches signing keys between requests", async () => {
  await verifyAccessJwt(await sign(key, goodClaims()), opts());
  await verifyAccessJwt(await sign(key, goodClaims()), opts());
  assert.equal(certFetches, 1);
});

test("rejects a token signed by a different key", async () => {
  await assert.rejects(verifyAccessJwt(await sign(otherKey, goodClaims()), opts()), /signature is invalid/);
});

test("rejects wrong audience, wrong issuer, expired, not-yet-valid", async () => {
  await assert.rejects(verifyAccessJwt(await sign(key, goodClaims({ aud: ["someone-else"] })), opts()), /audience/);
  await assert.rejects(verifyAccessJwt(await sign(key, goodClaims({ iss: "https://evil.cloudflareaccess.com" })), opts()), /issuer/);
  await assert.rejects(verifyAccessJwt(await sign(key, goodClaims({ exp: now() - 3600 })), opts()), /expired/);
  await assert.rejects(verifyAccessJwt(await sign(key, goodClaims({ nbf: now() + 3600 })), opts()), /not yet valid/);
});

test("rejects tampered payload, alg=none, unknown kid, garbage, missing", async () => {
  const t = await sign(key, goodClaims());
  const [h, , s] = t.split(".");
  await assert.rejects(verifyAccessJwt(`${h}.${enc(goodClaims({ email: "attacker@x.com" }))}.${s}`, opts()), /signature/);
  await assert.rejects(verifyAccessJwt(`${enc({ alg: "none", kid: "k1" })}.${enc(goodClaims())}.`, opts()), /algorithm/);
  await assert.rejects(verifyAccessJwt(await sign(key, goodClaims(), { kid: "nope" }), opts()), /unknown key/);
  await assert.rejects(verifyAccessJwt("not.a.jwt", opts()), /Malformed/);
  await assert.rejects(verifyAccessJwt(null, opts()), /Missing/);
});

test("fails closed when Access is not configured", async () => {
  await assert.rejects(verifyAccessJwt(await sign(key, goodClaims()), { ...opts(), aud: "" }), /not configured/);
});

/* ---- Through the Worker's fetch handler ---- */
const env = (extra = {}) => ({
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: "",
  ASSETS: { fetch: async () => new Response("<h1>admin</h1>", { headers: { "Content-Type": "text/html" } }) },
  ...extra,
});
const withFetch = async (fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

test("worker: /admin without a token is refused even though the route exists", async () => {
  const res = await worker.fetch(new Request("https://cmscookieco3more.com/admin/"), env());
  assert.equal(res.status, 401);
  const api = await worker.fetch(new Request("https://cmscookieco3more.com/api/admin/me"), env());
  assert.equal(api.status, 401);
});

test("worker: valid token gets through; ADMIN_EMAILS narrows it further", async () => {
  await withFetch(async () => {
    const token = await sign(key, goodClaims());
    const req = () => new Request("https://cmscookieco3more.com/api/admin/me", { headers: { "Cf-Access-Jwt-Assertion": token } });
    const ok = await worker.fetch(req(), env());
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).email, "cmscookieco3more@gmail.com");
    const page = await worker.fetch(new Request("https://cmscookieco3more.com/admin/", { headers: { "Cf-Access-Jwt-Assertion": token } }), env());
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("Cache-Control"), "no-store");
    const narrowed = await worker.fetch(req(), env({ ADMIN_EMAILS: "someone@else.com" }));
    assert.equal(narrowed.status, 403);
  });
});

test("worker: ACCESS_DEV_BYPASS is ignored on a real hostname", async () => {
  const res = await worker.fetch(new Request("https://cmscookieco3more.com/api/admin/me"), env({ ACCESS_DEV_BYPASS: "true" }));
  assert.equal(res.status, 401);
  const local = await worker.fetch(new Request("http://localhost:8787/api/admin/me"), env({ ACCESS_DEV_BYPASS: "true" }));
  assert.equal(local.status, 200);
});

test("worker: unconfigured Access fails closed with 503", async () => {
  const res = await worker.fetch(new Request("https://cmscookieco3more.com/admin/"), env({ ACCESS_AUD: "" }));
  assert.equal(res.status, 503);
});

test("worker: www redirects to the apex domain", async () => {
  const res = await worker.fetch(new Request("https://www.cmscookieco3more.com/concepts/modern/?a=1"), env());
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("Location"), "https://cmscookieco3more.com/concepts/modern/?a=1");
});
