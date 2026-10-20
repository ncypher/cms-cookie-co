import { requireAdmin, AccessError } from "./access.js";

/* ============ Constants ============ */
const TZ = "America/Detroit";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_TYPES = {
  "image/jpeg": { ext: "jpg", kind: "photo" },
  "image/png": { ext: "png", kind: "photo" },
  "image/webp": { ext: "webp", kind: "photo" },
  "video/mp4": { ext: "mp4", kind: "video" },
};
const FLAVOR_IDS = ["cc", "dcc", "dcss", "fs"];
const SHORT = { cc: "Choc Chip", dcc: "Double Choc", dcss: "Sea Salt", fs: "Frosted Sugar" };
const MEDIA_KEY_RE = /^(img|video)\/\d{4}\/[0-9a-f-]{36}\.(jpg|png|webp|mp4)$/;

/* ============ Helpers ============ */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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

async function getContent(env) {
  const today = todayLocal();
  const [menu, specials, events, media] = await env.DB.batch([
    env.DB.prepare("SELECT key, kind, name, price_cents, active FROM menu ORDER BY sort"),
    env.DB.prepare(
      `SELECT * FROM specials WHERE active = 1
         AND (starts IS NULL OR starts <= ?1) AND (ends IS NULL OR ends >= ?1)
       ORDER BY CASE kind WHEN 'cotm' THEN 0 ELSE 1 END, id DESC`
    ).bind(today),
    env.DB.prepare("SELECT * FROM events WHERE date >= ?1 ORDER BY date, id LIMIT 6").bind(today),
    env.DB.prepare("SELECT * FROM media WHERE featured = 1 ORDER BY id DESC LIMIT 12"),
  ]);
  const all = specials.results.map(shapeSpecial);
  const featured = media.results.map(shapeMedia);
  return {
    today,
    menu: menu.results.map((m) => ({ key: m.key, kind: m.kind, name: m.name, price: dollars(m.price_cents), active: !!m.active })),
    cookieOfTheMonth: all.find((s) => s.kind === "cotm") || null,
    specials: all.filter((s) => s.kind === "special"),
    events: events.results.map((e) => ({ id: e.id, title: e.title, date: e.date, body: e.body, flyer: mediaUrl(e.flyer_key), rsvp_url: e.rsvp_url })),
    tip: featured.find((m) => m.kind === "video" || m.kind === "instagram") || null,
    photos: featured.filter((m) => m.kind === "photo"),
  };
}

/* ============ Public: orders ============ */
async function priceOrder(env, items) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, "Your order is empty");
  if (items.length > 30) throw new HttpError(400, "Too many items in one order");
  const { results } = await env.DB.prepare("SELECT key, kind, name, price_cents, active FROM menu").all();
  const menu = Object.fromEntries(results.map((r) => [r.key, r]));
  const activeFlavor = (id) => FLAVOR_IDS.includes(id) && menu["flavor-" + id]?.active;
  const item = (key) => {
    const m = menu[key];
    if (!m || !m.active || m.price_cents == null) throw new HttpError(400, `${m ? m.name : key} isn't available right now`);
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
        const flavors = it.flavors && typeof it.flavors === "object" ? it.flavors : {};
        let sum = 0; const parts = [];
        for (const [id, n] of Object.entries(flavors)) {
          if (!activeFlavor(id)) throw new HttpError(400, `That flavor isn't available right now`);
          if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "Box flavor counts are invalid");
          if (n) { sum += n; parts.push(`${n} ${SHORT[id]}`); }
        }
        if (sum !== size) throw new HttpError(400, `A ${size === 6 ? "half-dozen" : "dozen"} box needs exactly ${size} cookies`);
        name = size === 6 ? "Half-dozen box" : "Dozen box"; detail = parts.join(", "); unit = m.price_cents;
        break;
      }
      case "single": {
        if (!activeFlavor(it.flavor)) throw new HttpError(400, "That flavor isn't available right now");
        name = menu["flavor-" + it.flavor].name; detail = "Single cookie"; unit = item("single").price_cents;
        break;
      }
      case "flight": { const m = item("flight"); name = m.name; detail = "One of each flavor"; unit = m.price_cents; break; }
      case "gram": { const m = item("gram"); name = m.name; unit = m.price_cents; break; }
      case "mini": {
        const size = Number(it.size);
        if (size !== 12 && size !== 24) throw new HttpError(400, "Mini lunch boxes come in 12 or 24");
        const m = item("mini" + size); name = m.name; unit = m.price_cents;
        break;
      }
      case "special": {
        const today = todayLocal();
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

function newOrderId() {
  const d = todayLocal().slice(5).replace("-", "");
  const n = crypto.getRandomValues(new Uint16Array(1))[0] % 9000 + 1000;
  return `CMS-${d}-${n}`;
}

async function createOrder(request, env) {
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
        `INSERT INTO orders (id, name, phone, wanted_date, fulfillment, dietary, notes, items_json, total_cents)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(id, name, phone, body.date, fulfillment, dietary, notes, JSON.stringify(lines), total_cents).run();
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

/* ============ Admin API ============ */
function sniffOk(bytes, type) {
  const b = bytes, ascii = (o, n) => String.fromCharCode(...b.slice(o, o + n));
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/png") return b[0] === 0x89 && ascii(1, 3) === "PNG";
  if (type === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
  if (type === "video/mp4") return ascii(4, 4) === "ftyp";
  return false;
}

async function uploadMedia(request, env) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const spec = UPLOAD_TYPES[type];
  if (!spec) throw new HttpError(415, "Only mp4, jpg, png and webp files can be uploaded");
  const len = Number(request.headers.get("Content-Length"));
  if (!len) throw new HttpError(411, "Upload size is required");
  if (len > MAX_UPLOAD_BYTES) throw new HttpError(413, "Files must be 100 MB or smaller");
  const key = `${spec.kind === "video" ? "video" : "img"}/${todayLocal().slice(0, 4)}/${crypto.randomUUID()}.${spec.ext}`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });
  const head = await env.MEDIA.get(key, { range: { offset: 0, length: 16 } });
  const bytes = new Uint8Array(await head.arrayBuffer());
  if (!sniffOk(bytes, type)) {
    await env.MEDIA.delete(key);
    throw new HttpError(415, "That file doesn't look like a real " + spec.ext.toUpperCase());
  }
  return json({ ok: true, key, url: mediaUrl(key), kind: spec.kind, content_type: type, size: head.size }, 201);
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

const shapeOrder = (o) => ({ ...o, items: JSON.parse(o.items_json), items_json: undefined, total: dollars(o.total_cents), confirmed: !!o.confirmed, paid: !!o.paid });
const shapeAdminSpecial = (s) => ({ ...s, price: dollars(s.price_cents), image: mediaUrl(s.image_key), active: !!s.active });
const shapeAdminEvent = (e) => ({ ...e, flyer: mediaUrl(e.flyer_key) });
const shapeAdminMedia = (m) => ({ ...m, url: m.kind === "instagram" ? m.key_or_url : mediaUrl(m.key_or_url), featured: !!m.featured });

async function specialFromBody(env, b) {
  return {
    kind: b.kind === "cotm" ? "cotm" : "special",
    title: str(b.title, { max: 120, required: true, field: "Title" }),
    body: str(b.body, { max: 1000, field: "Description" }),
    price_cents: priceToCents(b.price),
    image_key: (await assertMediaKey(env, b.image_key, "photo", "Image"))?.key ?? null,
    starts: optDate(b.starts, "Start date"),
    ends: optDate(b.ends, "End date"),
    active: bool01(b.active ?? true),
  };
}
async function eventFromBody(env, b) {
  if (!isDate(b.date)) throw new HttpError(400, "Event date must be YYYY-MM-DD");
  return {
    title: str(b.title, { max: 120, required: true, field: "Title" }),
    date: b.date,
    body: str(b.body, { max: 1000, field: "Details" }),
    flyer_key: (await assertMediaKey(env, b.flyer_key, "photo", "Flyer"))?.key ?? null,
    rsvp_url: httpsUrl(b.rsvp_url, "RSVP link"),
  };
}

async function adminApi(request, env, path, admin) {
  const m = request.method;
  const seg = path.split("/").filter(Boolean); // ["specials", "3"]
  const id = seg[1];
  const DB = env.DB;

  if (seg[0] === "me" && m === "GET") return json({ email: admin.email, dev: !!admin.dev });

  if (seg[0] === "upload" && m === "PUT") return uploadMedia(request, env);

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
        row = await DB.prepare(`UPDATE specials SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(", ")} WHERE id = ?${cols.length + 1} RETURNING *`).bind(...vals, Number(id)).first();
        if (!row) throw new HttpError(404, "Special not found");
      }
      return json({ special: shapeAdminSpecial(row) }, m === "POST" ? 201 : 200);
    }
    if (m === "DELETE" && id) {
      await DB.prepare("DELETE FROM specials WHERE id = ?1").bind(Number(id)).run();
      return json({ ok: true });
    }
  }

  if (seg[0] === "events") {
    if (m === "GET" && !id) {
      const { results } = await DB.prepare("SELECT * FROM events ORDER BY date DESC, id DESC").all();
      return json({ events: results.map(shapeAdminEvent) });
    }
    if ((m === "POST" && !id) || (m === "PUT" && id)) {
      const e = await eventFromBody(env, await readJson(request));
      const cols = Object.keys(e), vals = Object.values(e);
      let row;
      if (m === "POST") {
        row = await DB.prepare(`INSERT INTO events (${cols.join(", ")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(", ")}) RETURNING *`).bind(...vals).first();
      } else {
        row = await DB.prepare(`UPDATE events SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(", ")} WHERE id = ?${cols.length + 1} RETURNING *`).bind(...vals, Number(id)).first();
        if (!row) throw new HttpError(404, "Event not found");
      }
      return json({ event: shapeAdminEvent(row) }, m === "POST" ? 201 : 200);
    }
    if (m === "DELETE" && id) {
      await DB.prepare("DELETE FROM events WHERE id = ?1").bind(Number(id)).run();
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
      let keyOrUrl, contentType = null, size = null;
      if (kind === "instagram") {
        keyOrUrl = httpsUrl(b.key_or_url, "Instagram link", ["www.instagram.com", "instagram.com"]);
        if (!keyOrUrl) throw new HttpError(400, "Instagram link is required");
      } else {
        const r = await assertMediaKey(env, b.key_or_url, kind, "File");
        if (!r) throw new HttpError(400, "Upload a file first");
        keyOrUrl = r.key; contentType = r.head.httpMetadata?.contentType ?? null; size = r.head.size;
      }
      const row = await DB.prepare(
        "INSERT INTO media (kind, key_or_url, caption, featured, content_type, size_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING *"
      ).bind(kind, keyOrUrl, str(b.caption, { max: 300, field: "Caption" }), bool01(b.featured), contentType, size).first();
      return json({ media: shapeAdminMedia(row) }, 201);
    }
    if (m === "PATCH" && id) {
      const b = await readJson(request);
      const row = await DB.prepare(
        "UPDATE media SET caption = COALESCE(?1, caption), featured = COALESCE(?2, featured) WHERE id = ?3 RETURNING *"
      ).bind("caption" in b ? str(b.caption, { max: 300, field: "Caption" }) ?? "" : null, "featured" in b ? bool01(b.featured) : null, Number(id)).first();
      if (!row) throw new HttpError(404, "Media not found");
      return json({ media: shapeAdminMedia(row) });
    }
    if (m === "DELETE" && id) {
      const row = await DB.prepare("DELETE FROM media WHERE id = ?1 RETURNING *").bind(Number(id)).first();
      if (row && row.kind !== "instagram") await env.MEDIA.delete(row.key_or_url);
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
      if (e instanceof HttpError) return withSecurityHeaders(json({ error: e.message }, e.status));
      console.error("unhandled", e?.stack || e);
      return withSecurityHeaders(json({ error: "Something went wrong. Please try again or text Shaun." }, 500));
    }
  },
};
