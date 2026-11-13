// Photo Studio math, kept free of the DOM so `node --test` can check it.
// Coordinates: the frame is 1 unit wide and 1/aspect tall. The image's scale `s` is frame units per source pixel.

// Destination -> shape. The public site shows exactly this shape (see index.html CSS).
export const SHAPES = {
  circle: { aspect: 1, label: "circle" },   // Cookie of the Month, flavors (site: 1:1, border-radius 50%)
  square: { aspect: 1, label: "square" },   // treats, gallery photos (site: 1:1)
  wide:   { aspect: 4 / 3, label: "4:3" },  // specials (site: aspect-ratio 4/3)
  whole:  { aspect: null, label: "whole" }, // event flyer: never cropped, frame = photo
};

export const MAX_LONG = 1600;       // photo shown on the site
export const MAX_ORIGINAL = 2400;   // kept so "Edit photo" can start again from the real picture
export const MAX_WORK = 2048;       // the picture the studio edits; big enough for the 1600 px result
export const TARGET_BYTES = 400 * 1024;
export const HEADER_BYTES = 1024 * 1024; // how much of a file imageInfo() needs to see

/* ---- Photo size without decoding it ----
   Phones make 50-megapixel photos now. Decoding one at full size takes ~200 MB, which is what made
   Android Chrome give up ("low memory"). So we read the size (and the JPEG's EXIF rotation) from the
   file's first bytes and ask the browser to decode straight to a capped size. */
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

function exifOrientation(b, start, end) {
  // start points at the TIFF header ("II*\0" or "MM\0*") inside an APP1 Exif segment.
  if (start + 8 > end) return 1;
  const le = b[start] === 0x49, r16 = (o) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o) => (le ? (u16le(b, o) + u16le(b, o + 2) * 65536) : u32be(b, o));
  const ifd = start + r32(start + 4);
  if (ifd + 2 > end) return 1;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
  }
  return 1;
}

/** {type, w, h, orientation} as stored in the file (before EXIF rotation), or null if unknown/truncated. */
export function imageInfo(b) {
  if (!b || b.length < 30) return null;
  if (b[0] === 0xff && b[1] === 0xd8) { // JPEG: walk the segments to the frame header
    let i = 2, orientation = 1;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }                 // fill byte
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m === 0xd9 || m === 0xda) return null;         // end / scan before a frame header
      const len = u16be(b, i + 2);
      if (m === 0xe1 && ascii(b, i + 4, 4) === "Exif") orientation = exifOrientation(b, i + 10, Math.min(b.length, i + 2 + len));
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = u16be(b, i + 5), w = u16be(b, i + 7);
        return w && h ? { type: "jpeg", w, h, orientation } : null;
      }
      i += 2 + len;
    }
    return null;
  }
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") {
    return { type: "png", w: u32be(b, 16), h: u32be(b, 20), orientation: 1 };
  }
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const c = ascii(b, 12, 4);
    if (c === "VP8 ") return { type: "webp", w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff, orientation: 1 };
    if (c === "VP8L") return { type: "webp", w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)), orientation: 1 };
    if (c === "VP8X") return { type: "webp", w: 1 + u24le(b, 24), h: 1 + u24le(b, 27), orientation: 1 };
  }
  return null;
}

/** Size the photo shows at once EXIF rotation is applied (orientations 5–8 swap width and height). */
export function orientedSize(info) {
  return info.orientation >= 5 ? { w: info.h, h: info.w } : { w: info.w, h: info.h };
}

export function rotatedSize(iw, ih, rot) {
  return rot % 180 ? { w: ih, h: iw } : { w: iw, h: ih };
}

export function frameAspect(shape, iw, ih, rot) {
  const a = SHAPES[shape]?.aspect;
  if (a) return a;
  const r = rotatedSize(iw, ih, rot);
  return r.w / r.h;
}

// Scale where the photo just covers the frame, and where the whole photo just fits.
export function scales(shape, iw, ih, rot) {
  const A = frameAspect(shape, iw, ih, rot), r = rotatedSize(iw, ih, rot);
  return { A, cover: Math.max(1 / r.w, 1 / A / r.h), contain: Math.min(1 / r.w, 1 / A / r.h) };
}

export const MAX_ZOOM = 5;
export function zoomRange(shape, iw, ih, rot) {
  if (shape === "whole") return { min: 1, max: 1 };
  const { cover, contain } = scales(shape, iw, ih, rot);
  return { min: contain / cover, max: MAX_ZOOM };
}

// Keep the photo covering the frame when it's bigger than it, and inside the frame when it's smaller.
export function clampState(st, shape, iw, ih) {
  const { A, cover } = scales(shape, iw, ih, st.rot);
  const { min, max } = zoomRange(shape, iw, ih, st.rot);
  const zoom = Math.min(max, Math.max(min, st.zoom));
  const s = cover * zoom, r = rotatedSize(iw, ih, st.rot);
  const limX = Math.abs(r.w * s - 1) / 2, limY = Math.abs(r.h * s - 1 / A) / 2;
  const c = (v, l) => Math.min(l, Math.max(-l, v)) + 0; // + 0 turns -0 into 0
  return { ...st, zoom, px: c(st.px, limX), py: c(st.py, limY) };
}

export function initialState() {
  return { rot: 0, zoom: 1, px: 0, py: 0, bright: 0, layers: [] };
}

// Output pixel size: long edge up to MAX_LONG, but never upscaled past what the photo really has.
export function outputSize(st, shape, iw, ih, maxLong = MAX_LONG) {
  const { A, cover } = scales(shape, iw, ih, st.rot);
  const s = cover * st.zoom;
  const frameLongPx = Math.max(1 / s, 1 / A / s); // frame's long edge measured in source pixels
  const long = Math.round(Math.min(maxLong, Math.max(320, frameLongPx)));
  return A >= 1 ? { w: long, h: Math.max(1, Math.round(long / A)) } : { w: Math.max(1, Math.round(long * A)), h: long };
}

export function fitInside(w, h, maxLong) {
  const k = Math.min(1, maxLong / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * Encode under a byte budget. `encode(type, quality, scale)` returns a Blob-like {size, type}.
 * WebP first; if the browser can't write WebP (it hands back PNG), use JPEG. Lower quality, then shrink.
 */
export async function encodeUnder(encode, { limit = TARGET_BYTES, qualities = [0.86, 0.8, 0.72, 0.64, 0.56] } = {}) {
  let type = "image/webp";
  let last = await encode(type, qualities[0], 1);
  if (!last || last.type !== type) { type = "image/jpeg"; last = await encode(type, qualities[0], 1); }
  if (last.size <= limit) return last;
  for (let scale = 1; scale >= 0.4; scale *= 0.8) {
    for (const q of qualities) {
      if (scale === 1 && q === qualities[0]) continue; // already tried
      last = await encode(type, q, scale);
      if (last.size <= limit) return last;
    }
  }
  return last;
}

export function money(n) {
  if (n == null || n === "" || !Number.isFinite(Number(n))) return "";
  const c = Math.round(Number(n) * 100);
  return "$" + (c % 100 ? (c / 100).toFixed(2) : String(c / 100));
}
