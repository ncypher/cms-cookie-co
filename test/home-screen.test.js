// Home-screen icon: must open /admin/ in the normal browser (not a full-screen web app), and /kitchen/ must be public.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import worker from "../src/worker.js";

const pub = (p) => fs.readFileSync(path.join(import.meta.dirname, "..", "public", p), "utf8");
const manifest = JSON.parse(pub("pwa/admin.webmanifest"));

test("manifest: opens /admin/ as a plain browser tab", () => {
  assert.equal(manifest.display, "browser");
  assert.equal(manifest.start_url, "/admin/");
  assert.ok("/kitchen/".startsWith(manifest.scope) && "/admin/".startsWith(manifest.scope), "both pages are in scope");
  assert.ok(manifest.icons.some((i) => i.sizes === "512x512"));
});

for (const page of ["admin/index.html", "kitchen/index.html"]) {
  test(`${page}: links the manifest + apple-touch-icon and never asks for full-screen app mode`, () => {
    const html = pub(page);
    assert.match(html, /<link rel="manifest" href="\/pwa\/admin\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/assets\/apple-touch-icon\.png">/);
    assert.match(html, /apple-mobile-web-app-title" content="CMS Admin"/);
    assert.doesNotMatch(html, /<meta name="apple-mobile-web-app-capable"/);
    assert.doesNotMatch(html, /<meta name="mobile-web-app-capable"/);
  });
}

test("kitchen page: big button to /admin/", () => {
  assert.match(pub("kitchen/index.html"), /<a class="go" href="\/admin\/" id="open">Open my kitchen<\/a>/);
});

test("kitchen page: Android steps match Chrome's Install / Create shortcut drawer", () => {
  const html = pub("kitchen/index.html");
  assert.match(html, /Tap <b>Add to Home screen<\/b>\.<\/li><li>Chrome asks <b>Install<\/b> or <b>Create shortcut<\/b>: tap <b>Create shortcut<\/b>\.<\/li><li>Tap <b>Add<\/b>\.<\/li>/);
  const guide = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "guide", "tasks.json"), "utf8"));
  const home = guide.tasks.find((t) => t.id === "home");
  assert.ok(home.steps.some((s) => /\{Create shortcut\}/.test(s.caption)), "Help says Create shortcut too");
});

test("kitchen page: forwarding shows the cookie and 'Opening your kitchen…', never a blank page", () => {
  const html = pub("kitchen/index.html");
  assert.match(html, /<div class="splash" role="status"><img class="icon" src="\/assets\/admin-icon-192\.png"[^>]*><p>Opening your kitchen…<\/p><\/div>/);
  assert.match(html, /html\.fwd \.splash\{display:block\}/);
  assert.doesNotMatch(html.split("</head>")[0], /location\.replace/, "no redirect before anything is painted");
  assert.match(html, /requestAnimationFrame\(function\(\)\{ requestAnimationFrame\(go\); \}\)/);
  assert.match(html, /fonts\.googleapis[^>]*media="print" onload=/, "web fonts don't block the first paint");
});

test("worker: /kitchen/ is public (no Access check), /admin/ is not", async () => {
  const env = { ASSETS: { fetch: async () => new Response("ok", { headers: { "Content-Type": "text/html" } }) } };
  const kitchen = await worker.fetch(new Request("https://cmscookieco3more.com/kitchen/"), env);
  assert.equal(kitchen.status, 200);
  const adminPage = await worker.fetch(new Request("https://cmscookieco3more.com/admin/"), env);
  assert.notEqual(adminPage.status, 200);
});
