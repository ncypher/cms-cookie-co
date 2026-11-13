// Photo Studio: frame, brighten and decorate a photo on the phone before it's uploaded. Canvas + pointer events,
// no libraries. Usage: const r = await PhotoStudio.open({source, shape, price}); r is null (cancelled) or
// {photo: Blob, original: Blob|null}. `source` is a File (new photo) or {url, isOriginal} (Edit photo).
import {
  SHAPES, MAX_ORIGINAL, initialState, clampState, scales, zoomRange, outputSize, fitInside, encodeUnder, rotatedSize, money,
} from "./studio-core.js";

const C = { paper: "#FFF9F2", green: "#1F4A37", pink: "#E54F7C", pinkBtn: "#D63F6D", cocoa: "#4A2A1E", cream: "#FFF4E6", red: "#B42D55" };
const FONTS = { script: '"Kaushan Script", "Brush Script MT", cursive', display: '"Abril Fatface", Georgia, serif', caps: '"Josefin Sans", "Century Gothic", sans-serif', hand: '"Kalam", "Comic Sans MS", cursive' };
const TEXT_STYLES = [
  { id: "ribbon", label: "Pink ribbon" },
  { id: "script", label: "Script" },
  { id: "bold", label: "Bold" },
];
const STICKERS = [
  { id: "new", label: "NEW!" },
  { id: "soldout", label: "Sold out" },
  { id: "limited", label: "Limited" },
  { id: "heart", label: "Heart" },
  { id: "price", label: "Price tag" },
];

/* ---------------- Fonts: draw only after the site fonts are really loaded ---------------- */
let fontsReady = null;
function loadFonts() {
  if (!fontsReady) {
    const want = [`40px ${FONTS.script}`, `40px ${FONTS.display}`, `700 40px ${FONTS.caps}`, `700 40px ${FONTS.hand}`];
    const all = Promise.all(want.map((f) => document.fonts.load(f).catch(() => null))).then(() => document.fonts.ready);
    fontsReady = Promise.race([all, new Promise((r) => setTimeout(r, 4000))]);
  }
  return fontsReady;
}

/* ---------------- Decoding (browsers apply EXIF rotation to <img> by default) ---------------- */
function decode(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => (img.naturalWidth && img.naturalHeight ? resolve(img) : reject(new Error("empty")));
    img.onerror = () => reject(new Error("undecodable"));
    img.src = src;
  });
}

/* ---------------- Drawing ---------------- */
function drawPhoto(ctx, W, H, img, st, shape) {
  const { cover } = scales(shape, img.naturalWidth, img.naturalHeight, st.rot);
  const s = cover * st.zoom * W; // canvas px per source px
  const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
  ctx.save();
  ctx.fillStyle = C.cream; ctx.fillRect(0, 0, W, H); // shows around the photo after "Fit whole photo"
  ctx.translate(W / 2 + st.px * W, H / 2 + st.py * W);
  ctx.rotate((st.rot * Math.PI) / 180);
  ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
  if (st.bright > 0) { // "screen" the photo over itself: lifts shadows and mid-tones, keeps whites white
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = Math.min(1, st.bright);
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
    if (st.bright > 1) { ctx.globalAlpha = st.bright - 1; ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih); }
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

// Draws a layer centred at (0,0) in the current transform; returns its half-size {hw, hh} in canvas px.
function drawLayerShape(ctx, L, W) {
  const fs = L.size * W;
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  if (L.type === "text") {
    const lines = String(L.text || "").split("\n").slice(0, 4);
    const font = L.style === "bold" ? `${fs}px ${FONTS.display}` : `${fs}px ${FONTS.script}`;
    ctx.font = font;
    const lh = fs * 1.12;
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width), fs);
    const th = lh * lines.length;
    if (L.style === "ribbon") {
      const w = tw + fs * 1.6, h = th + fs * 0.5, n = fs * 0.45;
      ctx.save(); ctx.rotate(-0.035);
      const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2); g.addColorStop(0, "#F07D9A"); g.addColorStop(1, "#E25A82");
      ctx.fillStyle = g; ctx.shadowColor = "rgba(80,20,30,.35)"; ctx.shadowBlur = fs * 0.25; ctx.shadowOffsetY = fs * 0.08;
      ctx.beginPath(); ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(w / 2, -h / 2); ctx.lineTo(w / 2 - n, 0); ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(-w / 2, h / 2); ctx.lineTo(-w / 2 + n, 0); ctx.closePath(); ctx.fill();
      ctx.shadowColor = "transparent"; ctx.fillStyle = "#fff";
      lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * lh));
      ctx.restore();
      return { hw: w / 2, hh: h / 2 };
    }
    ctx.lineWidth = fs * (L.style === "bold" ? 0.16 : 0.2);
    ctx.strokeStyle = L.style === "bold" ? C.cocoa : "#fff";
    ctx.fillStyle = L.style === "bold" ? "#fff" : C.green;
    lines.forEach((l, i) => { const y = (i - (lines.length - 1) / 2) * lh; ctx.strokeText(l, 0, y); ctx.fillText(l, 0, y); });
    return { hw: tw / 2 + fs * 0.2, hh: th / 2 + fs * 0.1 };
  }
  // Stickers: `size` is the sticker's width as a share of the frame width.
  const w = fs;
  ctx.save();
  if (L.kind === "new") {
    ctx.rotate(-0.2); const R = w / 2, r = R * 0.8;
    ctx.beginPath(); for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2, rr = i % 2 ? r : R; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    ctx.closePath(); ctx.fillStyle = C.pinkBtn; ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = w * 0.06; ctx.fill(); ctx.shadowColor = "transparent";
    ctx.lineWidth = w * 0.03; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = `${w * 0.27}px ${FONTS.display}`; ctx.fillText("NEW!", 0, w * 0.01);
    ctx.restore(); return { hw: R, hh: R };
  }
  if (L.kind === "soldout" || L.kind === "limited") {
    const sold = L.kind === "soldout", h = w * 0.3, text = sold ? "SOLD OUT" : "LIMITED";
    ctx.rotate(sold ? -0.17 : -0.06);
    roundRect(ctx, -w / 2, -h / 2, w, h, sold ? w * 0.04 : h / 2);
    ctx.fillStyle = sold ? "rgba(255,255,255,.88)" : C.green; ctx.fill();
    ctx.lineWidth = w * 0.035; ctx.strokeStyle = sold ? C.red : "#fff"; ctx.stroke();
    ctx.fillStyle = sold ? C.red : "#fff"; ctx.font = `700 ${h * 0.5}px ${FONTS.caps}`;
    ctx.fillText(text, 0, h * 0.06, w * 0.86);
    ctx.restore(); return { hw: w / 2, hh: w * 0.2 };
  }
  if (L.kind === "heart") {
    const k = w / 100; ctx.scale(k, k);
    ctx.beginPath(); ctx.moveTo(0, 38); ctx.bezierCurveTo(-60, 0, -48, -46, 0, -22); ctx.bezierCurveTo(48, -46, 60, 0, 0, 38); ctx.closePath();
    ctx.fillStyle = C.pink; ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 6; ctx.fill(); ctx.shadowColor = "transparent";
    ctx.lineWidth = 4; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.restore(); return { hw: w / 2, hh: w * 0.42 };
  }
  // price tag
  const h = w * 0.5, notch = h * 0.5;
  ctx.rotate(-0.1);
  ctx.beginPath(); ctx.moveTo(-w / 2 + notch, -h / 2); ctx.lineTo(w / 2, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.lineTo(-w / 2 + notch, h / 2); ctx.lineTo(-w / 2, 0); ctx.closePath();
  ctx.fillStyle = C.cream; ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = w * 0.05; ctx.fill(); ctx.shadowColor = "transparent";
  ctx.lineWidth = w * 0.03; ctx.strokeStyle = C.pinkBtn; ctx.stroke();
  ctx.beginPath(); ctx.arc(-w / 2 + notch * 0.75, 0, h * 0.08, 0, Math.PI * 2); ctx.fillStyle = C.pinkBtn; ctx.fill();
  ctx.fillStyle = C.pinkBtn; ctx.font = `700 ${h * 0.56}px ${FONTS.hand}`; ctx.fillText(L.text || "", notch * 0.45, h * 0.04, w - notch * 1.4);
  ctx.restore(); return { hw: w / 2, hh: h / 2 };
}

function drawLayers(ctx, W, H, layers, selected) {
  for (const L of layers) {
    ctx.save(); ctx.translate(L.x * W, L.y * H);
    const box = drawLayerShape(ctx, L, W);
    ctx.restore();
    L._box = { hw: box.hw / W, hh: box.hh / H }; // in frame fractions, for tapping
    if (L === selected) {
      ctx.save(); ctx.setLineDash([8, 6]); ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 4;
      ctx.strokeRect(L.x * W - box.hw - 6, L.y * H - box.hh - 6, box.hw * 2 + 12, box.hh * 2 + 12); ctx.restore();
    }
  }
}

function render(ctx, W, H, img, st, shape, { preview = false, selected = null } = {}) {
  drawPhoto(ctx, W, H, img, st, shape);
  drawLayers(ctx, W, H, st.layers, preview ? selected : null);
  if (preview && shape === "circle") { // dim what the round frame on the site won't show
    ctx.save(); ctx.fillStyle = "rgba(40,22,16,.55)";
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.arc(W / 2, H / 2, W / 2 - 1, 0, Math.PI * 2, true); ctx.fill("evenodd");
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(W / 2, H / 2, W / 2 - 1, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
}

function canvasBlob(canvas, type, q) { return new Promise((r) => canvas.toBlob((b) => r(b), type, q)); }

/* ---------------- UI ---------------- */
const CSS = `
.ps{position:fixed; inset:0; z-index:100; background:#2B1C16; color:#fff; display:flex; flex-direction:column; font:400 16px/1.4 "Figtree","Helvetica Neue",Arial,sans-serif;
  padding:env(safe-area-inset-top,0) env(safe-area-inset-right,0) 0 env(safe-area-inset-left,0); touch-action:manipulation}
.ps *{box-sizing:border-box}
.ps-top{display:flex; align-items:center; gap:10px; padding:10px 14px}
.ps-top h2{margin:0 auto 0 0; font:700 22px/1 "Kalam","Comic Sans MS",cursive; color:#FCE6EC}
.ps-stage{flex:1 1 auto; min-height:0; display:grid; place-items:center; padding:4px 14px}
.ps-stage canvas{display:block; touch-action:none; border-radius:6px; box-shadow:0 10px 30px rgba(0,0,0,.45); max-width:100%}
.ps-hint{text-align:center; font-size:14px; color:#E9D6CC; min-height:20px; padding:2px 14px}
.ps-panel{background:#FFF9F2; color:#4A2A1E; border-radius:20px 20px 0 0; padding:12px 14px calc(12px + env(safe-area-inset-bottom,0px)); display:grid; gap:10px}
.ps-sl{display:grid; grid-template-columns:86px 1fr; align-items:center; gap:10px; font-weight:700; font-size:15px}
.ps-sl input{width:100%; height:32px; accent-color:#D63F6D}
.ps-row{display:grid; grid-template-columns:repeat(4,1fr); gap:8px}
.ps-row.two{grid-template-columns:1fr 1fr}
.ps-b{border:1.5px solid rgba(74,42,30,.18); background:#fff; color:#4A2A1E; border-radius:14px; min-height:48px; padding:6px 4px; font:700 13.5px/1.15 "Figtree",Arial,sans-serif; display:grid; place-items:center; gap:2px; cursor:pointer}
.ps-b .i{font-size:19px; line-height:1}
.ps-b[disabled]{opacity:.4}
.ps-go{border:0; border-radius:999px; min-height:56px; background:#D63F6D; color:#fff; font:700 18px "Figtree",Arial,sans-serif; cursor:pointer; box-shadow:0 10px 22px -10px #D63F6D}
.ps-go[disabled]{opacity:.6}
.ps-x{border:1.5px solid rgba(255,255,255,.5); background:transparent; color:#fff; border-radius:999px; min-height:44px; padding:8px 16px; font-weight:700; cursor:pointer}
.ps-sel{display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px}
.ps-sheet{position:absolute; inset:auto 0 0 0; background:#FFF9F2; color:#4A2A1E; border-radius:20px 20px 0 0; padding:16px 14px calc(16px + env(safe-area-inset-bottom,0px)); display:grid; gap:12px; box-shadow:0 -10px 40px rgba(0,0,0,.4); z-index:2; max-height:85%; overflow:auto}
.ps-sheet h3{margin:0; font:700 22px "Kalam","Comic Sans MS",cursive; color:#1F4A37}
.ps-sheet textarea,.ps-sheet input{width:100%; font:16px "Figtree",Arial,sans-serif; border:1.5px solid rgba(74,42,30,.2); border-radius:12px; padding:12px; background:#fff; color:#4A2A1E}
.ps-sheet textarea{min-height:76px; resize:vertical}
.ps-chips{display:grid; grid-template-columns:repeat(3,1fr); gap:8px}
.ps-chip{border:2px solid rgba(74,42,30,.15); background:#fff; border-radius:14px; min-height:58px; cursor:pointer; color:#4A2A1E; padding:4px}
.ps-chip[aria-pressed=true]{border-color:#D63F6D; background:#FCE6EC}
.ps-chip.ribbon span{display:inline-block; background:linear-gradient(#F07D9A,#E25A82); color:#fff; padding:3px 12px; clip-path:polygon(0 0,100% 0,92% 50%,100% 100%,0 100%,8% 50%); font:20px ${FONTS.script}}
.ps-chip.script span{font:22px ${FONTS.script}; color:#1F4A37}
.ps-chip.bold span{font:20px ${FONTS.display}; color:#4A2A1E}
.ps-stk{display:grid; grid-template-columns:repeat(3,1fr); gap:8px}
.ps-stk button{min-height:72px}
.ps-msg{position:absolute; inset:0; display:grid; place-items:center; padding:24px; background:rgba(20,10,6,.7); z-index:3}
.ps-msg div{background:#FFF9F2; color:#4A2A1E; border-radius:20px; padding:22px; max-width:340px; display:grid; gap:14px; text-align:center}
.ps-msg h3{margin:0; font:700 22px "Kalam","Comic Sans MS",cursive; color:#1F4A37}
@media (max-height:700px){ .ps-panel{gap:8px; padding-top:10px} .ps-b{min-height:44px} }
`;

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function message(root, title, text, button = "OK") {
  return new Promise((resolve) => {
    const m = el(`<div class="ps-msg" role="alertdialog" aria-modal="true"><div><h3>${escHtml(title)}</h3><p style="margin:0">${escHtml(text)}</p>
      <button class="ps-go" type="button">${escHtml(button)}</button></div></div>`);
    root.append(m);
    m.querySelector("button").addEventListener("click", () => { m.remove(); resolve(); });
    m.querySelector("button").focus();
  });
}

async function open({ source, shape = "square", price = null, title = "Fix your photo" } = {}) {
  if (!SHAPES[shape]) shape = "square";
  if (!document.getElementById("ps-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ps-css", textContent: CSS }));
  const root = el(`<div class="ps" role="dialog" aria-modal="true" aria-label="Photo studio">
    <div class="ps-top"><h2>${escHtml(title)}</h2><button class="ps-x" type="button" data-a="cancel">Cancel</button></div>
    <div class="ps-stage"><canvas aria-label="Your photo. Drag to move it, pinch to zoom."></canvas></div>
    <p class="ps-hint" aria-live="polite"></p>
    <div class="ps-panel">
      <div class="ps-sel" hidden><button class="ps-b" type="button" data-a="edit-layer"><span class="i">✏️</span>Change words</button>
        <button class="ps-b" type="button" data-a="del-layer"><span class="i">🗑️</span>Remove it</button>
        <button class="ps-b" type="button" data-a="done-layer"><span class="i">✔️</span>Done</button></div>
      <div class="ps-main">
        <div style="display:grid; gap:4px">
          <label class="ps-sl" data-zoomrow>Zoom<input type="range" data-s="zoom" min="0" max="1000" value="0" aria-label="Zoom"></label>
          <label class="ps-sl">Brighten<input type="range" data-s="bright" min="0" max="150" value="0" aria-label="Brighten"></label>
        </div>
        <div class="ps-row" style="margin-top:8px">
          <button class="ps-b" type="button" data-a="rotate"><span class="i">↻</span>Turn</button>
          <button class="ps-b" type="button" data-a="fit"><span class="i">⤢</span>Fit whole photo</button>
          <button class="ps-b" type="button" data-a="undo"><span class="i">↶</span>Undo</button>
          <button class="ps-b" type="button" data-a="reset"><span class="i">⟲</span>Start over</button>
        </div>
        <div class="ps-row two" style="margin-top:8px">
          <button class="ps-b" type="button" data-a="text"><span class="i">Aa</span>Add words</button>
          <button class="ps-b" type="button" data-a="sticker"><span class="i">★</span>Add sticker</button>
        </div>
      </div>
      <button class="ps-go" type="button" data-a="use">Use this photo</button>
    </div>
  </div>`);
  document.body.append(root);
  const prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";
  const $ = (s) => root.querySelector(s);
  const canvas = $("canvas"), ctx = canvas.getContext("2d");
  const hint = $(".ps-hint"), zoomEl = $('[data-s="zoom"]'), brightEl = $('[data-s="bright"]');
  let finish;
  const done = new Promise((r) => (finish = r));
  const close = (value) => { document.documentElement.style.overflow = prevOverflow; root.remove(); finish(value); };
  $('[data-a="cancel"]').addEventListener("click", () => close(null));
  $('[data-a="cancel"]').focus();

  // Load the photo (a new File, or a stored URL when editing).
  const isFile = source instanceof Blob;
  const url = isFile ? URL.createObjectURL(source) : source.url;
  let img;
  try { [img] = await Promise.all([decode(url), loadFonts()]); }
  catch {
    if (isFile) URL.revokeObjectURL(url);
    await message(root, "That photo won't open", "Sorry, this phone can't open that picture here. Try a different photo, or take a screenshot of it and use the screenshot.");
    close(null);
    return done;
  } finally { if (isFile && img) setTimeout(() => URL.revokeObjectURL(url), 0); }
  const IW = img.naturalWidth, IH = img.naturalHeight;

  let st = initialState(), selected = null, history = [];
  const snap = () => JSON.stringify(st, (k, v) => (k === "_box" ? undefined : v));
  const restore = (s) => { st = JSON.parse(s); selected = null; };
  const push = (before) => { if (before !== snap()) { history.push(before); if (history.length > 60) history.shift(); } };
  const clamp = () => { st = clampState(st, shape, IW, IH); };

  // Canvas display size: as big as fits the stage, in the destination's shape.
  let W = 0, H = 0;
  function layout() {
    const box = $(".ps-stage").getBoundingClientRect();
    const A = scales(shape, IW, IH, st.rot).A;
    let w = Math.max(160, box.width - 28), h = w / A;
    const maxH = Math.max(160, box.height - 10);
    if (h > maxH) { h = maxH; w = h * A; }
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    W = canvas.width; H = canvas.height;
    draw();
  }
  function draw() {
    render(ctx, W, H, img, st, shape, { preview: true, selected });
    const zr = zoomRange(shape, IW, IH, st.rot);
    $("[data-zoomrow]").hidden = shape === "whole";
    $('[data-a="fit"]').disabled = shape === "whole";
    zoomEl.value = zr.max > zr.min ? Math.round(((Math.log(st.zoom) - Math.log(zr.min)) / (Math.log(zr.max) - Math.log(zr.min))) * 1000) : 0;
    brightEl.value = Math.round(st.bright * 100);
    $('[data-a="undo"]').disabled = !history.length;
    $(".ps-sel").hidden = !selected; $(".ps-main").hidden = !!selected;
    hint.textContent = selected ? "Drag to move it. Pinch to make it bigger or smaller."
      : shape === "whole" ? "The whole flyer is used. Nothing gets cut off."
      : "Drag to move the photo. Pinch to zoom.";
  }
  const ro = new ResizeObserver(() => layout());
  ro.observe($(".ps-stage"));
  const stopObserving = () => ro.disconnect();
  done.then(stopObserving);

  /* ---- Gestures ---- */
  const pts = new Map();
  let g = null; // current gesture
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r }; };
  function hit(p) {
    for (let i = st.layers.length - 1; i >= 0; i--) {
      const L = st.layers[i], b = L._box; if (!b) continue;
      if (Math.abs(p.x - L.x) <= b.hw + 0.03 && Math.abs(p.y - L.y) <= b.hh + 0.03) return L;
    }
    return null;
  }
  function startGesture() {
    const list = [...pts.values()];
    const base = { before: g?.before ?? snap(), moved: g?.moved ?? false };
    if (list.length === 1) {
      g = { ...base, type: "drag", start: list[0], px: st.px, py: st.py, lx: selected?.x, ly: selected?.y };
    } else if (list.length >= 2) {
      const d = Math.hypot(list[0].cx - list[1].cx, list[0].cy - list[1].cy) || 1;
      g = { ...base, type: "pinch", d, zoom: st.zoom, size: selected?.size };
    }
  }
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    if (pts.size === 0) {
      const L = hit(p);
      if (L !== selected) { selected = L; if (L) { st.layers.splice(st.layers.indexOf(L), 1); st.layers.push(L); } draw(); }
    }
    pts.set(e.pointerId, { cx: e.clientX, cy: e.clientY, ...p });
    startGesture();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { cx: e.clientX, cy: e.clientY, ...pos(e) });
    const list = [...pts.values()];
    if (g.type === "drag" && list.length === 1) {
      const r = list[0].r, dx = (list[0].cx - g.start.cx) / r.width, dy = (list[0].cy - g.start.cy) / r.height;
      if (Math.abs(dx) + Math.abs(dy) > 0.004) g.moved = true;
      if (selected) { selected.x = Math.min(1, Math.max(0, g.lx + dx)); selected.y = Math.min(1, Math.max(0, g.ly + dy)); }
      else if (shape !== "whole") { st.px = g.px + dx; st.py = g.py + (dy * r.height) / r.width; clamp(); }
    } else if (g.type === "pinch" && list.length >= 2) {
      const k = (Math.hypot(list[0].cx - list[1].cx, list[0].cy - list[1].cy) || 1) / g.d;
      g.moved = true;
      if (selected) selected.size = Math.min(1.2, Math.max(0.05, g.size * k));
      else if (shape !== "whole") { st.zoom = g.zoom * k; clamp(); }
    }
    draw();
  });
  const up = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size === 0) { if (g?.moved) push(g.before); g = null; draw(); }
    else startGesture();
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (e) => { // desktop / trackpad
    e.preventDefault(); const before = snap();
    if (selected) selected.size = Math.min(1.2, Math.max(0.05, selected.size * Math.exp(-e.deltaY / 500)));
    else if (shape !== "whole") { st.zoom *= Math.exp(-e.deltaY / 500); clamp(); }
    push(before); draw();
  }, { passive: false });

  /* ---- Sliders ---- */
  for (const sl of [zoomEl, brightEl]) {
    let before = null;
    sl.addEventListener("input", () => {
      if (before === null) before = snap();
      if (sl === zoomEl) { const zr = zoomRange(shape, IW, IH, st.rot); st.zoom = Math.exp(Math.log(zr.min) + (sl.value / 1000) * (Math.log(zr.max) - Math.log(zr.min))); clamp(); }
      else st.bright = sl.value / 100;
      draw();
    });
    sl.addEventListener("change", () => { if (before !== null) push(before); before = null; draw(); });
  }

  /* ---- Sheets: words and stickers ---- */
  function sheet(html) {
    root.querySelector(".ps-sheet")?.remove();
    const s = el(`<div class="ps-sheet" role="dialog" aria-modal="true">${html}</div>`);
    root.append(s); return s;
  }
  function textSheet(layer) {
    let style = layer?.style || "ribbon";
    const s = sheet(`<h3>${layer ? "Change the words" : "Add words"}</h3>
      <textarea maxlength="60" placeholder="Fresh today!" aria-label="Your words">${escHtml(layer?.text || "")}</textarea>
      <div class="ps-chips">${TEXT_STYLES.map((t) => `<button type="button" class="ps-chip ${t.id}" data-style="${t.id}" aria-pressed="${t.id === style}" aria-label="${t.label}"><span>Aa</span></button>`).join("")}</div>
      <div class="ps-row two"><button class="ps-b" type="button" data-x>Never mind</button><button class="ps-go" type="button" data-ok>${layer ? "Save words" : "Add to photo"}</button></div>`);
    const ta = s.querySelector("textarea"); setTimeout(() => ta.focus(), 50);
    s.querySelectorAll("[data-style]").forEach((b) => b.addEventListener("click", () => {
      style = b.dataset.style; s.querySelectorAll("[data-style]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    }));
    s.querySelector("[data-x]").addEventListener("click", () => s.remove());
    s.querySelector("[data-ok]").addEventListener("click", () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      const before = snap();
      if (layer) { layer.text = text; layer.style = style; }
      else { const L = { type: "text", style, text, x: 0.5, y: shape === "circle" ? 0.78 : 0.82, size: style === "ribbon" ? 0.085 : 0.11 }; st.layers.push(L); selected = L; }
      push(before); s.remove(); draw();
    });
  }
  function stickerSheet() {
    const s = sheet(`<h3>Add a sticker</h3>
      <div class="ps-stk">${STICKERS.map((k) => `<button class="ps-b" type="button" data-k="${k.id}">${k.id === "heart" ? `<span class="i" style="color:${C.pink}; font-size:28px">♥</span>` : ""}${k.id === "price" ? escHtml(money(price) ? `Price tag ${money(price)}` : "Price tag") : k.label}</button>`).join("")}</div>
      <label hidden data-pricebox style="display:grid; gap:6px; font-weight:700">Price on the tag<input inputmode="decimal" placeholder="$4" value="${escHtml(money(price))}"></label>
      <button class="ps-b" type="button" data-x>Never mind</button>`);
    s.querySelector("[data-x]").addEventListener("click", () => s.remove());
    s.querySelectorAll("[data-k]").forEach((b) => b.addEventListener("click", () => {
      const kind = b.dataset.k;
      let text = "";
      if (kind === "price") {
        const box = s.querySelector("[data-pricebox]"), input = box.querySelector("input");
        if (box.hidden && !money(price)) { box.hidden = false; input.focus(); b.textContent = "Add price tag"; return; }
        const v = input.value.trim().replace(/^\$/, "");
        text = money(v) || (box.hidden ? money(price) : "") || input.value.trim();
        if (!text) { input.focus(); return; }
      }
      const before = snap();
      const L = { type: "sticker", kind, text, x: 0.8, y: 0.2, size: kind === "heart" ? 0.18 : kind === "new" ? 0.26 : 0.36 };
      st.layers.push(L); selected = L; push(before); s.remove(); draw();
    }));
  }

  /* ---- Buttons ---- */
  const act = {
    rotate() { const b = snap(); st.rot = (st.rot + 90) % 360; st.zoom = 1; st.px = st.py = 0; clamp(); push(b); layout(); },
    fit() { const b = snap(); st.zoom = zoomRange(shape, IW, IH, st.rot).min; st.px = st.py = 0; clamp(); push(b); draw(); },
    undo() { const prev = history.pop(); if (prev) { const rotBefore = st.rot; restore(prev); st.rot !== rotBefore ? layout() : draw(); } },
    reset() { const b = snap(); const rotBefore = st.rot; st = initialState(); selected = null; push(b); st.rot !== rotBefore ? layout() : draw(); },
    text() { textSheet(null); },
    sticker() { stickerSheet(); },
    "edit-layer"() {
      if (selected?.type === "text") return textSheet(selected);
      if (selected?.kind !== "price") return;
      const L = selected;
      const s = sheet(`<h3>Price on the tag</h3><input inputmode="decimal" value="${escHtml(L.text)}" aria-label="Price on the tag">
        <div class="ps-row two"><button class="ps-b" type="button" data-x>Never mind</button><button class="ps-go" type="button" data-ok>Save price</button></div>`);
      const input = s.querySelector("input"); setTimeout(() => input.focus(), 50);
      s.querySelector("[data-x]").addEventListener("click", () => s.remove());
      s.querySelector("[data-ok]").addEventListener("click", () => {
        const v = input.value.trim(); if (!v) return input.focus();
        const b = snap(); L.text = money(v.replace(/^\$/, "")) || v; push(b); s.remove(); draw();
      });
    },
    "del-layer"() { const b = snap(); st.layers = st.layers.filter((L) => L !== selected); selected = null; push(b); draw(); },
    "done-layer"() { selected = null; draw(); },
    async use() {
      const btn = $('[data-a="use"]'); btn.disabled = true; btn.textContent = "Getting it ready…";
      try {
        const out = outputSize(st, shape, IW, IH);
        const photo = await encodeUnder(async (type, q, scale) => {
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(out.w * scale)); c.height = Math.max(1, Math.round(out.h * scale));
          render(c.getContext("2d"), c.width, c.height, img, st, shape);
          return canvasBlob(c, type, q);
        });
        let original = null;
        if (isFile || !source.isOriginal) { // keep the untouched picture (made smaller) so Edit photo can start over from it
          const o = fitInside(IW, IH, MAX_ORIGINAL), c = document.createElement("canvas");
          c.width = o.w; c.height = o.h; c.getContext("2d").drawImage(img, 0, 0, o.w, o.h);
          original = await canvasBlob(c, "image/webp", 0.9);
          if (!original || original.type !== "image/webp") original = await canvasBlob(c, "image/jpeg", 0.9);
        }
        if (!photo) throw new Error("encode");
        close({ photo, original, width: out.w, height: out.h });
      } catch {
        btn.disabled = false; btn.textContent = "Use this photo";
        await message(root, "Hmm, that didn't work", "Your phone couldn't finish the photo. Tap Use this photo again, or try Start over.");
      }
    },
  };
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-a]"); if (b && act[b.dataset.a] && !b.disabled) act[b.dataset.a](); });
  layout();
  if (shape === "whole") { const zr = zoomRange(shape, IW, IH, 0); st.zoom = zr.min; }
  return done;
}

window.PhotoStudio = { open, SHAPES, rotatedSize };
