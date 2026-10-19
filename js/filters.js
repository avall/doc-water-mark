// Page filters: tone (gray / black & white / dither) and colour-preserving noise contour lines.
// Pure functions work on ImageData-like objects `{ data, width, height }` so they run in node too.

export const TONES = ['color', 'gray', 'bw', 'bw-dither'];

/** Rec.709 luma of the RGB pixel starting at byte `i`, 0..255. */
function luma(d, i) {
  return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
}

/** Replaces every pixel with its Rec.709 luminance, in place. Alpha is kept. */
export function toGray(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = luma(d, i);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  return img;
}

/** Otsu's threshold (0..255) over the luminance histogram: maximises between-class variance. */
export function otsuThreshold(img) {
  const d = img.data;
  const hist = new Float64Array(256);
  for (let i = 0; i < d.length; i += 4) hist[(luma(d, i) + 0.5) | 0]++;
  const total = d.length / 4;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v];
  let weightBack = 0;
  let sumBack = 0;
  let best = -1;
  let threshold = 127;
  for (let v = 0; v < 256; v++) {
    weightBack += hist[v];
    if (!weightBack) continue;
    const weightFore = total - weightBack;
    if (!weightFore) break;
    sumBack += v * hist[v];
    const diff = sumBack / weightBack - (sumAll - sumBack) / weightFore;
    const between = weightBack * weightFore * diff * diff;
    if (between > best) {
      best = between;
      threshold = v;
    }
  }
  return threshold;
}

/** Pure black/white: luminance above `threshold` becomes white. Defaults to Otsu. */
export function toBlackWhite(img, threshold = otsuThreshold(img)) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = luma(d, i) > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  return img;
}

/** 1-bit Floyd–Steinberg error diffusion. Only two row buffers, so memory stays O(width). */
export function ditherFloydSteinberg(img) {
  const { data: d, width: w, height: h } = img;
  let cur = new Float32Array(w + 2);
  let next = new Float32Array(w + 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const old = luma(d, i) + cur[x + 1];
      const v = old < 128 ? 0 : 255;
      const err = old - v;
      d[i] = d[i + 1] = d[i + 2] = v;
      cur[x + 2] += (err * 7) / 16;
      next[x] += (err * 3) / 16;
      next[x + 1] += (err * 5) / 16;
      next[x + 2] += err / 16;
    }
    [cur, next] = [next, cur];
    next.fill(0);
  }
  return img;
}

/** Applies a tone mode ('color' | 'gray' | 'bw' | 'bw-dither') to the canvas behind `ctx`. */
export function applyTone(ctx, w, h, mode) {
  if (!mode || mode === 'color') return;
  const img = ctx.getImageData(0, 0, w, h);
  if (mode === 'gray') toGray(img);
  else if (mode === 'bw') toBlackWhite(img);
  else if (mode === 'bw-dither') ditherFloydSteinberg(img);
  else return;
  ctx.putImageData(img, 0, 0);
}

/**
 * Seeded fractal value noise. Returns `(x, y) => value` in [-1, 1]; one lattice unit is one
 * feature of the first octave. `rng` is a `() => [0, 1)` generator.
 */
export function createNoise2D(rng, octaves = 4) {
  const perm = new Uint8Array(512);
  const values = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    values[i] = rng() * 2 - 1;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const offsets = Array.from({ length: octaves }, () => [rng() * 256, rng() * 256]);
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lattice = (ix, iy) => values[perm[perm[ix & 255] + (iy & 255)]];

  const octave = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = fade(x - ix);
    const fy = fade(y - iy);
    const top = lattice(ix, iy) + (lattice(ix + 1, iy) - lattice(ix, iy)) * fx;
    const bottom = lattice(ix, iy + 1) + (lattice(ix + 1, iy + 1) - lattice(ix, iy + 1)) * fx;
    return top + (bottom - top) * fy;
  };

  let norm = 0;
  for (let o = 0, amp = 1; o < octaves; o++, amp /= 2) norm += amp;
  return (x, y) => {
    let sum = 0;
    for (let o = 0, freq = 1, amp = 1; o < octaves; o++, freq *= 2, amp /= 2) {
      sum += amp * octave(x * freq + offsets[o][0], y * freq + offsets[o][1]);
    }
    return sum / norm;
  };
}

// Edge pairs per marching-squares case; edges are 0 top, 1 right, 2 bottom, 3 left. Saddles (5, 10) are resolved inline.
const CASES = [null, [3, 2], [2, 1], [3, 1], [0, 1], null, [0, 2], [0, 3], [0, 3], [0, 2], null, [0, 1], [3, 1], [2, 1], [3, 2], null];

/**
 * Marching squares over a `gw` x `gh` grid of samples. Calls `emit(x1, y1, x2, y2)` (grid units)
 * for every segment of the iso-line at `level`; no per-segment allocations.
 */
export function marchingSquares(field, gw, gh, level, emit) {
  const ex = new Float64Array(4);
  const ey = new Float64Array(4);
  const seg = (e1, e2) => emit(ex[e1], ey[e1], ex[e2], ey[e2]);
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const a = field[y * gw + x];
      const b = field[y * gw + x + 1];
      const c = field[(y + 1) * gw + x + 1];
      const d = field[(y + 1) * gw + x];
      const id = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (id === 0 || id === 15) continue;
      ex[0] = x + (level - a) / (b - a);
      ey[0] = y;
      ex[1] = x + 1;
      ey[1] = y + (level - b) / (c - b);
      ex[2] = x + (level - d) / (c - d);
      ey[2] = y + 1;
      ex[3] = x;
      ey[3] = y + (level - a) / (d - a);
      if (id === 5 || id === 10) {
        // Saddle: the cell centre decides which diagonal pair of corners is connected.
        const centreHigh = (a + b + c + d) / 4 > level;
        if (centreHigh === (id === 5)) {
          seg(0, 3);
          seg(2, 1);
        } else {
          seg(0, 1);
          seg(3, 2);
        }
        continue;
      }
      seg(CASES[id][0], CASES[id][1]);
    }
  }
}

/** A 2D canvas (OffscreenCanvas when it supports 2D, else a DOM canvas) and its context. */
export function makeCanvas(w, h, readback = false) {
  const attrs = readback ? { willReadFrequently: true } : undefined;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', attrs);
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d', attrs) };
}

/** Frees a scratch canvas' backing store right away instead of waiting for GC. */
export function releaseCanvas(canvas) {
  canvas.width = canvas.height = 0;
}

/**
 * Turns the page to `baseTone` ('gray' | 'bw' | 'bw-dither') except along contour lines of a
 * seeded noise field, where the original colour shows through.
 */
export function applyContours(ctx, w, h, rng, baseTone = 'gray') {
  const original = makeCanvas(w, h);
  original.ctx.drawImage(ctx.canvas, 0, 0);
  applyTone(ctx, w, h, baseTone);

  const base = Math.min(w, h);
  // Coarse sampling grid: the field is smooth, so ~400 cells on the long side are plenty.
  const cell = Math.max(4, Math.max(w, h) / 400);
  const gw = Math.ceil(w / cell) + 1;
  const gh = Math.ceil(h / cell) + 1;
  const noise = createNoise2D(rng, 4);
  const scale = (cell * 2.5) / base;
  const field = new Float32Array(gw * gh);
  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const v = noise(x * scale, y * scale);
      field[y * gw + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const mask = makeCanvas(w, h);
  const mctx = mask.ctx;
  mctx.strokeStyle = '#fff';
  mctx.lineWidth = Math.min(3, Math.max(2, base / 1000));
  mctx.lineCap = 'round';
  const levels = Math.min(16, Math.max(6, Math.round(base / 300)));
  for (let k = 0; k < levels; k++) {
    const level = min + ((max - min) * (k + 0.5)) / levels;
    mctx.beginPath();
    marchingSquares(field, gw, gh, level, (x1, y1, x2, y2) => {
      mctx.moveTo(x1 * cell, y1 * cell);
      mctx.lineTo(x2 * cell, y2 * cell);
    });
    mctx.stroke();
  }
  // Keep the original pixels only where the lines were drawn, then lay them over the toned page.
  mctx.globalCompositeOperation = 'source-in';
  mctx.drawImage(original.canvas, 0, 0);
  releaseCanvas(original.canvas);
  ctx.drawImage(mask.canvas, 0, 0);
  releaseCanvas(mask.canvas);
}
