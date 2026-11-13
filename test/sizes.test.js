// Stage 2: optional sizes on treats and specials, treat groups, Menu tab buttons.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import worker from "../src/worker.js";
import { fakeD1, fakeR2 } from "./helpers/fakes.js";

const ORIGIN = "http://localhost:8787";
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const env = () => ({ DB: fakeD1(), MEDIA: fakeR2(), ACCESS_DEV_BYPASS: "true" });
const call = async (e, method, p, body, headers = {}) => {
  const res = await worker.fetch(new Request(`${ORIGIN}${p}`, {
    method, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  return { status: res.status, body: await res.json() };
};
const admin = (e, m, p, b) => call(e, m, `/api/admin/${p}`, b);
let ip = 1;
const order = (e, items) => call(e, "POST", "/api/orders", { name: "Test", phone: "5555550100", date: day(5), items }, { "CF-Connecting-IP": `198.51.100.${ip++}` });
const KITS = [{ label: "Kit for 2", price: "10" }, { label: "Family kit", price: "18" }];

test("treat with sizes: public card gets the sizes; the server prices by size id and keeps the label", async () => {
  const e = env();
  const t = (await admin(e, "POST", "treats", { name: "Cookie Kits", sizes: KITS })).body.treat;
  assert.deepEqual(t.sizes.map((z) => [z.label, z.price]), [["Kit for 2", 10], ["Family kit", 18]]);
  assert.equal(t.price, 10, "from price = first size");
  assert.match(t.sizes[0].id, /^[a-z0-9]{6}$/);
  const pub = (await call(e, "GET", "/api/content")).body.treats[0];
  assert.deepEqual(pub.sizes, t.sizes);
  const fam = t.sizes[1].id;
  const r = await order(e, [{ type: "treat", id: t.id, size_id: fam, qty: 2, price: 0.01 }]);
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 36);
  assert.deepEqual([r.body.lines[0].detail, r.body.lines[0].size, r.body.lines[0].size_id], ["Family kit", "Family kit", fam]);
  const csv = await (await worker.fetch(new Request(`${ORIGIN}/api/admin/orders.csv`), e)).text();
  assert.match(csv, /2 × Cookie Kits \(Family kit\)/, "spreadsheet keeps the size");
});

test("sizes: missing, unknown or removed size refused; editing keeps the ids so carts still match", async () => {
  const e = env();
  const t = (await admin(e, "POST", "treats", { name: "Cookie Kits", sizes: KITS })).body.treat;
  assert.match((await order(e, [{ type: "treat", id: t.id, qty: 1 }])).body.error, /Pick a size for Cookie Kits/);
  assert.equal((await order(e, [{ type: "treat", id: t.id, size_id: "zzzzzz", qty: 1 }])).status, 400);
  const [two, fam] = t.sizes.map((z) => z.id);
  // Edit: rename "Family kit", drop "Kit for 2", add a new one.
  const ed = (await admin(e, "PUT", `treats/${t.id}`, { name: "Cookie Kits", sizes: [{ id: fam, label: "Family kit (6)", price: "19" }, { label: "Party kit", price: "30" }] })).body.treat;
  assert.equal(ed.sizes[0].id, fam, "kept");
  assert.notEqual(ed.sizes[1].id, two);
  const gone = await order(e, [{ type: "treat", id: t.id, size_id: two, qty: 1 }]);
  assert.equal(gone.status, 400);
  assert.match(gone.body.error, /isn't available any more/);
  const ok = await order(e, [{ type: "treat", id: t.id, size_id: fam, qty: 1 }]);
  assert.deepEqual([ok.status, ok.body.total, ok.body.lines[0].detail], [201, 19, "Family kit (6)"]);
  // Sizes removed altogether -> back to one price; an old cart line with a size is refused, not mispriced.
  await admin(e, "PUT", `treats/${t.id}`, { name: "Cookie Kits", price: "15", sizes: [] });
  assert.equal((await order(e, [{ type: "treat", id: t.id, size_id: fam, qty: 1 }])).status, 400);
  assert.equal((await order(e, [{ type: "treat", id: t.id, qty: 1 }])).body.total, 15);
});

test("special with sizes (Cookie of the Month too): priced by size, label kept", async () => {
  const e = env();
  const s = (await admin(e, "POST", "specials", { title: "Christmas Cookie Kits", price: "", sizes: KITS })).body.special;
  assert.equal(s.price, 10);
  const pub = (await call(e, "GET", "/api/content")).body.specials[0];
  assert.deepEqual(pub.sizes.map((z) => z.label), ["Kit for 2", "Family kit"]);
  const r = await order(e, [{ type: "special", id: s.id, size_id: s.sizes[1].id, qty: 1 }]);
  assert.deepEqual([r.body.total, r.body.lines[0].detail], [18, "Family kit"]);
  assert.equal((await order(e, [{ type: "special", id: s.id, qty: 1 }])).status, 400);
});

test("no sizes: treats and specials behave exactly as before (her Snickerdoodle, Kits, Wine & Cookie Flight)", async () => {
  const e = env();
  e.DB.raw.exec(`INSERT INTO specials (kind, title, price_cents, starts, ends, active) VALUES ('cotm', 'Wrapped & Stuffed Snickerdoodle', 2800, date('now','-1 day'), date('now','+40 days'), 1),
    ('special', 'Christmas Cookie Kits', 1000, date('now','-1 day'), date('now','+10 days'), 1);
    INSERT INTO treats (name, price_cents, category, active, sort) VALUES ('Wine & Cookie Flight', 1200, NULL, 1, 10);`);
  const c = (await call(e, "GET", "/api/content")).body;
  assert.deepEqual([c.cookieOfTheMonth.price, c.cookieOfTheMonth.sizes], [28, null]);
  assert.deepEqual([c.specials[0].price, c.specials[0].sizes], [10, null]);
  assert.deepEqual([c.treats[0].price, c.treats[0].sizes, c.treats[0].category], [12, null, null]);
  const r = await order(e, [{ type: "special", id: c.cookieOfTheMonth.id, qty: 1 }, { type: "special", id: c.specials[0].id, qty: 2 }, { type: "treat", id: c.treats[0].id, qty: 1 }]);
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 28 + 20 + 12);
  assert.deepEqual(r.body.lines.map((l) => l.detail), ["Cookie of the Month", "Special", "Treat"], "same details as before");
  assert.ok(r.body.lines.every((l) => !("size" in l)));
  assert.equal((await order(e, [{ type: "treat", id: c.treats[0].id, size_id: "abcdef", qty: 1 }])).status, 400, "no sizes = no size allowed");
  // Editing without sizes still needs a treat price.
  assert.equal((await admin(e, "PUT", `treats/${c.treats[0].id}`, { name: "Wine & Cookie Flight", price: "" })).status, 400);
});

test("size rules: up to 6, each needs a name and a price, no duplicate names", async () => {
  const e = env();
  const seven = Array.from({ length: 7 }, (_, i) => ({ label: `S${i}`, price: "5" }));
  assert.equal((await admin(e, "POST", "treats", { name: "X", sizes: seven })).status, 400);
  assert.equal((await admin(e, "POST", "treats", { name: "X", sizes: [{ label: "", price: "5" }] })).status, 400);
  assert.equal((await admin(e, "POST", "treats", { name: "X", sizes: [{ label: "Big", price: "" }] })).status, 400);
  assert.equal((await admin(e, "POST", "treats", { name: "X", sizes: [{ label: "Big", price: "5" }, { label: "big", price: "6" }] })).status, 400);
  assert.equal((await admin(e, "POST", "treats", { name: "X", sizes: [{ label: "", price: "" }], price: "4" })).body.treat.sizes, null, "blank rows ignored");
});

const html = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "index.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "admin", "index.html"), "utf8");
test("public: size pickers, grouped More treats with a small heading per group (none when nothing is grouped)", () => {
  assert.match(html, /function sizePicker\(/);
  assert.match(html, /size_id: c\.sizeId/);
  assert.match(html, /class="tr-group"/);
  assert.match(html, /const grouped = TREATS\.some\(t => t\.category\)/);
});
test("admin: Menu opens with three big buttons; treat group suggestions; sizes editor", () => {
  for (const t of ["+ Add a treat", "always on your menu", "+ Add a special", "for a limited time", "+ Add a flavor", "for boxes and singles"]) assert.ok(adminHtml.includes(t), t);
  for (const g of ["Kits", "Gift boxes", "Party trays", "Other"]) assert.match(adminHtml, new RegExp(`"${g}"`));
  assert.match(adminHtml, /type:"sizes"/);
});
