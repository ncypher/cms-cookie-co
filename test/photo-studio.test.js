// Photo Studio: frame math, encoding budget, and how the server stores/cleans up framed photos + originals.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  scales, zoomRange, clampState, outputSize, encodeUnder, initialState, frameAspect, fitInside, money, TARGET_BYTES,
} from "../public/admin/studio-core.js";
import worker from "../src/worker.js";
import { fakeD1, fakeR2 } from "./helpers/fakes.js";

/* ---- Frame math ---- */
test("shapes: circle/square 1:1, specials 4:3, flyers take the photo's own shape (after turning)", () => {
  assert.equal(frameAspect("circle", 4000, 3000, 0), 1);
  assert.equal(frameAspect("square", 4000, 3000, 0), 1);
  assert.equal(frameAspect("wide", 3000, 4000, 0), 4 / 3);
  assert.equal(frameAspect("whole", 3000, 4000, 0), 0.75);
  assert.equal(frameAspect("whole", 3000, 4000, 90), 4 / 3);
});

test("zoom: 1 = photo covers the frame; Fit whole photo goes down to contain; flyers can't zoom", () => {
  const { cover, contain } = scales("square", 4000, 3000, 0);
  assert.equal(cover, 1 / 3000);
  assert.equal(contain, 1 / 4000);
  assert.deepEqual(zoomRange("square", 4000, 3000, 0), { min: 0.75, max: 5 });
  assert.deepEqual(zoomRange("whole", 4000, 3000, 0), { min: 1, max: 1 });
});

test("dragging can't pull the photo off the frame; zoomed out it stays inside", () => {
  const st = clampState({ ...initialState(), zoom: 1, px: 5, py: -5 }, "square", 4000, 3000);
  // covered width = 4000/3000 = 1.333 frame units -> can slide 0.1667 each way, none vertically
  assert.ok(Math.abs(st.px - 1 / 6) < 1e-9);
  assert.equal(st.py, 0);
  const out = clampState({ ...initialState(), zoom: 0.1, px: 1 }, "square", 4000, 3000);
  assert.equal(out.zoom, 0.75); // can't go below "fit whole photo"
  assert.equal(out.px, 0); // whole photo exactly fills the width
});

test("output: long edge 1600 max, shape-correct, never upscaled far past the photo", () => {
  assert.deepEqual(outputSize(initialState(), "wide", 4032, 3024), { w: 1600, h: 1200 });
  assert.deepEqual(outputSize(initialState(), "circle", 4032, 3024), { w: 1600, h: 1600 });
  assert.deepEqual(outputSize(initialState(), "whole", 1700, 2200), { w: 1236, h: 1600 });
  assert.deepEqual(outputSize(initialState(), "square", 800, 600), { w: 600, h: 600 });
  assert.deepEqual(fitInside(6000, 4000, 2400), { w: 2400, h: 1600 });
});

test("encode: WebP first, JPEG when the browser can't write WebP, shrinks until ≤ 400 KB", async () => {
  const calls = [];
  // Fake encoder: size falls with quality and scale.
  const enc = (canWebp) => async (type, q, scale) => {
    calls.push([type, q, scale]);
    const t = type === "image/webp" && !canWebp ? "image/png" : type;
    return { type: t, size: Math.round(900 * 1024 * q * scale * scale) };
  };
  const a = await encodeUnder(enc(true));
  assert.equal(a.type, "image/webp");
  assert.ok(a.size <= TARGET_BYTES);
  calls.length = 0;
  const b = await encodeUnder(enc(false));
  assert.equal(b.type, "image/jpeg");
  assert.ok(b.size <= TARGET_BYTES);
  assert.ok(calls.slice(1).every(([t]) => t === "image/jpeg"));
});

test("price tag text comes from the item's price", () => {
  assert.equal(money("4.5"), "$4.50");
  assert.equal(money(12), "$12");
  assert.equal(money(""), "");
});

/* ---- Admin: every photo pick goes through the studio; site shapes match ---- */
const pub = (p) => fs.readFileSync(path.join(import.meta.dirname, "..", "public", p), "utf8");
test("admin: photo inputs accept any image, offer Take photo, and open the studio", () => {
  const html = pub("admin/index.html");
  assert.match(html, /<script type="module" src="\/admin\/studio\.js"><\/script>/);
  assert.match(html, /accept="image\/\*" capture="environment"/);
  assert.doesNotMatch(html, /accept="image\/jpeg,image\/png,image\/webp"/, "no picker bypasses the studio");
  assert.match(html, /PhotoStudio\.open/);
});
test("public site: specials 4:3, Cookie of the Month circle, gallery square, flyers whole", () => {
  const html = pub("index.html");
  assert.match(html, /\.sp img\{[^}]*aspect-ratio:4\/3/);
  assert.match(html, /\.cotm img\{[^}]*aspect-ratio:1;[^}]*border-radius:50%/);
  assert.match(html, /\.strip img\{[^}]*aspect-ratio:1;/);
  assert.match(html, /\.ev \.flyer\{[^}]*object-fit:contain/);
  assert.doesNotMatch(html, /\.sp img\{[^}]*max-height/);
});

/* ---- Server: originals stored next to photos, cleaned up together ---- */
const ORIGIN = "http://localhost:8787";
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);
const k = (c) => `img/2026/${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}.webp`;
const env = () => ({ DB: fakeD1(), MEDIA: fakeR2(), ACCESS_DEV_BYPASS: "true" });
const admin = (e, method, p, body) => worker.fetch(new Request(`${ORIGIN}/api/admin/${p}`, {
  method, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: body === undefined ? undefined : JSON.stringify(body),
}), e);
const put = (e, ...keys) => Promise.all(keys.map((key) => e.MEDIA.put(key, WEBP, { httpMetadata: { contentType: "image/webp" } })));

test("special: saves the original; replacing the photo deletes the old photo AND old original", async () => {
  const e = env();
  await put(e, k("a"), k("b"), k("c"), k("d"));
  const { special } = await (await admin(e, "POST", "specials", { title: "Kits", image_key: k("a"), image_orig_key: k("b") })).json();
  assert.equal(special.image_orig_key, k("b"));
  assert.equal(special.image_orig, `/media/${k("b")}`);
  const res = await admin(e, "PUT", `specials/${special.id}`, { title: "Kits", image_key: k("c"), image_orig_key: k("d") });
  assert.equal(res.status, 200);
  assert.equal(e.MEDIA.objects.has(k("a")), false);
  assert.equal(e.MEDIA.objects.has(k("b")), false);
  // Re-framing from the same original keeps it.
  await put(e, k("e"));
  await admin(e, "PUT", `specials/${special.id}`, { title: "Kits", image_key: k("e"), image_orig_key: k("d") });
  assert.equal(e.MEDIA.objects.has(k("c")), false);
  assert.equal(e.MEDIA.objects.has(k("d")), true);
  await admin(e, "DELETE", `specials/${special.id}`);
  assert.equal(e.MEDIA.objects.has(k("e")), false);
  assert.equal(e.MEDIA.objects.has(k("d")), false);
});

test("special: the public site never sees the original", async () => {
  const e = env();
  await put(e, k("a"), k("b"));
  await admin(e, "POST", "specials", { title: "Kits", image_key: k("a"), image_orig_key: k("b") });
  const text = await (await worker.fetch(new Request(`${ORIGIN}/api/content`), e)).text();
  assert.ok(text.includes(k("a")));
  assert.ok(!text.includes(k("b")));
});

test("event: flyer original stored and removed with the event", async () => {
  const e = env();
  await put(e, k("a"), k("b"));
  const date = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const { event } = await (await admin(e, "POST", "events", { title: "Market", date, flyer_key: k("a"), flyer_orig_key: k("b") })).json();
  assert.equal(event.flyer_orig_key, k("b"));
  await admin(e, "DELETE", `events/${event.id}`);
  assert.equal(e.MEDIA.objects.size, 0);
});

test("legacy photo (no original) still saves; an original without a photo is dropped", async () => {
  const e = env();
  await put(e, k("a"), k("b"));
  const a = await (await admin(e, "POST", "specials", { title: "Old", image_key: k("a") })).json();
  assert.equal(a.special.image_orig_key, null);
  const b = await (await admin(e, "POST", "specials", { title: "No photo", image_orig_key: k("b") })).json();
  assert.equal(b.special.image_orig_key, null);
});

test("original must be a real uploaded photo", async () => {
  const e = env();
  await put(e, k("a"));
  const res = await admin(e, "POST", "specials", { title: "X", image_key: k("a"), image_orig_key: "video/2026/" + k("b").slice(9, 45) + ".mp4" });
  assert.equal(res.status, 400);
});

test("media: Edit photo swaps in the re-framed photo and frees the old files; videos can't be swapped", async () => {
  const e = env();
  await put(e, k("a"), k("b"), k("c"), k("d"));
  const { media } = await (await admin(e, "POST", "media", { kind: "photo", key_or_url: k("a"), orig_key: k("b"), featured: true })).json();
  assert.equal(media.orig_key, k("b"));
  const r = await (await admin(e, "PATCH", `media/${media.id}`, { key_or_url: k("c"), orig_key: k("d") })).json();
  assert.equal(r.media.key_or_url, k("c"));
  assert.equal(r.media.featured, true, "other fields unchanged");
  assert.deepEqual([...e.MEDIA.objects.keys()].sort(), [k("c"), k("d")].sort());
  await admin(e, "DELETE", `media/${media.id}`);
  assert.equal(e.MEDIA.objects.size, 0);
  const ig = await (await admin(e, "POST", "media", { kind: "instagram", key_or_url: "https://www.instagram.com/p/x/" })).json();
  await put(e, k("f"));
  assert.equal((await admin(e, "PATCH", `media/${ig.media.id}`, { key_or_url: k("f") })).status, 400);
});

test("migration 0004 keeps existing rows and adds empty original columns", () => {
  const e = env();
  const cols = (t) => e.DB.raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols("specials").includes("image_orig_key"));
  assert.ok(cols("events").includes("flyer_orig_key"));
  assert.ok(cols("media").includes("orig_key"));
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM menu").get().n, 11);
});
