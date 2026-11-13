// Pay-link QR codes: the generator must reproduce the flyer's Venmo QR exactly, and every code it makes
// must read back (checked by a small independent decoder below: format bits, unmask, de-interleave,
// Reed–Solomon syndromes all zero, then the byte-mode text).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { qrMatrix, qrSvg } from "../public/assets/qr.js";

const FLYER_SVG = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "venmo-flyer-qr.svg"), "utf8").trim();

test("Venmo QR for @CmsCookieCo is identical to the one on the site before (module for module)", () => {
  assert.equal(qrSvg("https://venmo.com/u/CmsCookieCo", { label: "QR code for CMS Cookie Co. on Venmo" }), FLYER_SVG);
});

/* ---- a tiny decoder, written separately from the encoder ---- */
const EXP = [], LOG = [];
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); }
const mul = (a, b) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);
const BLOCKS = { M: [[10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5]] };
const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

function decode(q) {
  const n = q.size, ver = (n - 17) / 4, isFn = (x, y) => {
    if ((x < 9 && y < 9) || (x >= n - 8 && y < 9) || (x < 9 && y >= n - 8)) return true; // finders, separators, format
    if (x === 6 || y === 6) return true;
    if (ver >= 7 && ((x >= n - 11 && x < n - 8 && y < 6) || (y >= n - 11 && y < n - 8 && x < 6))) return true;
    const a = ALIGN[ver];
    return a.some((ax) => a.some((ay) => !((ax === 6 && ay === 6) || (ax === 6 && ay === a.at(-1)) || (ax === a.at(-1) && ay === 6)) && Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2));
  };
  // Format bits (first copy) -> error level + mask, by trying all 32 valid codes.
  let raw = 0;
  const fpos = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  fpos.forEach(([x, y], i) => { if (q.dark(x, y)) raw |= 1 << i; });
  let fmt = null;
  for (let d = 0; d < 32; d++) {
    let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    if ((((d << 10) | r) ^ 0x5412) === raw) fmt = { ecl: d >> 3, mask: d & 7 };
  }
  assert.ok(fmt, "format bits readable");
  assert.equal(fmt.ecl, 0, "error correction M");
  const bits = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < n; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? n - 1 - v : v;
      if (!isFn(x, y)) bits.push(q.dark(x, y) !== MASKS[fmt.mask](x, y) ? 1 : 0);
    }
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const [ecc, nb] = BLOCKS.M[ver - 1];
  const shortLen = Math.floor(words.length / nb), numShort = nb - (words.length % nb);
  const blocks = Array.from({ length: nb }, () => []);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) for (let b = 0; b < nb; b++) {
    if (i === shortLen - ecc && b < numShort) continue; // short blocks have no word here
    if (blocks[b].length < shortLen + (b < numShort ? 0 : 1)) blocks[b].push(words[k++]);
  }
  const data = [];
  for (const blk of blocks) {
    for (let s = 0; s < ecc; s++) { // syndrome S_s = blk(alpha^s) must be 0
      let acc = 0; for (const w of blk) acc = mul(acc, EXP[s]) ^ w;
      assert.equal(acc, 0, `syndrome ${s} of a block`);
    }
    data.push(...blk.slice(0, blk.length - ecc));
  }
  const db = data.flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (w >> i) & 1)), rd = (o, l) => db.slice(o, o + l).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(rd(0, 4), 0b0100, "byte mode");
  const len = rd(4, 8);
  return new TextDecoder().decode(new Uint8Array(Array.from({ length: len }, (_, i) => rd(12 + i * 8, 8))));
}

test("every pay link QR reads back: short and long Venmo names, Cash App cashtags (versions 2–4)", () => {
  const links = [
    "https://venmo.com/u/CmsCookieCo", "https://venmo.com/u/a", "https://venmo.com/u/Shaun-Marie_Schwartz2026",
    "https://venmo.com/u/" + "x".repeat(30), "https://cash.app/$CmsCookieCo", "https://cash.app/$" + "z".repeat(20),
  ];
  const versions = new Set();
  for (const l of links) { const q = qrMatrix(l); versions.add(q.version); assert.equal(decode(q), l); }
  assert.ok(versions.has(4), "a two-block (version 4) code is covered");
});

test("QR maker refuses text that's too long instead of drawing a broken code", () => {
  assert.throws(() => qrMatrix("x".repeat(400)), /Too long/);
});
