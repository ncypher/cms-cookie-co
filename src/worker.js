import { requireAdmin, AccessError } from "./access.js";
import { TOO_MANY_ORDERS, HEVC_VIDEO } from "./messages.js";
import { toCsv } from "./csv.js";

/* ============ Constants ============ */
const TZ = "America/Detroit";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_TYPES = {
  "image/jpeg": { ext: "jpg", kind: "photo" },
  "image/png": { ext: "png", kind: "photo" },
  "image/webp": { ext: "webp", kind: "photo" },
  // Videos are accepted only when the video track is H.264 (checked after upload). HEVC (iPhone "High
  // Efficiency", many Android phones too) or no recognizable video track is refused and deleted.
  "video/mp4": { ext: "mp4", kind: "video", codecCheck: true },
  // iPhone .MOV is served as video/mp4 so Chrome/Android will play it (same ISO container family).
  "video/quicktime": { ext: "mov", kind: "video", serveAs: "video/mp4", codecCheck: true },
};
const MOV_SCAN_HEAD = 1024 * 1024;     // moov at the start (faststart)
const MOV_SCAN_TAIL = 4 * 1024 * 1024; // moov at the end (iPhone default, most phone .mp4s)
const FLAVOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// "Showing today": switched on and inside its optional start/end dates (SQL, ?1 = today).
const IN_SEASON = "active = 1 AND (starts IS NULL OR starts <= ?1) AND (ends IS NULL OR ends >= ?1)";
const inSeason = (r, today) => !!r.active && (!r.starts || r.starts <= today) && (!r.ends || r.ends >= today);
const MEDIA_KEY_RE = /^(img|video)\/\d{4}\/[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov)$/;
const ORDER_LIMIT = 5;
// Ways to pay (Admin -> Payments). Venmo and Cash App need a name; "card" is a coming-soon placeholder.
const PAY_LABEL = { venmo: "Venmo", cashapp: "Cash App", cash: "Cash at pickup", card: "Card (Square)" };
const PAY_NEEDS_HANDLE = new Set(["venmo", "cashapp"]);
const PAY_HANDLE_RE = /^[A-Za-z0-9_-]{1,30}$/;
const ORDER_WINDOW_MS = 10 * 60 * 1000;

/* ============ Helpers ============ */
class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

function todayLocal(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
const dollars = (cents) => (cents == null ? null : cents / 100);
const money = (cents) => "$" + (cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2));
const mediaUrl = (key) => (key ? `/media/${key}` : null);

function str(v, { max = 200, required = false, field = "value" } = {}) {
  if (v == null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
  const s = v.trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return s || null;
}
function priceToCents(v, { field = "price", allowNull = true } = {}) {
  if (v == null || v === "") {
    if (allowNull) return null;
    throw new HttpError(400, `${field} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new HttpError(400, `${field} must be between 0 and 1000`);
  return Math.round(n * 100);
}
function optDate(v, field) {
  if (v == null || v === "") return null;
  if (!isDate(v)) throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  return v;
}
function httpsUrl(v, field, hosts) {
  if (v == null || v === "") return null;
  let u;
  try { u = new URL(String(v).trim()); } catch { throw new HttpError(400, `${field} must be a link`); }
  if (u.protocol !== "https:") throw new HttpError(400, `${field} must start with https://`);
  if (hosts && !hosts.includes(u.hostname.toLowerCase())) throw new HttpError(400, `${field} must be a ${hosts[0]} link`);
  return u.toString();
}
const bool01 = (v) => (v === true || v === 1 || v === "1" || v === "true" ? 1 : 0);

async function readJson(request, maxBytes = 64 * 1024) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > maxBytes) throw new HttpError(413, "Request is too large");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request is too large");
  try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "Body must be JSON"); }
}

/* ============ Security headers ============ */
function withSecurityHeaders(res, { admin = false } = {}) {
  const r = new Response(res.body, res);
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  r.headers.set("X-Frame-Options", "DENY");
  r.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (admin) {
    r.headers.set("Cache-Control", "no-store");
    r.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return r;
}

/* ============ Public: content ============ */
function shapeSpecial(s) {
  return { id: s.id, kind: s.kind, title: s.title, body: s.body, price: dollars(s.price_cents), image: mediaUrl(s.image_key), starts: s.starts, ends: s.ends };
}
function shapeMedia(m) {
  return { id: m.id, kind: m.kind, caption: m.caption, url: m.kind === "instagram" ? m.key_or_url : mediaUrl(m.key_or_url), content_type: m.content_type };
}

const flavorPhoto = (r) => (r.photo_key ? mediaUrl(r.photo_key) : r.asset || null);
const shapeFlavor = (r) => ({ id: r.key.slice(7), name: r.name, short: r.short || r.name, description: r.description, photo: flavorPhoto(r), in_flight: !!r.in_flight });
// Seats already reserved for event e (correlated subquery; the table alias must be `e`).
const TAKEN = "(SELECT COALESCE(SUM(r.seats), 0) FROM registrations r WHERE r.event_id = e.id)";
// What the site shows about signing up: null = no signup on the site.
function eventSignup(e, today) {
  if (e.ticket_price_cents == null || !e.signups_open) return null;
  const closes = e.signup_closes || e.date;
  const left = e.capacity == null ? null : Math.max(0, e.capacity - (e.taken || 0));
  return { price: dollars(e.ticket_price_cents), spots_left: left, closes, state: today > closes ? "closed" : left === 0 ? "soldout" : "open" };
}
const shapePackage = (k) => ({ id: k.id, name: k.name, description: k.description, from: dollars(k.from_cents), serves: k.serves, photo: mediaUrl(k.photo_key) });
const shapeTreat = (t) => ({ id: t.id, name: t.name, price: dollars(t.price_cents), description: t.description, category: t.category, photo: mediaUrl(t.photo_key) });

async function getContent(env) {
  const today = todayLocal();
  const [menu, specials, events, media, flavors, treats, payments, catering, packages] = await env.DB.batch([
    env.DB.prepare("SELECT key, kind, name, price_cents, active FROM menu WHERE kind = 'item' ORDER BY sort"),
    env.DB.prepare(
      `SELECT * FROM specials WHERE active = 1
         AND (starts IS NULL OR starts <= ?1) AND (ends IS NULL OR ends >= ?1)
       ORDER BY CASE kind WHEN 'cotm' THEN 0 ELSE 1 END, id DESC`
    ).bind(today),
    env.DB.prepare(`SELECT e.*, ${TAKEN} AS taken FROM events e WHERE e.published = 1 AND e.date >= ?1 ORDER BY e.date, e.id LIMIT 6`).bind(today),
    env.DB.prepare("SELECT * FROM media WHERE featured = 1 ORDER BY id DESC LIMIT 12"),
    env.DB.prepare(`SELECT * FROM menu WHERE kind = 'flavor' AND ${IN_SEASON} ORDER BY sort, key`).bind(today),
    env.DB.prepare(`SELECT * FROM treats WHERE ${IN_SEASON} ORDER BY sort, id`).bind(today),
    env.DB.prepare("SELECT id, handle FROM payment_methods WHERE enabled = 1 AND id <> 'card' ORDER BY sort, id"),
    env.DB.prepare("SELECT * FROM catering WHERE id = 1"),
    env.DB.prepare("SELECT * FROM catering_packages WHERE active = 1 ORDER BY sort, id"),
  ]);
  const cat = catering.results[0];
  const all = specials.results.map(shapeSpecial);
  const featured = media.results.map(shapeMedia);
  return {
    today,
    menu: menu.results.map((m) => ({ key: m.key, kind: m.kind, name: m.name, price: dollars(m.price_cents), active: !!m.active })),
    flavors: flavors.results.map(shapeFlavor),
    treats: treats.results.map(shapeTreat),
    cookieOfTheMonth: all.find((s) => s.kind === "cotm") || null,
    specials: all.filter((s) => s.kind === "special"),
    events: events.results.map((e) => ({ id: e.id, title: e.title, date: e.date, body: e.body, flyer: mediaUrl(e.flyer_key), rsvp_url: e.rsvp_url, signup: eventSignup(e, today) })),
    tip: featured.find((m) => m.kind === "video" || m.kind === "instagram") || null,
    photos: featured.filter((m) => m.kind === "photo"),
    // Only the ways Shaun has switched on (never the card placeholder). Venmo/Cash App without a name are skipped.
    payments: payments.results.filter((p) => !PAY_NEEDS_HANDLE.has(p.id) || p.handle).map((p) => ({ id: p.id, handle: p.handle })),
    // Nothing about catering is public until Shaun switches it on.
    catering: cat?.enabled ? {
      intro: cat.intro, notice_days: cat.notice_days, earliest: todayLocal(cat.notice_days), items: JSON.parse(cat.items_json || "[]"),
      packages: packages.results.map(shapePackage),
    } : null,
  };
}

/* ============ Public: orders ============ */
async function priceOrder(env, items) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, "Your order is empty");
  if (items.length > 30) throw new HttpError(400, "Too many items in one order");
  const today = todayLocal();
  const { results } = await env.DB.prepare("SELECT * FROM menu ORDER BY sort, key").all();
  const menu = new Map(results.map((r) => [r.key, r]));
  const flavors = new Map(results.filter((r) => r.kind === "flavor" && inSeason(r, today)).map((r) => [r.key.slice(7), r]));
  const activeFlavor = (id) => (typeof id === "string" ? flavors.get(id) : undefined);
  const item = (key) => {
    const m = menu.get(key);
    if (!m || m.kind !== "item" || !m.active || m.price_cents == null) throw new HttpError(400, `${m ? m.name : key} isn't available right now`);
    return m;
  };
  const lines = [];
  for (const it of items) {
    const qty = Number(it?.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw new HttpError(400, "Quantities must be between 1 and 50");
    let name, detail = null, unit;
    switch (it.type) {
      case "box": {
        const size = Number(it.size);
        if (size !== 6 && size !== 12) throw new HttpError(400, "Boxes come in 6 or 12");
        const m = item(size === 6 ? "half" : "dozen");
        const picked = it.flavors && typeof it.flavors === "object" ? it.flavors : {};
        let sum = 0; const parts = [];
        for (const [id, n] of Object.entries(picked)) {
          const f = activeFlavor(id);
          if (!f) throw new HttpError(400, `That flavor isn't available right now`);
          if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "Box flavor counts are invalid");
          if (n) { sum += n; parts.push(`${n} ${f.short || f.name}`); }
        }
        if (sum !== size) throw new HttpError(400, `A ${size === 6 ? "half-dozen" : "dozen"} box needs exactly ${size} cookies`);
        name = size === 6 ? "Half-dozen box" : "Dozen box"; detail = parts.join(", "); unit = m.price_cents;
        break;
      }
      case "single": {
        const f = activeFlavor(it.flavor);
        if (!f) throw new HttpError(400, "That flavor isn't available right now");
        name = f.name; detail = "Single cookie"; unit = item("single").price_cents;
        break;
      }
      case "flight": {
        const m = item("flight");
        const inFlight = [...flavors.values()].filter((f) => f.in_flight);
        if (!inFlight.length) throw new HttpError(400, `${m.name} isn't available right now`);
        name = m.name; detail = "One of each: " + inFlight.map((f) => f.short || f.name).join(", "); unit = m.price_cents;
        break;
      }
      case "treat": {
        const t = await env.DB.prepare(`SELECT * FROM treats WHERE id = ?2 AND ${IN_SEASON}`).bind(today, Number(it.id) || 0).first();
        if (!t) throw new HttpError(400, "That treat isn't available right now");
        name = t.name; detail = t.category || "Treat"; unit = t.price_cents;
        break;
      }
      case "gram": { const m = item("gram"); name = m.name; unit = m.price_cents; break; }
      case "mini": {
        const size = Number(it.size);
        if (size !== 12 && size !== 24) throw new HttpError(400, "Mini lunch boxes come in 12 or 24");
        const m = item("mini" + size); name = m.name; unit = m.price_cents;
        break;
      }
      case "special": {
        const s = await env.DB.prepare(
          `SELECT * FROM specials WHERE id = ?1 AND active = 1 AND price_cents IS NOT NULL
             AND (starts IS NULL OR starts <= ?2) AND (ends IS NULL OR ends >= ?2)`
        ).bind(Number(it.id) || 0, today).first();
        if (!s) throw new HttpError(400, "That special has ended");
        name = s.title; detail = s.kind === "cotm" ? "Cookie of the Month" : "Special"; unit = s.price_cents;
        break;
      }
      default:
        throw new HttpError(400, "Unknown item in your order");
    }
    lines.push({ type: it.type, name, detail, qty, unit_cents: unit, line_cents: unit * qty });
  }
  return { lines, total_cents: lines.reduce((s, l) => s + l.line_cents, 0) };
}

function orderEmailText(o) {
  const items = o.lines.map((l) => `• ${l.qty} × ${l.name}${l.detail && l.type === "box" ? ` (${l.detail})` : ""} — ${money(l.line_cents)}`).join("\n");
  const [y, m, d] = o.wanted_date.split("-").map(Number);
  const wanted = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return [
    `New cookie order ${o.id}`, "", items, "",
    `Total: ${money(o.total_cents)}`,
    `Name: ${o.name}`,
    `Phone: ${o.phone}`,
    `Wanted: ${wanted} · ${o.fulfillment === "delivery" ? "Delivery (ask Shaun)" : "Pickup"}`,
    o.dietary ? `Dietary: ${o.dietary}` : null,
    o.notes ? `Notes: ${o.notes}` : null,
    "", "Confirm or mark paid: /admin",
  ].filter((x) => x !== null).join("\n");
}

function newOrderId(prefix = "CMS") {
  const d = todayLocal().slice(5).replace("-", "");
  const n = crypto.getRandomValues(new Uint16Array(1))[0] % 9000 + 1000;
  return `${prefix}-${d}-${n}`;
}

// Salted hash of the caller's IP: enough to count orders per device without storing the address.
async function clientHash(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.RATE_LIMIT_SALT || "cms-cookie-co"}|${ip}`));
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function enforceOrderLimit(env, hash) {
  if (env.ORDER_LIMITER) {
    const { success } = await env.ORDER_LIMITER.limit({ key: hash });
    if (!success) throw new HttpError(429, TOO_MANY_ORDERS, { "Retry-After": "60" });
  }
  const since = new Date(Date.now() - ORDER_WINDOW_MS).toISOString();
  const recent = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM orders WHERE client_hash = ?1 AND created_at >= ?2)
       + (SELECT COUNT(*) FROM registrations WHERE client_hash = ?1 AND created_at >= ?2)
       + (SELECT COUNT(*) FROM requests WHERE client_hash = ?1 AND created_at >= ?2) AS n`
  ).bind(hash, since).first();
  if ((recent?.n ?? 0) >= ORDER_LIMIT) throw new HttpError(429, TOO_MANY_ORDERS, { "Retry-After": "600" });
}

async function createOrder(request, env) {
  const hash = await clientHash(request, env);
  await enforceOrderLimit(env, hash);
  const body = await readJson(request);
  if (body.website) return json({ ok: true, id: newOrderId(), total: 0 }, 201); // honeypot: pretend success
  const name = str(body.name, { max: 80, required: true, field: "Name" });
  const phone = str(body.phone, { max: 30, required: true, field: "Phone" });
  if (phone.replace(/\D/g, "").length < 10) throw new HttpError(400, "Add a 10-digit phone number so Shaun can text you back");
  if (!isDate(body.date)) throw new HttpError(400, "Pick the date you'd like your cookies");
  if (body.date < todayLocal() || body.date > todayLocal(365)) throw new HttpError(400, "Pick a date between today and a year from now");
  const fulfillment = body.fulfillment === "delivery" ? "delivery" : "pickup";
  const dietary = (Array.isArray(body.dietary) ? body.dietary : [])
    .map((x) => ({ gf: "Gluten-free", df: "Dairy-free" })[x]).filter(Boolean).join(", ") || null;
  const notes = str(body.notes, { max: 1000, field: "Notes" });
  const { lines, total_cents } = await priceOrder(env, body.items);

  let id;
  for (let attempt = 0; attempt < 5; attempt++) {
    id = newOrderId();
    try {
      await env.DB.prepare(
        `INSERT INTO orders (id, name, phone, wanted_date, fulfillment, dietary, notes, items_json, total_cents, client_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      ).bind(id, name, phone, body.date, fulfillment, dietary, notes, JSON.stringify(lines), total_cents, hash).run();
      break;
    } catch (e) {
      if (attempt === 4 || !String(e.message).includes("UNIQUE")) throw e;
    }
  }

  const order = { id, name, phone, wanted_date: body.date, fulfillment, dietary, notes, lines, total_cents };
  let emailStatus = "skipped";
  if (env.EMAIL && env.NOTIFY_TO && env.NOTIFY_FROM) {
    try {
      await env.EMAIL.send({
        from: { name: "CMS Cookie Co. Orders", email: env.NOTIFY_FROM },
        to: env.NOTIFY_TO,
        subject: `Cookie order ${id} from ${name} — ${money(total_cents)}`,
        text: orderEmailText(order).replace("/admin", `${env.SITE_ORIGIN || ""}/admin`),
      });
      emailStatus = "sent";
    } catch (e) {
      console.error("order email failed", id, e?.message);
      emailStatus = "failed";
    }
  }
  await env.DB.prepare("UPDATE orders SET email_status = ?1 WHERE id = ?2").bind(emailStatus, id).run();
  return json({ ok: true, id, total: dollars(total_cents), lines: lines.map((l) => ({ ...l, unit: dollars(l.unit_cents), line: dollars(l.line_cents) })), emailed: emailStatus === "sent" }, 201);
}

/* ============ Event signups ============ */
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const prettyDay = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };

// Reserve spots. The price comes from the event, and the capacity check is part of the INSERT itself
// (one statement, so two people can't both get the last spot). `preview` = admin trying a Draft event.
async function registerForEvent(request, env, eventId, { preview = false } = {}) {
  const hash = await clientHash(request, env);
  if (!preview) await enforceOrderLimit(env, hash);
  const b = await readJson(request);
  if (b.website) return json({ ok: true, id: newOrderId("EV"), seats: 1, total: 0 }, 201); // honeypot: pretend success
  const name = str(b.name, { max: 80, required: true, field: "Name" });
  const phone = str(b.phone, { max: 30, required: true, field: "Phone" });
  if (phone.replace(/\D/g, "").length < 10) throw new HttpError(400, "Add a 10-digit phone number so Shaun can text you back");
  const email = str(b.email, { max: 120, field: "Email" });
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, "That email doesn't look right. You can leave it empty.");
  const notes = str(b.notes, { max: 500, field: "Notes" });
  const seats = Number(b.seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > 10) throw new HttpError(400, "Pick 1 to 10 spots");
  const id = Number(eventId);
  const ev = Number.isInteger(id) && id > 0 ? await env.DB.prepare(`SELECT e.*, ${TAKEN} AS taken FROM events e WHERE e.id = ?1`).bind(id).first() : null;
  if (!ev || (!ev.published && !preview)) throw new HttpError(404, "That event isn't taking signups");
  if (ev.ticket_price_cents == null || !ev.signups_open) throw new HttpError(409, "Signups aren't open for this event");
  const today = todayLocal();
  if (today > (ev.signup_closes || ev.date)) throw new HttpError(409, "Signups for this event have closed");

  let row = null, resId;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    resId = newOrderId("EV");
    try {
      row = await env.DB.prepare(
        `INSERT INTO registrations (id, event_id, name, phone, email, seats, notes, price_cents, total_cents, client_hash)
         SELECT ?1, e.id, ?3, ?4, ?5, ?6, ?7, e.ticket_price_cents, e.ticket_price_cents * ?6, ?8 FROM events e
         WHERE e.id = ?2 AND (e.published = 1 OR ?9 = 1) AND e.signups_open = 1 AND e.ticket_price_cents IS NOT NULL
           AND ?10 <= COALESCE(e.signup_closes, e.date)
           AND (e.capacity IS NULL OR e.capacity - ${TAKEN} >= ?6)
         RETURNING *`
      ).bind(resId, id, name, phone, email, seats, notes, hash, preview ? 1 : 0, today).first();
      if (!row) break;
    } catch (e) {
      if (attempt === 4 || !String(e.message).includes("UNIQUE")) throw e;
    }
  }
  if (!row) {
    const now = await env.DB.prepare(`SELECT e.capacity, ${TAKEN} AS taken FROM events e WHERE e.id = ?1`).bind(id).first();
    const left = now?.capacity == null ? null : Math.max(0, now.capacity - now.taken);
    if (left === 0) throw new HttpError(409, "Sold out. Every spot is taken.");
    if (left != null) throw new HttpError(409, `Only ${left} spot${left === 1 ? "" : "s"} left. Pick ${left} or fewer.`);
    throw new HttpError(409, "Signups aren't open for this event");
  }

  let emailStatus = "skipped";
  if (env.EMAIL && env.NOTIFY_TO && env.NOTIFY_FROM) {
    try {
      await env.EMAIL.send({
        from: { name: "CMS Cookie Co. Signups", email: env.NOTIFY_FROM },
        to: env.NOTIFY_TO,
        subject: `${preview ? "[PREVIEW] " : ""}Signup ${row.id}: ${name}, ${seats} for ${ev.title} — ${money(row.total_cents)}`,
        text: [
          `New signup ${row.id}${preview ? " (made from the admin preview of a draft)" : ""}`, "",
          `Event: ${ev.title} (${prettyDay(ev.date)})`,
          `Spots: ${seats} × ${money(row.price_cents)} = ${money(row.total_cents)}`,
          `Name: ${name}`, `Phone: ${phone}`, email ? `Email: ${email}` : null, notes ? `Notes: ${notes}` : null,
          "", `See everyone who signed up: ${env.SITE_ORIGIN || ""}/admin/#events`,
        ].filter((x) => x !== null).join("\n"),
      });
      emailStatus = "sent";
    } catch (e) {
      console.error("signup email failed", row.id, e?.message);
      emailStatus = "failed";
    }
  }
  await env.DB.prepare("UPDATE registrations SET email_status = ?1 WHERE id = ?2").bind(emailStatus, row.id).run();
  return json({ ok: true, id: row.id, seats, price: dollars(row.price_cents), total: dollars(row.total_cents),
    event: { id: ev.id, title: ev.title, date: ev.date }, emailed: emailStatus === "sent" }, 201);
}

/* ============ Requests: catering quotes and custom orders ============ */
const REQUEST_STATUSES = ["new", "quoted", "booked", "done", "declined"];
const STATUS_LABEL = { new: "New", quoted: "Quoted", booked: "Booked", done: "Done", declined: "Declined" };
// "about 20" -> 20. Anything without a number is kept for the notes instead.
function headcountOf(v) {
  if (v == null || v === "") return { n: null, text: null };
  const m = String(v).match(/\d{1,5}/);
  const n = m ? Number(m[0]) : null;
  if (n != null && (n < 1 || n > 5000)) throw new HttpError(400, "How many people should be between 1 and 5000");
  return { n, text: n == null ? str(String(v), { max: 60, field: "How many people" }) : null };
}
async function createRequest(request, env) {
  const hash = await clientHash(request, env);
  await enforceOrderLimit(env, hash);
  const b = await readJson(request);
  if (b.website) return json({ ok: true, id: newOrderId("REQ") }, 201); // honeypot: pretend success
  const kind = b.kind === "catering" ? "catering" : b.kind === "custom" ? "custom" : null;
  if (!kind) throw new HttpError(400, "Unknown request");
  const cat = await env.DB.prepare("SELECT * FROM catering WHERE id = 1").first();
  if (kind === "catering" && !cat?.enabled) throw new HttpError(409, "Catering requests are closed right now. Please text Shaun.");
  const name = str(b.name, { max: 80, required: true, field: "Name" });
  const phone = str(b.phone, { max: 30, required: true, field: "Phone" });
  if (phone.replace(/\D/g, "").length < 10) throw new HttpError(400, "Add a 10-digit phone number so Shaun can text you back");
  const email = str(b.email, { max: 120, field: "Email" });
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, "That email doesn't look right. You can leave it empty.");
  const today = todayLocal();
  let event_date = null;
  if (b.date != null && b.date !== "") {
    if (!isDate(b.date)) throw new HttpError(400, "Pick the date of your event");
    event_date = b.date;
  }
  if (kind === "catering") {
    if (!event_date) throw new HttpError(400, "Pick the date of your event");
    const earliest = todayLocal(cat.notice_days);
    if (event_date < earliest) throw new HttpError(400, `Catering needs at least ${cat.notice_days} days' notice. Pick ${prettyDay(earliest)} or later, or text Shaun.`);
  } else if (event_date && event_date < today) throw new HttpError(400, "That date has already passed");
  if (event_date && event_date > todayLocal(730)) throw new HttpError(400, "Pick a date within the next two years");
  const hc = headcountOf(b.headcount);
  if (kind === "catering" && hc.n == null) throw new HttpError(400, "How many people is it for?");
  const fulfillment = b.fulfillment === "delivery" ? "delivery" : b.fulfillment === "pickup" || kind === "catering" ? "pickup" : null;
  const interests = (Array.isArray(b.interests) ? b.interests : []).filter((x) => typeof x === "string").map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 15);
  let package_id = null;
  if (b.package_id != null && b.package_id !== "") {
    const k = kind === "catering" ? await env.DB.prepare("SELECT * FROM catering_packages WHERE id = ?1 AND active = 1").bind(Number(b.package_id) || 0).first() : null;
    if (!k) throw new HttpError(400, "That package isn't available any more");
    package_id = k.id;
    if (!interests.includes(k.name)) interests.unshift(k.name);
  }
  const budget = str(b.budget, { max: 80, field: "Budget" });
  let notes = str(b.notes, { max: 1500, field: "Notes" });
  if (hc.text) notes = [`How many: ${hc.text}`, notes].filter(Boolean).join("\n");

  let row = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    try {
      row = await env.DB.prepare(
        `INSERT INTO requests (id, kind, name, phone, email, event_date, headcount, fulfillment, interests, budget, notes, package_id, client_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) RETURNING *`
      ).bind(newOrderId("REQ"), kind, name, phone, email, event_date, hc.n, fulfillment, JSON.stringify(interests), budget, notes, package_id, hash).first();
    } catch (e) {
      if (attempt === 4 || !String(e.message).includes("UNIQUE")) throw e;
    }
  }
  let emailStatus = "skipped";
  if (env.EMAIL && env.NOTIFY_TO && env.NOTIFY_FROM) {
    try {
      await env.EMAIL.send({
        from: { name: "CMS Cookie Co. Requests", email: env.NOTIFY_FROM },
        to: env.NOTIFY_TO,
        subject: `${kind === "catering" ? "Catering request" : "Custom order request"} ${row.id} from ${name}`,
        text: [
          `New ${kind === "catering" ? "catering" : "custom order"} request ${row.id}`, "",
          interests.length ? `Would like: ${interests.join(", ")}` : null,
          event_date ? `Date: ${prettyDay(event_date)}` : null,
          hc.n ? `How many: ${hc.n}` : null,
          fulfillment ? `Pickup or delivery: ${fulfillment === "delivery" ? "Delivery" : "Pickup"}` : null,
          budget ? `Budget: ${budget}` : null,
          `Name: ${name}`, `Phone: ${phone}`, email ? `Email: ${email}` : null, notes ? `Notes: ${notes}` : null,
          "", `Answer it and set a quote: ${env.SITE_ORIGIN || ""}/admin/#requests`,
        ].filter((x) => x !== null).join("\n"),
      });
      emailStatus = "sent";
    } catch (e) {
      console.error("request email failed", row.id, e?.message);
      emailStatus = "failed";
    }
  }
  await env.DB.prepare("UPDATE requests SET email_status = ?1 WHERE id = ?2").bind(emailStatus, row.id).run();
  return json({ ok: true, id: row.id, kind, emailed: emailStatus === "sent" }, 201);
}

/* ============ Spreadsheets (CSV) ============ */
const csvMoney = (cents) => (cents == null ? "" : "$" + (cents / 100).toFixed(2));
const csvWhen = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const yesNo = (v) => (v ? "Yes" : "No");
const localDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
function csvResponse(filename, body) {
  return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
}
async function signupsCsv(env, eventId) {
  const ev = await env.DB.prepare("SELECT * FROM events WHERE id = ?1").bind(Number(eventId)).first();
  if (!ev) throw new HttpError(404, "Event not found");
  const { results } = await env.DB.prepare("SELECT * FROM registrations WHERE event_id = ?1 ORDER BY created_at").bind(ev.id).all();
  const rows = [["Reservation", "Signed up", "Name", "Phone", "Email", "Spots", "Price per spot", "Total", "Paid", "Checked in", "Notes"],
    ...results.map((r) => [r.id, csvWhen(r.created_at), r.name, r.phone, r.email, r.seats, csvMoney(r.price_cents), csvMoney(r.total_cents), yesNo(r.paid), yesNo(r.checked_in), r.notes])];
  const slug = String(ev.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "event";
  return csvResponse(`signups-${slug}-${ev.date}.csv`, toCsv(rows));
}
async function ordersCsv(env, url) {
  const { from, to, rows: results } = await rowsInRange(env, "orders", url);
  const items = (o) => JSON.parse(o.items_json).map((l) => `${l.qty} × ${l.name}${l.detail ? ` (${l.detail})` : ""}`).join("; ");
  const rows = [["Order", "Placed", "Wanted", "Name", "Phone", "Pickup or delivery", "Items", "Total", "Confirmed", "Paid", "Dietary", "Notes"],
    ...results.map((o) => [o.id, csvWhen(o.created_at), prettyDay(o.wanted_date), o.name, o.phone, o.fulfillment === "delivery" ? "Delivery" : "Pickup", items(o), csvMoney(o.total_cents), yesNo(o.confirmed), yesNo(o.paid), o.dietary, o.notes])];
  return csvResponse(`orders-${from}-to-${to}.csv`, toCsv(rows));
}

// Rows created between two Michigan dates (inclusive). created_at is UTC, so widen by a day and filter.
async function rowsInRange(env, table, url) {
  const to = url.searchParams.get("to") || todayLocal(), from = url.searchParams.get("from") || todayLocal(-29);
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, "Dates must be YYYY-MM-DD");
  if (from > to) throw new HttpError(400, "The start date is after the end date");
  if (Date.parse(to) - Date.parse(from) > 366 * 864e5) throw new HttpError(400, "Pick a year or less");
  const lo = new Date(Date.parse(from + "T00:00:00Z") - 864e5).toISOString(), hi = new Date(Date.parse(to + "T00:00:00Z") + 2 * 864e5).toISOString();
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE created_at >= ?1 AND created_at < ?2 ORDER BY created_at`).bind(lo, hi).all();
  return { from, to, rows: results.filter((o) => { const d = localDay(o.created_at); return d >= from && d <= to; }) };
}
async function requestsCsv(env, url) {
  const { from, to, rows } = await rowsInRange(env, "requests", url);
  const out = [["Request", "Received", "Kind", "Status", "Name", "Phone", "Email", "Event date", "How many", "Pickup or delivery", "Would like", "Budget", "Quote", "Notes", "Your notes"],
    ...rows.map((r) => [r.id, csvWhen(r.created_at), r.kind === "catering" ? "Catering" : "Custom order", STATUS_LABEL[r.status], r.name, r.phone, r.email,
      r.event_date ? prettyDay(r.event_date) : "", r.headcount, r.fulfillment ? (r.fulfillment === "delivery" ? "Delivery" : "Pickup") : "",
      JSON.parse(r.interests || "[]").join("; "), r.budget, csvMoney(r.quote_cents), r.notes, r.admin_notes])];
  return csvResponse(`requests-${from}-to-${to}.csv`, toCsv(out));
}

/* ============ Public: media from R2 ============ */
async function serveMedia(request, env, key) {
  if (!MEDIA_KEY_RE.test(key)) return new Response("Not found", { status: 404 });
  const obj = await env.MEDIA.get(key, { range: request.headers, onlyIf: request.headers });
  if (obj === null) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable"); // keys are random UUIDs, never reused
  if (!("body" in obj) || !obj.body) return new Response(null, { status: 304, headers });
  if (obj.range && request.headers.has("Range")) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}

/* ============ Payments (admin) ============ */
// "@CmsCookieCo" / "$CmsCookieCo" -> "CmsCookieCo". Letters, digits, - and _ only (it ends up in links).
function payHandle(v, id) {
  if (v == null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${PAY_LABEL[id]} name must be text`);
  const s = v.trim().replace(/^[@$]/, "");
  if (!s) return null;
  if (s.length > 30) throw new HttpError(400, `${PAY_LABEL[id]} name is too long (30 letters at most)`);
  if (!PAY_HANDLE_RE.test(s)) throw new HttpError(400, `${PAY_LABEL[id]} names can only use letters, numbers, - and _`);
  return s;
}
const shapePayment = (p) => ({ id: p.id, label: PAY_LABEL[p.id], enabled: !!p.enabled, handle: p.handle, coming_soon: p.id === "card", updated_at: p.updated_at, updated_by: p.updated_by });

async function updatePayment(request, env, id, admin) {
  const cur = await env.DB.prepare("SELECT * FROM payment_methods WHERE id = ?1").bind(id).first();
  if (!cur) throw new HttpError(404, "Payment method not found");
  if (id === "card") throw new HttpError(400, "Card payments are coming soon. There's nothing to switch on yet.");
  const b = await readJson(request);
  const handle = PAY_NEEDS_HANDLE.has(id) ? ("handle" in b ? payHandle(b.handle, id) : cur.handle) : null;
  const enabled = "enabled" in b ? bool01(b.enabled) : cur.enabled;
  if (enabled && PAY_NEEDS_HANDLE.has(id) && !handle) {
    throw new HttpError(400, `Type your ${PAY_LABEL[id]} name first, then switch it on.`);
  }
  const row = await env.DB.prepare("UPDATE payment_methods SET enabled = ?1, handle = ?2, updated_at = ?3, updated_by = ?4 WHERE id = ?5 RETURNING *")
    .bind(enabled, handle, new Date().toISOString(), admin.email, id).first();
  return json({ payment: shapePayment(row) });
}

/* ============ Admin API ============ */
function sniffOk(bytes, type) {
  const b = bytes, ascii = (o, n) => String.fromCharCode(...b.slice(o, o + n));
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/png") return b[0] === 0x89 && ascii(1, 3) === "PNG";
  if (type === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
  if (type === "video/mp4" || type === "video/quicktime") return ascii(4, 4) === "ftyp"; // brand "qt  " is fine
  return false;
}

// Video codec from the sample description: each 'stsd' box is
// size(4) 'stsd'(4) version/flags(4) entry_count(4) entry_size(4) FORMAT(4), so the
// fourcc sits 16 bytes after the 'stsd' tag. Anchoring on 'stsd' avoids false hits
// from "avc1"/"hvc1" bytes that happen to appear inside compressed frames.
const H264 = new Set(["avc1", "avc3"]);
const HEVC = new Set(["hvc1", "hev1"]);
function sampleEntryCodecs(bytes) {
  const found = new Set();
  for (let i = 0; i + 20 <= bytes.length; i++) {
    if (bytes[i] === 0x73 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x73 && bytes[i + 3] === 0x64) { // "stsd"
      found.add(String.fromCharCode(bytes[i + 16], bytes[i + 17], bytes[i + 18], bytes[i + 19]));
    }
  }
  return found;
}
async function movVideoCodec(env, key, size) {
  const ranges = size <= MOV_SCAN_HEAD + MOV_SCAN_TAIL
    ? [{ offset: 0, length: size }]
    : [{ offset: 0, length: MOV_SCAN_HEAD }, { suffix: MOV_SCAN_TAIL }];
  const codecs = new Set();
  for (const range of ranges) {
    const part = await env.MEDIA.get(key, { range });
    for (const c of sampleEntryCodecs(new Uint8Array(await part.arrayBuffer()))) codecs.add(c);
  }
  if ([...codecs].some((c) => HEVC.has(c))) return "hevc";
  if ([...codecs].some((c) => H264.has(c))) return "h264";
  return null;
}

async function uploadMedia(request, env) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const spec = UPLOAD_TYPES[type];
  if (!spec) throw new HttpError(415, "Only mp4, mov, jpg, png and webp files can be uploaded");
  const len = Number(request.headers.get("Content-Length"));
  if (!len) throw new HttpError(411, "Upload size is required");
  if (len > MAX_UPLOAD_BYTES) throw new HttpError(413, "Files must be 100 MB or smaller");
  const key = `${spec.kind === "video" ? "video" : "img"}/${todayLocal().slice(0, 4)}/${crypto.randomUUID()}.${spec.ext}`;
  const contentType = spec.serveAs || type;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType } });
  const head = await env.MEDIA.get(key, { range: { offset: 0, length: 16 } });
  const bytes = new Uint8Array(await head.arrayBuffer());
  if (!sniffOk(bytes, type)) {
    await env.MEDIA.delete(key);
    throw new HttpError(415, "That file doesn't look like a real " + spec.ext.toUpperCase());
  }
  if (spec.codecCheck && (await movVideoCodec(env, key, head.size)) !== "h264") {
    await env.MEDIA.delete(key);
    throw new HttpError(415, HEVC_VIDEO);
  }
  return json({ ok: true, key, url: mediaUrl(key), kind: spec.kind, content_type: contentType, size: head.size }, 201);
}

async function assertMediaKey(env, key, kind, field) {
  if (key == null || key === "") return null;
  if (!MEDIA_KEY_RE.test(key)) throw new HttpError(400, `${field} is not a valid upload`);
  if (kind === "photo" && !key.startsWith("img/")) throw new HttpError(400, `${field} must be a photo`);
  if (kind === "video" && !key.startsWith("video/")) throw new HttpError(400, `${field} must be a video`);
  const head = await env.MEDIA.head(key);
  if (!head) throw new HttpError(400, `${field} upload was not found`);
  return { key, head };
}

// Every column that can point at an R2 object. An object is deleted once none of them do.
const MEDIA_REFS = [
  ["specials", "image_key"], ["specials", "image_orig_key"],
  ["events", "flyer_key"], ["events", "flyer_orig_key"],
  ["media", "key_or_url"], ["media", "orig_key"],
  ["menu", "photo_key"], ["menu", "photo_orig_key"],
  ["treats", "photo_key"], ["treats", "photo_orig_key"],
  ["catering_packages", "photo_key"], ["catering_packages", "photo_orig_key"],
];
async function deleteMediaIfUnused(env, ...keys) {
  let deleted = 0;
  for (const key of new Set(keys)) {
    if (!key || !MEDIA_KEY_RE.test(key)) continue;
    const ref = await env.DB.prepare(`SELECT ${MEDIA_REFS.map(([t, c]) => `(SELECT COUNT(*) FROM ${t} WHERE ${c} = ?1)`).join(" + ")} AS n`).bind(key).first();
    if ((ref?.n ?? 0) > 0) continue;
    await env.MEDIA.delete(key);
    deleted++;
  }
  return deleted;
}
// After an update, drop whichever of the row's old files it no longer uses.
const releaseReplaced = (env, prev, row, cols) => deleteMediaIfUnused(env, ...cols.filter((c) => prev?.[c] && prev[c] !== row[c]).map((c) => prev[c]));

const shapeOrder = (o) => ({ ...o, items: JSON.parse(o.items_json), items_json: undefined, total: dollars(o.total_cents), confirmed: !!o.confirmed, paid: !!o.paid });
const shapeAdminSpecial = (s) => ({ ...s, price: dollars(s.price_cents), image: mediaUrl(s.image_key), image_orig: mediaUrl(s.image_orig_key), active: !!s.active });
const shapeAdminEvent = (e) => ({ ...e, flyer: mediaUrl(e.flyer_key), flyer_orig: mediaUrl(e.flyer_orig_key),
  published: !!e.published, signups_open: !!e.signups_open, ticket_price: dollars(e.ticket_price_cents), taken: e.taken ?? 0, signups: e.signups ?? 0,
  paid_cents: e.paid_cents ?? 0, expected_cents: e.expected_cents ?? 0 });
const shapeRequest = (r) => ({ ...r, client_hash: undefined, interests: JSON.parse(r.interests || "[]"), quote: dollars(r.quote_cents) });
const shapeCatering = (c) => ({ enabled: !!c.enabled, intro: c.intro, notice_days: c.notice_days, items: JSON.parse(c.items_json || "[]"), updated_at: c.updated_at });
const shapeAdminPackage = (k) => ({ ...k, from: dollars(k.from_cents), photo: mediaUrl(k.photo_key), photo_orig: mediaUrl(k.photo_orig_key), active: !!k.active });
async function packageFromBody(env, b) {
  let serves = null;
  if (b.serves != null && b.serves !== "") {
    serves = Number(b.serves);
    if (!Number.isInteger(serves) || serves < 1 || serves > 5000) throw new HttpError(400, "Serves must be a whole number from 1 to 5000");
  }
  return {
    name: str(b.name, { max: 80, required: true, field: "Name" }),
    description: str(b.description, { max: 400, field: "Description" }),
    from_cents: priceToCents(b.from, { field: "From price" }),
    serves,
    ...(await photoPair(env, b, "photo_key", "photo_orig_key", "Photo")),
    active: bool01(b.active ?? true),
  };
}
const shapeRegistration = (r) => ({ ...r, client_hash: undefined, paid: !!r.paid, checked_in: !!r.checked_in, price: dollars(r.price_cents), total: dollars(r.total_cents) });
const ADMIN_EVENT_SQL = `SELECT e.*, ${TAKEN} AS taken,
  (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS signups,
  (SELECT COALESCE(SUM(total_cents), 0) FROM registrations r WHERE r.event_id = e.id) AS expected_cents,
  (SELECT COALESCE(SUM(total_cents), 0) FROM registrations r WHERE r.event_id = e.id AND r.paid = 1) AS paid_cents
  FROM events e`;
const shapeAdminMedia = (m) => ({ ...m, url: m.kind === "instagram" ? m.key_or_url : mediaUrl(m.key_or_url), orig: mediaUrl(m.orig_key), featured: !!m.featured });

// A framed photo and its untouched original travel together; an original without a photo is dropped.
async function photoPair(env, b, keyField, origField, label) {
  const key = (await assertMediaKey(env, b[keyField], "photo", label))?.key ?? null;
  const orig = key ? (await assertMediaKey(env, b[origField], "photo", label))?.key ?? null : null;
  return { [keyField]: key, [origField]: orig };
}

async function specialFromBody(env, b) {
  return {
    kind: b.kind === "cotm" ? "cotm" : "special",
    title: str(b.title, { max: 120, required: true, field: "Title" }),
    body: str(b.body, { max: 1000, field: "Description" }),
    price_cents: priceToCents(b.price),
    ...(await photoPair(env, b, "image_key", "image_orig_key", "Image")),
    starts: optDate(b.starts, "Start date"),
    ends: optDate(b.ends, "End date"),
    active: bool01(b.active ?? true),
  };
}
async function eventFromBody(env, b) {
  if (!isDate(b.date)) throw new HttpError(400, "Event date must be YYYY-MM-DD");
  const ticket_price_cents = priceToCents(b.ticket_price, { field: "Price per spot" });
  let capacity = null;
  if (b.capacity != null && b.capacity !== "") {
    capacity = Number(b.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new HttpError(400, "Spots must be a whole number from 1 to 1000");
  }
  const signup_closes = optDate(b.signup_closes, "Signups close");
  if (signup_closes && signup_closes > b.date) throw new HttpError(400, "Signups should close on or before the event day");
  const signups_open = bool01(b.signups_open ?? false);
  if (signups_open && ticket_price_cents == null) throw new HttpError(400, "Add a price per spot to take signups (0 if it's free)");
  return {
    title: str(b.title, { max: 120, required: true, field: "Title" }),
    date: b.date,
    body: str(b.body, { max: 1000, field: "Details" }),
    ...(await photoPair(env, b, "flyer_key", "flyer_orig_key", "Flyer")),
    rsvp_url: httpsUrl(b.rsvp_url, "RSVP link"),
    published: bool01(b.published ?? true),
    ticket_price_cents, capacity, signup_closes, signups_open,
  };
}

function slugify(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "flavor";
}
function dateRange(b) {
  const starts = optDate(b.starts, "Start date"), ends = optDate(b.ends, "End date");
  if (starts && ends && ends < starts) throw new HttpError(400, "The end date is before the start date");
  return { starts, ends };
}
const shapeAdminFlavor = (r) => ({
  id: r.key.slice(7), key: r.key, name: r.name, short: r.short, description: r.description, photo: flavorPhoto(r),
  photo_key: r.photo_key, photo_orig_key: r.photo_orig_key, photo_orig: mediaUrl(r.photo_orig_key),
  starts: r.starts, ends: r.ends, in_flight: !!r.in_flight, active: !!r.active, sort: r.sort,
});
const shapeAdminTreat = (t) => ({ ...t, price: dollars(t.price_cents), photo: mediaUrl(t.photo_key), photo_orig: mediaUrl(t.photo_orig_key), active: !!t.active });

async function flavorFromBody(env, b) {
  const name = str(b.name, { max: 60, required: true, field: "Name" });
  return {
    name,
    short: str(b.short, { max: 20, field: "Short name" }) || name.slice(0, 20),
    description: str(b.description, { max: 300, field: "Description" }),
    ...(await photoPair(env, b, "photo_key", "photo_orig_key", "Photo")),
    ...dateRange(b),
    in_flight: bool01(b.in_flight ?? true),
    active: bool01(b.active ?? true),
  };
}
async function treatFromBody(env, b) {
  return {
    name: str(b.name, { max: 80, required: true, field: "Name" }),
    price_cents: priceToCents(b.price, { field: "Price", allowNull: false }),
    description: str(b.description, { max: 300, field: "Description" }),
    category: str(b.category, { max: 40, field: "Category" }),
    ...(await photoPair(env, b, "photo_key", "photo_orig_key", "Photo")),
    ...dateRange(b),
    active: bool01(b.active ?? true),
  };
}

// Up/down buttons: swap with the neighbour, then renumber the whole list so sorts stay tidy.
async function moveRow(DB, { table, idCol, where, base }, id, dir) {
  const { results } = await DB.prepare(`SELECT ${idCol} AS id FROM ${table} ${where} ORDER BY sort, ${idCol}`).all();
  const ids = results.map((r) => String(r.id));
  const i = ids.indexOf(String(id));
  if (i < 0) throw new HttpError(404, "Not found");
  const j = dir === "up" ? i - 1 : dir === "down" ? i + 1 : i;
  if (j < 0 || j >= ids.length || j === i) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await DB.batch(ids.map((v, k) => DB.prepare(`UPDATE ${table} SET sort = ?1 WHERE ${idCol} = ?2`).bind(base + k * 10, table === "treats" ? Number(v) : v)));
}

async function adminApi(request, env, path, admin) {
  const m = request.method;
  const seg = path.split("/").filter(Boolean); // ["specials", "3"]
  const id = seg[1];
  const DB = env.DB;

  if (seg[0] === "me" && m === "GET") return json({ email: admin.email, dev: !!admin.dev });

  if (seg[0] === "upload" && m === "PUT") return uploadMedia(request, env);

  if (seg[0] === "payments") {
    if (m === "GET" && !id) {
      const { results } = await DB.prepare("SELECT * FROM payment_methods ORDER BY sort, id").all();
      return json({ payments: results.map(shapePayment) });
    }
    if (m === "PUT" && id) return updatePayment(request, env, id, admin);
  }

  if (seg[0] === "orders") {
    if (m === "GET" && !id) {
      const filter = new URL(request.url).searchParams.get("filter") || "open";
      const where = filter === "all" ? "" : "WHERE confirmed = 0 OR paid = 0";
      const { results } = await DB.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT 200`).all();
      return json({ orders: results.map(shapeOrder) });
    }
    if (m === "PATCH" && id) {
      const b = await readJson(request);
      const sets = [], vals = [];
      for (const f of ["confirmed", "paid"]) if (f in b) { sets.push(`${f} = ?${vals.length + 1}`); vals.push(bool01(b[f])); }
      if (!sets.length) throw new HttpError(400, "Nothing to update");
      vals.push(new Date().toISOString(), admin.email, id);
      const n = vals.length;
      const r = await DB.prepare(`UPDATE orders SET ${sets.join(", ")}, updated_at = ?${n - 2}, updated_by = ?${n - 1} WHERE id = ?${n}`).bind(...vals).run();
      if (!r.meta.changes) throw new HttpError(404, "Order not found");
      return json({ order: shapeOrder(await DB.prepare("SELECT * FROM orders WHERE id = ?1").bind(id).first()) });
    }
  }

  if (seg[0] === "specials") {
    if (m === "GET" && !id) {
      const { results } = await DB.prepare("SELECT * FROM specials ORDER BY active DESC, CASE kind WHEN 'cotm' THEN 0 ELSE 1 END, id DESC").all();
      return json({ specials: results.map(shapeAdminSpecial) });
    }
    if ((m === "POST" && !id) || (m === "PUT" && id)) {
      const s = await specialFromBody(env, await readJson(request));
      const cols = Object.keys(s), vals = Object.values(s);
      let row;
      if (m === "POST") {
        row = await DB.prepare(`INSERT INTO specials (${cols.join(", ")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(", ")}) RETURNING *`).bind(...vals).first();
      } else {
        const prev = await DB.prepare("SELECT image_key, image_orig_key FROM specials WHERE id = ?1").bind(Number(id)).first();
        row = await DB.prepare(`UPDATE specials SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(", ")} WHERE id = ?${cols.length + 1} RETURNING *`).bind(...vals, Number(id)).first();
        if (!row) throw new HttpError(404, "Special not found");
        await releaseReplaced(env, prev, row, ["image_key", "image_orig_key"]);
      }
      return json({ special: shapeAdminSpecial(row) }, m === "POST" ? 201 : 200);
    }
    if (m === "DELETE" && id) {
      const row = await DB.prepare("DELETE FROM specials WHERE id = ?1 RETURNING image_key, image_orig_key").bind(Number(id)).first();
      await deleteMediaIfUnused(env, row?.image_key, row?.image_orig_key);
      return json({ ok: true });
    }
  }

  if (seg[0] === "orders.csv" && m === "GET") return ordersCsv(env, new URL(request.url));
  if (seg[0] === "requests.csv" && m === "GET") return requestsCsv(env, new URL(request.url));

  if (seg[0] === "requests") {
    if (m === "GET" && !id) {
      const filter = new URL(request.url).searchParams.get("filter") || "open";
      const where = filter === "all" ? "" : "WHERE status IN ('new', 'quoted', 'booked')";
      const { results } = await DB.prepare(`SELECT * FROM requests ${where} ORDER BY created_at DESC LIMIT 300`).all();
      const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'new'").first();
      return json({ requests: results.map(shapeRequest), new_count: n });
    }
    if (m === "PATCH" && id) {
      const b = await readJson(request);
      const sets = [], vals = [];
      const set = (col, v) => { sets.push(`${col} = ?${vals.length + 1}`); vals.push(v); };
      if ("status" in b) { if (!REQUEST_STATUSES.includes(b.status)) throw new HttpError(400, "Unknown status"); set("status", b.status); }
      if ("quote" in b) set("quote_cents", priceToCents(b.quote, { field: "Quote" }) ?? null);
      if ("admin_notes" in b) set("admin_notes", str(b.admin_notes, { max: 2000, field: "Notes" }));
      if (!sets.length) throw new HttpError(400, "Nothing to update");
      set("updated_at", new Date().toISOString()); set("updated_by", admin.email);
      const row = await DB.prepare(`UPDATE requests SET ${sets.join(", ")} WHERE id = ?${vals.length + 1} RETURNING *`).bind(...vals, id).first();
      if (!row) throw new HttpError(404, "Request not found");
      return json({ request: shapeRequest(row) });
    }
  }

  if (seg[0] === "catering") {
    const sub = seg[1], pid = seg[2];
    if (!sub && m === "GET") {
      const [cat, pk] = await Promise.all([DB.prepare("SELECT * FROM catering WHERE id = 1").first(), DB.prepare("SELECT * FROM catering_packages ORDER BY sort, id").all()]);
      return json({ catering: shapeCatering(cat), packages: pk.results.map(shapeAdminPackage) });
    }
    if (!sub && m === "PUT") {
      const b = await readJson(request);
      const cur = await DB.prepare("SELECT * FROM catering WHERE id = 1").first();
      const notice = "notice_days" in b ? Number(b.notice_days) : cur.notice_days;
      if (!Number.isInteger(notice) || notice < 0 || notice > 90) throw new HttpError(400, "Notice must be 0 to 90 days");
      let items = JSON.parse(cur.items_json || "[]");
      if ("items" in b) {
        if (!Array.isArray(b.items)) throw new HttpError(400, "Items must be a list");
        items = b.items.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean);
        if (items.length > 20) throw new HttpError(400, "20 things at most");
        if (items.some((x) => x.length > 60)) throw new HttpError(400, "Each thing must be 60 letters or fewer");
      }
      const row = await DB.prepare("UPDATE catering SET enabled = ?1, intro = ?2, notice_days = ?3, items_json = ?4, updated_at = ?5, updated_by = ?6 WHERE id = 1 RETURNING *")
        .bind("enabled" in b ? bool01(b.enabled) : cur.enabled, "intro" in b ? str(b.intro, { max: 600, field: "Intro" }) : cur.intro, notice, JSON.stringify(items), new Date().toISOString(), admin.email).first();
      return json({ catering: shapeCatering(row) });
    }
    if (sub === "packages") {
      if (m === "GET" && !pid) {
        const { results } = await DB.prepare("SELECT * FROM catering_packages ORDER BY sort, id").all();
        return json({ packages: results.map(shapeAdminPackage) });
      }
      if (m === "POST" && pid && seg[3] === "move") {
        await moveRow(DB, { table: "catering_packages", idCol: "id", where: "", base: 10 }, Number(pid), (await readJson(request)).dir);
        return json({ ok: true });
      }
      if (m === "POST" && !pid) {
        const k = await packageFromBody(env, await readJson(request));
        const { s } = await DB.prepare("SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM catering_packages").first();
        const row = { ...k, sort: s }, cols = Object.keys(row);
        const saved = await DB.prepare(`INSERT INTO catering_packages (${cols.join(", ")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(", ")}) RETURNING *`).bind(...Object.values(row)).first();
        return json({ package: shapeAdminPackage(saved) }, 201);
      }
      if (m === "PUT" && pid) {
        const prev = await DB.prepare("SELECT * FROM catering_packages WHERE id = ?1").bind(Number(pid)).first();
        if (!prev) throw new HttpError(404, "Package not found");
        const k = await packageFromBody(env, await readJson(request)), cols = Object.keys(k);
        const row = await DB.prepare(`UPDATE catering_packages SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(", ")} WHERE id = ?${cols.length + 1} RETURNING *`).bind(...Object.values(k), Number(pid)).first();
        await releaseReplaced(env, prev, row, ["photo_key", "photo_orig_key"]);
        return json({ package: shapeAdminPackage(row) });
      }
      if (m === "DELETE" && pid) {
        const row = await DB.prepare("DELETE FROM catering_packages WHERE id = ?1 RETURNING *").bind(Number(pid)).first();
        if (!row) throw new HttpError(404, "Package not found");
        await deleteMediaIfUnused(env, row.photo_key, row.photo_orig_key);
        return json({ ok: true });
      }
    }
  }

  if (seg[0] === "registrations" && id) {
    if (m === "PATCH") {
      const b = await readJson(request);
      const sets = [], vals = [];
      for (const f of ["paid", "checked_in"]) if (f in b) { sets.push(`${f} = ?${vals.length + 1}`); vals.push(bool01(b[f])); }
      if (!sets.length) throw new HttpError(400, "Nothing to update");
      vals.push(new Date().toISOString(), admin.email, id);
      const n = vals.length;
      const row = await DB.prepare(`UPDATE registrations SET ${sets.join(", ")}, updated_at = ?${n - 2}, updated_by = ?${n - 1} WHERE id = ?${n} RETURNING *`).bind(...vals).first();
      if (!row) throw new HttpError(404, "Signup not found");
      return json({ registration: shapeRegistration(row) });
    }
    if (m === "DELETE") {
      const row = await DB.prepare("DELETE FROM registrations WHERE id = ?1 RETURNING id").bind(id).first();
      if (!row) throw new HttpError(404, "Signup not found");
      return json({ ok: true });
    }
  }

  if (seg[0] === "events" && id && seg[2]) {
    if (seg[2] === "registrations.csv" && m === "GET") return signupsCsv(env, id);
    if (seg[2] === "registrations" && m === "GET") {
      const event = await DB.prepare(`${ADMIN_EVENT_SQL} WHERE e.id = ?1`).bind(Number(id)).first();
      if (!event) throw new HttpError(404, "Event not found");
      const { results } = await DB.prepare("SELECT * FROM registrations WHERE event_id = ?1 ORDER BY created_at").bind(event.id).all();
      return json({ event: shapeAdminEvent(event), registrations: results.map(shapeRegistration) });
    }
    if (seg[2] === "register" && m === "POST") return registerForEvent(request, env, id, { preview: true });
  }

  if (seg[0] === "events") {
    if (m === "GET" && !id) {
      const { results } = await DB.prepare(`${ADMIN_EVENT_SQL} ORDER BY e.date DESC, e.id DESC`).all();
      return json({ events: results.map(shapeAdminEvent) });
    }
    if (m === "GET" && id) { // admin preview of a (draft) event as the site would show it
      const e = await DB.prepare(`SELECT e.*, ${TAKEN} AS taken FROM events e WHERE e.id = ?1`).bind(Number(id)).first();
      if (!e) throw new HttpError(404, "Event not found");
      return json({ event: { id: e.id, title: e.title, date: e.date, body: e.body, flyer: mediaUrl(e.flyer_key), rsvp_url: e.rsvp_url, published: !!e.published, signup: eventSignup(e, todayLocal()) } });
    }
    if ((m === "POST" && !id) || (m === "PUT" && id)) {
      const e = await eventFromBody(env, await readJson(request));
      const cols = Object.keys(e), vals = Object.values(e);
      let row;
      if (m === "POST") {
        row = await DB.prepare(`INSERT INTO events (${cols.join(", ")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(", ")}) RETURNING *`).bind(...vals).first();
      } else {
        const prev = await DB.prepare("SELECT flyer_key, flyer_orig_key FROM events WHERE id = ?1").bind(Number(id)).first();
        row = await DB.prepare(`UPDATE events SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(", ")} WHERE id = ?${cols.length + 1} RETURNING *`).bind(...vals, Number(id)).first();
        if (!row) throw new HttpError(404, "Event not found");
        await releaseReplaced(env, prev, row, ["flyer_key", "flyer_orig_key"]);
      }
      return json({ event: shapeAdminEvent(row) }, m === "POST" ? 201 : 200);
    }
    if (m === "DELETE" && id) {
      await DB.prepare("DELETE FROM registrations WHERE event_id = ?1").bind(Number(id)).run(); // its signups go with it
      const row = await DB.prepare("DELETE FROM events WHERE id = ?1 RETURNING flyer_key, flyer_orig_key").bind(Number(id)).first();
      await deleteMediaIfUnused(env, row?.flyer_key, row?.flyer_orig_key);
      return json({ ok: true });
    }
  }

  if (seg[0] === "media") {
    if (m === "GET" && !id) {
      const { results } = await DB.prepare("SELECT * FROM media ORDER BY id DESC").all();
      return json({ media: results.map(shapeAdminMedia) });
    }
    if (m === "POST" && !id) {
      const b = await readJson(request);
      const kind = ["photo", "video", "instagram"].includes(b.kind) ? b.kind : null;
      if (!kind) throw new HttpError(400, "Kind must be photo, video or instagram");
      let keyOrUrl, contentType = null, size = null, origKey = null;
      if (kind === "instagram") {
        keyOrUrl = httpsUrl(b.key_or_url, "Instagram link", ["www.instagram.com", "instagram.com"]);
        if (!keyOrUrl) throw new HttpError(400, "Instagram link is required");
      } else {
        const r = await assertMediaKey(env, b.key_or_url, kind, "File");
        if (!r) throw new HttpError(400, "Upload a file first");
        keyOrUrl = r.key; contentType = r.head.httpMetadata?.contentType ?? null; size = r.head.size;
        if (kind === "photo") origKey = (await assertMediaKey(env, b.orig_key, "photo", "Original photo"))?.key ?? null;
      }
      const row = await DB.prepare(
        "INSERT INTO media (kind, key_or_url, caption, featured, content_type, size_bytes, orig_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *"
      ).bind(kind, keyOrUrl, str(b.caption, { max: 300, field: "Caption" }), bool01(b.featured), contentType, size, origKey).first();
      return json({ media: shapeAdminMedia(row) }, 201);
    }
    if (m === "PATCH" && id) {
      const b = await readJson(request);
      if ("key_or_url" in b) { // "Edit photo": swap in the re-framed picture (photos only)
        const prev = await DB.prepare("SELECT * FROM media WHERE id = ?1").bind(Number(id)).first();
        if (!prev) throw new HttpError(404, "Media not found");
        if (prev.kind !== "photo") throw new HttpError(400, "Only photos can be edited");
        const r = await assertMediaKey(env, b.key_or_url, "photo", "Photo");
        if (!r) throw new HttpError(400, "Upload a photo first");
        const orig = (await assertMediaKey(env, b.orig_key, "photo", "Original photo"))?.key ?? null;
        const row = await DB.prepare("UPDATE media SET key_or_url = ?1, orig_key = ?2, content_type = ?3, size_bytes = ?4 WHERE id = ?5 RETURNING *")
          .bind(r.key, orig, r.head.httpMetadata?.contentType ?? null, r.head.size, Number(id)).first();
        await releaseReplaced(env, prev, row, ["key_or_url", "orig_key"]);
        return json({ media: shapeAdminMedia(row) });
      }
      const row = await DB.prepare(
        "UPDATE media SET caption = COALESCE(?1, caption), featured = COALESCE(?2, featured) WHERE id = ?3 RETURNING *"
      ).bind("caption" in b ? str(b.caption, { max: 300, field: "Caption" }) ?? "" : null, "featured" in b ? bool01(b.featured) : null, Number(id)).first();
      if (!row) throw new HttpError(404, "Media not found");
      return json({ media: shapeAdminMedia(row) });
    }
    if (m === "DELETE" && id) {
      const row = await DB.prepare("DELETE FROM media WHERE id = ?1 RETURNING *").bind(Number(id)).first();
      if (row && row.kind !== "instagram") await deleteMediaIfUnused(env, row.key_or_url, row.orig_key);
      return json({ ok: true });
    }
  }

  if (seg[0] === "flavors") {
    const key = id ? "flavor-" + id : null;
    if (id && !FLAVOR_ID_RE.test(id)) throw new HttpError(404, "Flavor not found");
    if (m === "GET" && !id) {
      const { results } = await DB.prepare("SELECT * FROM menu WHERE kind = 'flavor' ORDER BY sort, key").all();
      return json({ flavors: results.map(shapeAdminFlavor) });
    }
    if (m === "POST" && id && seg[2] === "move") {
      await moveRow(DB, { table: "menu", idCol: "key", where: "WHERE kind = 'flavor'", base: 100 }, key, (await readJson(request)).dir);
      return json({ ok: true });
    }
    if (m === "POST" && !id) {
      const f = await flavorFromBody(env, await readJson(request));
      let slug = slugify(f.short || f.name);
      for (let n = 2; await DB.prepare("SELECT 1 FROM menu WHERE key = ?1").bind("flavor-" + slug).first(); n++) slug = `${slugify(f.short || f.name).slice(0, 28)}-${n}`;
      const { s } = await DB.prepare("SELECT COALESCE(MAX(sort), 100) + 10 AS s FROM menu WHERE kind = 'flavor'").first();
      const row = { key: "flavor-" + slug, kind: "flavor", price_cents: null, sort: s, ...f };
      const cols = Object.keys(row);
      const saved = await DB.prepare(`INSERT INTO menu (${cols.join(", ")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(", ")}) RETURNING *`).bind(...Object.values(row)).first();
      return json({ flavor: shapeAdminFlavor(saved) }, 201);
    }
    if (m === "PUT" && id) {
      const prev = await DB.prepare("SELECT * FROM menu WHERE key = ?1 AND kind = 'flavor'").bind(key).first();
      if (!prev) throw new HttpError(404, "Flavor not found");
      const f = await flavorFromBody(env, await readJson(request));
      const cols = Object.keys(f);
      const row = await DB.prepare(`UPDATE menu SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(", ")} WHERE key = ?${cols.length + 1} RETURNING *`).bind(...Object.values(f), key).first();
      await releaseReplaced(env, prev, row, ["photo_key", "photo_orig_key"]);
      return json({ flavor: shapeAdminFlavor(row) });
    }
    if (m === "DELETE" && id) {
      const row = await DB.prepare("DELETE FROM menu WHERE key = ?1 AND kind = 'flavor' RETURNING *").bind(key).first();
      if (!row) throw new HttpError(404, "Flavor not found");
      await deleteMediaIfUnused(env, row.photo_key, row.photo_orig_key);
      return json({ ok: true });
    }
  }

  if (seg[0] === "treats") {
    if (m === "GET" && !id) {
      const { results } = await DB.prepare("SELECT * FROM treats ORDER BY sort, id").all();
      return json({ treats: results.map(shapeAdminTreat) });
    }
    if (m === "POST" && id && seg[2] === "move") {
      await moveRow(DB, { table: "treats", idCol: "id", where: "", base: 10 }, Number(id), (await readJson(request)).dir);
      return json({ ok: true });
    }
    if (m === "POST" && !id) {
      const t = await treatFromBody(env, await readJson(request));
      const { s } = await DB.prepare("SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM treats").first();
      const row = { ...t, sort: s }, cols = Object.keys(row);
      const saved = await DB.prepare(`INSERT INTO treats (${cols.join(", ")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(", ")}) RETURNING *`).bind(...Object.values(row)).first();
      return json({ treat: shapeAdminTreat(saved) }, 201);
    }
    if (m === "PUT" && id) {
      const prev = await DB.prepare("SELECT * FROM treats WHERE id = ?1").bind(Number(id)).first();
      if (!prev) throw new HttpError(404, "Treat not found");
      const t = await treatFromBody(env, await readJson(request)), cols = Object.keys(t);
      const row = await DB.prepare(`UPDATE treats SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(", ")} WHERE id = ?${cols.length + 1} RETURNING *`).bind(...Object.values(t), Number(id)).first();
      await releaseReplaced(env, prev, row, ["photo_key", "photo_orig_key"]);
      return json({ treat: shapeAdminTreat(row) });
    }
    if (m === "PATCH" && id) { // on/off switch
      const b = await readJson(request);
      const row = await DB.prepare("UPDATE treats SET active = ?1 WHERE id = ?2 RETURNING *").bind(bool01(b.active), Number(id)).first();
      if (!row) throw new HttpError(404, "Treat not found");
      return json({ treat: shapeAdminTreat(row) });
    }
    if (m === "DELETE" && id) {
      const row = await DB.prepare("DELETE FROM treats WHERE id = ?1 RETURNING *").bind(Number(id)).first();
      if (!row) throw new HttpError(404, "Treat not found");
      await deleteMediaIfUnused(env, row.photo_key, row.photo_orig_key);
      return json({ ok: true });
    }
  }

  if (seg[0] === "menu") {
    if (m === "GET" && !id) {
      const { results } = await DB.prepare("SELECT * FROM menu ORDER BY sort").all();
      return json({ menu: results.map((r) => ({ ...r, price: dollars(r.price_cents), active: !!r.active })) });
    }
    if (m === "PUT" && id) {
      const b = await readJson(request);
      const cur = await DB.prepare("SELECT * FROM menu WHERE key = ?1").bind(id).first();
      if (!cur) throw new HttpError(404, "Menu item not found");
      const price = cur.kind === "flavor" ? null : ("price" in b ? priceToCents(b.price, { allowNull: false }) : cur.price_cents);
      const active = "active" in b ? bool01(b.active) : cur.active;
      const row = await DB.prepare("UPDATE menu SET price_cents = ?1, active = ?2 WHERE key = ?3 RETURNING *").bind(price, active, id).first();
      return json({ item: { ...row, price: dollars(row.price_cents), active: !!row.active } });
    }
  }

  throw new HttpError(404, "Not found");
}

/* ============ Router ============ */
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
    return Response.redirect(url.toString(), 301);
  }

  const isAdminPage = path === "/admin" || path.startsWith("/admin/");
  const isAdminApi = path.startsWith("/api/admin/") || path === "/api/admin";
  if (isAdminPage || isAdminApi) {
    let admin;
    try { admin = await requireAdmin(request, env); }
    catch (e) {
      const status = e instanceof AccessError ? e.status : 403;
      return withSecurityHeaders(isAdminApi ? json({ error: e.message }, status) : new Response(`Admin sign-in required: ${e.message}`, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } }), { admin: true });
    }
    if (isAdminApi) {
      if (!["GET", "HEAD"].includes(request.method)) {
        // Same-origin only for writes, on top of the Access check. Browsers always send
        // Sec-Fetch-Site and pages can't forge it; fall back to an exact Origin match.
        const site = request.headers.get("Sec-Fetch-Site");
        const origin = request.headers.get("Origin");
        const sameOrigin = site ? site === "same-origin" : origin === url.origin;
        if (!sameOrigin) return withSecurityHeaders(json({ error: "Cross-site request blocked" }, 403), { admin: true });
      }
      return withSecurityHeaders(await adminApi(request, env, path.replace(/^\/api\/admin\/?/, ""), admin), { admin: true });
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request), { admin: true });
  }

  if (path === "/api/content" && request.method === "GET") return withSecurityHeaders(json(await getContent(env)));
  if (path === "/api/orders" && request.method === "POST") return withSecurityHeaders(await createOrder(request, env));
  if (path === "/api/requests" && request.method === "POST") return withSecurityHeaders(await createRequest(request, env));
  const reg = path.match(/^\/api\/events\/(\d+)\/register$/);
  if (reg && request.method === "POST") return withSecurityHeaders(await registerForEvent(request, env, reg[1]));
  if (path.startsWith("/api/")) return withSecurityHeaders(json({ error: "Not found" }, 404));
  if (path.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) {
    return withSecurityHeaders(await serveMedia(request, env, decodeURIComponent(path.slice(7))));
  }
  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) return withSecurityHeaders(json({ error: e.message }, e.status, e.headers));
      console.error("unhandled", e?.stack || e);
      return withSecurityHeaders(json({ error: "Something went wrong. Please try again or text Shaun." }, 500));
    }
  },
};
