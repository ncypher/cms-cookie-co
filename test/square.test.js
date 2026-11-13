// Square card payments: dark until configured, Connect Square (OAuth state), encrypted tokens,
// refresh/revoke, payment links priced by the server, webhook signatures, paid exactly once,
// and no secret in any response or log. Square itself is a fake: no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import worker from "../src/worker.js";
import { encryptToken, decryptToken, verifySignature } from "../src/square.js";
import { fakeD1, fakeR2 } from "./helpers/fakes.js";

const ORIGIN = "http://localhost:8787";
const SECRETS = {
  SQUARE_APP_ID: "sandbox-sq0idb-TESTAPP",
  SQUARE_APP_SECRET: "sandbox-sq0csb-VERY-SECRET-123",
  SQUARE_TOKEN_ENC_KEY: crypto.randomBytes(32).toString("base64"),
  SQUARE_WEBHOOK_SIGNATURE_KEY: "whsig-TOPSECRET-456",
};
const HOOK_URL = `${ORIGIN}/api/square/webhook`;
const DAY = 864e5;

/* ---------- a fake Square ---------- */
function fakeSquare() {
  const sq = { calls: [], links: [], orders: new Map(), payments: new Map(), n: 0, tokens: new Set(), refreshDead: false, revokedNow: false, revokeCalls: 0 };
  const issue = () => { const t = `EAAA-ACCESS-${++sq.n}-${crypto.randomBytes(6).toString("hex")}`; sq.tokens.add(t); return t; };
  sq.refreshToken = "EAAA-REFRESH-" + crypto.randomBytes(6).toString("hex");
  const out = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  sq.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    const body = init.body ? JSON.parse(init.body) : null;
    const auth = new Headers(init.headers).get("Authorization") || "";
    sq.calls.push({ path: u.pathname, method: init.method || "GET", body });
    if (u.pathname === "/oauth2/token") {
      if (body.client_id !== SECRETS.SQUARE_APP_ID || body.client_secret !== SECRETS.SQUARE_APP_SECRET) return out(401, { message: "Not Authorized", type: "service.not_authorized" });
      if (body.grant_type === "authorization_code") {
        if (body.code !== "good-code") return out(401, { errors: [{ code: "UNAUTHORIZED" }] });
        return out(200, { access_token: issue(), token_type: "bearer", expires_at: new Date(Date.now() + 30 * DAY).toISOString(), merchant_id: "MERCH1", refresh_token: sq.refreshToken, short_lived: false });
      }
      if (body.grant_type === "refresh_token") {
        if (sq.refreshDead || body.refresh_token !== sq.refreshToken) return out(401, { errors: [{ code: "UNAUTHORIZED" }] });
        return out(200, { access_token: issue(), expires_at: new Date(Date.now() + 30 * DAY).toISOString(), merchant_id: "MERCH1", refresh_token: sq.refreshToken });
      }
    }
    if (u.pathname === "/oauth2/revoke") { sq.revokeCalls++; assert.equal(auth, "Client " + SECRETS.SQUARE_APP_SECRET); return out(200, { success: true }); }
    // Everything else needs a live seller token.
    if (sq.revokedNow) return out(401, { errors: [{ code: "ACCESS_TOKEN_REVOKED" }] });
    if (!sq.tokens.has(auth.replace(/^Bearer /, ""))) return out(401, { errors: [{ code: "ACCESS_TOKEN_EXPIRED" }] });
    if (u.pathname === "/v2/merchants/me") return out(200, { merchant: { id: "MERCH1", business_name: "Shaun's Test Kitchen", main_location_id: "LOC1" } });
    if (u.pathname === "/v2/locations") return out(200, { locations: [{ id: "LOC0", status: "INACTIVE", currency: "USD" }, { id: "LOC1", name: "South Lyon", status: "ACTIVE", currency: "USD", capabilities: ["CREDIT_CARD_PROCESSING"] }] });
    if (u.pathname === "/v2/online-checkout/payment-links" && init.method === "POST") {
      const id = "PL" + ++sq.n, order_id = "ORD" + sq.n;
      sq.links.push({ id, order_id, body });
      sq.orders.set(order_id, { id: order_id, state: "DRAFT", reference_id: body.order.reference_id, tenders: [] });
      return out(200, { payment_link: { id, order_id, url: `https://sandbox.square.link/u/${id}`, version: 1 } });
    }
    let m;
    if ((m = u.pathname.match(/^\/v2\/orders\/(.+)$/))) { const o = sq.orders.get(decodeURIComponent(m[1])); return o ? out(200, { order: o }) : out(404, { errors: [{ code: "NOT_FOUND" }] }); }
    if ((m = u.pathname.match(/^\/v2\/payments\/(.+)$/))) { const p = sq.payments.get(decodeURIComponent(m[1])); return p ? out(200, { payment: p }) : out(404, { errors: [{ code: "NOT_FOUND" }] }); }
    return out(404, { errors: [{ code: "NOT_FOUND" }] });
  };
  // A buyer pays on Square's page.
  sq.pay = (orderId, amount, status = "COMPLETED") => {
    const p = { id: "PAY" + ++sq.n, order_id: orderId, status, amount_money: { amount, currency: "USD" }, location_id: "LOC1" };
    sq.payments.set(p.id, p);
    sq.orders.get(orderId).tenders.push({ id: p.id, payment_id: p.id });
    sq.orders.get(orderId).state = status === "COMPLETED" ? "OPEN" : "DRAFT";
    return p;
  };
  return sq;
}

/* ---------- harness ---------- */
let SQ, LOG, BODIES;
const realFetch = globalThis.fetch;
beforeEach(() => { SQ = fakeSquare(); globalThis.fetch = SQ.fetch; LOG = []; BODIES = []; });
for (const k of ["log", "error", "warn", "info"]) { const orig = console[k]; console[k] = (...a) => { LOG?.push(a.map(String).join(" ")); if (k === "log") orig(...a); }; }
process.on("exit", () => { globalThis.fetch = realFetch; });

const env = (extra = {}) => ({ DB: fakeD1(), MEDIA: fakeR2(), ACCESS_DEV_BYPASS: "true", ...SECRETS, ...extra });
const darkEnv = () => ({ DB: fakeD1(), MEDIA: fakeR2(), ACCESS_DEV_BYPASS: "true" });
async function hit(e, method, p, body, headers = {}) {
  const res = await worker.fetch(new Request(ORIGIN + p, { method, redirect: "manual",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), e);
  const text = await res.text();
  BODIES.push(text, JSON.stringify([...res.headers]));
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
}
const admin = (e, m, p, b) => hit(e, m, "/api/admin/" + p, b);
const day = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const placeOrder = (e, ip = "192.0.2.10") => hit(e, "POST", "/api/orders", { name: "Pat Buyer", phone: "5555550100", date: day(5), items: [{ type: "gram", qty: 2 }] }, { "CF-Connecting-IP": ip });

async function connect(e) {
  const start = await admin(e, "POST", "square/connect");
  assert.equal(start.status, 200);
  const state = new URL(start.body.url).searchParams.get("state");
  const cb = await admin(e, "GET", `square/callback?code=good-code&state=${state}`);
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get("Location"), /square=connected/);
  return state;
}
async function connectAndSwitchOn(e) {
  await connect(e);
  const r = await admin(e, "PUT", "payments/card", { enabled: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
function signed(e, event, url = HOOK_URL, key = SECRETS.SQUARE_WEBHOOK_SIGNATURE_KEY) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha256", key).update(url + raw).digest("base64");
  return hit(e, "POST", "/api/square/webhook", raw, { "x-square-hmacsha256-signature": sig });
}
const paymentEvent = (p, eventId = "EVT-" + p.id, type = "payment.updated", merchant = "MERCH1") =>
  ({ merchant_id: merchant, type, event_id: eventId, created_at: new Date().toISOString(), data: { type: "payment", id: p.id, object: { payment: p } } });

/* ---------- dark mode ---------- */
test("dark: with no Square credentials the site, admin and APIs look exactly as today", async () => {
  const e = darkEnv(); let fetched = 0; globalThis.fetch = async () => { fetched++; throw new Error("no network"); };
  const pays = await admin(e, "GET", "payments");
  assert.deepEqual(pays.body.payments.find((p) => p.id === "card"), { id: "card", label: "Card (Square)", enabled: false, handle: null, coming_soon: true, updated_at: null, updated_by: null });
  assert.match((await admin(e, "PUT", "payments/card", { enabled: true })).body.error, /coming soon/);
  const content = (await hit(e, "GET", "/api/content")).body;
  assert.deepEqual(content.payments, [{ id: "venmo", handle: "CmsCookieCo" }, { id: "cash", handle: null }]);
  const order = await placeOrder(e);
  assert.equal(order.status, 201);
  assert.deepEqual(Object.keys(order.body).sort(), ["emailed", "id", "lines", "ok", "total"], "same order response as before (no pay token)");
  assert.deepEqual((await admin(e, "GET", "square")).body, { square: { configured: false } });
  for (const [m, p] of [["POST", "/api/pay"], ["GET", "/api/pay/status?ref=x&t=y"], ["POST", "/api/square/webhook"], ["POST", "/api/admin/square/connect"], ["GET", "/api/admin/square/callback?code=a&state=b"], ["POST", "/api/admin/square/links"]]) {
    assert.equal((await hit(e, m, p, m === "POST" ? {} : undefined)).status, 404, `${m} ${p} is 404 while dark`);
  }
  const waits = []; await worker.scheduled({}, e, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits);
  assert.equal(fetched, 0, "nothing calls Square while dark");
});

test("dark: production config sets no Square secret; admin and site only show card when the API says so", () => {
  const cfg = fs.readFileSync(path.join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
  assert.doesNotMatch(cfg, /SQUARE_(APP_ID|APP_SECRET|TOKEN_ENC_KEY|WEBHOOK_SIGNATURE_KEY|API_BASE)/, "no Square values in production vars");
  const site = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "index.html"), "utf8");
  assert.match(site, /payWay\("card"\)/, "the card button depends on the switched-on list from /api/content");
  const a = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "admin", "index.html"), "utf8");
  assert.match(a, /p\.coming_soon/, "admin keeps the greyed coming-soon row while unconfigured");
});

/* ---------- Connect Square ---------- */
test("connect: authorize URL has least scopes + a one-time state; callback checks it", async () => {
  const e = env();
  const start = await admin(e, "POST", "square/connect");
  const u = new URL(start.body.url);
  assert.equal(u.origin + u.pathname, "https://connect.squareupsandbox.com/oauth2/authorize");
  assert.equal(u.searchParams.get("client_id"), SECRETS.SQUARE_APP_ID);
  assert.deepEqual(u.searchParams.get("scope").split(" ").sort(), ["MERCHANT_PROFILE_READ", "ORDERS_READ", "ORDERS_WRITE", "PAYMENTS_READ", "PAYMENTS_WRITE"]);
  const state = u.searchParams.get("state");
  assert.match(state, /^[0-9a-f]{64}$/);

  const wrong = await admin(e, "GET", "square/callback?code=good-code&state=" + "0".repeat(64));
  assert.match(new URL(wrong.headers.get("Location")).searchParams.get("square_error"), /old or not from this page/);
  assert.equal(SQ.calls.filter((c) => c.path === "/oauth2/token").length, 0, "no code exchange without a valid state");
  const none = await admin(e, "GET", "square/callback?code=good-code");
  assert.match(none.headers.get("Location"), /square_error/);

  const ok = await admin(e, "GET", `square/callback?code=good-code&state=${state}`);
  assert.match(ok.headers.get("Location"), /\/admin\/\?square=connected&name=Shaun%27s\+Test\+Kitchen#payments$/);
  const st = (await admin(e, "GET", "square")).body.square;
  assert.equal(st.connected, true);
  assert.equal(st.business_name, "Shaun's Test Kitchen");
  assert.equal(st.location_name, "South Lyon", "the active main location, not the inactive one");
  assert.equal(st.enabled, false, "card stays off until she switches it on");

  const again = await admin(e, "GET", `square/callback?code=good-code&state=${state}`);
  assert.match(again.headers.get("Location"), /square_error/, "a state works once");
});

test("connect: an expired state, a Deny, or a cross-site start are refused", async () => {
  const e = env();
  const state = new URL((await admin(e, "POST", "square/connect")).body.url).searchParams.get("state");
  e.DB.raw.prepare("UPDATE square_oauth_states SET created_at = ?").run(new Date(Date.now() - 16 * 60000).toISOString());
  assert.match((await admin(e, "GET", `square/callback?code=good-code&state=${state}`)).headers.get("Location"), /square_error/);
  const s2 = new URL((await admin(e, "POST", "square/connect")).body.url).searchParams.get("state");
  const deny = await admin(e, "GET", `square/callback?error=access_denied&state=${s2}`);
  assert.match(decodeURIComponent(deny.headers.get("Location").replace(/\+/g, " ")), /you tapped Deny/);
  const x = await hit(e, "POST", "/api/admin/square/connect", {}, { "Sec-Fetch-Site": "cross-site" });
  assert.equal(x.status, 403);
  const locked = { ...env(), ACCESS_DEV_BYPASS: undefined };
  assert.notEqual((await admin(locked, "GET", `square/callback?code=good-code&state=${s2}`)).status, 302, "callback needs the admin sign-in");
});

test("card can't be switched on before Square is connected", async () => {
  const e = env();
  const r = await admin(e, "PUT", "payments/card", { enabled: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Connect Square first/);
  assert.equal((await admin(e, "GET", "payments")).body.payments.find((p) => p.id === "card").coming_soon, false);
});

/* ---------- tokens ---------- */
test("tokens: AES-GCM round trip; stored encrypted; wrong key or tampering fails", async () => {
  const e = env();
  const enc = await encryptToken(e, "EAAA-plain-token");
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes("EAAA-plain-token"));
  assert.notEqual(enc, await encryptToken(e, "EAAA-plain-token"), "fresh IV every time");
  assert.equal(await decryptToken(e, enc), "EAAA-plain-token");
  await assert.rejects(decryptToken({ ...e, SQUARE_TOKEN_ENC_KEY: crypto.randomBytes(32).toString("base64") }, enc));
  const [v, iv, ct] = enc.split(":"); const b = Buffer.from(ct, "base64"); b[0] ^= 1;
  await assert.rejects(decryptToken(e, [v, iv, b.toString("base64")].join(":")));
  await assert.rejects(encryptToken({ ...e, SQUARE_TOKEN_ENC_KEY: "too-short" }, "x"));

  await connect(e);
  const row = e.DB.raw.prepare("SELECT * FROM square_connection").get();
  const dump = JSON.stringify(row);
  for (const t of [...SQ.tokens, SQ.refreshToken]) assert.ok(!dump.includes(t), "no plain token in D1");
  assert.equal(await decryptToken(e, row.access_token_enc), [...SQ.tokens][0]);
  assert.equal(await decryptToken(e, row.refresh_token_enc), SQ.refreshToken);
});

test("refresh: the daily job renews a token that's 6+ days old, and leaves a fresh one alone", async () => {
  const e = env();
  await connect(e);
  const run = async () => { const w = []; await worker.scheduled({}, e, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };
  await run();
  assert.equal(SQ.calls.filter((c) => c.body?.grant_type === "refresh_token").length, 0, "fresh token: no refresh");
  const before = e.DB.raw.prepare("SELECT access_token_enc FROM square_connection").get().access_token_enc;
  e.DB.raw.prepare("UPDATE square_connection SET refreshed_at = ?").run(new Date(Date.now() - 6.5 * DAY).toISOString());
  await run();
  assert.equal(SQ.calls.filter((c) => c.body?.grant_type === "refresh_token").length, 1);
  const after = e.DB.raw.prepare("SELECT * FROM square_connection").get();
  assert.notEqual(after.access_token_enc, before);
  assert.ok(Date.now() - Date.parse(after.refreshed_at) < 60000);
  assert.equal(after.status, "connected");
});

test("refresh also runs in the background on page loads (works without a cron); never while dark", async () => {
  const e = env();
  await connect(e);
  e.DB.raw.prepare("UPDATE square_connection SET refreshed_at = ?").run(new Date(Date.now() - 7 * DAY).toISOString());
  const waits = [];
  await worker.fetch(new Request(ORIGIN + "/api/content"), e, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(SQ.calls.filter((c) => c.body?.grant_type === "refresh_token").length, 1);
  const dark = darkEnv(), w2 = [];
  await worker.fetch(new Request(ORIGIN + "/api/content"), dark, { waitUntil: (p) => w2.push(p) });
  assert.equal(w2.length, 0, "nothing scheduled while dark");
});

test("refresh: an auth failure refreshes once and retries; Square refusing the refresh disconnects and switches card off", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  const o = await placeOrder(e);
  SQ.tokens.clear(); // access token expired at Square
  const r = await hit(e, "POST", "/api/pay", { ref: o.body.id, t: o.body.pay_token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /^https:\/\/sandbox\.square\.link\//);
  assert.equal(SQ.calls.filter((c) => c.body?.grant_type === "refresh_token").length, 1);

  SQ.tokens.clear(); SQ.refreshDead = true; // the seller removed the app
  const o2 = await placeOrder(e, "192.0.2.11");
  const r2 = await hit(e, "POST", "/api/pay", { ref: o2.body.id, t: o2.body.pay_token });
  assert.equal(r2.status, 409);
  const st = (await admin(e, "GET", "square")).body.square;
  assert.equal(st.connected, false);
  assert.match(st.note, /Connect Square/);
  assert.ok(!(await hit(e, "GET", "/api/content")).body.payments.some((p) => p.id === "card"), "card gone from the site");
  assert.equal(e.DB.raw.prepare("SELECT enabled FROM payment_methods WHERE id = 'card'").get().enabled, 0);
  assert.equal(e.DB.raw.prepare("SELECT access_token_enc FROM square_connection").get().access_token_enc, null, "tokens deleted");
});

test("revoked: ACCESS_TOKEN_REVOKED or the oauth.authorization.revoked webhook switch card off", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  SQ.revokedNow = true;
  const o = await placeOrder(e);
  assert.equal((await hit(e, "POST", "/api/pay", { ref: o.body.id, t: o.body.pay_token })).status, 409);
  assert.equal((await admin(e, "GET", "square")).body.square.connected, false);

  const e2 = env(); SQ.revokedNow = false;
  await connectAndSwitchOn(e2);
  const w = await signed(e2, { merchant_id: "MERCH1", type: "oauth.authorization.revoked", event_id: "EVT-REV-1", data: { type: "revocation", object: { revocation: { revoker_type: "MERCHANT" } } } });
  assert.equal(w.status, 200);
  assert.equal(w.body.result, "disconnected");
  assert.equal((await admin(e2, "GET", "square")).body.square.enabled, false);
});

test("disconnect: revokes at Square, deletes tokens, switches card off", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  const r = await admin(e, "POST", "square/disconnect");
  assert.equal(r.status, 200);
  assert.equal(r.body.revoked, true);
  assert.equal(SQ.revokeCalls, 1);
  const row = e.DB.raw.prepare("SELECT * FROM square_connection").get();
  assert.equal(row.status, "disconnected");
  assert.equal(row.access_token_enc, null);
  assert.equal(row.refresh_token_enc, null);
  assert.equal(r.body.square.enabled, false);
});

/* ---------- payment links: the server prices everything ---------- */
test("pay with card: the link is for the server's total, tagged with our order number; the pay token is required", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  assert.deepEqual((await hit(e, "GET", "/api/content")).body.payments[0], { id: "card", handle: null });
  const o = await placeOrder(e);
  assert.match(o.body.pay_token, /^[0-9a-f]{32}$/);
  assert.equal((await hit(e, "POST", "/api/pay", { ref: o.body.id, t: "nope" })).status, 404);
  assert.equal((await hit(e, "POST", "/api/pay", { ref: o.body.id })).status, 404);
  const r = await hit(e, "POST", "/api/pay", { ref: o.body.id, t: o.body.pay_token, amount: 0.01, total: 1, price: 1, items: [{ type: "gram", qty: 1 }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.amount, 18, "2 × Cookie Gram at the menu price, not what the browser sent");
  const sent = SQ.links.at(-1).body;
  assert.deepEqual(sent.order.line_items, [{ name: `CMS Cookie Co. order ${o.body.id}`, quantity: "1", base_price_money: { amount: 1800, currency: "USD" } }]);
  assert.equal(sent.order.reference_id, o.body.id);
  assert.equal(sent.order.location_id, "LOC1");
  assert.equal(sent.checkout_options.allow_tipping, false);
  const back = new URL(sent.checkout_options.redirect_url);
  assert.equal(back.origin, ORIGIN);
  assert.equal(back.searchParams.get("paid"), o.body.id);
  assert.equal(back.searchParams.get("t"), o.body.pay_token);
  // Asking again reuses the same unused link instead of making a new one.
  const again = await hit(e, "POST", "/api/pay", { ref: o.body.id, t: o.body.pay_token });
  assert.equal(again.body.url, r.body.url);
  assert.equal(SQ.links.length, 1);
});

test("return address: DEV_ORIGIN only counts on localhost; the live site always uses its own origin", async () => {
  const e = env({ DEV_ORIGIN: "http://localhost:8787" });
  await connectAndSwitchOn(e);
  const o = await placeOrder(e);
  await worker.fetch(new Request("http://localhost/api/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: o.body.id, t: o.body.pay_token }) }), e);
  assert.match(SQ.links.at(-1).body.checkout_options.redirect_url, /^http:\/\/localhost:8787\/\?paid=/, "wrangler dev hides the port; DEV_ORIGIN puts it back");
  e.DEV_ORIGIN = "https://evil.example";
  const o3 = await placeOrder(e, "192.0.2.13");
  await worker.fetch(new Request("http://localhost/api/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: o3.body.id, t: o3.body.pay_token }) }), e);
  assert.match(SQ.links.at(-1).body.checkout_options.redirect_url, /^http:\/\/localhost\/\?paid=/, "a non-localhost DEV_ORIGIN is ignored");
  e.DEV_ORIGIN = "http://localhost:8787";
  const o2 = await placeOrder(e, "192.0.2.12");
  const res = await worker.fetch(new Request("https://cmscookieco3more.com/api/pay", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ ref: o2.body.id, t: o2.body.pay_token }) }), e);
  assert.equal(res.status, 200);
  assert.match(SQ.links.at(-1).body.checkout_options.redirect_url, /^https:\/\/cmscookieco3more\.com\/\?paid=/);
});

test("signups pay seats × price; requests pay Shaun's quote (and need one); free or under $1 can't use card", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  e.DB.raw.exec(`INSERT INTO events (id, title, date, published, ticket_price_cents, signups_open) VALUES (7, 'Cookie Class', '${day(10)}', 1, 1250, 1)`);
  const s = await hit(e, "POST", "/api/events/7/register", { name: "Ann Lee", phone: "5555550100", seats: 3 }, { "CF-Connecting-IP": "192.0.2.20" });
  assert.equal(s.status, 201);
  const sl = await hit(e, "POST", "/api/pay", { ref: s.body.id, t: s.body.pay_token });
  assert.equal(sl.body.amount, 37.5);
  assert.match(SQ.links.at(-1).body.order.line_items[0].name, /^Cookie Class: 3 spots \(EV-/);

  e.DB.raw.exec(`INSERT INTO events (id, title, date, published, ticket_price_cents, signups_open) VALUES (8, 'Free Tasting', '${day(10)}', 1, 0, 1)`);
  const free = await hit(e, "POST", "/api/events/8/register", { name: "Bo", phone: "5555550101", seats: 1 }, { "CF-Connecting-IP": "192.0.2.21" });
  assert.equal(free.body.pay_token, undefined, "nothing to pay");

  e.DB.raw.exec("INSERT INTO requests (id, kind, name, phone) VALUES ('REQ-1113-1234', 'catering', 'Cat Erer', '5555550102')");
  const noQuote = await admin(e, "POST", "square/links", { ref: "REQ-1113-1234" });
  assert.equal(noQuote.status, 400);
  assert.match(noQuote.body.error, /Add a quote first/);
  await admin(e, "PATCH", "requests/REQ-1113-1234", { quote: "240.00" });
  const q = await admin(e, "POST", "square/links", { ref: "REQ-1113-1234" });
  assert.equal(q.status, 200);
  assert.equal(q.body.amount, 240);
  assert.match(q.body.message, /^Hi Cat! Here's your secure card payment link for Catering REQ-1113-1234 \(\$240\): https:\/\/sandbox\.square\.link\//);
  assert.equal(q.body.phone, "5555550102");
  await admin(e, "PATCH", "requests/REQ-1113-1234", { quote: "0.50" });
  assert.match((await admin(e, "POST", "square/links", { ref: "REQ-1113-1234" })).body.error, /\$1 or more/);
  assert.equal((await admin(e, "POST", "square/links", { ref: "CMS-0000-0000" })).status, 404);
});

test("card off or not connected: no card on the site, no links", async () => {
  const e = env();
  await connect(e); // connected but switched off
  assert.ok(!(await hit(e, "GET", "/api/content")).body.payments.some((p) => p.id === "card"));
  const o = await placeOrder(e);
  assert.equal(o.body.pay_token, undefined);
  const tok = e.DB.raw.prepare("SELECT pay_token FROM orders WHERE id = ?").get(o.body.id).pay_token;
  assert.equal((await hit(e, "POST", "/api/pay", { ref: o.body.id, t: tok })).status, 409);
  assert.equal((await admin(e, "POST", "square/links", { ref: o.body.id })).status, 409);
});

/* ---------- marked paid: return check + webhook, exactly once ---------- */
test("back on the thank-you page the server asks Square itself; the return URL alone proves nothing", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  const o = await placeOrder(e);
  await hit(e, "POST", "/api/pay", { ref: o.body.id, t: o.body.pay_token });
  const q = `/api/pay/status?ref=${o.body.id}&t=${o.body.pay_token}`;
  const before = await hit(e, "GET", q);
  assert.deepEqual(before.body, { ref: o.body.id, kind: "order", paid: false, by_card: false, amount: 18 }, "came back without paying: still unpaid");
  assert.equal((await hit(e, "GET", `/api/pay/status?ref=${o.body.id}&t=wrong`)).status, 404);

  SQ.pay(SQ.links[0].order_id, 1800, "FAILED"); // declined card
  assert.equal((await hit(e, "GET", q)).body.paid, false, "a declined card doesn't count");
  const p = SQ.pay(SQ.links[0].order_id, 1800);
  const after = await hit(e, "GET", q);
  assert.deepEqual(after.body, { ref: o.body.id, kind: "order", paid: true, by_card: true, amount: 18 });
  const row = e.DB.raw.prepare("SELECT * FROM orders WHERE id = ?").get(o.body.id);
  assert.equal(row.paid, 1); assert.equal(row.paid_method, "card"); assert.equal(row.square_payment_id, p.id); assert.equal(row.updated_by, "Square");
  const ord = (await admin(e, "GET", "orders?filter=all")).body.orders.find((x) => x.id === o.body.id);
  assert.equal(ord.paid_method, "card");
  assert.equal(ord.pay_token, undefined, "admin never gets pay tokens either");
});

test("webhook signature matches Square's own published test vectors (square-ruby-sdk webhooks_helper tests)", async () => {
  const body = '{"merchant_id":"MLEFBHHSJGVHD","type":"webhooks.test_notification","event_id":"ac3ac95b-f97d-458c-a6e6-18981597e05f","created_at":"2022-07-13T20:30:59.037339943Z","data":{"type":"webhooks","id":"bc368e64-01aa-407e-b46e-3231809b1129"}}';
  const url = "https://webhook.site/679a4f3a-dcfa-49ee-bac5-9d0edad886b9";
  assert.equal(await verifySignature("Ibxx_5AKakO-3qeNVR61Dw", url, body, "GF4YkrJgGBDZ9NIYbNXBnMzqb2HoL4RW/S6vkZ9/2N4="), true);
  assert.equal(await verifySignature("signature-key", "https://webhook.site/webhooks", '{"data":{"type":"webhooks","id":">id<"}}', "Cxt7+aTi4rKgcA0bC4g9EHdVtLSDWdqccmL5MvihU4U="), true);
  assert.equal(await verifySignature("Ibxx_5AKakO-3qeNVR61Dw", "https://webhook.site/79a4f3a-dcfa-49ee-bac5-9d0edad886b9", body, "GF4YkrJgGBDZ9NIYbNXBnMzqb2HoL4RW/S6vkZ9/2N4="), false, "URL mismatch");
  assert.equal(await verifySignature("MCmhFRxGX82xMwg5FsaoQA", url, body, "GF4YkrJgGBDZ9NIYbNXBnMzqb2HoL4RW/S6vkZ9/2N4="), false, "wrong key");
  assert.equal(await verifySignature("Ibxx_5AKakO-3qeNVR61Dw", url, body, ""), false, "no header");
});

test("webhook: good signature marks paid once; bad signature, wrong URL, replays and other merchants change nothing", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  const o = await placeOrder(e);
  await hit(e, "POST", "/api/pay", { ref: o.body.id, t: o.body.pay_token });
  const p = SQ.pay(SQ.links[0].order_id, 1800);
  const ev = paymentEvent(p);

  const forged = await signed(e, ev, HOOK_URL, "not-the-key");
  assert.equal(forged.status, 403);
  const wrongUrl = await signed(e, ev, "https://evil.example/api/square/webhook");
  assert.equal(wrongUrl.status, 403);
  const raw = JSON.stringify(ev);
  const tampered = await hit(e, "POST", "/api/square/webhook", raw.replace("1800", "1"), { "x-square-hmacsha256-signature": crypto.createHmac("sha256", SECRETS.SQUARE_WEBHOOK_SIGNATURE_KEY).update(HOOK_URL + raw).digest("base64") });
  assert.equal(tampered.status, 403);
  assert.equal((await hit(e, "POST", "/api/square/webhook", raw)).status, 403, "no signature");
  assert.equal(e.DB.raw.prepare("SELECT paid FROM orders WHERE id = ?").get(o.body.id).paid, 0);

  const other = await signed(e, paymentEvent(p, "EVT-OTHER", "payment.updated", "SOMEONE-ELSE"));
  assert.equal(other.body.result, "ignored");

  const good = await signed(e, ev);
  assert.equal(good.status, 200);
  assert.equal(good.body.result, "paid");
  const paidAt = e.DB.raw.prepare("SELECT paid_at FROM orders WHERE id = ?").get(o.body.id).paid_at;
  const replay = await signed(e, ev);
  assert.deepEqual(replay.body, { ok: true, duplicate: true });
  const second = await signed(e, paymentEvent(p, "EVT-NEW-ID", "payment.created"));
  assert.equal(second.body.result, "noted", "same payment, new event: already paid, nothing changes");
  assert.equal((await hit(e, "GET", `/api/pay/status?ref=${o.body.id}&t=${o.body.pay_token}`)).body.paid, true);
  assert.equal(e.DB.raw.prepare("SELECT paid_at FROM orders WHERE id = ?").get(o.body.id).paid_at, paidAt, "marked paid exactly once");
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM square_links WHERE payment_id IS NOT NULL").get().n, 1);
});

test("webhook: wrong amount or unfinished payment isn't marked paid; a paid order can't get a new link", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  const o = await placeOrder(e);
  await hit(e, "POST", "/api/pay", { ref: o.body.id, t: o.body.pay_token });
  const oid = SQ.links[0].order_id;
  const approved = { id: "PAYA", order_id: oid, status: "APPROVED", amount_money: { amount: 1800, currency: "USD" } };
  assert.equal((await signed(e, paymentEvent(approved, "E1"))).body.result, "noted");
  const short = { id: "PAYS", order_id: oid, status: "COMPLETED", amount_money: { amount: 100, currency: "USD" } };
  assert.equal((await signed(e, paymentEvent(short, "E2"))).body.result, "noted");
  assert.equal(e.DB.raw.prepare("SELECT paid FROM orders WHERE id = ?").get(o.body.id).paid, 0);
  const full = { id: "PAYF", order_id: oid, status: "COMPLETED", amount_money: { amount: 1800, currency: "USD" } };
  assert.equal((await signed(e, paymentEvent(full, "E3"))).body.result, "paid");
  const again = await hit(e, "POST", "/api/pay", { ref: o.body.id, t: o.body.pay_token });
  assert.deepEqual(again.body, { paid: true, ref: o.body.id });
  assert.equal(SQ.links.length, 1);
  const send = await admin(e, "POST", "square/links", { ref: o.body.id });
  assert.equal(send.body.paid, true);
});

test("webhook + return check racing: still exactly one paid update", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  const o = await placeOrder(e);
  await hit(e, "POST", "/api/pay", { ref: o.body.id, t: o.body.pay_token });
  const p = SQ.pay(SQ.links[0].order_id, 1800);
  const results = await Promise.all([signed(e, paymentEvent(p)), hit(e, "GET", `/api/pay/status?ref=${o.body.id}&t=${o.body.pay_token}`), signed(e, paymentEvent(p, "EVT-dupe-2"))]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results.filter((r) => r.body?.result === "paid").length <= 1, true);
  const row = e.DB.raw.prepare("SELECT paid, square_payment_id FROM orders WHERE id = ?").get(o.body.id);
  assert.deepEqual({ ...row }, { paid: 1, square_payment_id: p.id });
});

test("spreadsheets say how it was paid; signups and requests get the Paid by card mark too", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  e.DB.raw.exec(`INSERT INTO events (id, title, date, published, ticket_price_cents, signups_open) VALUES (9, 'Decorating Night', '${day(10)}', 1, 2000, 1)`);
  const s = await hit(e, "POST", "/api/events/9/register", { name: "Ann Lee", phone: "5555550100", seats: 1 }, { "CF-Connecting-IP": "192.0.2.30" });
  await hit(e, "POST", "/api/pay", { ref: s.body.id, t: s.body.pay_token });
  SQ.pay(SQ.links.at(-1).order_id, 2000);
  assert.equal((await hit(e, "GET", `/api/pay/status?ref=${s.body.id}&t=${s.body.pay_token}`)).body.by_card, true);
  const csv = (await admin(e, "GET", "events/9/registrations.csv")).text.replace(/^﻿/, "").split("\r\n");
  assert.match(csv[1], /,\$20\.00,Yes,Card,No,$/);
  const reg = (await admin(e, "GET", "events/9/registrations")).body.registrations[0];
  assert.equal(reg.paid_method, "card");

  e.DB.raw.exec("INSERT INTO requests (id, kind, name, phone, quote_cents, status) VALUES ('REQ-1113-5678', 'custom', 'Cus Tom', '5555550103', 5000, 'quoted')");
  await admin(e, "POST", "square/links", { ref: "REQ-1113-5678" });
  SQ.pay(SQ.links.at(-1).order_id, 5000);
  const tok = e.DB.raw.prepare("SELECT pay_token FROM requests WHERE id = 'REQ-1113-5678'").get().pay_token;
  assert.equal((await hit(e, "GET", `/api/pay/status?ref=REQ-1113-5678&t=${tok}`)).body.paid, true);
  const req = (await admin(e, "GET", "requests?filter=all")).body.requests.find((r) => r.id === "REQ-1113-5678");
  assert.equal(req.paid, true); assert.equal(req.paid_method, "card"); assert.equal(req.pay_token, undefined);
  const rcsv = (await admin(e, "GET", "requests.csv")).text;
  assert.match(rcsv, /REQ-1113-5678,.*,\$50\.00,Yes,Card,/);
});

/* ---------- secrets ---------- */
test("no secret in any response or log (tokens, app secret, keys)", async () => {
  const e = env();
  await connectAndSwitchOn(e);
  const o = await placeOrder(e);
  await hit(e, "POST", "/api/pay", { ref: o.body.id, t: o.body.pay_token });
  SQ.tokens.clear(); // force a refresh + an error log path
  await admin(e, "POST", "square/links", { ref: o.body.id });
  SQ.pay(SQ.links[0].order_id, 1800);
  await signed(e, paymentEvent(SQ.payments.values().next().value));
  for (const p of ["square", "payments", "orders?filter=all", "orders.csv"]) await admin(e, "GET", p);
  await hit(e, "GET", "/api/content");
  await admin(e, "POST", "square/disconnect");
  const everything = [...BODIES, ...LOG].join("\n");
  const secrets = [SECRETS.SQUARE_APP_SECRET, SECRETS.SQUARE_TOKEN_ENC_KEY, SECRETS.SQUARE_WEBHOOK_SIGNATURE_KEY, SQ.refreshToken, ...[...Array(SQ.n + 1).keys()].map((i) => `EAAA-ACCESS-${i}-`)];
  for (const s of secrets) assert.ok(!everything.includes(s), `leaked ${s.slice(0, 12)}…`);
  assert.ok(BODIES.length > 10);
});
