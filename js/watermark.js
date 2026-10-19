// Watermark rendering engine. Draws a tiled, hard-to-remove watermark on a canvas.

import { applyContours, applyTone, makeCanvas, releaseCanvas } from './filters.js';

/** Deterministic PRNG (mulberry32) so the same settings + trace code give the same output. */
export function createRng(seedText) {
  let seed = 2166136261;
  for (const ch of seedText) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 128-bit secret salt (hex). Never shown or stored; mixed into the seed so the overlay cannot be regenerated from visible text. */
export function createSalt() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Slightly shifts a color's channels so automated color-keying cannot isolate the mark. */
function jitterColor([r, g, b], rng, amount) {
  const d = () => Math.round((rng() - 0.5) * 2 * amount);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  return `rgb(${clamp(r + d())} ${clamp(g + d())} ${clamp(b + d())})`;
}

/** Fine interlaced sine curves crossing the whole page (banknote-style guilloche). */
function drawGuilloche(ctx, w, h, rgb, opacity, rng) {
  const base = Math.min(w, h);
  const lines = 14;
  ctx.save();
  ctx.globalAlpha = Math.min(1, opacity * 0.55);
  ctx.strokeStyle = `rgb(${rgb.join(' ')})`;
  ctx.lineWidth = Math.max(1, base / 900);
  for (let i = 0; i < lines; i++) {
    const amp = base * (0.04 + rng() * 0.08);
    const period = base * (0.25 + rng() * 0.35);
    const phase = rng() * Math.PI * 2;
    const y0 = (h / lines) * (i + 0.5);
    const amp2 = amp * 0.35;
    const period2 = period / 2.7;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const y = y0 + amp * Math.sin((x / period) * Math.PI * 2 + phase) + amp2 * Math.sin((x / period2) * Math.PI * 2 - phase);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draws the watermark onto `ctx` covering a `w` x `h` area.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {object} opts
 * @param {string} opts.text          Full watermark text.
 * @param {string} opts.microText     Text used for the micro-print lines.
 * @param {string} opts.color         Hex color (#rrggbb).
 * @param {number} opts.opacity       0..1
 * @param {number} opts.size          Font size as % of the shortest side.
 * @param {number} opts.density       1 (sparse) .. 5 (dense)
 * @param {number} opts.angle         Degrees.
 * @param {boolean} opts.wave         Per-glyph wave (2-3 summed sines) + jitter.
 * @param {boolean} [opts.randomAngle] Seeded angle in [-60, 60] degrees instead of `angle`.
 * @param {boolean} opts.guilloche    Security line pattern.
 * @param {boolean} opts.micro        Micro-print lines between rows.
 * @param {string} opts.seed          PRNG seed.
 */
export function drawWatermark(ctx, w, h, opts) {
  const text = opts.text.trim();
  if (!text) return;

  const rng = createRng(`${opts.seed}|${w}x${h}`);
  const rgb = hexToRgb(opts.color);
  // Halo color: contrasting outline keeps the mark visible on both light and dark areas.
  const halo = luminance(rgb) > 0.6 ? 'rgb(0 0 0)' : 'rgb(255 255 255)';
  const base = Math.min(w, h);
  const fontPx = Math.max(10, (base * opts.size) / 100);
  const lineGap = fontPx * (6.2 - opts.density * 0.95);
  const diag = Math.hypot(w, h);
  const font = `700 ${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  const unit = `${text}   •   `;

  if (opts.guilloche) drawGuilloche(ctx, w, h, rgb, opts.opacity, rng);

  ctx.save();
  ctx.translate(w / 2, h / 2);
  const angle = opts.randomAngle ? createRng(`${opts.seed}|angle`)() * 120 - 60 : opts.angle;
  ctx.rotate((angle * Math.PI) / 180);
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const unitWidth = ctx.measureText(unit).width;
  const widthCache = new Map();
  const charWidth = (ch) => {
    if (!widthCache.has(ch)) widthCache.set(ch, ctx.measureText(ch).width);
    return widthCache.get(ch);
  };

  const half = diag / 2 + fontPx * 2;
  let row = 0;
  for (let y = -half; y <= half; y += lineGap, row++) {
    // Stagger rows so the pattern does not form clean columns.
    const offset = opts.wave ? rng() * unitWidth : (row % 2) * (unitWidth / 2);
    const waves = opts.wave ? rowWaves(rng, fontPx) : null;
    // Alternate filled and outlined rows: mixed styles defeat single-pass removal.
    const outlined = opts.wave && row % 3 === 2;

    for (let x = -half - offset; x < half; x += unitWidth) {
      if (!opts.wave) {
        drawGlyphRun(ctx, unit, x, y, { rgb, halo, fontPx, opacity: opts.opacity, outlined: false });
        continue;
      }
      let cx = x;
      for (const ch of unit) {
        const cw = charWidth(ch);
        if (ch.trim()) {
          let cy = y;
          let dy = 0;
          for (const wv of waves) {
            const t = (cx + cw / 2) * wv.k + wv.phase;
            cy += wv.amp * Math.sin(t);
            dy += wv.amp * wv.k * Math.cos(t);
          }
          const slope = Math.atan(dy);
          ctx.save();
          ctx.translate(cx + cw / 2, cy);
          ctx.rotate(slope + (rng() - 0.5) * 0.12);
          const scale = 1 + (rng() - 0.5) * 0.1;
          ctx.scale(scale, scale);
          drawGlyphRun(ctx, ch, -cw / 2, (rng() - 0.5) * fontPx * 0.08, {
            rgb,
            halo,
            fontPx,
            opacity: opts.opacity * (0.85 + rng() * 0.3),
            outlined,
            color: jitterColor(rgb, rng, 28),
          });
          ctx.restore();
        }
        cx += cw;
      }
    }

    if (opts.micro && opts.microText) {
      drawMicroLine(ctx, opts.microText, y + lineGap / 2, half, fontPx, rgb, opts.opacity);
    }
  }
  ctx.restore();
}

/** 2-3 sines per row whose amplitudes add up to roughly the old single-sine amplitude. */
function rowWaves(rng, fontPx) {
  const count = rng() < 0.5 ? 2 : 3;
  const total = fontPx * (0.25 + rng() * 0.35);
  const waves = Array.from({ length: count }, () => ({
    weight: 0.4 + rng() * 0.6,
    k: (Math.PI * 2) / (fontPx * (6 + rng() * 16)),
    phase: rng() * Math.PI * 2,
  }));
  const sum = waves.reduce((acc, wv) => acc + wv.weight, 0);
  for (const wv of waves) wv.amp = (total * wv.weight) / sum;
  return waves;
}

function drawGlyphRun(ctx, str, x, y, { rgb, halo, fontPx, opacity, outlined, color }) {
  const fill = color ?? `rgb(${rgb.join(' ')})`;
  ctx.globalAlpha = Math.min(1, opacity * 0.55);
  ctx.strokeStyle = halo;
  ctx.lineWidth = Math.max(1, fontPx * 0.09);
  ctx.strokeText(str, x, y);
  ctx.globalAlpha = Math.min(1, opacity);
  if (outlined) {
    ctx.strokeStyle = fill;
    ctx.lineWidth = Math.max(1, fontPx * 0.06);
    ctx.strokeText(str, x, y);
  } else {
    ctx.fillStyle = fill;
    ctx.fillText(str, x, y);
  }
}

function drawMicroLine(ctx, microText, y, half, fontPx, rgb, opacity) {
  const microPx = Math.max(6, fontPx * 0.22);
  ctx.save();
  ctx.font = `600 ${microPx}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.globalAlpha = Math.min(1, opacity * 1.1);
  ctx.fillStyle = `rgb(${rgb.join(' ')})`;
  const unit = `${microText} · `;
  const uw = ctx.measureText(unit).width;
  const repeated = unit.repeat(Math.ceil((half * 2) / uw) + 1);
  ctx.fillText(repeated, -half, y);
  ctx.restore();
}

/**
 * Single render entry point, applied on top of the (already redacted) page pixels:
 * tone/contours on the page, watermark on its own layer, optional warp, then composite.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {object} opts              Everything `drawWatermark` takes, plus:
 * @param {string} [opts.tone]       'color' (default) | 'gray' | 'bw' | 'bw-dither'.
 * @param {boolean} [opts.contours]  Gray page with original colour along noise contour lines.
 * @param {boolean} [opts.warp]      Random bulge/pinch distortions of the watermark layer.
 * @param {boolean} [opts.adaptive]  Mark goes black on light pixels, white on dark ones.
 */
export function renderProtected(ctx, w, h, opts) {
  const tone = opts.tone ?? 'color';
  if (opts.contours) {
    const base = tone === 'bw' || tone === 'bw-dither' ? tone : 'gray';
    applyContours(ctx, w, h, createRng(`${opts.seed}|contours|${w}x${h}`), base);
  } else {
    applyTone(ctx, w, h, tone);
  }
  if (!opts.text.trim()) return;
  // Without warp or adaptive the layer is unnecessary: draw straight on the page as before.
  if (!opts.warp && !opts.adaptive) {
    drawWatermark(ctx, w, h, opts);
    return;
  }
  const layer = makeCanvas(w, h, true);
  drawWatermark(layer.ctx, w, h, opts);
  if (opts.warp) warpLayer(layer.ctx, w, h, createRng(`${opts.seed}|warp|${w}x${h}`));
  if (opts.adaptive) compositeAdaptive(ctx, layer.ctx, w, h);
  else ctx.drawImage(layer.canvas, 0, 0);
  releaseCanvas(layer.canvas);
}

/** Non-overlapping bulges/pinches on a jittered grid; each one resamples only its own bounding box. */
function warpLayer(lctx, w, h, rng) {
  const radius = Math.min(w, h) * 0.11;
  if (radius < 8) return;
  const cols = Math.max(1, Math.floor(w / (radius * 2.6)));
  const rows = Math.max(1, Math.floor(h / (radius * 2.6)));
  const cellW = w / cols;
  const cellH = h / rows;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      // Jitter stays inside the cell so neighbouring circles never overlap.
      const r = radius * (0.75 + rng() * 0.25);
      const cx = (gx + 0.5) * cellW + (rng() - 0.5) * Math.max(0, cellW - 2 * r);
      const cy = (gy + 0.5) * cellH + (rng() - 0.5) * Math.max(0, cellH - 2 * r);
      const strength = (0.2 + rng() * 0.2) * (rng() < 0.5 ? 1 : -1);
      bulge(lctx, cx, cy, r, strength);
    }
  }
}

/** Inverse-mapped radial warp: strength > 0 magnifies the centre, < 0 pinches it. */
function bulge(lctx, cx, cy, r, strength) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const bw = Math.min(lctx.canvas.width, Math.ceil(cx + r)) - x0;
  const bh = Math.min(lctx.canvas.height, Math.ceil(cy + r)) - y0;
  if (bw < 2 || bh < 2) return;
  const src = lctx.getImageData(x0, y0, bw, bh).data;
  const out = lctx.createImageData(bw, bh);
  const d = out.data;
  d.set(src);
  const r2 = r * r;
  for (let y = 0; y < bh; y++) {
    const dy = y0 + y + 0.5 - cy;
    for (let x = 0; x < bw; x++) {
      const dx = x0 + x + 0.5 - cx;
      const dist2 = dx * dx + dy * dy;
      if (dist2 >= r2) continue;
      const fall = 1 - dist2 / r2;
      const f = 1 - strength * fall * fall;
      sampleBilinear(src, bw, bh, cx + dx * f - x0 - 0.5, cy + dy * f - y0 - 0.5, d, (y * bw + x) * 4);
    }
  }
  lctx.putImageData(out, x0, y0);
}

/** Alpha-weighted bilinear sample, so transparent neighbours do not darken glyph edges. */
function sampleBilinear(src, bw, bh, sx, sy, out, o) {
  const x = Math.min(bw - 1.001, Math.max(0, sx));
  const y = Math.min(bh - 1.001, Math.max(0, sy));
  const ix = x | 0;
  const iy = y | 0;
  const fx = x - ix;
  const fy = y - iy;
  const i00 = (iy * bw + ix) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + bw * 4;
  const i11 = i01 + 4;
  const w00 = (1 - fx) * (1 - fy) * src[i00 + 3];
  const w10 = fx * (1 - fy) * src[i10 + 3];
  const w01 = (1 - fx) * fy * src[i01 + 3];
  const w11 = fx * fy * src[i11 + 3];
  const alpha = w00 + w10 + w01 + w11;
  if (alpha < 1e-3) {
    out[o + 3] = 0;
    return;
  }
  for (let c = 0; c < 3; c++) {
    out[o + c] = (src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11) / alpha;
  }
  out[o + 3] = alpha;
}

const STRIP_ROWS = 256;

/** Uses the layer only as a coverage mask: each covered pixel moves toward black or white by its alpha. */
function compositeAdaptive(ctx, lctx, w, h) {
  for (let y = 0; y < h; y += STRIP_ROWS) {
    const rows = Math.min(STRIP_ROWS, h - y);
    const page = ctx.getImageData(0, y, w, rows);
    const layer = lctx.getImageData(0, y, w, rows).data;
    const d = page.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = layer[i + 3];
      if (!a) continue;
      const k = a / 255;
      const target = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 127.5 ? 0 : 255;
      d[i] += (target - d[i]) * k;
      d[i + 1] += (target - d[i + 1]) * k;
      d[i + 2] += (target - d[i + 2]) * k;
    }
    ctx.putImageData(page, 0, y);
  }
}
