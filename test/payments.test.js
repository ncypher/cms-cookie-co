// Stage 2: ways to pay are data Shaun switches on/off; the public site shows only what's on.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import worker from "../src/worker.js";
import { fakeD1, fakeR2 } from "./helpers/fakes.js";

const ORIGIN = "http://localhost:8787";
const env = (extra = {}) => ({ DB: fakeD1(), MEDIA: fakeR2(), ACCESS_DEV_BYPASS: "true", ...extra });
const admin = async (e, method, p, body, headers = {}) => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/admin/${p}`, {
    method, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  return { status: res.status, body: await res.json() };
};
const content = async (e) => (await worker.fetch(new Request(`${ORIGIN}/api/content`), e)).json();

test("migration seeds what the site showed before: Venmo @CmsCookieCo on, cash at pickup on, Cash App off, card coming soon", async () => {
  const e = env();
  const { body } = await admin(e, "GET", "payments");
  assert.deepEqual(body.payments.map((p) => [p.id, p.enabled, p.handle, p.coming_soon]), [
    ["venmo", true, "CmsCookieCo", false], ["cashapp", false, null, false], ["cash", true, null, false], ["card", false, null, true],
  ]);
  assert.deepEqual((await content(e)).payments, [{ id: "venmo", handle: "CmsCookieCo" }, { id: "cash", handle: null }]);
});

test("Venmo name: @ and $ are dropped; letters, digits, - and _ only; 30 at most (checked on the server)", async () => {
  const e = env();
  const ok = await admin(e, "PUT", "payments/venmo", { handle: " @Shaun-Marie_2 " });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.payment.handle, "Shaun-Marie_2");
  assert.equal(ok.body.payment.updated_by, "dev@localhost");
  for (const bad of ["Shaun Marie", "<script>", "a.b", "x/../y", "shaun?x=1", "é", "x".repeat(31), 42]) {
    const r = await admin(e, "PUT", "payments/venmo", { handle: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await content(e)).payments[0].handle, "Shaun-Marie_2", "bad names never saved");
});

test("Cash App can't be switched on without a cashtag; with one it shows on the site", async () => {
  const e = env();
  const r = await admin(e, "PUT", "payments/cashapp", { enabled: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Type your Cash App name first/);
  assert.equal((await admin(e, "PUT", "payments/cashapp", { enabled: true, handle: "$CmsCookieCo" })).status, 200);
  assert.deepEqual((await content(e)).payments.map((p) => [p.id, p.handle]), [["venmo", "CmsCookieCo"], ["cashapp", "CmsCookieCo"], ["cash", null]]);
});

test("switching things off hides them from the site; the card placeholder never shows and can't be switched on", async () => {
  const e = env();
  await admin(e, "PUT", "payments/venmo", { enabled: false });
  await admin(e, "PUT", "payments/cash", { enabled: false });
  assert.deepEqual((await content(e)).payments, []);
  const card = await admin(e, "PUT", "payments/card", { enabled: true });
  assert.equal(card.status, 400);
  assert.match(card.body.error, /coming soon/);
  e.DB.raw.exec("UPDATE payment_methods SET enabled = 1 WHERE id = 'card'"); // even if forced on in the DB
  assert.ok(!(await content(e)).payments.some((p) => p.id === "card"));
  assert.equal((await admin(e, "PUT", "payments/paypal", { enabled: true })).status, 404);
});

test("payments admin API needs the admin sign-in and same-origin writes", async () => {
  const locked = { DB: fakeD1(), MEDIA: fakeR2() }; // no dev bypass, Access not configured -> fails closed
  assert.notEqual((await admin(locked, "GET", "payments")).status, 200);
  assert.notEqual((await admin(locked, "PUT", "payments/venmo", { handle: "Evil" })).status, 200);
  const e = env();
  const x = await admin(e, "PUT", "payments/venmo", { handle: "Evil" }, { "Sec-Fetch-Site": "cross-site" });
  assert.equal(x.status, 403);
  assert.equal((await content(e)).payments[0].handle, "CmsCookieCo");
});

const html = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "index.html"), "utf8");
test("public site: pay buttons and contact panel come from the switched-on list; Venmo link format unchanged", () => {
  assert.match(html, /let PAYMENTS = \[\{id:"venmo", handle:CONFIG\.venmo\}, \{id:"cash"\}\];/, "same as before while loading / offline");
  assert.match(html, /https:\/\/venmo\.com\/\$\{encodeURIComponent\(v\.handle\)\}\?txn=pay&amount=\$\{amount\}&note=\$\{encodeURIComponent\(note\)\}/);
  assert.match(html, /payButtons\(o\.total, "CMS Cookie Co\. order " \+ o\.id\)/);
  assert.match(html, /import\("\/assets\/qr\.js"\)/, "QR is generated from the stored name, vendored (no CDN)");
  assert.doesNotMatch(html, /cdn|unpkg|jsdelivr/i);
  assert.match(html, /if \(Array\.isArray\(c\.payments\)\)\{ PAYMENTS = c\.payments; renderPayContact\(\); \}/);
});

test("admin: a Payments tab with Venmo, Cash App, Cash at pickup and a greyed card row", () => {
  const a = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "admin", "index.html"), "utf8");
  assert.match(a, /<button data-tab="payments">/);
  assert.match(a, /payments: renderPayments/);
  assert.match(a, /card pay soon/);
});
