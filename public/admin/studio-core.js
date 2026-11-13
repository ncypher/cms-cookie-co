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
export const TARGET_BYTES = 400 * 1024;

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
