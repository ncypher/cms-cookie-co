// Stage 3: event signups (drafts, server pricing, capacity, closing date) and spreadsheet downloads.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { toCsv, csvCell } from "../src/csv.js";
import { TOO_MANY_ORDERS } from "../src/messages.js";
import { fakeD1, fakeR2 } from "./helpers/fakes.js";

const ORIGIN = "http://localhost:8787";
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
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
const content = async (e) => (await call(e, "GET", "/api/content")).body;
let ip = 10;
const signup = (e, id, b = {}) => call(e, "POST", `/api/events/${id}/register`,
  { name: "Test Person", phone: "5555550100", seats: 1, ...b }, { "CF-Connecting-IP": `198.51.100.${ip++}` });
const newEvent = async (e, b = {}) => (await admin(e, "POST", "events", {
  title: "Cookie Class", date: day(10), published: true, ticket_price: "15", capacity: "3", signups_open: true, ...b,
})).body.event;

test("migration: existing events stay published with signups off; registrations table exists", () => {
  const e = env();
  e.DB.raw.exec("INSERT INTO events (title, date) VALUES ('Old market', date('now', '+3 days'))");
  const row = e.DB.raw.prepare("SELECT published, signups_open, ticket_price_cents, capacity, signup_closes FROM events").get();
  assert.deepEqual({ ...row }, { published: 1, signups_open: 0, ticket_price_cents: null, capacity: null, signup_closes: null });
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM registrations").get().n, 0);
});

test("drafts: hidden from /api/content and the home page data, and public signups are refused", async () => {
  const e = env();
  const draft = await newEvent(e, { title: "TEST - ignore", published: false });
  const pub = await newEvent(e, { title: "Published class" });
  const c = await content(e);
  assert.deepEqual(c.events.map((x) => x.title), ["Published class"]);
  assert.ok(!JSON.stringify(c).includes("TEST - ignore"));
  const r = await signup(e, draft.id);
  assert.equal(r.status, 404);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM registrations").get().n, 0);
  assert.equal((await signup(e, pub.id)).status, 201);
});

test("server prices the seats: price comes from the event, never from the browser", async () => {
  const e = env();
  const ev = await newEvent(e, { ticket_price: "12.50", capacity: "" });
  const r = await signup(e, ev.id, { seats: 3, price: 0.01, total: 0.03, price_cents: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 37.5);
  assert.equal(r.body.price, 12.5);
  assert.match(r.body.id, /^EV-\d{4}-\d{4}$/);
  const row = e.DB.raw.prepare("SELECT price_cents, total_cents, seats FROM registrations").get();
  assert.deepEqual({ ...row }, { price_cents: 1250, total_cents: 3750, seats: 3 });
  const c = await content(e);
  assert.deepEqual(c.events[0].signup, { price: 12.5, spots_left: null, closes: ev.date, state: "open" });
});

test("capacity: last spot goes to exactly one of two people at once; then Sold out", async () => {
  const e = env();
  const ev = await newEvent(e, { capacity: "3" });
  assert.equal((await signup(e, ev.id, { seats: 2 })).status, 201);
  const [a, b] = await Promise.all([signup(e, ev.id, { name: "A" }), signup(e, ev.id, { name: "B" })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.match((a.status === 409 ? a : b).body.error, /Sold out/);
  const late = await signup(e, ev.id);
  assert.equal(late.status, 409);
  assert.match(late.body.error, /Sold out/);
  assert.equal(e.DB.raw.prepare("SELECT SUM(seats) n FROM registrations").get().n, 3, "never oversold");
  assert.equal((await content(e)).events[0].signup.state, "soldout");
});

test("capacity: asking for more than is left says how many are left", async () => {
  const e = env();
  const ev = await newEvent(e, { capacity: "5" });
  await signup(e, ev.id, { seats: 3 });
  const r = await signup(e, ev.id, { seats: 3 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Only 2 spots left/);
  assert.equal((await content(e)).events[0].signup.spots_left, 2);
});

test("closed signups: after the closing date (or switched off) nobody can sign up", async () => {
  const e = env();
  const ev = await newEvent(e, { signup_closes: day(2) });
  e.DB.raw.exec(`UPDATE events SET signup_closes = date('now', '-2 days') WHERE id = ${ev.id}`);
  const r = await signup(e, ev.id);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /closed/);
  assert.equal((await content(e)).events[0].signup.state, "closed");
  const off = await newEvent(e, { signups_open: false });
  assert.equal((await signup(e, off.id)).status, 409);
  assert.equal((await content(e)).events.find((x) => x.id === off.id).signup, null);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM registrations").get().n, 0);
});

test("signup form rules: 1–10 spots, 10-digit phone, optional email checked, honeypot pretends", async () => {
  const e = env();
  const ev = await newEvent(e, { capacity: "" });
  for (const seats of [0, 11, 2.5, "x"]) assert.equal((await signup(e, ev.id, { seats })).status, 400, String(seats));
  assert.equal((await signup(e, ev.id, { phone: "555" })).status, 400);
  assert.equal((await signup(e, ev.id, { email: "not-an-email" })).status, 400);
  assert.equal((await signup(e, ev.id, { email: "a@b.co", notes: "Allergic to nuts" })).status, 201);
  const hp = await signup(e, ev.id, { website: "spam.example" });
  assert.equal(hp.status, 201);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM registrations").get().n, 1, "honeypot saved nothing");
  assert.equal((await call(e, "POST", "/api/events/abc/register", { name: "x" })).status, 404);
});

test("signups share the per-device limit with orders (5 per 10 minutes)", async () => {
  const e = env();
  const ev = await newEvent(e, { capacity: "" });
  const h = { "CF-Connecting-IP": "203.0.113.50" };
  for (let i = 0; i < 5; i++) assert.equal((await call(e, "POST", `/api/events/${ev.id}/register`, { name: "R", phone: "5555550100", seats: 1 }, h)).status, 201);
  const r = await call(e, "POST", `/api/events/${ev.id}/register`, { name: "R", phone: "5555550100", seats: 1 }, h);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, TOO_MANY_ORDERS);
});

test("admin preview: a Draft can be tried from admin (not public), Paid/Checked-in and totals", async () => {
  const e = env();
  const ev = await newEvent(e, { title: "TEST - ignore", published: false, ticket_price: "5", capacity: "3" });
  const pv = await admin(e, "GET", `events/${ev.id}`);
  assert.equal(pv.body.event.published, false);
  assert.equal(pv.body.event.signup.state, "open");
  const one = await admin(e, "POST", `events/${ev.id}/register`, { name: "Prev One", phone: "5555550101", seats: 2 });
  assert.equal(one.status, 201);
  assert.equal((await admin(e, "POST", `events/${ev.id}/register`, { name: "Prev Two", phone: "5555550102", seats: 1 })).status, 201);
  const four = await admin(e, "POST", `events/${ev.id}/register`, { name: "Prev Three", phone: "5555550103", seats: 1 });
  assert.equal(four.status, 409);
  assert.match(four.body.error, /Sold out/);
  assert.equal((await admin(e, "PATCH", `registrations/${one.body.id}`, { paid: true })).body.registration.paid, true);
  assert.equal((await admin(e, "PATCH", `registrations/${one.body.id}`, { checked_in: true })).body.registration.checked_in, true);
  const list = (await admin(e, "GET", `events/${ev.id}/registrations`)).body;
  assert.equal(list.registrations.length, 2);
  assert.equal(list.registrations[0].client_hash, undefined, "no device hash sent to the page");
  assert.deepEqual([list.event.taken, list.event.capacity, list.event.expected_cents, list.event.paid_cents], [3, 3, 1500, 1000]);
  // Deleting the event takes its signups with it.
  await admin(e, "DELETE", `events/${ev.id}`);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM registrations").get().n, 0);
});

test("event form checks: signups need a price; closing date not after the event; spots 1–1000", async () => {
  const e = env();
  const bad = async (b) => (await admin(e, "POST", "events", { title: "X", date: day(10), ...b })).status;
  assert.equal(await bad({ signups_open: true }), 400);
  assert.equal(await bad({ ticket_price: "5", signup_closes: day(11) }), 400);
  assert.equal(await bad({ ticket_price: "5", capacity: "0" }), 400);
  assert.equal(await bad({ ticket_price: "5", capacity: "2.5" }), 400);
  assert.equal(await bad({ ticket_price: "0", signups_open: true, capacity: "20" }), 201, "free events with a head count are fine");
});

/* ---- Spreadsheets ---- */
test("CSV: BOM, quotes, commas, new lines, formulas made harmless", () => {
  assert.equal(csvCell('She said "hi", then left'), '"She said ""hi"", then left"');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell("=HYPERLINK(\"http://x\")"), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell("+1 734 555 0100"), "'+1 734 555 0100");
  assert.equal(csvCell("@cmscookieco"), "'@cmscookieco");
  assert.equal(csvCell(3), "3");
  assert.equal(csvCell(null), "");
  const out = toCsv([["a", "b"], ["1", "x,y"]]);
  assert.ok(out.startsWith("﻿"));
  assert.equal(out, '﻿a,b\r\n1,"x,y"\r\n');
});

test("CSV of an event's signups: readable dates, dollars, Yes/No, file name", async () => {
  const e = env();
  const ev = await newEvent(e, { title: "Cookie Class, Dec!", ticket_price: "12.5", capacity: "" });
  const r = await signup(e, ev.id, { name: 'Ann "Annie" Lee', seats: 2, notes: "Nut allergy,\nplease" });
  await admin(e, "PATCH", `registrations/${r.body.id}`, { paid: true });
  const csv = await admin(e, "GET", `events/${ev.id}/registrations.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("Content-Type"), /^text\/csv; charset=utf-8/);
  assert.match(csv.headers.get("Content-Disposition"), new RegExp(`attachment; filename="signups-cookie-class-dec-${ev.date}\\.csv"`));
  const lines = csv.body.replace(/^﻿/, "").split("\r\n");
  assert.equal(lines[0], "Reservation,Signed up,Name,Phone,Email,Spots,Price per spot,Total,Paid,Payment method,Checked in,Notes");
  assert.match(lines[1], new RegExp(`^${r.body.id},"[A-Z][a-z]{2} \\d{1,2}, \\d{4}, \\d{1,2}:\\d{2} [AP]M","Ann ""Annie"" Lee",5555550100,,2,\\$12\\.50,\\$25\\.00,Yes,Marked paid,No,"Nut allergy,`));
});

test("CSV of orders by date range (default last 30 days)", async () => {
  const e = env();
  await call(e, "POST", "/api/orders", { name: "Order, Person", phone: "5555550100", date: day(5), items: [{ type: "gram", qty: 2 }] }, { "CF-Connecting-IP": "192.0.2.1" });
  e.DB.raw.exec("INSERT INTO orders (id, name, phone, wanted_date, fulfillment, items_json, total_cents, created_at) VALUES ('CMS-0101-1111', 'Old', '5555550100', '2025-01-05', 'pickup', '[]', 100, '2025-01-01T15:00:00.000Z')");
  const d = await admin(e, "GET", "orders.csv");
  assert.equal(d.status, 200);
  const lines = d.body.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "Order,Placed,Wanted,Name,Phone,Pickup or delivery,Items,Total,Confirmed,Paid,Payment method,Dietary,Notes");
  assert.equal(lines.length, 2, "old order outside the last 30 days");
  assert.match(lines[1], /"Order, Person",5555550100,Pickup,2 × Cookie Gram,\$18\.00,No,No,,,$/);
  const old = await admin(e, "GET", "orders.csv?from=2025-01-01&to=2025-01-31");
  assert.match(old.body, /CMS-0101-1111/);
  assert.match(old.headers.get("Content-Disposition"), /orders-2025-01-01-to-2025-01-31\.csv/);
  assert.equal((await admin(e, "GET", "orders.csv?from=2025-02-01&to=2025-01-01")).status, 400);
});

test("CSV and signup lists are admin-only (Access + ADMIN_EMAILS guard /api/admin)", async () => {
  const locked = { DB: fakeD1(), MEDIA: fakeR2() }; // no dev bypass; Access unset -> fails closed
  for (const p of ["orders.csv", "events/1/registrations.csv", "events/1/registrations", "events/1"]) {
    const r = await admin(locked, "GET", p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!String(r.body).includes("Reservation,"), p);
  }
  // A deployed host never gets the localhost bypass, even with the flag set.
  const prodish = await worker.fetch(new Request("https://cmscookieco3more.com/api/admin/orders.csv"), env());
  assert.notEqual(prodish.status, 200);
  // Public paths can't reach them.
  assert.equal((await call(env(), "GET", "/api/orders.csv")).status, 404);
  assert.equal((await call(env(), "GET", "/api/events/1/registrations.csv")).status, 404);
});
