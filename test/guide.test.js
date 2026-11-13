// "Show me" guide: tasks.json is the single source; the generated Help assets must match it exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "guide", "tasks.json"), "utf8"));
const guide = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "admin", "help", "guide.json"), "utf8"));
const pub = (url) => path.join(ROOT, "public", ...url.split("/").filter(Boolean));

test("tasks.json covers every task in the brief, 4–6 steps each", () => {
  assert.deepEqual(spec.tasks.map((t) => t.id), ["home", "photo", "cotm", "special", "event", "signups", "flavor", "treat", "price", "order", "pay", "spreadsheet", "tip"]);
  for (const t of spec.tasks) {
    assert.ok(t.steps.length >= 4 && t.steps.length <= 6, `${t.id} has ${t.steps.length} steps`);
    for (const s of t.steps) { assert.ok(s.caption.trim(), t.id); assert.ok(s.highlight, t.id); }
    assert.ok(t.start.startsWith("/"), t.id);
  }
});

test("Help words are exactly the tasks.json words (pictures and words can't drift)", () => {
  assert.deepEqual(guide.tasks.map((t) => t.id), spec.tasks.map((t) => t.id), "re-run `npm run guide`");
  for (const [i, t] of spec.tasks.entries()) {
    const g = guide.tasks[i];
    assert.equal(g.title, t.title);
    assert.equal(g.tip, t.tip);
    assert.deepEqual(g.steps.map((s) => s.caption), t.steps.map((s) => s.caption), `${t.id}: re-run \`npm run guide\``);
  }
});

test("every step picture and clip exists; clips are silent H.264 MP4, ≤ 20 s, < 1.5 MB", () => {
  for (const t of guide.tasks) {
    for (const s of t.steps) {
      const f = pub(s.image);
      assert.ok(fs.existsSync(f), s.image);
      const b = fs.readFileSync(f);
      assert.equal(b.subarray(8, 12).toString(), "WEBP", s.image);
    }
    const clip = fs.readFileSync(pub(t.clip));
    assert.equal(clip.subarray(4, 8).toString(), "ftyp", t.clip);
    assert.ok(clip.length < 1.5 * 1024 * 1024, `${t.clip} is ${clip.length} bytes`);
    assert.ok(t.clip_seconds > 0 && t.clip_seconds <= 20, `${t.clip} is ${t.clip_seconds}s`);
    assert.ok(clip.includes(Buffer.from("avc1")), `${t.clip} is H.264`);
    assert.ok(!clip.includes(Buffer.from("mp4a")), `${t.clip} has no audio`);
  }
});

test("admin Help is built from guide.json (lazy pictures + Show me), not a hard-coded list", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "admin", "index.html"), "utf8");
  assert.match(html, /fetch\("\/admin\/help\/guide\.json"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /Show me/);
  assert.doesNotMatch(html, /const HELP = \[/);
});

test("guide runner refuses anything but local dev", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "guide.mjs"), "utf8");
  assert.match(src, /only runs against local wrangler dev/);
});

test("admin and public inline scripts parse (no syntax errors)", () => {
  for (const page of ["admin/index.html", "index.html", "kitchen/index.html"]) {
    const html = fs.readFileSync(path.join(ROOT, "public", page), "utf8");
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]), page);
  }
});
