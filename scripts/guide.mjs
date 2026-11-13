// `npm run guide`: rebuild the admin "Show me" guide from guide/tasks.json.
// Drives LOCAL wrangler dev with seed content (never production) in a 390x844 phone-sized browser.
// For each task: one picture per step with the control to tap highlighted, plus one silent H.264 clip
// (<= 20 s, < 1.5 MB). Writes public/admin/help/<task>/N.webp, clip.mp4 and public/admin/help/guide.json.
// Needs: ffmpeg on PATH, `npx playwright install chromium` once.
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = process.env.GUIDE_BASE || "http://localhost:8787";
const OUT = path.join(ROOT, "public", "admin", "help");
const TMP = path.join(ROOT, "test-results", "guide");
const VIEW = { width: 390, height: 844 };
const MAX_CLIP_S = 19.5, MAX_CLIP_BYTES = 1.5 * 1024 * 1024;
const only = process.argv.slice(2); // optional task ids

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error(`The guide only runs against local wrangler dev, not ${BASE}`);
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "guide", "tasks.json"), "utf8"));
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && cmd === "npx" }).toString();
try { sh("ffmpeg", ["-version"]); } catch { throw new Error("ffmpeg is needed for the clips. Install it (winget install Gyan.FFmpeg) and try again."); }

/* ---- local dev server + seed ---- */
async function up() { try { return (await fetch(BASE + "/api/content")).ok; } catch { return false; } }
/* ---- a pretend Square: the guide never calls the real one ---- */
const MOCK = "http://127.0.0.1:8790";
async function mockUp() { try { return (await fetch(MOCK + "/health")).ok; } catch { return false; } }
let mockProc = null;
if (!(await mockUp())) {
  mockProc = spawn(process.execPath, ["scripts/square-mock.mjs"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, GUIDE_BASE: BASE, SQUARE_MOCK_PORT: "8790" } });
  for (let i = 0; i < 20 && !(await mockUp()); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await mockUp())) throw new Error("The pretend Square didn't start on " + MOCK);
}
// These --var values win over .dev.vars, so real Square keys there are never used by the guide.
const SQUARE_VARS = { SQUARE_API_BASE: MOCK, SQUARE_APP_ID: "sandbox-guide-mock", SQUARE_APP_SECRET: "guide-mock-secret",
  SQUARE_TOKEN_ENC_KEY: crypto.randomBytes(32).toString("hex"), SQUARE_WEBHOOK_SIGNATURE_KEY: "guide-mock", DEV_ORIGIN: BASE };

let devProc = null;
if (!(await up())) {
  console.log("Starting wrangler dev (with the pretend Square)…");
  devProc = spawn("npx", ["wrangler", "dev", ...Object.entries(SQUARE_VARS).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd: ROOT, shell: process.platform === "win32", stdio: "ignore" });
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await up())) throw new Error("wrangler dev didn't start on " + BASE);
}
const sqState = await (await fetch(BASE + "/api/admin/square")).json().catch(() => ({}));
if (!sqState.square?.mock) {
  if (mockProc) mockProc.kill();
  throw new Error("wrangler dev is already running without the pretend Square (it could reach the real one). Stop it and run `npm run guide` again; the guide starts its own.");
}
const me = await (await fetch(BASE + "/api/admin/me")).json().catch(() => ({}));
if (!me.dev) throw new Error("Admin needs ACCESS_DEV_BYPASS=true in .dev.vars (copy .dev.vars.example).");
console.log("Seeding local D1/R2 (local only)…");
sh("node", ["scripts/seed-dev.mjs"]);

/* ---- helpers ---- */
const dateIn = (n) => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const fillText = (t) => String(t).replace(/\{\+(\d+)d\}/g, (_, n) => dateIn(+n));

async function highlight(page, sel, on) {
  await page.evaluate(({ sel, on }) => {
    document.getElementById("guide-hl")?.remove();
    if (!on) return;
    const el = document.querySelector(sel); if (!el) return;
    const r = el.getBoundingClientRect(), pad = 6;
    const d = document.createElement("div");
    d.id = "guide-hl";
    Object.assign(d.style, {
      position: "fixed", left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px",
      border: "4px solid #E54F7C", borderRadius: "14px", boxShadow: "0 0 0 4px rgba(255,255,255,.85), 0 0 0 9999px rgba(40,20,14,.28)",
      zIndex: 2147483647, pointerEvents: "none",
    });
    document.body.append(d);
  }, { sel, on });
}

async function act(page, a) {
  const loc = (s) => page.locator(s).first();
  if (a.wait) return loc(a.wait).waitFor({ state: "visible", timeout: 15000 });
  if (a.waitGone) return page.waitForFunction((s) => !document.querySelector(s), a.waitGone, { timeout: 30000 });
  if (a.tap) return loc(a.tap).click();
  if (a.fill) return loc(a.fill).fill(fillText(a.text));
  if (a.select) return loc(a.select).selectOption(a.value);
  if (a.file) return loc(a.file).setInputFiles(path.join(ROOT, a.path));
  if (a.press) return page.keyboard.press(a.press);
  if (a.scroll) return loc(a.scroll).scrollIntoViewIfNeeded();
  if (a.pause) return page.waitForTimeout(a.pause);
  if (a.goto) return page.goto(a.goto.startsWith("http") ? a.goto : BASE + a.goto);
  if (a.tapIf) { const l = loc(a.tapIf); if (await l.waitFor({ state: "visible", timeout: a.timeout || 2500 }).then(() => true, () => false)) await l.click(); return; }
  if (a.check) { const l = loc(a.check); await l.waitFor({ state: "attached" }); if (!(await l.isChecked())) await l.click(); return; }
  if (a.range) return loc(a.range).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, a.value);
  if (a.drag) {
    const b = await loc(a.drag).boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + (a.dx || 0), y + (a.dy || 0), { steps: 12 }); await page.mouse.up();
    return;
  }
  throw new Error("Unknown action " + JSON.stringify(a));
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete && i.loading !== "lazy").map((i) => new Promise((r) => { i.onload = i.onerror = r; }))));
}

function encodeClip(webm, mp4) {
  const probe = sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", webm]);
  const dur = parseFloat(probe) || MAX_CLIP_S;
  const speed = Math.max(1, dur / MAX_CLIP_S);
  for (const crf of [28, 31, 34, 37]) {
    sh("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-an",
      "-vf", `setpts=PTS/${speed.toFixed(3)},fps=24,scale=390:-2:flags=lanczos,format=yuv420p`,
      "-c:v", "libx264", "-profile:v", "main", "-preset", "slow", "-crf", String(crf), "-movflags", "+faststart", mp4]);
    if (fs.statSync(mp4).size < MAX_CLIP_BYTES) break;
  }
  const out = parseFloat(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", mp4]));
  return { seconds: Math.round(out * 10) / 10, bytes: fs.statSync(mp4).size, speed: Math.round(speed * 100) / 100 };
}

/* ---- run ---- */
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const browser = await chromium.launch();
const guide = { generated: new Date().toISOString(), tasks: [] };
const prev = fs.existsSync(path.join(OUT, "guide.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "guide.json"), "utf8")) : { tasks: [] };
let failed = false;
try {
  for (const task of spec.tasks) {
    if (only.length && !only.includes(task.id)) { const old = prev.tasks.find((t) => t.id === task.id); if (old) guide.tasks.push(old); continue; }
    const dir = path.join(OUT, task.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, hasTouch: true, isMobile: true, recordVideo: { dir: TMP, size: VIEW } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    const steps = [];
    try {
      await page.goto(BASE + task.start);
      await settle(page);
      for (const a of task.before || []) await act(page, a);
      for (const [i, step] of task.steps.entries()) {
        for (const a of step.before || []) await act(page, a);
        const target = page.locator(step.highlight).first();
        await target.waitFor({ state: "visible" });
        await target.scrollIntoViewIfNeeded();
        await settle(page);
        await page.waitForTimeout(250);
        await highlight(page, step.highlight, true);
        const png = path.join(TMP, `${task.id}-${i + 1}.png`);
        await page.screenshot({ path: png });
        // Picture for Help: 480 px wide WebP (sharp at the size Help shows it).
        sh("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-vf", "scale=480:-2:flags=lanczos", "-c:v", "libwebp", "-quality", "72", path.join(dir, `${i + 1}.webp`)]);
        await page.waitForTimeout(650); // the clip shows the highlight before the tap
        await highlight(page, step.highlight, false);
        if (step.tap !== false) await target.click();
        for (const a of step.after || []) await act(page, a);
        steps.push({ caption: step.caption, image: `/admin/help/${task.id}/${i + 1}.webp` });
      }
      await page.waitForTimeout(600);
    } catch (e) {
      failed = true;
      await page.screenshot({ path: path.join(TMP, `${task.id}-FAILED.png`) }).catch(() => {});
      console.error(`✗ ${task.id}: ${e.message.split("\n")[0]}`);
    }
    const video = page.video();
    await ctx.close();
    if (failed) break;
    const clip = encodeClip(await video.path(), path.join(dir, "clip.mp4"));
    console.log(`✓ ${task.id}: ${steps.length} pictures, clip ${clip.seconds}s ${(clip.bytes / 1024).toFixed(0)} KB${clip.speed > 1 ? ` (sped up ×${clip.speed})` : ""}`);
    guide.tasks.push({ id: task.id, icon: task.icon, title: task.title, go: task.go, tip: task.tip, ...(task.needs ? { needs: task.needs } : {}), steps, clip: `/admin/help/${task.id}/clip.mp4`, clip_seconds: clip.seconds });
  }
} finally {
  await browser.close();
  // On Windows, npx runs under a shell: kill the whole tree or wrangler/workerd stay running on the port.
  if (devProc) { if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(devProc.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} } else devProc.kill(); }
  if (mockProc) mockProc.kill();
}
if (failed) { console.error(`Guide not written. See ${path.relative(ROOT, TMP)} for the screenshot where it stopped.`); process.exit(1); }
// Keep the order from tasks.json.
guide.tasks.sort((a, b) => spec.tasks.findIndex((t) => t.id === a.id) - spec.tasks.findIndex((t) => t.id === b.id));
fs.writeFileSync(path.join(OUT, "guide.json"), JSON.stringify(guide, null, 2) + "\n");
console.log(`\nWrote ${path.relative(ROOT, OUT)}/guide.json (${guide.tasks.length} tasks). Local data was changed by the run; \`npm run seed:dev\` resets it.`);
