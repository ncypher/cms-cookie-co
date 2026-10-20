// Order rate limiting and R2 cleanup, run against the real worker.js with fake bindings.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { TOO_MANY_ORDERS } from "../src/messages.js";
import { fakeD1, fakeR2, fakeLimiter } from "./helpers/fakes.js";

const ORIGIN = "http://localhost:8787";
const makeEnv = (extra = {}) => ({ DB: fakeD1(), MEDIA: fakeR2(), ACCESS_DEV_BYPASS: "true", ...extra });
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

function order(env, ip, name = "Rate Test") {
  return worker.fetch(new Request(`${ORIGIN}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ name, phone: "5555550100", date: inDays(5), items: [{ type: "gram", qty: 1 }] }),
  }), env);
}
const admin = (env, method, path, body) => worker.fetch(new Request(`${ORIGIN}/api/admin/${path}`, {
  method,
  headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
  body: body === undefined ? undefined : JSON.stringify(body),
}), env);

/* ---- Rate limiting ---- */
test("orders: 6th order from one device inside 10 minutes gets 429 with the text-Shaun message", async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) assert.equal((await order(env, "203.0.113.7")).status, 201, `order ${i + 1}`);
  const res = await order(env, "203.0.113.7");
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, TOO_MANY_ORDERS);
  assert.equal(res.headers.get("Retry-After"), "600");
  // A different device is unaffected.
  assert.equal((await order(env, "198.51.100.9")).status, 201);
});

test("orders: older orders fall out of the 10-minute window", async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) await order(env, "203.0.113.8");
  env.DB.raw.exec("UPDATE orders SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-11 minutes')");
  assert.equal((await order(env, "203.0.113.8")).status, 201);
});

test("orders: the ORDER_LIMITER binding blocks bursts before anything is saved", async () => {
  const env = makeEnv({ ORDER_LIMITER: fakeLimiter(2) });
  assert.equal((await order(env, "203.0.113.9")).status, 201);
  assert.equal((await order(env, "203.0.113.9")).status, 201);
  const res = await order(env, "203.0.113.9");
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
  const { n } = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM orders").get();
  assert.equal(n, 2);
});

test("orders: the raw IP is never stored, only a salted hash", async () => {
  const env = makeEnv({ RATE_LIMIT_SALT: "s1" });
  await order(env, "203.0.113.10");
  const row = env.DB.raw.prepare("SELECT * FROM orders").get();
  assert.match(row.client_hash, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(row).includes("203.0.113.10"));
  const env2 = makeEnv({ RATE_LIMIT_SALT: "s2" });
  await order(env2, "203.0.113.10");
  assert.notEqual(env2.DB.raw.prepare("SELECT client_hash FROM orders").get().client_hash, row.client_hash);
});

/* ---- R2 cleanup ---- */
const KEY_A = "img/2026/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp";
const KEY_B = "img/2026/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp";
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);

test("delete special removes its image from R2", async () => {
  const env = makeEnv();
  await env.MEDIA.put(KEY_A, WEBP, { httpMetadata: { contentType: "image/webp" } });
  const { special } = await (await admin(env, "POST", "specials", { title: "S", image_key: KEY_A })).json();
  assert.equal((await admin(env, "DELETE", `specials/${special.id}`)).status, 200);
  assert.equal(env.MEDIA.objects.has(KEY_A), false);
});

test("delete special keeps the image when another row still uses it", async () => {
  const env = makeEnv();
  await env.MEDIA.put(KEY_A, WEBP, { httpMetadata: { contentType: "image/webp" } });
  const a = (await (await admin(env, "POST", "specials", { title: "A", image_key: KEY_A })).json()).special;
  await admin(env, "POST", "events", { title: "E", date: inDays(3), flyer_key: KEY_A });
  await admin(env, "DELETE", `specials/${a.id}`);
  assert.equal(env.MEDIA.objects.has(KEY_A), true, "event still points at it");
});

test("delete event removes its flyer; replacing a flyer removes the old one", async () => {
  const env = makeEnv();
  await env.MEDIA.put(KEY_A, WEBP, { httpMetadata: { contentType: "image/webp" } });
  await env.MEDIA.put(KEY_B, WEBP, { httpMetadata: { contentType: "image/webp" } });
  const { event } = await (await admin(env, "POST", "events", { title: "E", date: inDays(3), flyer_key: KEY_A })).json();
  assert.equal((await admin(env, "PUT", `events/${event.id}`, { title: "E", date: inDays(3), flyer_key: KEY_B })).status, 200);
  assert.equal(env.MEDIA.objects.has(KEY_A), false, "old flyer removed on replace");
  await admin(env, "DELETE", `events/${event.id}`);
  assert.equal(env.MEDIA.objects.has(KEY_B), false, "flyer removed on delete");
});

test("delete media keeps the file if a special uses the same key", async () => {
  const env = makeEnv();
  await env.MEDIA.put(KEY_A, WEBP, { httpMetadata: { contentType: "image/webp" } });
  const { media } = await (await admin(env, "POST", "media", { kind: "photo", key_or_url: KEY_A, featured: true })).json();
  await admin(env, "POST", "specials", { title: "S", image_key: KEY_A });
  await admin(env, "DELETE", `media/${media.id}`);
  assert.equal(env.MEDIA.objects.has(KEY_A), true);
});
