// Square card payments: "Connect Square" (OAuth), encrypted tokens, Square-hosted payment links,
// and marking things paid (webhook + a direct check when the customer comes back).
//
// Ships dark. With no SQUARE_APP_ID (production today) configured() is false and nothing here runs:
// the site and admin look exactly as before. Card details never touch this site; customers pay
// on Square's own page. Tokens are AES-GCM encrypted in D1 and never sent to a browser or logged.

export class SquareError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SQUARE_VERSION = "2025-10-16";
// Least we need: make payment links (orders + payments write), read payments/orders back,
// and read the business name and location.
export const SCOPES = ["MERCHANT_PROFILE_READ", "PAYMENTS_READ", "PAYMENTS_WRITE", "ORDERS_READ", "ORDERS_WRITE"];
const STATE_TTL_MS = 15 * 60 * 1000;
const REFRESH_EVERY_MS = 6 * 24 * 3600 * 1000; // Square: renew every 7 days or less
const MIN_CARD_CENTS = 100;
const REF_KIND = (id) => (/^CMS-/.test(id) ? "order" : /^EV-/.test(id) ? "signup" : /^REQ-/.test(id) ? "request" : null);
const REF_TABLE = { order: "orders", signup: "registrations", request: "requests" };

/* ---------- configuration ---------- */
export const configured = (env) => !!(env.SQUARE_APP_ID && env.SQUARE_APP_SECRET && env.SQUARE_TOKEN_ENC_KEY);
export const isSandbox = (env) => String(env.SQUARE_APP_ID || "").startsWith("sandbox-");
// SQUARE_API_BASE points at a local mock (Help guide). Only a localhost URL is honoured, so it can't
// send tokens anywhere else even if set by mistake.
function apiBase(env) {
  const o = env.SQUARE_API_BASE;
  if (o && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)) return o;
  return isSandbox(env) ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}
export const dashboardUrl = (env) => (isSandbox(env) ? "https://app.squareupsandbox.com/dashboard/" : "https://app.squareup.com/dashboard/");
export const isMock = (env) => apiBase(env).startsWith("http://");

/* ---------- token encryption (AES-GCM, 32-byte key) ---------- */
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function encKey(env) {
  const raw = String(env.SQUARE_TOKEN_ENC_KEY || "").trim();
  const bytes = /^[0-9a-f]{64}$/i.test(raw) ? Uint8Array.from(raw.match(/../g), (h) => parseInt(h, 16)) : (() => { try { return unb64(raw); } catch { return new Uint8Array(); } })();
  if (bytes.length !== 32) throw new SquareError(500, "Card payments aren't set up right (the token key must be 32 bytes).");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const AAD = new TextEncoder().encode("cms-square-token-v1");
export async function encryptToken(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await encKey(env), new TextEncoder().encode(plain)));
  return "v1:" + b64(iv) + ":" + b64(ct);
}
export async function decryptToken(env, stored) {
  const [v, iv, ct] = String(stored || "").split(":");
  if (v !== "v1" || !iv || !ct) throw new SquareError(500, "Stored Square token is unreadable. Disconnect and connect again.");
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: AAD }, await encKey(env), unb64(ct)));
  } catch { throw new SquareError(500, "Stored Square token is unreadable. Disconnect and connect again."); }
}

/* ---------- small helpers ---------- */
const now = () => new Date().toISOString();
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const newPayToken = () => randomHex(16);
function sameString(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0 && a.length > 0;
}
// Log what happened, never what was sent or received (token responses carry secrets).
const logSq = (what, status, data) => console.error("square", what, status, (data?.errors || []).map((e) => e.code).join(",") || data?.type || "");

async function sq(env, path, { method = "GET", body, auth } = {}) {
  let res;
  try {
    res = await fetch(apiBase(env) + path, {
      method,
      headers: { "Square-Version": SQUARE_VERSION, "Content-Type": "application/json", Accept: "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    console.error("square", path.split("?")[0], "network", e?.message);
    throw new SquareError(502, "Square didn't answer. Please try again in a minute.");
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}
const codes = (data) => (data?.errors || []).map((e) => e.code);

/* ---------- the connection ---------- */
export async function getConnection(env) {
  return env.DB.prepare("SELECT * FROM square_connection WHERE id = 1").first();
}
// For the admin screens: never includes a token.
export async function connectionStatus(env) {
  if (!configured(env)) return { configured: false };
  const c = await getConnection(env);
  const card = await env.DB.prepare("SELECT enabled FROM payment_methods WHERE id = 'card'").first();
  const connected = c?.status === "connected";
  return {
    configured: true, sandbox: isSandbox(env), mock: isMock(env), connected,
    business_name: connected ? c.business_name : null, location_name: connected ? c.location_name : null,
    connected_at: connected ? c.connected_at : null, enabled: connected && !!card?.enabled,
    dashboard_url: dashboardUrl(env),
    note: !connected && c?.disconnect_reason ? c.disconnect_reason : null,
    last_error: connected ? c.last_error : null,
  };
}
// Card shows to customers only with credentials + a live connection + Shaun's switch on.
export async function cardAvailable(env) {
  if (!configured(env)) return false;
  const r = await env.DB.prepare(
    "SELECT c.status, p.enabled FROM square_connection c, payment_methods p WHERE c.id = 1 AND p.id = 'card'"
  ).first();
  return r?.status === "connected" && !!r.enabled;
}

async function markDisconnected(env, reason) {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE square_connection SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, expires_at = NULL,
         disconnected_at = ?1, disconnect_reason = ?2 WHERE id = 1`
    ).bind(now(), reason),
    env.DB.prepare("UPDATE payment_methods SET enabled = 0, updated_at = ?1, updated_by = 'Square' WHERE id = 'card'").bind(now()),
  ]);
}

// Step 1 of Connect Square: a one-time state value, then off to Square's Allow screen.
export async function startConnect(env, admin) {
  if (!configured(env)) throw new SquareError(404, "Not found");
  const state = randomHex(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM square_oauth_states WHERE created_at < ?1").bind(new Date(Date.now() - STATE_TTL_MS).toISOString()),
    env.DB.prepare("INSERT INTO square_oauth_states (state, created_at, created_by) VALUES (?1, ?2, ?3)").bind(state, now(), admin.email),
  ]);
  const u = new URL(apiBase(env) + "/oauth2/authorize");
  u.searchParams.set("client_id", env.SQUARE_APP_ID);
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("session", "false"); // production: pick the right account (ignored in sandbox)
  u.searchParams.set("state", state);
  return u.toString();
}

// Step 2: Square sends her back with ?code&state (or ?error). Returns a plain-words result.
export async function finishConnect(env, admin, params) {
  if (!configured(env)) throw new SquareError(404, "Not found");
  const state = params.get("state") || "";
  const row = state ? await env.DB.prepare("DELETE FROM square_oauth_states WHERE state = ?1 RETURNING *").bind(state).first() : null;
  if (!row || Date.now() - Date.parse(row.created_at) > STATE_TTL_MS) {
    throw new SquareError(400, "That Connect Square link was old or not from this page. Tap Connect Square again.");
  }
  if (params.get("error")) {
    throw new SquareError(400, params.get("error") === "access_denied" ? "Square wasn't connected (you tapped Deny). Nothing changed." : "Square didn't connect. Please try again.");
  }
  const code = params.get("code");
  if (!code) throw new SquareError(400, "Square didn't send a code back. Please try again.");
  const t = await sq(env, "/oauth2/token", { method: "POST", body: { client_id: env.SQUARE_APP_ID, client_secret: env.SQUARE_APP_SECRET, code, grant_type: "authorization_code" } });
  if (!t.ok || !t.data.access_token) { logSq("obtain token", t.status, t.data); throw new SquareError(502, "Square didn't connect. Please try again."); }
  const auth = "Bearer " + t.data.access_token;
  const m = await sq(env, "/v2/merchants/me", { auth });
  if (!m.ok) { logSq("merchant", m.status, m.data); throw new SquareError(502, "Connected, but Square wouldn't tell us the business name. Please try again."); }
  const merchant = m.data.merchant || {};
  const locs = await sq(env, "/v2/locations", { auth });
  if (!locs.ok) { logSq("locations", locs.status, locs.data); throw new SquareError(502, "Connected, but Square wouldn't list your locations. Please try again."); }
  const active = (locs.data.locations || []).filter((l) => l.status === "ACTIVE" && (l.capabilities || ["CREDIT_CARD_PROCESSING"]).includes("CREDIT_CARD_PROCESSING"));
  const loc = active.find((l) => l.id === merchant.main_location_id) || active[0];
  if (!loc) throw new SquareError(400, "Your Square account has no location that can take cards yet. Finish setting up Square, then connect again.");
  if (loc.currency && loc.currency !== "USD") throw new SquareError(400, "This Square account isn't in US dollars.");
  const name = merchant.business_name || loc.business_name || loc.name || "your Square account";
  await env.DB.prepare(
    `INSERT INTO square_connection (id, status, merchant_id, business_name, location_id, location_name, access_token_enc, refresh_token_enc,
       expires_at, refreshed_at, connected_at, connected_by, disconnected_at, disconnect_reason, last_error)
     VALUES (1, 'connected', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, NULL, NULL, NULL)
     ON CONFLICT (id) DO UPDATE SET status = 'connected', merchant_id = ?1, business_name = ?2, location_id = ?3, location_name = ?4,
       access_token_enc = ?5, refresh_token_enc = ?6, expires_at = ?7, refreshed_at = ?8, connected_at = ?8, connected_by = ?9,
       disconnected_at = NULL, disconnect_reason = NULL, last_error = NULL`
  ).bind(t.data.merchant_id || merchant.id, name, loc.id, loc.name || null,
    await encryptToken(env, t.data.access_token), t.data.refresh_token ? await encryptToken(env, t.data.refresh_token) : null,
    t.data.expires_at || null, now(), admin.email).run();
  return { business_name: name };
}

export async function disconnect(env, admin) {
  if (!configured(env)) throw new SquareError(404, "Not found");
  const c = await getConnection(env);
  let revoked = false;
  if (c?.access_token_enc) {
    const r = await sq(env, "/oauth2/revoke", { method: "POST", auth: "Client " + env.SQUARE_APP_SECRET,
      body: { client_id: env.SQUARE_APP_ID, access_token: await decryptToken(env, c.access_token_enc) } }).catch(() => ({ ok: false }));
    revoked = !!(r.ok && r.data?.success);
    if (!r.ok) logSq("revoke", r.status, r.data);
  }
  await markDisconnected(env, `Disconnected by ${admin.email}`);
  return { revoked };
}

// New access token from the refresh token (code flow: the refresh token stays the same).
// Square refusing it means the connection is gone: mark it disconnected and switch card off.
export async function refresh(env, reason = "scheduled") {
  const c = await getConnection(env);
  if (c?.status !== "connected" || !c.refresh_token_enc) return { refreshed: false };
  const r = await sq(env, "/oauth2/token", { method: "POST", body: {
    client_id: env.SQUARE_APP_ID, client_secret: env.SQUARE_APP_SECRET, grant_type: "refresh_token", refresh_token: await decryptToken(env, c.refresh_token_enc),
  } });
  if (r.ok && r.data.access_token) {
    await env.DB.prepare("UPDATE square_connection SET access_token_enc = ?1, refresh_token_enc = COALESCE(?2, refresh_token_enc), expires_at = ?3, refreshed_at = ?4, last_error = NULL WHERE id = 1")
      .bind(await encryptToken(env, r.data.access_token), r.data.refresh_token ? await encryptToken(env, r.data.refresh_token) : null, r.data.expires_at || null, now()).run();
    return { refreshed: true };
  }
  logSq("refresh " + reason, r.status, r.data);
  if (r.status === 400 || r.status === 401) {
    await markDisconnected(env, "Square ended the connection (it was removed or expired). Tap Connect Square to turn card payments back on.");
    return { refreshed: false, disconnected: true };
  }
  await env.DB.prepare("UPDATE square_connection SET last_error = ?1 WHERE id = 1").bind("Couldn't renew the Square connection; will try again.").run();
  return { refreshed: false };
}

// A call made as Shaun's business. On an auth failure: refresh once and retry. Revoked: disconnect.
async function asSeller(env, path, opts = {}, retried = false) {
  const c = await getConnection(env);
  if (c?.status !== "connected" || !c.access_token_enc) throw new SquareError(409, "Square isn't connected. Connect it in Admin → Payments.");
  const r = await sq(env, path, { ...opts, auth: "Bearer " + (await decryptToken(env, c.access_token_enc)) });
  if (r.status !== 401) return { r, c };
  logSq(path.split("?")[0], r.status, r.data);
  if (codes(r.data).includes("ACCESS_TOKEN_REVOKED")) {
    await markDisconnected(env, "Square says the connection was removed. Tap Connect Square to turn card payments back on.");
    throw new SquareError(409, "Square isn't connected any more. Card payments are off.");
  }
  if (retried) throw new SquareError(502, "Square didn't accept the connection. Please try again.");
  const f = await refresh(env, "auth-retry");
  if (!f.refreshed) throw new SquareError(f.disconnected ? 409 : 502, f.disconnected ? "Square isn't connected any more. Card payments are off." : "Square didn't answer. Please try again in a minute.");
  return asSeller(env, path, opts, true);
}

export async function scheduled(env) {
  if (!configured(env)) return { skipped: true };
  await env.DB.prepare("DELETE FROM square_oauth_states WHERE created_at < ?1").bind(new Date(Date.now() - STATE_TTL_MS).toISOString()).run();
  await env.DB.prepare("DELETE FROM square_events WHERE received_at < ?1").bind(new Date(Date.now() - 90 * 864e5).toISOString()).run();
  const c = await getConnection(env);
  if (c?.status !== "connected") return { refreshed: false };
  const last = Date.parse(c.refreshed_at || c.connected_at || 0) || 0;
  const expSoon = c.expires_at && Date.parse(c.expires_at) - Date.now() < 21 * 864e5;
  if (Date.now() - last < REFRESH_EVERY_MS && !expSoon) return { refreshed: false };
  return refresh(env, "scheduled");
}

/* ---------- what's being paid for ---------- */
// The amount always comes from our database: order total, seats × price, or Shaun's quote.
async function loadRef(env, id) {
  const kind = REF_KIND(String(id || ""));
  if (!kind) throw new SquareError(404, "That order wasn't found");
  const row = await env.DB.prepare(`SELECT * FROM ${REF_TABLE[kind]} WHERE id = ?1`).bind(id).first();
  if (!row) throw new SquareError(404, "That order wasn't found");
  let amount = kind === "request" ? row.quote_cents : row.total_cents, label;
  if (kind === "order") label = `CMS Cookie Co. order ${row.id}`;
  if (kind === "signup") {
    const ev = await env.DB.prepare("SELECT title FROM events WHERE id = ?1").bind(row.event_id).first();
    label = `${ev?.title || "Event"}: ${row.seats} spot${row.seats === 1 ? "" : "s"} (${row.id})`;
  }
  if (kind === "request") label = `${row.kind === "catering" ? "Catering" : "Custom order"} ${row.id}`;
  return { kind, row, amount: amount ?? null, label: label.slice(0, 250) };
}
async function ensurePayToken(env, ref) {
  if (ref.row.pay_token) return ref.row.pay_token;
  const t = newPayToken();
  await env.DB.prepare(`UPDATE ${REF_TABLE[ref.kind]} SET pay_token = COALESCE(pay_token, ?1) WHERE id = ?2`).bind(t, ref.row.id).run();
  return (await env.DB.prepare(`SELECT pay_token FROM ${REF_TABLE[ref.kind]} WHERE id = ?1`).bind(ref.row.id).first()).pay_token;
}

// Mark paid exactly once. Only a COMPLETED payment for the exact amount on the exact Square order counts.
export async function markPaid(env, link, payment) {
  if (!link || !payment || payment.status !== "COMPLETED") return false;
  if (payment.order_id !== link.square_order_id) return false;
  if (payment.amount_money?.currency !== "USD" || payment.amount_money?.amount !== link.amount_cents) {
    console.error("square payment amount mismatch", link.ref_id);
    return false;
  }
  const at = now();
  const r = await env.DB.prepare(
    `UPDATE ${REF_TABLE[link.ref_kind]} SET paid = 1, paid_method = 'card', square_payment_id = ?1, paid_at = ?2, updated_at = ?2, updated_by = 'Square'
     WHERE id = ?3 AND square_payment_id IS NULL`
  ).bind(payment.id, at, link.ref_id).run();
  await env.DB.prepare("UPDATE square_links SET payment_id = ?1, paid_at = ?2 WHERE id = ?3 AND payment_id IS NULL").bind(payment.id, at, link.id).run();
  return r.meta.changes === 1;
}

// Ask Square directly whether any of this thing's payment links has been paid. Never trusts the return URL.
export async function checkPaid(env, kind, id) {
  const { results } = await env.DB.prepare("SELECT * FROM square_links WHERE ref_kind = ?1 AND ref_id = ?2 AND payment_id IS NULL ORDER BY created_at DESC LIMIT 5").bind(kind, id).all();
  for (const link of results) {
    const o = await asSeller(env, `/v2/orders/${encodeURIComponent(link.square_order_id)}`);
    if (!o.r.ok) { logSq("order", o.r.status, o.r.data); continue; }
    for (const t of o.r.data.order?.tenders || []) {
      const pid = t.payment_id || t.id;
      const p = await asSeller(env, `/v2/payments/${encodeURIComponent(pid)}`);
      if (p.r.ok && (await markPaid(env, link, p.r.data.payment))) return true;
    }
  }
  return false;
}

// A Square-hosted payment link for something unpaid. Reuses a recent unused link for the same amount.
export async function createPayLink(env, id, { origin, by = "customer", token } = {}) {
  if (!configured(env)) throw new SquareError(404, "Not found");
  if (!(await cardAvailable(env))) throw new SquareError(409, "Card payments are off right now.");
  const ref = await loadRef(env, id);
  if (token !== undefined && !sameString(token, ref.row.pay_token)) throw new SquareError(404, "That order wasn't found");
  if (ref.row.paid) return { paid: true, ref: ref.row.id, kind: ref.kind };
  if (ref.amount == null) throw new SquareError(400, "Add a quote first, then send the pay link.");
  if (ref.amount < MIN_CARD_CENTS) throw new SquareError(400, "Card payments need $1 or more.");
  if (await checkPaid(env, ref.kind, ref.row.id)) return { paid: true, ref: ref.row.id, kind: ref.kind };
  const c = await getConnection(env);
  const reuse = await env.DB.prepare(
    `SELECT * FROM square_links WHERE ref_kind = ?1 AND ref_id = ?2 AND amount_cents = ?3 AND payment_id IS NULL AND merchant_id = ?4 AND location_id = ?5 AND created_at >= ?6
     ORDER BY created_at DESC LIMIT 1`
  ).bind(ref.kind, ref.row.id, ref.amount, c.merchant_id, c.location_id, new Date(Date.now() - 7 * 864e5).toISOString()).first();
  if (reuse) return { url: reuse.url, amount_cents: reuse.amount_cents, ref: ref.row.id, kind: ref.kind, label: ref.label, row: ref.row };
  const payToken = await ensurePayToken(env, ref);
  const back = new URL("/", origin);
  back.searchParams.set("paid", ref.row.id);
  back.searchParams.set("t", payToken);
  const { r } = await asSeller(env, "/v2/online-checkout/payment-links", { method: "POST", body: {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: c.location_id,
      reference_id: ref.row.id,
      line_items: [{ name: ref.label, quantity: "1", base_price_money: { amount: ref.amount, currency: "USD" } }],
    },
    checkout_options: { redirect_url: back.toString(), allow_tipping: false, ask_for_shipping_address: false },
    payment_note: ref.label,
  } });
  const link = r.data.payment_link;
  if (!r.ok || !link?.url || !link.order_id) { logSq("payment link", r.status, r.data); throw new SquareError(502, "Square couldn't make a payment link. Please try again."); }
  await env.DB.prepare(
    "INSERT INTO square_links (id, ref_kind, ref_id, amount_cents, square_order_id, url, merchant_id, location_id, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
  ).bind(link.id, ref.kind, ref.row.id, ref.amount, link.order_id, link.url, c.merchant_id, c.location_id, by).run();
  return { url: link.url, amount_cents: ref.amount, ref: ref.row.id, kind: ref.kind, label: ref.label, row: ref.row };
}

// The customer is back on our thank-you page: ask Square ourselves, then say what we know.
export async function payStatus(env, id, token) {
  if (!configured(env)) throw new SquareError(404, "Not found");
  const ref = await loadRef(env, id).catch(() => null);
  if (!ref || !sameString(token, ref.row.pay_token)) throw new SquareError(404, "That order wasn't found");
  let paid = !!ref.row.paid;
  if (!paid && (await getConnection(env))?.status === "connected") paid = await checkPaid(env, ref.kind, ref.row.id).catch(() => false);
  const row = paid ? await env.DB.prepare(`SELECT paid_method FROM ${REF_TABLE[ref.kind]} WHERE id = ?1`).bind(ref.row.id).first() : null;
  return { ref: ref.row.id, kind: ref.kind, paid, by_card: row?.paid_method === "card", amount: ref.amount == null ? null : ref.amount / 100 };
}

/* ---------- webhook ---------- */
export async function verifySignature(key, notificationUrl, rawBody, header) {
  if (!key || !header) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(notificationUrl + rawBody)));
  return sameString(b64(sig), header.trim());
}

export async function handleWebhook(request, env) {
  if (!configured(env)) throw new SquareError(404, "Not found");
  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY) throw new SquareError(503, "Webhook not set up");
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > 256 * 1024) throw new SquareError(413, "Too large");
  const raw = await request.text();
  if (raw.length > 256 * 1024) throw new SquareError(413, "Too large");
  const url = env.SQUARE_WEBHOOK_URL || new URL("/api/square/webhook", request.url).toString();
  if (!(await verifySignature(env.SQUARE_WEBHOOK_SIGNATURE_KEY, url, raw, request.headers.get("x-square-hmacsha256-signature")))) {
    throw new SquareError(403, "Bad signature");
  }
  let ev;
  try { ev = JSON.parse(raw); } catch { throw new SquareError(400, "Bad JSON"); }
  const eventId = String(ev.event_id || "");
  if (!eventId) throw new SquareError(400, "No event id");
  if (await env.DB.prepare("SELECT 1 FROM square_events WHERE event_id = ?1").bind(eventId).first()) return { ok: true, duplicate: true };
  const c = await getConnection(env);
  let result = "ignored";
  if (c && ev.merchant_id && ev.merchant_id === c.merchant_id) {
    if (ev.type === "oauth.authorization.revoked" && c.status === "connected") {
      await markDisconnected(env, "Square says the connection was removed. Tap Connect Square to turn card payments back on.");
      result = "disconnected";
    } else if (ev.type === "payment.created" || ev.type === "payment.updated") {
      const p = ev.data?.object?.payment;
      const link = p?.order_id ? await env.DB.prepare("SELECT * FROM square_links WHERE square_order_id = ?1").bind(p.order_id).first() : null;
      if (link && link.merchant_id === c.merchant_id) result = (await markPaid(env, link, p)) ? "paid" : "noted";
    }
  }
  await env.DB.prepare("INSERT OR IGNORE INTO square_events (event_id, type) VALUES (?1, ?2)").bind(eventId, String(ev.type || "").slice(0, 80)).run();
  return { ok: true, result };
}
