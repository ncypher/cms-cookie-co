// Catering + custom requests are saved; catering settings and packages; admin list and spreadsheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import worker from "../src/worker.js";
import { TOO_MANY_ORDERS } from "../src/messages.js";
import { fakeD1, fakeR2 } from "./helpers/fakes.js";

const ORIGIN = "http://localhost:8787";
// Michigan dates, same as the server.
const day = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Detroit" }).format(new Date(Date.now() + n * 864e5));
const env = (extra = {}) => ({ DB: fakeD1(), MEDIA: fakeR2(), ACCESS_DEV_BYPASS: "true", ...extra });
const call = async (e, method, p, body, headers = {}) => {
  const res = await worker.fetch(new Request(`${ORIGIN}${p}`, {
    method, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data, headers: res.headers };
};
const admin = (e, method, p, body, h) => call(e, method, `/api/admin/${p}`, body, h);
let ip = 1;
const ask = (e, b, h = {}) => call(e, "POST", "/api/requests", { name: "Test Person", phone: "5555550100", ...b }, { "CF-Connecting-IP": `198.51.100.${ip++}`, ...h });
const catering = (b) => ({ kind: "catering", date: day(14), headcount: 40, fulfillment: "delivery", interests: ["Cookie trays"], ...b });
const turnOn = (e, b = {}) => admin(e, "PUT", "catering", { enabled: true, ...b });

test("migration: catering is OFF, so /api/content has nothing about it and catering requests are refused", async () => {
  const e = env();
  const c = (await call(e, "GET", "/api/content")).body;
  assert.equal(c.catering, null);
  const r = await ask(e, catering());
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Catering requests are closed/);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM requests").get().n, 0);
  const s = (await admin(e, "GET", "catering")).body.catering;
  assert.equal(s.enabled, false);
  assert.equal(s.notice_days, 7);
  assert.ok(s.items.includes("Cookie trays"));
});

test("catering ON: intro, things she caters, earliest date and active packages are public", async () => {
  const e = env();
  await turnOn(e, { intro: "Parties!", notice_days: 10, items: ["Trays", " ", "Cake bites"] });
  await admin(e, "POST", "catering/packages", { name: "Party tray", description: "4 dozen", from: "60", serves: "25" });
  await admin(e, "POST", "catering/packages", { name: "Hidden one", active: false });
  const c = (await call(e, "GET", "/api/content")).body.catering;
  assert.equal(c.intro, "Parties!");
  assert.deepEqual(c.items, ["Trays", "Cake bites"]);
  assert.equal(c.notice_days, 10);
  assert.equal(c.earliest, day(10));
  assert.deepEqual(c.packages.map((k) => [k.name, k.from, k.serves]), [["Party tray", 60, 25]]);
});

test("catering request is saved with a REQ number; minimum notice is enforced on the server", async () => {
  const e = env();
  await turnOn(e, { notice_days: 7 });
  const tooSoon = await ask(e, catering({ date: day(3) }));
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.body.error, /at least 7 days' notice/);
  const ok = await ask(e, catering({ date: day(7), budget: "about $150", email: "a@b.co", notes: "Baby shower" }));
  assert.equal(ok.status, 201);
  assert.match(ok.body.id, /^REQ-\d{4}-\d{4}$/);
  const row = e.DB.raw.prepare("SELECT * FROM requests").get();
  assert.deepEqual([row.kind, row.status, row.headcount, row.fulfillment, row.budget, JSON.parse(row.interests)[0]], ["catering", "new", 40, "delivery", "about $150", "Cookie trays"]);
  assert.match(row.client_hash, /^[0-9a-f]{32}$/);
  await turnOn(e, { notice_days: 0 });
  assert.equal((await ask(e, catering({ date: day(0) }))).status, 201, "0 days' notice allows today");
});

test("request validation: name, 10-digit phone, catering needs date + how many, email checked, honeypot", async () => {
  const e = env();
  await turnOn(e);
  assert.equal((await ask(e, catering({ name: "" }))).status, 400);
  assert.equal((await ask(e, catering({ phone: "555-1234" }))).status, 400);
  assert.equal((await ask(e, catering({ date: "" }))).status, 400);
  assert.equal((await ask(e, catering({ date: "next week" }))).status, 400);
  assert.equal((await ask(e, catering({ headcount: "" }))).status, 400);
  assert.equal((await ask(e, catering({ headcount: 0 }))).status, 400);
  assert.equal((await ask(e, catering({ email: "nope" }))).status, 400);
  assert.equal((await ask(e, { kind: "party" })).status, 400);
  assert.equal((await ask(e, catering({ notes: "x".repeat(1501) }))).status, 400);
  const hp = await ask(e, catering({ website: "http://spam" }));
  assert.equal(hp.status, 201);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM requests").get().n, 0);
});

test("Upon Request (custom) is saved even with catering off; 'about 20' guests is understood", async () => {
  const e = env();
  const r = await ask(e, { kind: "custom", interests: ["Cookie Cupcakes", 5, "Custom design / theme"], headcount: "about 20", date: day(3), notes: "Pink!" });
  assert.equal(r.status, 201);
  const row = e.DB.raw.prepare("SELECT * FROM requests").get();
  assert.deepEqual([row.kind, row.headcount, row.fulfillment, JSON.parse(row.interests)], ["custom", 20, null, ["Cookie Cupcakes", "Custom design / theme"]]);
  assert.equal((await ask(e, { kind: "custom", headcount: "a lot" })).status, 201);
  assert.match(e.DB.raw.prepare("SELECT notes FROM requests WHERE headcount IS NULL").get().notes, /How many: a lot/);
  assert.equal((await ask(e, { kind: "custom", date: day(-1) })).status, 400, "past dates refused");
});

test("'Ask about this' package: its id is checked and its name leads the list", async () => {
  const e = env();
  await turnOn(e);
  const k = (await admin(e, "POST", "catering/packages", { name: "Dessert table", from: "120" })).body.package;
  const r = await ask(e, catering({ package_id: k.id, interests: ["Cookie trays"] }));
  assert.equal(r.status, 201);
  const row = e.DB.raw.prepare("SELECT package_id, interests FROM requests").get();
  assert.equal(row.package_id, k.id);
  assert.deepEqual(JSON.parse(row.interests), ["Dessert table", "Cookie trays"]);
  await admin(e, "PUT", `catering/packages/${k.id}`, { name: "Dessert table", active: false });
  assert.equal((await ask(e, catering({ package_id: k.id }))).status, 400, "switched-off package refused");
});

test("requests share the per-device limit with orders and signups (5 per 10 minutes)", async () => {
  const e = env();
  const h = { "CF-Connecting-IP": "203.0.113.77" };
  for (let i = 0; i < 3; i++) assert.equal((await ask(e, { kind: "custom" }, h)).status, 201);
  for (let i = 0; i < 2; i++) assert.equal((await call(e, "POST", "/api/orders", { name: "O", phone: "5555550100", date: day(5), items: [{ type: "gram", qty: 1 }] }, h)).status, 201);
  const r = await ask(e, { kind: "custom" }, h);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, TOO_MANY_ORDERS);
});

test("admin: newest first, New count, status buttons, quote and private notes; private notes never public", async () => {
  const e = env();
  const a = (await ask(e, { kind: "custom", notes: "first" })).body.id;
  e.DB.raw.exec("UPDATE requests SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')");
  const b = (await ask(e, { kind: "custom", notes: "second" })).body.id;
  let list = (await admin(e, "GET", "requests")).body;
  assert.deepEqual(list.requests.map((r) => r.id), [b, a]);
  assert.equal(list.new_count, 2);
  assert.equal(list.requests[0].client_hash, undefined);
  const u = (await admin(e, "PATCH", `requests/${a}`, { status: "quoted", quote: "145.50", admin_notes: "Use the pink boxes" })).body.request;
  assert.deepEqual([u.status, u.quote, u.admin_notes, u.updated_by], ["quoted", 145.5, "Use the pink boxes", "dev@localhost"]);
  assert.equal((await admin(e, "PATCH", `requests/${a}`, { status: "maybe" })).status, 400);
  await admin(e, "PATCH", `requests/${b}`, { status: "declined" });
  list = (await admin(e, "GET", "requests")).body;
  assert.deepEqual([list.requests.map((r) => r.id), list.new_count], [[a], 0], "open = new, quoted, booked");
  assert.equal((await admin(e, "GET", "requests?filter=all")).body.requests.length, 2);
  assert.ok(!JSON.stringify((await call(e, "GET", "/api/content")).body).includes("pink boxes"));
});

test("requests spreadsheet: same CSV rules as orders, includes status and quote", async () => {
  const e = env();
  await turnOn(e);
  const id = (await ask(e, catering({ name: "=cmd|' /C calc'!A0", notes: "Line one,\nline two" }))).body.id;
  await admin(e, "PATCH", `requests/${id}`, { status: "booked", quote: "200" });
  const r = await admin(e, "GET", "requests.csv");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Disposition"), /attachment; filename="requests-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
  const raw = new Uint8Array(await (await worker.fetch(new Request(`${ORIGIN}/api/admin/requests.csv`), e)).arrayBuffer());
  assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM so Excel reads it right");
  const lines = r.body.replace(/^﻿/, "").split("\r\n");
  assert.equal(lines[0], "Request,Received,Kind,Status,Name,Phone,Email,Event date,How many,Pickup or delivery,Would like,Budget,Quote,Notes,Your notes");
  assert.match(lines[1], /,Catering,Booked,'=cmd\|' \/C calc'!A0,5555550100,,"[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4}",40,Delivery,Cookie trays,,\$200\.00,"Line one,\nline two",$/);
});

test("requests list, settings, packages and spreadsheet are admin-only", async () => {
  const locked = { DB: fakeD1(), MEDIA: fakeR2() };
  for (const [m, p] of [["GET", "requests"], ["GET", "requests.csv"], ["GET", "catering"], ["PUT", "catering"], ["POST", "catering/packages"], ["PATCH", "requests/REQ-0101-1111"]]) {
    assert.notEqual((await admin(locked, m, p, m === "GET" ? undefined : { enabled: true, name: "x" })).status, 200, `${m} ${p}`);
  }
  const e = env();
  assert.equal((await admin(e, "PUT", "catering", { enabled: true }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await call(e, "GET", "/api/requests")).status, 404, "no public list");
});

test("catering settings and packages: checks, reorder, 4:3 photo cleaned up on delete", async () => {
  const e = env();
  assert.equal((await turnOn(e, { notice_days: 91 })).status, 400);
  assert.equal((await turnOn(e, { items: ["x".repeat(61)] })).status, 400);
  assert.equal((await admin(e, "POST", "catering/packages", { name: "" })).status, 400);
  assert.equal((await admin(e, "POST", "catering/packages", { name: "X", serves: "2.5" })).status, 400);
  const KEY = "img/2026/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp";
  await e.MEDIA.put(KEY, new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), { httpMetadata: { contentType: "image/webp" } });
  const a = (await admin(e, "POST", "catering/packages", { name: "A", photo_key: KEY })).body.package;
  const b = (await admin(e, "POST", "catering/packages", { name: "B" })).body.package;
  await admin(e, "POST", `catering/packages/${b.id}/move`, { dir: "up" });
  assert.deepEqual((await admin(e, "GET", "catering")).body.packages.map((k) => k.name), ["B", "A"]);
  await admin(e, "DELETE", `catering/packages/${a.id}`);
  assert.equal(e.MEDIA.objects.has(KEY), false);
});

test("public site: Catering panel hidden until on, packages never go in the cart, Upon Request posts kind custom", () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /<section class="panel catering-panel" id="catering" hidden>/);
  assert.match(html, /id="cateringBtn"[^>]*hidden/);
  assert.match(html, /data-askpkg/);
  assert.doesNotMatch(html.slice(html.indexOf("function renderCatering"), html.indexOf("function askAbout")), /addItem\(/, "packages are never added to the cart");
  assert.match(html, /kind:"custom"/);
  assert.match(html, /fetch\("\/api\/requests"/);
});
