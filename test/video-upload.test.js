// iPhone .mov uploads: H.264 accepted (served as video/mp4), HEVC refused and removed from R2.
// Fixtures were made with ffmpeg (testsrc2, 1s, 160x120):
//   h264-moov-end.mov  -c:v libx264 -f mov -movflags -faststart        (ftyp qt, moov at end)
//   hevc-moov-end.mov  -c:v libx265 -tag:v hvc1 -f mov -movflags -faststart
//   h264.mp4           -c:v libx264 -movflags +faststart
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import worker from "../src/worker.js";
import { HEVC_VIDEO } from "../src/messages.js";
import { fakeD1, fakeR2 } from "./helpers/fakes.js";

const fx = (name) => new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name)));
const makeEnv = () => ({ DB: fakeD1(), MEDIA: fakeR2(), ACCESS_DEV_BYPASS: "true" });
const upload = (env, bytes, type) => worker.fetch(new Request("http://localhost:8787/api/admin/upload", {
  method: "PUT",
  headers: { "Content-Type": type, "Content-Length": String(bytes.length), "Sec-Fetch-Site": "same-origin" },
  body: bytes,
}), env);

// Insert a big 'free' box right after ftyp so the file is > 5 MB with moov only in the last 4 MB.
// (Offsets inside the file go stale, which doesn't matter for the codec check.)
function padAfterFtyp(bytes, padBytes) {
  const ftypLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const free = new Uint8Array(padBytes);
  new DataView(free.buffer).setUint32(0, padBytes);
  free.set([0x66, 0x72, 0x65, 0x65], 4); // "free"
  const out = new Uint8Array(bytes.length + padBytes);
  out.set(bytes.subarray(0, ftypLen), 0);
  out.set(free, ftypLen);
  out.set(bytes.subarray(ftypLen), ftypLen + padBytes);
  return out;
}

test("H.264 .mov with moov at the end is accepted, stored as .mov, served as video/mp4", async () => {
  const env = makeEnv();
  const res = await upload(env, fx("h264-moov-end.mov"), "video/quicktime");
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.key, /^video\/\d{4}\/[0-9a-f-]{36}\.mov$/);
  assert.equal(body.kind, "video");
  assert.equal(body.content_type, "video/mp4");
  assert.equal(env.MEDIA.objects.get(body.key).contentType, "video/mp4");
  // and it can be featured as a media item
  const m = await worker.fetch(new Request("http://localhost:8787/api/admin/media", {
    method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ kind: "video", key_or_url: body.key, featured: true }),
  }), env);
  assert.equal(m.status, 201);
});

test("large H.264 .mov: codec found in the last 4 MB without reading the whole file", async () => {
  const env = makeEnv();
  const big = padAfterFtyp(fx("h264-moov-end.mov"), 7 * 1024 * 1024);
  const res = await upload(env, big, "video/quicktime");
  assert.equal(res.status, 201);
  const read = env.MEDIA.reads.reduce((n, r) => n + (r.end - r.start), 0);
  assert.ok(read <= 16 + 5 * 1024 * 1024, `read ${read} of ${big.length} bytes`);
  assert.ok(env.MEDIA.reads.some((r) => r.end === big.length && r.start === big.length - 4 * 1024 * 1024), "tail range read");
});

test("HEVC .mov is refused with the friendly message and deleted from R2", async () => {
  for (const bytes of [fx("hevc-moov-end.mov"), padAfterFtyp(fx("hevc-moov-end.mov"), 7 * 1024 * 1024)]) {
    const env = makeEnv();
    const res = await upload(env, bytes, "video/quicktime");
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error, HEVC_VIDEO);
    assert.equal(env.MEDIA.objects.size, 0, "nothing left in R2");
  }
});

test(".mov with no recognizable video track is refused the same way", async () => {
  const env = makeEnv();
  const bytes = new Uint8Array(4096);
  bytes.set([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]); // ftyp "qt  ", no moov
  const res = await upload(env, bytes, "video/quicktime");
  assert.equal(res.status, 415);
  assert.equal((await res.json()).error, HEVC_VIDEO);
  assert.equal(env.MEDIA.objects.size, 0);
});

test("mp4 uploads are unchanged (no codec check, stored as .mp4)", async () => {
  const env = makeEnv();
  const res = await upload(env, fx("h264.mp4"), "video/mp4");
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.key, /\.mp4$/);
  assert.equal(body.content_type, "video/mp4");
  assert.equal(env.MEDIA.reads.length, 1, "only the 16-byte sniff read");
});

test("a non-video file labelled .mov is refused before the codec check", async () => {
  const env = makeEnv();
  const res = await upload(env, new TextEncoder().encode("definitely not a movie, just text padding....."), "video/quicktime");
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /doesn't look like a real MOV/);
  assert.equal(env.MEDIA.objects.size, 0);
});
