// Stage C: flavors and treats are data. Builder, pricing and the flight all read from the DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import worker from "../src/worker.js";
import { fakeD1, fakeR2 } from "./helpers/fakes.js";

const ORIGIN = "http://localhost:8787";
const env = () => ({ DB: fakeD1(), MEDIA: fakeR2(), ACCESS_DEV_BYPASS: "true" });
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const admin = async (e, method, p, body) => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/admin/${p}`, {
    method, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  return { status: res.status, body: await res.json() };
};
const content = async (e) => (await worker.fetch(new Request(`${ORIGIN}/api/content`), e)).json();
let ip = 1;
const order = async (e, items) => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/orders`, {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${ip++}` },
    body: JSON.stringify({ name: "Test", phone: "5555550100", date: day(5), items }),
  }), e);
  return { status: res.status, body: await res.json() };
};

/* ---- Migration ---- */
test("migration: the four flavors keep their names, order and on/off, and get today's text and photos", async () => {
  const e = env();
  const rows = e.DB.raw.prepare("SELECT key, name, active, sort, short, asset, in_flight FROM menu WHERE kind = 'flavor' ORDER BY sort").all();
  assert.deepEqual(rows.map((r) => [r.key, r.name, r.short, r.asset, r.active, r.in_flight]), [
    ["flavor-cc", "Chocolate Chip", "Choc Chip", "/assets/f-cc.webp", 1, 1],
    ["flavor-dcc", "Double Chocolate Chip", "Double Choc", "/assets/f-dcc.webp", 1, 1],
    ["flavor-dcss", "Dark Chocolate Sea Salt", "Sea Salt", "/assets/f-dcss.webp", 1, 1],
    ["flavor-fs", "Frosted Sugar Cookie", "Frosted Sugar", "/assets/f-fs.webp", 1, 1],
  ]);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM menu").get().n, 11);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM treats").get().n, 0);
  const c = await content(e);
  assert.deepEqual(c.flavors.map((f) => [f.id, f.short, f.photo]), [
    ["cc", "Choc Chip", "/assets/f-cc.webp"], ["dcc", "Double Choc", "/assets/f-dcc.webp"],
    ["dcss", "Sea Salt", "/assets/f-dcss.webp"], ["fs", "Frosted Sugar", "/assets/f-fs.webp"],
  ]);
  assert.deepEqual(c.treats, []);
  assert.ok(c.menu.every((m) => m.kind === "item"));
});

test("migration on a copy of real data: a flavor switched off stays off, nothing else changes", () => {
  // Re-run 0005 over a DB that had 0001-0004 plus Shaun-style edits.
  const e = env();
  const db = e.DB.raw;
  db.exec("DROP TABLE treats");
  for (const c of ["short", "description", "photo_key", "photo_orig_key", "asset", "starts", "ends", "in_flight"]) db.exec(`ALTER TABLE menu DROP COLUMN ${c}`);
  db.exec("UPDATE menu SET active = 0 WHERE key = 'flavor-dcss'; UPDATE menu SET price_cents = 2700 WHERE key = 'dozen'");
  db.exec("INSERT INTO specials (kind, title, price_cents) VALUES ('cotm', 'Wrapped & Stuffed Snickerdoodle', 2800)");
  const before = db.prepare("SELECT key, name, price_cents, active, sort FROM menu ORDER BY key").all();
  db.exec(fs.readFileSync(path.join(import.meta.dirname, "..", "migrations", "0005_flavors_treats_data.sql"), "utf8"));
  assert.deepEqual(db.prepare("SELECT key, name, price_cents, active, sort FROM menu ORDER BY key").all(), before);
  assert.equal(db.prepare("SELECT title FROM specials").get().title, "Wrapped & Stuffed Snickerdoodle");
});

test("no hard-coded flavor lists left in the worker or the public page", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "worker.js"), "utf8");
  const html = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "index.html"), "utf8");
  assert.doesNotMatch(src, /FLAVOR_IDS|const SHORT\b/);
  assert.doesNotMatch(html, /const PHOTO\s*=|Chocolate Chip|"Choc Chip"/);
});

/* ---- New flavor ---- */
test("a new flavor shows in the builder, prices correctly in a box and as a single, and joins the flight", async () => {
  const e = env();
  const r = await admin(e, "POST", "flavors", { name: "Pumpkin Spice Snickerdoodle", short: "Pumpkin", description: "Fall!", in_flight: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.flavor.id, "pumpkin");
  const c = await content(e);
  assert.deepEqual(c.flavors.at(-1), { id: "pumpkin", name: "Pumpkin Spice Snickerdoodle", short: "Pumpkin", description: "Fall!", photo: null, in_flight: true });

  const o = await order(e, [
    { type: "box", size: 12, flavors: { pumpkin: 6, cc: 6 }, qty: 1 },
    { type: "single", flavor: "pumpkin", qty: 2 },
    { type: "flight", qty: 1 },
  ]);
  assert.equal(o.status, 201, JSON.stringify(o.body));
  assert.equal(o.body.total, 25 + 8 + 10);
  assert.equal(o.body.lines[0].detail, "6 Pumpkin, 6 Choc Chip");
  assert.equal(o.body.lines[1].name, "Pumpkin Spice Snickerdoodle");
  assert.equal(o.body.lines[2].detail, "One of each: Choc Chip, Double Choc, Sea Salt, Frosted Sugar, Pumpkin");
});

test("flavor ids are unique slugs", async () => {
  const e = env();
  const a = await admin(e, "POST", "flavors", { name: "Lemon" });
  const b = await admin(e, "POST", "flavors", { name: "Lemon" });
  assert.equal(a.body.flavor.id, "lemon");
  assert.equal(b.body.flavor.id, "lemon-2");
});

test("switched-off or out-of-season flavors are hidden and refused by the server", async () => {
  const e = env();
  await admin(e, "POST", "flavors", { name: "Later", starts: day(10) });
  await admin(e, "POST", "flavors", { name: "Gone", ends: day(-3) });
  await admin(e, "POST", "flavors", { name: "Off", active: false });
  const c = await content(e);
  assert.deepEqual(c.flavors.map((f) => f.id), ["cc", "dcc", "dcss", "fs"]);
  for (const id of ["later", "gone", "off"]) {
    const o = await order(e, [{ type: "single", flavor: id, qty: 1 }]);
    assert.equal(o.status, 400, id);
    assert.match(o.body.error, /isn't available/);
    const box = await order(e, [{ type: "box", size: 6, flavors: { [id]: 6 }, qty: 1 }]);
    assert.equal(box.status, 400, id);
  }
  // Built-in flavors switched off via the menu switch are refused too.
  await admin(e, "PUT", "menu/flavor-fs", { active: false });
  assert.equal((await order(e, [{ type: "single", flavor: "fs", qty: 1 }])).status, 400);
  assert.equal((await order(e, [{ type: "single", flavor: "__proto__", qty: 1 }])).status, 400);
});

test("flight leaves out flavors that aren't in it", async () => {
  const e = env();
  await admin(e, "PUT", "flavors/dcss", { name: "Dark Chocolate Sea Salt", short: "Sea Salt", in_flight: false });
  const o = await order(e, [{ type: "flight", qty: 1 }]);
  assert.equal(o.body.lines[0].detail, "One of each: Choc Chip, Double Choc, Frosted Sugar");
});

test("editing a built-in flavor keeps its shipped photo until a new one is added", async () => {
  const e = env();
  const r = await admin(e, "PUT", "flavors/cc", { name: "Chocolate Chip", short: "Choc Chip", description: "New words" });
  assert.equal(r.body.flavor.photo, "/assets/f-cc.webp");
  assert.equal((await content(e)).flavors[0].description, "New words");
});

test("reorder flavors with up/down", async () => {
  const e = env();
  await admin(e, "POST", "flavors/fs/move", { dir: "up" });
  await admin(e, "POST", "flavors/cc/move", { dir: "up" }); // already first: no-op
  assert.deepEqual((await content(e)).flavors.map((f) => f.id), ["cc", "dcc", "fs", "dcss"]);
  // Items keep their own sorts (flavor sorts stay above them).
  const items = (await content(e)).menu.map((m) => m.key);
  assert.deepEqual(items, ["dozen", "half", "single", "flight", "mini12", "mini24", "gram"]);
});

test("deleting a flavor keeps the names on orders already placed and frees its photo", async () => {
  const e = env();
  const KEY = "img/2026/abcdefab-abcd-4abc-8abc-abcdefabcdef.webp";
  await e.MEDIA.put(KEY, new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), { httpMetadata: { contentType: "image/webp" } });
  await admin(e, "POST", "flavors", { name: "Maple", photo_key: KEY });
  const o = await order(e, [{ type: "single", flavor: "maple", qty: 1 }]);
  assert.equal(o.status, 201);
  assert.equal((await admin(e, "DELETE", "flavors/maple")).status, 200);
  assert.equal(e.MEDIA.objects.has(KEY), false);
  const { orders } = (await admin(e, "GET", "orders?filter=all")).body;
  assert.equal(orders[0].items[0].name, "Maple");
});

/* ---- Treats ---- */
test("treats: shown in content, priced by the server (never by the browser)", async () => {
  const e = env();
  const t = await admin(e, "POST", "treats", { name: "Cookie Cake Bites", price: "12.50", category: "Cookie Cake", description: "A dozen bites" });
  assert.equal(t.status, 201);
  const c = await content(e);
  assert.deepEqual(c.treats, [{ id: t.body.treat.id, name: "Cookie Cake Bites", price: 12.5, sizes: null, description: "A dozen bites", category: "Cookie Cake", photo: null }]);
  const o = await order(e, [{ type: "treat", id: t.body.treat.id, qty: 2, price: 0.01 }]);
  assert.equal(o.status, 201);
  assert.equal(o.body.total, 25);
  assert.deepEqual([o.body.lines[0].name, o.body.lines[0].detail], ["Cookie Cake Bites", "Cookie Cake"]);
});

test("treats: off, not started, or ended are hidden and refused", async () => {
  const e = env();
  const ids = [];
  for (const b of [{ active: false }, { starts: day(3) }, { ends: day(-3) }]) ids.push((await admin(e, "POST", "treats", { name: "X", price: 5, ...b })).body.treat.id);
  assert.deepEqual((await content(e)).treats, []);
  for (const id of ids) assert.equal((await order(e, [{ type: "treat", id, qty: 1 }])).status, 400);
  // Switch one back on.
  await admin(e, "PATCH", `treats/${ids[0]}`, { active: true });
  assert.equal((await order(e, [{ type: "treat", id: ids[0], qty: 1 }])).status, 201);
});

test("treats: price is required, dates must make sense, up/down reorders", async () => {
  const e = env();
  assert.equal((await admin(e, "POST", "treats", { name: "No price" })).status, 400);
  assert.equal((await admin(e, "POST", "treats", { name: "Backwards", price: 3, starts: day(5), ends: day(1) })).status, 400);
  const a = (await admin(e, "POST", "treats", { name: "A", price: 1 })).body.treat.id;
  await admin(e, "POST", "treats", { name: "B", price: 1 });
  await admin(e, "POST", `treats/${a}/move`, { dir: "down" });
  assert.deepEqual((await content(e)).treats.map((t) => t.name), ["B", "A"]);
});

test("built-in items keep their keys and still order", async () => {
  const e = env();
  const o = await order(e, [{ type: "gram", qty: 1 }, { type: "mini", size: 24, qty: 1 }, { type: "box", size: 6, flavors: { cc: 3, fs: 3 }, qty: 1 }]);
  assert.equal(o.status, 201);
  assert.equal(o.body.total, 9 + 20 + 13);
  // A flavor row can't be ordered as an item.
  assert.equal((await admin(e, "PUT", "menu/flavor-cc", { active: true })).status, 200);
});
