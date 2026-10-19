import { createSalt, renderProtected } from './js/watermark.js';
import { buildPdf } from './js/pdf-writer.js';
import { buildZip } from './js/zip.js';
import { applyRedactions, hitTest, toPixels } from './js/redact.js';
import { detectLanguage, getLanguage, getLocale, LANGUAGES, setLanguage, t, translateDom } from './js/i18n.js';

const MAX_SIDE = 4096;
const MAX_AREA = 16_000_000; // stays under iOS Safari's canvas limit
const PDF_TARGET_WIDTH = 2200; // px used to rasterize PDF pages
const A4 = { w: 595.28, h: 841.89 };
const PREFS_KEY = 'ms-prefs-v1';
const LOG_KEY = 'ms-log-v1';
const UI_KEY = 'ms-ui-v1'; // theme + language; also read by the inline script in index.html
const THEMES = ['auto', 'light', 'dark'];
const SHARE_CACHE = 'share-target';
const TRACE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const MAX_COPIES = 20;
const TONES = ['color', 'gray', 'bw', 'bw-dither'];

const $ = (id) => document.getElementById(id);

const ui = {
  fileInput: $('file-input'),
  dropzone: $('dropzone'),
  cameraInput: $('camera-input'),
  cameraBtn: $('camera-btn'),
  cameraHint: $('camera-hint'),
  text: $('wm-text'),
  presets: $('presets'),
  optDate: $('opt-date'),
  optTrace: $('opt-trace'),
  traceRow: $('trace-row'),
  traceCode: $('trace-code'),
  traceRegen: $('trace-regen'),
  copiesBlock: $('copies-block'),
  copiesDec: $('copies-dec'),
  copiesInc: $('copies-inc'),
  copiesCount: $('copies-count'),
  copiesCodes: $('copies-codes'),
  color: $('wm-color'),
  swatches: $('swatches'),
  swatchAuto: $('swatch-auto'),
  opacity: $('wm-opacity'),
  size: $('wm-size'),
  density: $('wm-density'),
  angle: $('wm-angle'),
  outOpacity: $('out-opacity'),
  outSize: $('out-size'),
  outDensity: $('out-density'),
  outAngle: $('out-angle'),
  optRandomAngle: $('opt-random-angle'),
  tone: $('tone'),
  optWave: $('opt-wave'),
  optGuilloche: $('opt-guilloche'),
  optMicro: $('opt-micro'),
  optWarp: $('opt-warp'),
  optContours: $('opt-contours'),
  format: $('format'),
  downloadBtn: $('download-btn'),
  shareBtn: $('share-btn'),
  clearBtn: $('clear-btn'),
  pager: $('pager'),
  prevPage: $('prev-page'),
  nextPage: $('next-page'),
  pageLabel: $('page-label'),
  copyPager: $('copy-pager'),
  prevCopy: $('prev-copy'),
  nextCopy: $('next-copy'),
  copyLabel: $('copy-label'),
  empty: $('empty'),
  canvas: $('preview-canvas'),
  busy: $('busy'),
  busyLabel: $('busy-label'),
  logList: $('log-list'),
  logClear: $('log-clear'),
  netStatus: $('net-status'),
  installBtn: $('install-btn'),
  toast: $('toast'),
  redactBar: $('redact-bar'),
  redactMode: $('redact-mode'),
  redactUndo: $('redact-undo'),
  redactDelete: $('redact-delete'),
  redactHint: $('redact-hint'),
  langSelect: $('lang-select'),
  themeBtn: $('theme-btn'),
  themeColor: document.querySelector('meta[name="theme-color"]'),
};

const state = {
  /** @type {Array<{canvas: HTMLCanvasElement, ptWidth: number, ptHeight: number, regions: Array<{x: number, y: number, w: number, h: number, mode: string}>}>} */
  pages: [],
  sourceName: '',
  sourceIsPdf: false,
  pageIndex: 0,
  traceCode: newTraceCode(),
  /** Secret seed salt: memory only, never displayed, logged or persisted. */
  salt: createSalt(),
  /** Copies 2..N, each with its own trace code and secret salt (copy 1 uses traceCode/salt). Memory only. */
  extraCopies: [],
  /** Copy shown in the preview (0-based). */
  copyIndex: 0,
  /** Auto contrast swatch selected instead of a fixed colour. */
  adaptive: false,
  installPrompt: null,
  theme: 'auto',
  redactMode: 'none',
  /** Index of the selected redaction region on the current page, or -1. */
  selected: -1,
  /** Region being drawn (normalized), or null. */
  draft: null,
};

// ---------- Storage helpers (storage may be unavailable in private modes) ----------

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / privacy errors */
  }
}

// ---------- Options ----------

function newTraceCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => TRACE_ALPHABET[b % TRACE_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

function formatDate(date = new Date()) {
  return date.toLocaleDateString(getLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function getFormat() {
  return ui.format.querySelector('input:checked').value;
}

function getTone() {
  return ui.tone.querySelector('input:checked').value;
}

function newCopy() {
  return { code: newTraceCode(), salt: createSalt() };
}

function copyCount() {
  return 1 + state.extraCopies.length;
}

/** Trace code and secret salt of copy `index` (0 = the main trace code). */
function copyAt(index) {
  return index === 0 ? { code: state.traceCode, salt: state.salt } : state.extraCopies[index - 1];
}

function getOptions(copy = copyAt(state.copyIndex)) {
  const purpose = ui.text.value.trim() || t('text.default');
  const date = ui.optDate.checked ? formatDate() : '';
  const code = ui.optTrace.checked ? copy.code : '';
  const parts = [purpose, date, code && `${t('trace.prefix')} ${code}`].filter(Boolean);
  return {
    purpose,
    code,
    text: parts.join(' · '),
    microText: [code, date, purpose].filter(Boolean).join(' '),
    color: ui.color.value,
    opacity: Number(ui.opacity.value) / 100,
    size: Number(ui.size.value),
    density: Number(ui.density.value),
    angle: Number(ui.angle.value),
    wave: ui.optWave.checked,
    guilloche: ui.optGuilloche.checked,
    micro: ui.optMicro.checked,
    seed: `${copy.salt}|${copy.code}|${purpose}`,
    tone: getTone(),
    contours: ui.optContours.checked,
    warp: ui.optWarp.checked,
    adaptive: state.adaptive,
    randomAngle: ui.optRandomAngle.checked,
  };
}

function savePrefs() {
  writeJson(PREFS_KEY, {
    text: ui.text.value,
    date: ui.optDate.checked,
    trace: ui.optTrace.checked,
    color: ui.color.value,
    opacity: ui.opacity.value,
    size: ui.size.value,
    density: ui.density.value,
    angle: ui.angle.value,
    wave: ui.optWave.checked,
    guilloche: ui.optGuilloche.checked,
    micro: ui.optMicro.checked,
    adaptive: state.adaptive,
    randomAngle: ui.optRandomAngle.checked,
    tone: getTone(),
    warp: ui.optWarp.checked,
    contours: ui.optContours.checked,
  });
}

function loadPrefs() {
  const p = readJson(PREFS_KEY, null);
  if (!p) return;
  ui.text.value = p.text ?? '';
  ui.optDate.checked = p.date ?? true;
  ui.optTrace.checked = p.trace ?? true;
  ui.color.value = p.color ?? ui.color.value;
  ui.opacity.value = p.opacity ?? ui.opacity.value;
  ui.size.value = p.size ?? ui.size.value;
  ui.density.value = p.density ?? ui.density.value;
  ui.angle.value = p.angle ?? ui.angle.value;
  ui.optWave.checked = p.wave ?? true;
  ui.optGuilloche.checked = p.guilloche ?? true;
  ui.optMicro.checked = p.micro ?? true;
  state.adaptive = p.adaptive ?? false;
  ui.optRandomAngle.checked = p.randomAngle ?? false;
  ui.tone.querySelector(`input[value="${TONES.includes(p.tone) ? p.tone : 'color'}"]`).checked = true;
  ui.optWarp.checked = p.warp ?? false;
  ui.optContours.checked = p.contours ?? false;
}

function syncLabels() {
  ui.outOpacity.textContent = new Intl.NumberFormat(getLocale(), { style: 'percent' }).format(ui.opacity.value / 100);
  ui.outSize.textContent = `${ui.size.value}`;
  ui.outDensity.textContent = t(`density.${ui.density.value}`);
  ui.outAngle.textContent = ui.optRandomAngle.checked ? t('look.random') : `${ui.angle.value}°`;
  ui.angle.disabled = ui.optRandomAngle.checked;
  // Expose each slider's fill percentage to CSS (WebKit has no range-progress pseudo-element).
  for (const el of [ui.opacity, ui.size, ui.density, ui.angle]) {
    el.style.setProperty('--fill', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
  }
  ui.traceCode.textContent = state.traceCode;
  ui.traceRow.hidden = !ui.optTrace.checked;
  for (const btn of ui.swatches.children) {
    const active = btn === ui.swatchAuto ? state.adaptive : !state.adaptive && btn.dataset.color.toLowerCase() === ui.color.value.toLowerCase();
    btn.classList.toggle('active', active);
  }
  syncCopies();
}

function syncCopies() {
  const count = copyCount();
  ui.copiesBlock.hidden = !ui.optTrace.checked;
  ui.copiesCount.textContent = `${count}`;
  ui.copiesDec.disabled = count <= 1;
  ui.copiesInc.disabled = count >= MAX_COPIES;
  ui.copiesCodes.hidden = count < 2;
  ui.copiesCodes.replaceChildren(
    ...Array.from({ length: count }, (_, i) => {
      const code = document.createElement('code');
      code.textContent = copyAt(i).code;
      return code;
    }),
  );
  ui.downloadBtn.textContent = count > 1 ? t('export.downloadCopies', { count }) : t('export.download');
}

/** Gives every copy a fresh trace code and secret salt, keeping the number of copies. */
function regenerateCopies() {
  state.traceCode = newTraceCode();
  state.salt = createSalt();
  state.extraCopies = state.extraCopies.map(newCopy);
}

function setCopyCount(count) {
  const target = Math.min(MAX_COPIES, Math.max(1, count));
  while (copyCount() < target) state.extraCopies.push(newCopy());
  state.extraCopies.length = target - 1;
  state.copyIndex = Math.min(state.copyIndex, target - 1);
}

// ---------- Loading documents ----------

function whiteCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

function fitScale(width, height) {
  return Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_AREA / (width * height)));
}

function fitToA4(width, height) {
  const s = Math.min(A4.w / width, A4.h / height);
  return { ptWidth: width * s, ptHeight: height * s };
}

async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall back to <img>, e.g. for formats only the element decodes */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadImage(file) {
  const img = await decodeImage(file);
  const iw = img.naturalWidth ?? img.width;
  const ih = img.naturalHeight ?? img.height;
  const s = fitScale(iw, ih);
  const canvas = whiteCanvas(Math.round(iw * s), Math.round(ih * s));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  return { canvas, ...fitToA4(canvas.width, canvas.height) };
}

let pdfjsPromise;
function loadPdfJs() {
  pdfjsPromise ??= import('./vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    return pdfjs;
  });
  return pdfjsPromise;
}

async function loadPdf(file) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  task.onPassword = (updatePassword, reason) => {
    const retry = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    const pw = prompt(retry ? t('load.passwordRetry') : t('load.passwordPrompt', { name: file.name }));
    if (pw === null) task.destroy();
    else updatePassword(pw);
  };
  const doc = await task.promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      setBusy(t('load.readingPage', { n, total: doc.numPages }));
      const page = await doc.getPage(n);
      const unit = page.getViewport({ scale: 1 });
      let scale = Math.min(3, Math.max(1, PDF_TARGET_WIDTH / unit.width));
      scale *= fitScale(unit.width * scale, unit.height * scale);
      const viewport = page.getViewport({ scale });
      const canvas = whiteCanvas(Math.round(viewport.width), Math.round(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
      pages.push({ canvas, ptWidth: unit.width, ptHeight: unit.height });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

async function openFiles(fileList) {
  const files = [...fileList].filter((f) => isPdf(f) || f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic)$/i.test(f.name));
  if (!files.length) {
    toast(t('load.unsupported'), true);
    return;
  }
  setBusy(t('load.loading'));
  try {
    const pages = [];
    for (const file of files) {
      pages.push(...(isPdf(file) ? await loadPdf(file) : [await loadImage(file)]));
    }
    if (!pages.length) throw new Error(t('load.noPages'));
    for (const page of pages) page.regions = [];
    state.pages = pages;
    state.pageIndex = 0;
    state.selected = -1;
    state.sourceIsPdf = files.some(isPdf);
    state.sourceName = files[0].name.replace(/\.[^.]+$/, '');
    if (files.length > 1) state.sourceName += `-${t('file.andMore', { count: files.length - 1 })}`;
    // A fresh document gets fresh trace codes so every shared copy is unique.
    regenerateCopies();
    setFormat(state.sourceIsPdf || pages.length > 1 ? 'pdf' : 'jpeg');
    syncLabels();
    renderPreview();
    // On narrow screens the preview sits below the controls: bring it into view.
    if (matchMedia('(max-width: 999px)').matches) {
      requestAnimationFrame(() => ui.canvas.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
  } catch (err) {
    console.error(err);
    const msg = err?.name === 'PasswordException' ? t('load.passwordFailed') : t('load.failed', { error: err.message || err });
    toast(msg, true);
  } finally {
    setBusy(null);
  }
}

/** Drops the loaded document and returns the preview to its initial empty state. Watermark settings are kept. */
function resetDocument() {
  state.pages = [];
  state.pageIndex = 0;
  state.sourceName = '';
  state.sourceIsPdf = false;
  state.selected = -1;
  state.draft = null;
  state.redactMode = 'none';
  ui.redactMode.querySelector('input[value="none"]').checked = true;
  setFormat('jpeg');
  // Release the large bitmaps.
  previewCache.width = previewCache.height = 0;
  ui.canvas.width = ui.canvas.height = 0;
  ui.fileInput.value = '';
  syncLabels();
  renderPreview();
}

// ---------- Rendering ----------

function renderPage(page, target, options) {
  target.width = page.canvas.width;
  target.height = page.canvas.height;
  const ctx = target.getContext('2d');
  ctx.drawImage(page.canvas, 0, 0);
  applyRedactions(ctx, target.width, target.height, page.regions);
  renderProtected(ctx, target.width, target.height, options);
  return target;
}

// The fully rendered page is cached so drag overlays don't redraw the watermark each frame.
const previewCache = document.createElement('canvas');

let renderQueued = false;
function renderPreview() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const hasDoc = state.pages.length > 0;
    ui.empty.hidden = hasDoc;
    ui.canvas.hidden = !hasDoc;
    ui.downloadBtn.disabled = !hasDoc;
    ui.shareBtn.disabled = !hasDoc;
    ui.clearBtn.hidden = !hasDoc;
    ui.pager.hidden = state.pages.length < 2;
    ui.copyPager.hidden = !hasDoc || copyCount() < 2;
    syncRedactUi();
    if (!hasDoc) return;
    ui.pageLabel.textContent = `${state.pageIndex + 1} / ${state.pages.length}`;
    ui.prevPage.disabled = state.pageIndex === 0;
    ui.nextPage.disabled = state.pageIndex === state.pages.length - 1;
    ui.copyLabel.textContent = t('copies.pager', { n: state.copyIndex + 1, total: copyCount() });
    ui.prevCopy.disabled = state.copyIndex === 0;
    ui.nextCopy.disabled = state.copyIndex === copyCount() - 1;
    renderPage(currentPage(), previewCache, getOptions());
    drawOverlay();
  });
}

function currentPage() {
  return state.pages[state.pageIndex];
}

/** Copies the cached render to the visible canvas and draws editing aids (never exported). */
function drawOverlay() {
  const page = currentPage();
  if (!page) return;
  if (ui.canvas.width !== previewCache.width || ui.canvas.height !== previewCache.height) {
    ui.canvas.width = previewCache.width;
    ui.canvas.height = previewCache.height;
  }
  const ctx = ui.canvas.getContext('2d');
  ctx.drawImage(previewCache, 0, 0);

  // Keep outlines ~2 CSS px thick whatever the canvas resolution.
  const cssPx = ui.canvas.width / (ui.canvas.getBoundingClientRect().width || ui.canvas.width);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0f766e';
  const outline = (region, dashed) => {
    const r = toPixels(region, ui.canvas.width, ui.canvas.height);
    ctx.save();
    ctx.lineWidth = 2 * cssPx;
    ctx.setLineDash(dashed ? [6 * cssPx, 4 * cssPx] : []);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.lineDashOffset = dashed ? 5 * cssPx : 0;
    ctx.strokeStyle = accent;
    ctx.strokeRect(r.x - cssPx, r.y - cssPx, r.w + 2 * cssPx, r.h + 2 * cssPx);
    ctx.restore();
  };

  if (state.selected >= 0 && page.regions[state.selected]) outline(page.regions[state.selected], false);
  if (state.draft) {
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = accent;
    const r = toPixels(state.draft, ui.canvas.width, ui.canvas.height);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
    outline(state.draft, true);
  }
}

function onOptionsChanged() {
  syncLabels();
  savePrefs();
  renderPreview();
}

// ---------- Redaction (hide sensitive data) ----------

function syncRedactUi() {
  const page = currentPage();
  const count = page?.regions.length ?? 0;
  ui.redactBar.hidden = !page;
  ui.redactHint.hidden = !page;
  ui.redactUndo.disabled = count === 0;
  ui.redactDelete.disabled = state.selected < 0;
  const summary = count ? ` ${t(count === 1 ? 'redact.count.one' : 'redact.count.other', { count })}` : '';
  ui.redactHint.textContent = t(`redact.hint.${state.redactMode}`) + summary;
  ui.canvas.classList.toggle('drawing', state.redactMode !== 'none');
  ui.canvas.classList.toggle('can-select', state.redactMode === 'none' && count > 0);
}

/** Pointer position as normalized (0..1) page coordinates. */
function pointerToNormalized(e) {
  const rect = ui.canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
  };
}

function selectRegion(index) {
  state.selected = index;
  syncRedactUi();
  drawOverlay();
}

function deleteSelectedRegion() {
  const page = currentPage();
  if (!page || state.selected < 0) return;
  page.regions.splice(state.selected, 1);
  state.selected = -1;
  renderPreview();
}

function bindRedactEvents() {
  let origin = null;
  let overlayQueued = false;
  const queueOverlay = () => {
    if (overlayQueued) return;
    overlayQueued = true;
    requestAnimationFrame(() => {
      overlayQueued = false;
      drawOverlay();
    });
  };

  ui.redactMode.addEventListener('change', () => {
    state.redactMode = ui.redactMode.querySelector('input:checked').value;
    state.selected = -1;
    syncRedactUi();
    drawOverlay();
  });

  ui.canvas.addEventListener('pointerdown', (e) => {
    const page = currentPage();
    if (!page || e.button > 0) return;
    const p = pointerToNormalized(e);
    if (state.redactMode === 'none') {
      selectRegion(hitTest(page.regions, p.x, p.y));
      return;
    }
    e.preventDefault();
    ui.canvas.setPointerCapture(e.pointerId);
    origin = { ...p, clientX: e.clientX, clientY: e.clientY };
    state.draft = { x: p.x, y: p.y, w: 0, h: 0, mode: state.redactMode };
  });

  ui.canvas.addEventListener('pointermove', (e) => {
    if (!origin) return;
    const p = pointerToNormalized(e);
    state.draft = {
      x: Math.min(origin.x, p.x),
      y: Math.min(origin.y, p.y),
      w: Math.abs(p.x - origin.x),
      h: Math.abs(p.y - origin.y),
      mode: state.redactMode,
    };
    queueOverlay();
  });

  const finish = (e, cancelled) => {
    if (!origin) return;
    const page = currentPage();
    const moved = Math.hypot(e.clientX - origin.clientX, e.clientY - origin.clientY);
    const draft = state.draft;
    origin = null;
    state.draft = null;
    if (cancelled || !page) {
      drawOverlay();
    } else if (moved < 6) {
      // A tap rather than a drag: select the region under the pointer.
      selectRegion(hitTest(page.regions, draft.x, draft.y));
    } else {
      page.regions.push(draft);
      state.selected = page.regions.length - 1;
      renderPreview();
    }
  };
  ui.canvas.addEventListener('pointerup', (e) => finish(e, false));
  ui.canvas.addEventListener('pointercancel', (e) => finish(e, true));

  ui.redactUndo.addEventListener('click', () => {
    const page = currentPage();
    if (!page?.regions.length) return;
    page.regions.pop();
    state.selected = -1;
    renderPreview();
  });
  ui.redactDelete.addEventListener('click', deleteSelectedRegion);

  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected >= 0) {
      e.preventDefault();
      deleteSelectedRegion();
    } else if (e.key === 'Escape' && state.selected >= 0) {
      selectRegion(-1);
    }
  });

  // Outline thickness depends on the displayed size.
  window.addEventListener('resize', queueOverlay);
}

// ---------- Export ----------

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('export.imageFailed')))), type, quality);
  });
}

function slug(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
}

/** Renders one copy with `options`; `progress` prefixes the busy label when exporting several copies. */
async function exportFiles(options, progress = '') {
  const format = getFormat();
  const suffix = options.code ? `${t('file.suffix')}-${options.code}` : t('file.suffix');
  const base = `${slug(state.sourceName) || t('file.document')}-${suffix}`;
  const work = document.createElement('canvas');

  try {
    if (format === 'pdf') {
      const pdfPages = [];
      for (const [i, page] of state.pages.entries()) {
        setBusy(progress + t('export.renderingPage', { n: i + 1, total: state.pages.length }));
        renderPage(page, work, options);
        const jpeg = new Uint8Array(await (await canvasToBlob(work, 'image/jpeg', 0.9)).arrayBuffer());
        pdfPages.push({ jpeg, pxWidth: work.width, pxHeight: work.height, ptWidth: page.ptWidth, ptHeight: page.ptHeight });
      }
      return [new File([buildPdf(pdfPages)], `${base}.pdf`, { type: 'application/pdf' })];
    }

    const type = format === 'png' ? 'image/png' : 'image/jpeg';
    const ext = format === 'png' ? 'png' : 'jpg';
    const files = [];
    for (const [i, page] of state.pages.entries()) {
      setBusy(progress + t('export.renderingImage', { n: i + 1, total: state.pages.length }));
      renderPage(page, work, options);
      const blob = await canvasToBlob(work, type, 0.9);
      const name = state.pages.length > 1 ? `${base}-p${i + 1}.${ext}` : `${base}.${ext}`;
      files.push(new File([blob], name, { type }));
    }
    return files;
  } finally {
    // Release the full-size bitmap before the next copy is rendered.
    work.width = work.height = 0;
  }
}

/** Renders every copy sequentially to keep memory bounded. */
async function exportCopies() {
  const total = copyCount();
  const copies = [];
  for (let i = 0; i < total; i++) {
    const options = getOptions(copyAt(i));
    const progress = total > 1 ? t('export.copyProgress', { n: i + 1, total }) : '';
    copies.push({ options, files: await exportFiles(options, progress) });
  }
  return copies;
}

async function zipCopies(copies) {
  const entries = [];
  for (const file of copies.flatMap((c) => c.files)) {
    entries.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  }
  const name = `${slug(state.sourceName) || t('file.document')}-${t('file.suffix')}-${t('file.copies', { count: copies.length })}.zip`;
  return new File([buildZip(entries)], name, { type: 'application/zip' });
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function withExport(action) {
  if (!state.pages.length) return;
  ui.downloadBtn.disabled = ui.shareBtn.disabled = true;
  try {
    const copies = await exportCopies();
    setBusy(null);
    const done = await action(copies);
    if (done) for (const copy of copies) addLogEntry(copy.files, copy.options);
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.error(err);
      toast(t('export.failed', { error: err.message || err }), true);
    }
  } finally {
    setBusy(null);
    ui.downloadBtn.disabled = ui.shareBtn.disabled = false;
  }
}

async function handleDownload() {
  await withExport(async (copies) => {
    const files = copies.length > 1 ? [await zipCopies(copies)] : copies[0].files;
    for (const [i, file] of files.entries()) {
      // Small gap so browsers don't block consecutive downloads.
      if (i) await new Promise((r) => setTimeout(r, 350));
      downloadFile(file);
    }
    toast(files.length > 1 ? t('export.downloadedMany', { count: files.length }) : t('export.downloadedOne', { name: files[0].name }));
    return true;
  });
}

async function handleShare() {
  await withExport(async (copies) => {
    let files = copies.flatMap((c) => c.files);
    // Several copies: share them all if the platform accepts it, otherwise one ZIP.
    if (copies.length > 1 && !navigator.canShare?.({ files })) files = [await zipCopies(copies)];
    if (!navigator.canShare?.({ files })) {
      toast(t('export.shareUnsupported'), true);
      return false;
    }
    await navigator.share({ files, title: t('export.shareTitle') });
    return true;
  });
}

// ---------- Trace log ----------

function addLogEntry(files, opts) {
  const log = readJson(LOG_KEY, []);
  const last = log[0];
  if (last && last.code === opts.code && last.purpose === opts.purpose && last.file === files[0].name) return;
  log.unshift({
    code: opts.code || '—',
    purpose: opts.purpose,
    file: files[0].name,
    count: files.length,
    at: new Date().toISOString(),
  });
  writeJson(LOG_KEY, log.slice(0, 200));
  renderLog();
}

function renderLog() {
  const log = readJson(LOG_KEY, []);
  ui.logList.replaceChildren();
  ui.logClear.hidden = !log.length;
  if (!log.length) {
    const li = document.createElement('li');
    li.className = 'empty-log';
    li.textContent = t('log.empty');
    ui.logList.append(li);
    return;
  }
  log.forEach((entry, index) => {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = entry.code;
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = entry.purpose;
    text.title = entry.purpose;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const when = new Date(entry.at).toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' });
    meta.textContent = `${when} · ${entry.file}${entry.count > 1 ? ` (+${entry.count - 1})` : ''}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small ghost del';
    del.textContent = '✕';
    del.setAttribute('aria-label', t('log.delete', { code: entry.code }));
    del.addEventListener('click', () => {
      const current = readJson(LOG_KEY, []);
      current.splice(index, 1);
      writeJson(LOG_KEY, current);
      renderLog();
    });
    li.append(code, text, del, meta);
    ui.logList.append(li);
  });
}

// ---------- UI helpers ----------

function setBusy(label) {
  if (label) ui.busyLabel.textContent = label;
  ui.busy.hidden = !label;
}

let toastTimer;
function toast(message, isError = false) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle('error', isError);
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), isError ? 5000 : 2800);
}

function setFormat(value) {
  const input = ui.format.querySelector(`input[value="${value}"]`);
  if (input) input.checked = true;
}

function updateNetStatus() {
  const online = navigator.onLine;
  ui.netStatus.textContent = t(online ? 'top.online' : 'top.offline');
  ui.netStatus.classList.toggle('offline', !online);
}

// ---------- Share target (files shared to the installed app) ----------

async function consumeSharedFiles() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open(SHARE_CACHE);
    const requests = await cache.keys();
    const files = [];
    for (const req of requests) {
      const res = await cache.match(req);
      const name = decodeURIComponent(res.headers.get('X-File-Name') || t('file.document'));
      files.push(new File([await res.blob()], name, { type: res.headers.get('Content-Type') || '' }));
      await cache.delete(req);
    }
    if (files.length) await openFiles(files);
  } catch (err) {
    console.error(err);
  }
}

// ---------- Theme & language ----------

function saveUiPrefs() {
  writeJson(UI_KEY, { theme: state.theme, lang: getLanguage() });
}

function applyTheme(theme) {
  state.theme = THEMES.includes(theme) ? theme : 'auto';
  const root = document.documentElement;
  if (state.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = state.theme;
  ui.themeBtn.dataset.mode = state.theme;
  const label = t('theme.label', { mode: t(`theme.${state.theme}`) });
  ui.themeBtn.title = label;
  ui.themeBtn.setAttribute('aria-label', label);
  // Match the browser chrome to the theme actually shown.
  const dark = state.theme === 'dark' || (state.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  ui.themeColor.content = dark ? '#07090d' : '#f4f6f8';
  // Selection outlines use the accent color, which differs per theme.
  drawOverlay();
}

function applyLanguage(lang) {
  setLanguage(lang);
  ui.langSelect.value = getLanguage();
  translateDom();
  applyTheme(state.theme); // refreshes the translated theme label
  syncLabels();
  syncRedactUi();
  updateNetStatus();
  renderLog();
  renderPreview(); // the default watermark text and date format depend on the language
}

function initUiPrefs() {
  const prefs = readJson(UI_KEY, {});
  state.theme = THEMES.includes(prefs.theme) ? prefs.theme : 'auto';
  applyLanguage(LANGUAGES.includes(prefs.lang) ? prefs.lang : detectLanguage());

  ui.langSelect.addEventListener('change', () => {
    applyLanguage(ui.langSelect.value);
    saveUiPrefs();
  });
  ui.themeBtn.addEventListener('click', () => {
    applyTheme(THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length]);
    saveUiPrefs();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(state.theme));
}

// ---------- Wiring ----------

function bindEvents() {
  ui.fileInput.addEventListener('change', () => {
    if (ui.fileInput.files.length) openFiles(ui.fileInput.files);
    ui.fileInput.value = '';
  });
  ui.cameraBtn.addEventListener('click', () => ui.cameraInput.click());
  ui.cameraInput.addEventListener('change', () => {
    if (ui.cameraInput.files.length) openFiles(ui.cameraInput.files);
    ui.cameraInput.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    ui.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      ui.dropzone.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    ui.dropzone.addEventListener(type, () => ui.dropzone.classList.remove('over'));
  }
  // Accept drops anywhere on the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    ui.dropzone.classList.remove('over');
    if (e.dataTransfer?.files.length) openFiles(e.dataTransfer.files);
  });

  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      openFiles(files);
    }
  });

  ui.presets.addEventListener('click', (e) => {
    const preset = e.target.closest('[data-preset]')?.dataset.preset;
    if (!preset) return;
    ui.text.value = t(`preset.${preset}`);
    onOptionsChanged();
  });

  ui.swatches.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.adaptive = btn === ui.swatchAuto;
    if (btn.dataset.color) ui.color.value = btn.dataset.color;
    onOptionsChanged();
  });
  // Registered before the generic listener so the preview sees the fixed colour.
  ui.color.addEventListener('input', () => {
    state.adaptive = false;
  });
  // Copies only make sense with distinct tracking codes.
  ui.optTrace.addEventListener('change', () => {
    if (!ui.optTrace.checked) setCopyCount(1);
  });

  for (const el of [ui.text, ui.color, ui.opacity, ui.size, ui.density, ui.angle]) {
    el.addEventListener('input', onOptionsChanged);
  }
  for (const el of [ui.optDate, ui.optTrace, ui.optRandomAngle, ui.tone, ui.optWave, ui.optGuilloche, ui.optMicro, ui.optWarp, ui.optContours]) {
    el.addEventListener('change', onOptionsChanged);
  }

  ui.traceRegen.addEventListener('click', () => {
    regenerateCopies();
    onOptionsChanged();
  });
  ui.copiesDec.addEventListener('click', () => {
    setCopyCount(copyCount() - 1);
    onOptionsChanged();
  });
  ui.copiesInc.addEventListener('click', () => {
    setCopyCount(copyCount() + 1);
    onOptionsChanged();
  });
  ui.prevCopy.addEventListener('click', () => {
    state.copyIndex = Math.max(0, state.copyIndex - 1);
    renderPreview();
  });
  ui.nextCopy.addEventListener('click', () => {
    state.copyIndex = Math.min(copyCount() - 1, state.copyIndex + 1);
    renderPreview();
  });

  ui.prevPage.addEventListener('click', () => {
    state.pageIndex = Math.max(0, state.pageIndex - 1);
    state.selected = -1;
    renderPreview();
  });
  ui.nextPage.addEventListener('click', () => {
    state.pageIndex = Math.min(state.pages.length - 1, state.pageIndex + 1);
    state.selected = -1;
    renderPreview();
  });
  ui.clearBtn.addEventListener('click', resetDocument);

  bindRedactEvents();

  ui.downloadBtn.addEventListener('click', handleDownload);
  ui.shareBtn.addEventListener('click', handleShare);
  ui.logClear.addEventListener('click', () => {
    if (!confirm(t('log.confirmClear'))) return;
    writeJson(LOG_KEY, []);
    renderLog();
  });

  window.addEventListener('online', updateNetStatus);
  window.addEventListener('offline', updateNetStatus);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    ui.installBtn.hidden = false;
  });
  ui.installBtn.addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    ui.installBtn.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    ui.installBtn.hidden = true;
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.warn('Service worker registration failed', err);
  }
}

function init() {
  loadPrefs();
  ui.shareBtn.hidden = !navigator.canShare;
  // Camera capture is offered only on touch devices (phones and tablets).
  ui.cameraBtn.hidden = ui.cameraHint.hidden = !matchMedia('(pointer: coarse)').matches;
  bindEvents();
  initUiPrefs();
  registerServiceWorker();
  consumeSharedFiles();
}

init();
