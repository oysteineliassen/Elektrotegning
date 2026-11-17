'use strict';
/* Takpunkter – plasser downlights o.l. på plantegning og få mål til nærmeste vegg. */

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ---------------- Innstillinger ---------------- */
const S = Object.assign({ snap: 10, dims: 'all', sym: 1, thr: 150, minStroke: 0 }, (() => {
  try { return JSON.parse(localStorage.getItem('tp-settings') || '{}'); } catch (e) { return {}; }
})());
function saveS() { try { localStorage.setItem('tp-settings', JSON.stringify(S)); } catch (e) { } }

/* ---------------- Lagring (IndexedDB) ---------------- */
const store = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('takpunkter', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  run(name, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(name, mode);
      const req = fn(t.objectStore(name));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  all() { return this.run('projects', 'readonly', s => s.getAll()); },
  put(p) { return this.run('projects', 'readwrite', s => s.put(p)); },
  del(id) {
    return Promise.all([this.run('projects', 'readwrite', s => s.delete(id)), this.run('files', 'readwrite', s => s.delete(id))]);
  },
  putFile(id, blob) { return this.run('files', 'readwrite', s => s.put(blob, id)); },
  getFile(id) { return this.run('files', 'readonly', s => s.get(id)); }
};

/* ---------------- Symboltyper ---------------- */
function circ(ctx, r) { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
function cross(ctx, r) { const a = r * 0.7071; ctx.beginPath(); ctx.moveTo(-a, -a); ctx.lineTo(a, a); ctx.moveTo(a, -a); ctx.lineTo(-a, a); ctx.stroke(); }
function letter(ctx, r, t, col) { ctx.fillStyle = col; ctx.font = `700 ${r * 1.15}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, 0, r * 0.06); }
const TYPES = {
  downlight: { name: 'Downlight', color: '#ea580c', draw(c, r) { circ(c, r); cross(c, r); } },
  spot: { name: 'Spot', color: '#ca8a04', draw(c, r) { r *= 0.8; circ(c, r); cross(c, r); c.beginPath(); c.arc(0, 0, r * 0.28, 0, 7); c.fillStyle = this.color; c.fill(); } },
  lampe: { name: 'Lampepunkt', color: '#7c3aed', draw(c, r) { circ(c, r * 1.1); cross(c, r * 1.1); } },
  royk: { name: 'Røykvarsler', color: '#dc2626', draw(c, r) { circ(c, r); letter(c, r, 'R', this.color); } },
  hoyttaler: { name: 'Høyttaler', color: '#0891b2', draw(c, r) { circ(c, r); letter(c, r, 'H', this.color); } },
  boks: { name: 'Koblingsboks', color: '#475569', draw(c, r) { c.beginPath(); c.rect(-r * .8, -r * .8, r * 1.6, r * 1.6); c.fill(); c.stroke(); c.beginPath(); c.arc(0, 0, r * .25, 0, 7); c.fillStyle = this.color; c.fill(); } }
};

/* ---------------- Tegningsdokumenter ---------------- */
class PdfDoc {
  static async load(blob, pageNo) {
    const d = new PdfDoc();
    d.kind = 'pdf';
    const data = new Uint8Array(await blob.arrayBuffer());
    d.pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    d.page = await d.pdf.getPage(clamp(pageNo || 1, 1, d.pdf.numPages));
    const vp = d.page.getViewport({ scale: 1 });
    d.W = vp.width; d.H = vp.height;
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const maxPx = ios ? 9e6 : 14e6;
    const b = clamp(Math.sqrt(maxPx / (d.W * d.H)), 1, 7);
    const c = document.createElement('canvas');
    c.width = Math.floor(d.W * b); c.height = Math.floor(d.H * b);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await d.page.render({ canvasContext: ctx, viewport: d.page.getViewport({ scale: b }) }).promise;
    d.base = c; d.pw = c.width; d.ph = c.height; d.b = c.width / d.W;
    const img = ctx.getImageData(0, 0, d.pw, d.ph).data;
    const lum = new Uint8Array(d.pw * d.ph);
    for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (img[j] * 77 + img[j + 1] * 150 + img[j + 2] * 29) >> 8;
    d.lum = lum;
    d.bounds = { x0: 0, y0: 0, x1: d.W, y1: d.H };
    d.hi = null; d.task = null;
    return d;
  }
  draw(ctx, v, dpr, o) {
    ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, this.W, this.H);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.base, 0, 0, this.W, this.H);
    if (o.main && this.hi) {
      const h = this.hi, k = v.s / h.s;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, this.W, this.H); ctx.clip();
      ctx.setTransform(k, 0, 0, k, (v.tx - h.tx * k) * dpr, (v.ty - h.ty * k) * dpr);
      ctx.drawImage(h.canvas, 0, 0);
      ctx.restore();
    }
  }
  renderHi(v, cw, ch, dpr, done) {
    if (this.task) { try { this.task.cancel(); } catch (e) { } this.task = null; }
    if (v.s * dpr <= this.b * 1.1) { this.hi = null; return; }
    const c = document.createElement('canvas');
    c.width = Math.ceil(cw * dpr); c.height = Math.ceil(ch * dpr);
    const vp = this.page.getViewport({ scale: v.s * dpr, offsetX: v.tx * dpr, offsetY: v.ty * dpr });
    const snap = { s: v.s, tx: v.tx, ty: v.ty };
    const task = this.page.render({ canvasContext: c.getContext('2d'), viewport: vp });
    this.task = task;
    task.promise.then(() => {
      if (this.task !== task) return;
      this.task = null;
      this.hi = { canvas: c, ...snap };
      done();
    }).catch(() => { });
  }
  // avstand (i tegningsenheter) fra (x,y) til første mørke strek i retning dir
  ray(x, y, dir, mpu) {
    const b = this.b, pw = this.pw, ph = this.ph, lum = this.lum, thr = S.thr;
    let px = Math.floor(x * b), py = Math.floor(y * b);
    if (px < 0 || py < 0 || px >= pw || py >= ph) return null;
    const dx = dir === 'R' ? 1 : dir === 'L' ? -1 : 0, dy = dir === 'D' ? 1 : dir === 'U' ? -1 : 0;
    const minRun = S.minStroke > 0 && mpu ? Math.max(1, Math.round(S.minStroke / mpu * b)) : 1;
    const inside = () => px >= 0 && py >= 0 && px < pw && py < ph;
    const dark = () => lum[py * pw + px] < thr;
    while (inside() && dark()) { px += dx; py += dy; }
    while (inside()) {
      if (dark()) {
        const hx = px, hy = py;
        let run = 0;
        while (inside() && dark()) { run++; px += dx; py += dy; }
        if (run >= minRun) {
          if (dir === 'R') return Math.max(0, hx / b - x);
          if (dir === 'L') return Math.max(0, x - (hx + 1) / b);
          if (dir === 'D') return Math.max(0, hy / b - y);
          return Math.max(0, y - (hy + 1) / b);
        }
      } else { px += dx; py += dy; }
    }
    return null;
  }
}

const ACI = { 1: '#dc2626', 2: '#a16207', 3: '#16a34a', 4: '#0891b2', 5: '#1d4ed8', 6: '#c026d3', 7: '#111827', 8: '#6b7280', 9: '#9ca3af', 30: '#ea580c', 40: '#ea580c', 140: '#0284c7', 150: '#1d4ed8', 210: '#c026d3' };
const aci = c => ACI[c] || '#4b5563';
const EQ_RE = /^e[-_ .]|elektro|^el[-_ .]|stikk|bryter|lys|belys|lampe|armatur|kraft|svak|socket|switch|light|lamp|spot|downlight|vifte|termostat|r[øo]yk|uttak|tavle|sikring|kontakt|dimmer|ladeboks|varme/i;
const WALLMOUNT_RE = /stikk|bryter|uttak|socket|switch|kontakt|dimmer|termostat|vegglys|ladeboks/i;

class DxfDoc {
  static load(text, P) {
    const d = new DxfDoc();
    d.kind = 'dxf';
    d.r = DXF.parseDXF(text);
    d.bounds = d.r.bounds || { x0: 0, y0: 0, x1: 1000, y1: 1000 };
    d.gcache = new Map();
    d.applyLayers(P);
    return d;
  }
  autoEquip(l, i) {
    if (!l.inserts || WALL_RE.test(l.name)) return false;
    if (EQ_RE.test(l.name)) return true;
    return this.r.inserts.some(ins => ins.li === i && EQ_RE.test(ins.block));
  }
  applyLayers(P) {
    const L = this.r.layers, r = this.r;
    this.show = new Uint8Array(L.length); this.wall = new Uint8Array(L.length); this.equip = new Uint8Array(L.length);
    L.forEach((l, i) => {
      const c = (P.layers || {})[l.name] || {};
      this.show[i] = c.show === undefined ? (l.off ? 0 : 1) : (c.show ? 1 : 0);
      this.wall[i] = this.show[i] && c.wall ? 1 : 0;
      this.equip[i] = (c.equip === undefined ? this.autoEquip(l, i) : c.equip) ? 1 : 0;
    });
    this.eqIns = new Uint8Array(r.inserts.length);
    r.inserts.forEach(ins => { this.eqIns[ins.idx] = this.equip[ins.li]; });
    const sg = r.segs, isEq = k => sg.ins[k] >= 0 && this.eqIns[sg.ins[k]];
    this.paths = L.map(() => new Path2D());
    const wk = [];
    for (let k = 0; k < sg.n; k++) {
      if (isEq(k)) continue;
      const p = this.paths[sg.l[k]];
      p.moveTo(sg.x1[k], sg.y1[k]); p.lineTo(sg.x2[k], sg.y2[k]);
      if (this.wall[sg.l[k]]) wk.push(k);
    }
    this.wallIdx = Int32Array.from(wk);
    this.fillPaths = L.map(() => null);
    for (const f of r.fills) {
      if (f.ins >= 0 && this.eqIns[f.ins]) continue;
      const p = this.fillPaths[f.l] || (this.fillPaths[f.l] = new Path2D());
      for (const lp of f.loops) { lp.forEach((q, i) => i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])); p.closePath(); }
    }
    this.texts = r.texts.filter(t => !(t.ins >= 0 && this.eqIns[t.ins]));
  }
  geom(name) {
    let g = this.gcache.get(name);
    if (g) return g;
    const bg = this.r.blockGeom(name) || (typeof libGeom === 'function' ? libGeom(name) : null);
    if (!bg) return null;
    const s = bg.segs, path = new Path2D();
    for (let k = 0; k < s.x1.length; k++) { path.moveTo(s.x1[k], s.y1[k]); path.lineTo(s.x2[k], s.y2[k]); }
    let fill = null;
    for (const f of s.fills) { fill = fill || new Path2D(); for (const lp of f.loops) { lp.forEach((q, i) => i ? fill.lineTo(q[0], q[1]) : fill.moveTo(q[0], q[1])); fill.closePath(); } }
    const b = bg.bbox;
    const pts = [];
    for (let k = 0; k < s.x1.length; k++) pts.push(s.x1[k], s.y1[k], s.x2[k], s.y2[k]);
    g = { path, fill, fills: s.fills, texts: s.texts, bbox: b, pts, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, rad: Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2 };
    this.gcache.set(name, g);
    return g;
  }
  draw(ctx, v, dpr, o) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!o.loupe) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
    ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const k = o.k || 1, L = this.r.layers;
    for (let i = 0; i < this.fillPaths.length; i++) {
      if (!this.show[i] || !this.fillPaths[i]) continue;
      ctx.fillStyle = this.wall[i] ? '#b4b8bf' : aci(L[i].color); ctx.globalAlpha = this.wall[i] ? 1 : 0.35;
      ctx.fill(this.fillPaths[i], 'evenodd');
    }
    ctx.globalAlpha = 1;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < this.paths.length; i++) {
      if (!this.show[i] || (pass === 0) === !!this.wall[i]) continue;
      ctx.strokeStyle = this.wall[i] ? '#111' : aci(L[i].color);
      ctx.lineWidth = (this.wall[i] ? 1.4 : 0.9) * k / v.s;
      ctx.stroke(this.paths[i]);
    }
    const W = ctx.canvas.width / dpr, H = ctx.canvas.height / dpr;
    for (const t of this.texts) {
      if (!this.show[t.l] || t.item) continue;
      drawText(ctx, t, v, W, H, aci(L[t.l].color === 7 ? 8 : L[t.l].color), 0, 0);
    }
    if (typeof drawEquip === 'function') drawEquip(ctx, v, dpr, o, W, H);
  }
  renderHi() { }
  ray(x, y, dir) {
    const g = this.r.segs, X1 = g.x1, Y1 = g.y1, X2 = g.x2, Y2 = g.y2, idx = this.wallIdx;
    let best = Infinity;
    const horiz = dir === 'L' || dir === 'R';
    for (let n = 0; n < idx.length; n++) {
      const k = idx[n];
      if (horiz) {
        const ya = Y1[k], yb = Y2[k];
        if (ya === yb || (y < ya) === (y < yb)) continue;
        const ix = X1[k] + (y - ya) * (X2[k] - X1[k]) / (yb - ya), d = dir === 'R' ? ix - x : x - ix;
        if (d > 1e-9 && d < best) best = d;
      } else {
        const xa = X1[k], xb = X2[k];
        if (xa === xb || (x < xa) === (x < xb)) continue;
        const iy = Y1[k] + (x - xa) * (Y2[k] - Y1[k]) / (xb - xa), d = dir === 'D' ? iy - y : y - iy;
        if (d > 1e-9 && d < best) best = d;
      }
    }
    return best === Infinity ? null : best;
  }
  // nærmeste veggflate: {k, d, px, py, nx, ny (fra vegg mot punktet), tx, ty (langs veggen)}
  nearestWall(x, y, maxD, prefer) {
    const g = this.r.segs, idx = this.wallIdx;
    let best = null, pref = null;
    for (let n = 0; n < idx.length; n++) {
      const k = idx[n];
      const ax = g.x1[k], ay = g.y1[k], bx = g.x2[k], by = g.y2[k];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      let t = ((x - ax) * dx + (y - ay) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(x - px, y - py);
      if (d > maxD) continue;
      const c = { k, d, px, py, t, dx, dy, l2 };
      // likt (felles hjørne): velg segmentet der punktet ligger innenfor, ellers det lengste
      if (!best || d < best.d - 0.5) best = c;
      else if (d < best.d + 0.5) {
        const ci = t > 0 && t < 1, bi = best.t > 0 && best.t < 1;
        if ((ci && !bi) || (ci === bi && l2 > best.l2)) best = c;
      }
      if (k === prefer) pref = c;
    }
    if (pref && best && pref.d < best.d + maxD * 0.15) best = pref;
    if (!best) return null;
    const len = Math.hypot(best.dx, best.dy);
    best.tx = best.dx / len; best.ty = best.dy / len;
    if (best.d > 1e-9 && best.t > 0 && best.t < 1) { best.nx = (x - best.px) / best.d; best.ny = (y - best.py) / best.d; }
    else {
      // ved endepunkt/på linjen: bruk veggens normal, mot siden punktet ligger på
      best.nx = -best.ty; best.ny = best.tx;
      if ((x - best.px) * best.nx + (y - best.py) * best.ny < 0) { best.nx = -best.nx; best.ny = -best.ny; }
    }
    return best;
  }
}

function drawText(ctx, t, v, W, H, color, ox, oy) {
  const hs = t.h * v.s;
  if (hs < 2.2) return;
  const sx = (t.x + ox) * v.s + v.tx, sy = (t.y + oy) * v.s + v.ty, m = hs * Math.max(8, t.s.length);
  if (W && (sx < -m || sy < -m || sx > W + m || sy > H + m)) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.translate(t.x + ox, t.y + oy); ctx.rotate(-t.rot);
  const sc = t.h / 70; ctx.scale(sc, sc);
  ctx.font = '100px system-ui, sans-serif';
  ctx.textAlign = t.ha; ctx.textBaseline = t.va;
  const lines = t.s.split('\n'), ls = 116;
  const y0 = t.va === 'bottom' ? -(lines.length - 1) * ls : t.va === 'middle' ? -(lines.length - 1) * ls / 2 : 0;
  lines.forEach((ln, i) => ctx.fillText(ln, 0, y0 + i * ls));
  ctx.restore();
}

const UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const WALL_RE = /vegg|wall|wand|v[aä]gg|mur|b[æa]rende|a-?40|^a-?wall|vindu|window/i;

/* ---------------- Tilstand ---------------- */
let P = null, doc = null;
const view = { s: 1, tx: 0, ty: 0 };
let selId = null, curType = 'downlight', placing = true, mode = 'edit';
let calibPts = [], undoStack = [], labels = [], dragPt = null;
let guides = [], guideT = 0, rowPts = [], rowPreview = null;
let cw = 1, ch = 1, dpr = 1;
const cv = $('#cv');

/* ---------------- Mål ---------------- */
function dimsOf(p) {
  if (p._d) return p._d;
  const mpu = P.mmPerUnit;
  const L = doc.ray(p.x, p.y, 'L', mpu), R = doc.ray(p.x, p.y, 'R', mpu);
  const U = doc.ray(p.x, p.y, 'U', mpu), D = doc.ray(p.x, p.y, 'D', mpu);
  const pick = (lock, a, b, A, B) => {
    if (lock === A && a != null) return A;
    if (lock === B && b != null) return B;
    if (a == null && b == null) return null;
    if (b == null) return A;
    if (a == null) return B;
    return a <= b ? A : B;
  };
  p._d = { L, R, U, D, xs: pick(p.lockX, L, R, 'L', 'R'), ys: pick(p.lockY, U, D, 'U', 'D') };
  return p._d;
}
function dist(d, side) { return side === 'L' ? d.L : side === 'R' ? d.R : side === 'U' ? d.U : side === 'D' ? d.D : null; }
function mm(units) { return P.mmPerUnit ? Math.round(units * P.mmPerUnit) : null; }
function fmt(units) { const v = mm(units); return v == null ? '?' : String(v); }
const SIDE_TXT = { L: 'fra venstre vegg', R: 'fra høyre vegg', U: 'fra øvre vegg', D: 'fra nedre vegg' };
const SIDE_ARW = { L: '←', R: '→', U: '↑', D: '↓' };
function invalidateDims() { if (P) P.points.forEach(p => p._d = null); }

function applySnap(p) {
  if (!S.snap || !P.mmPerUnit) return;
  const mpu = P.mmPerUnit, step = S.snap / mpu;
  const d = dimsOf(p);
  if (d.xs) {
    const dd = dist(d, d.xs);
    const t = Math.max(step, Math.round(dd / step) * step);
    p.x += (d.xs === 'L' ? 1 : -1) * (t - dd);
  }
  if (d.ys) {
    const dd = dist(d, d.ys);
    const t = Math.max(step, Math.round(dd / step) * step);
    p.y += (d.ys === 'U' ? 1 : -1) * (t - dd);
  }
  p._d = null;
}

// juster mot andre punkter (samme X eller Y) – gjør det lett å lage rette rader
function alignSnap(p) {
  guides = [];
  const tol = 10 / view.s;
  let bx = null, by = null, dx = tol, dy = tol;
  for (const q of P.points) {
    if (q === p) continue;
    const ax = Math.abs(q.x - p.x), ay = Math.abs(q.y - p.y);
    if (ax < dx) { dx = ax; bx = q; }
    if (ay < dy) { dy = ay; by = q; }
  }
  if (bx) { p.x = bx.x; guides.push([bx, p]); }
  if (by) { p.y = by.y; guides.push([by, p]); }
  if (bx || by) p._d = null;
  clearTimeout(guideT);
}
function fadeGuides() { clearTimeout(guideT); guideT = setTimeout(() => { guides = []; req(); }, 900); }
// nærmeste naboer på samme linje
function neighbors(p) {
  const tol = 1 / (P.mmPerUnit || 1);
  const out = {};
  for (const q of P.points) {
    if (q === p) continue;
    if (Math.abs(q.y - p.y) < tol) {
      if (q.x < p.x && (!out.L || q.x > out.L.x)) out.L = q;
      if (q.x > p.x && (!out.R || q.x < out.R.x)) out.R = q;
    }
    if (Math.abs(q.x - p.x) < tol) {
      if (q.y < p.y && (!out.U || q.y > out.U.y)) out.U = q;
      if (q.y > p.y && (!out.D || q.y < out.D.y)) out.D = q;
    }
  }
  return out;
}

/* ---------------- Tegning ---------------- */
let rafId = 0;
function req() { if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; draw(); }); }

function draw() {
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#d1d5db'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!doc || !P) return;
  doc.draw(ctx, view, dpr, { main: true, k: 1 });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  labels = [];
  if (edMode === 'mal' || doc.kind !== 'dxf') drawOverlay(ctx, view, { main: true, k: S.sym });
  if (typeof drawPalDrag === 'function') drawPalDrag(ctx);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (dragPt) drawLoupe(ctx, dragPt, true);
  else if (gest && gest.type === 'idrag') drawLoupe(ctx, gest.item, false);
  else if (typeof palDrag !== 'undefined' && palDrag && palDrag.inside) drawLoupe(ctx, palDrag, false);
  updatePanel();
  if (typeof positionEqBar === 'function') positionEqBar();
}

function drawOverlay(ctx, v, o) {
  const k = o.k;
  const pts = P.points;
  for (const p of pts) {
    if (o.export || S.dims === 'all' || p.id === selId || p === dragPt) drawDims(ctx, v, p, o);
  }
  if (!o.export) {
    ctx.strokeStyle = '#0d9488'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 4]);
    for (const [a, b] of guides) {
      ctx.beginPath(); ctx.moveTo(a.x * v.s + v.tx, a.y * v.s + v.ty); ctx.lineTo(b.x * v.s + v.tx, b.y * v.s + v.ty); ctx.stroke();
    }
    ctx.setLineDash([]);
    const sp = dragPt || (selId && pts.find(q => q.id === selId));
    if (sp && P.mmPerUnit) drawSpacing(ctx, v, sp, o);
  }
  pts.forEach((p, i) => {
    const sx = p.x * v.s + v.tx, sy = p.y * v.s + v.ty;
    drawSym(ctx, p, sx, sy, 11 * k, !o.export && p.id === selId, i + 1, k);
  });
  if (o.main && rowPreview) {
    ctx.globalAlpha = 0.75;
    rowPreview.forEach(q => drawSym(ctx, { type: curType }, q.x * v.s + v.tx, q.y * v.s + v.ty, 11 * k, false, '', k));
    ctx.globalAlpha = 1;
  }
  if (o.main && mode === 'row' && rowPts.length === 1) {
    const q = rowPts[0], x = q.x * v.s + v.tx, y = q.y * v.s + v.ty;
    ctx.strokeStyle = '#0d9488'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.moveTo(x - 15, y); ctx.lineTo(x + 15, y); ctx.moveTo(x, y - 15); ctx.lineTo(x, y + 15); ctx.stroke();
  }
  if (o.main && mode === 'calib') {
    ctx.strokeStyle = '#16a34a'; ctx.fillStyle = '#16a34a'; ctx.lineWidth = 2;
    calibPts.forEach((c, i) => {
      const x = c.x * v.s + v.tx, y = c.y * v.s + v.ty;
      ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); ctx.stroke();
      if (i === 1) {
        const a = calibPts[0];
        ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(a.x * v.s + v.tx, a.y * v.s + v.ty); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
      }
    });
  }
}

function drawDims(ctx, v, p, o) {
  const k = o.k, d = dimsOf(p);
  const sx = p.x * v.s + v.tx, sy = p.y * v.s + v.ty;
  const sel = !o.export && (p.id === selId || p === dragPt);
  const lw = (sel ? 2 : 1.3) * k;
  if (d.xs) {
    const dd = dist(d, d.xs);
    const wx = sx + (d.xs === 'L' ? -1 : 1) * dd * v.s;
    dimLine(ctx, sx, sy, wx, sy, '#2563eb', lw, k);
    dimLabel(ctx, fmt(dd), (sx + wx) / 2, sy, Math.abs(wx - sx), true, '#2563eb', k, sel, o.main ? { p, axis: 'x' } : null, d.xs === 'L' ? -1 : 1);
  }
  if (d.ys) {
    const dd = dist(d, d.ys);
    const wy = sy + (d.ys === 'U' ? -1 : 1) * dd * v.s;
    dimLine(ctx, sx, sy, sx, wy, '#c026d3', lw, k);
    dimLabel(ctx, fmt(dd), sx, (sy + wy) / 2, Math.abs(wy - sy), false, '#c026d3', k, sel, o.main ? { p, axis: 'y' } : null, d.ys === 'U' ? -1 : 1);
  }
}
function drawSpacing(ctx, v, p, o) {
  const nb = neighbors(p), k = o.k || 1, off = 24 * k, col = '#0d9488';
  const sx = p.x * v.s + v.tx, sy = p.y * v.s + v.ty;
  for (const side of ['L', 'R', 'U', 'D']) {
    const q = nb[side];
    if (!q) continue;
    const qx = q.x * v.s + v.tx, qy = q.y * v.s + v.ty;
    const horiz = side === 'L' || side === 'R';
    const ax = horiz ? sx : sx - off, ay = horiz ? sy - off : sy, bx = horiz ? qx : qx - off, by = horiz ? qy - off : qy;
    ctx.strokeStyle = col; ctx.lineWidth = 1.4 * k;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    if (horiz) { ctx.moveTo(ax, ay - 6); ctx.lineTo(ax, ay + 6); ctx.moveTo(bx, by - 6); ctx.lineTo(bx, by + 6); }
    else { ctx.moveTo(ax - 6, ay); ctx.lineTo(ax + 6, ay); ctx.moveTo(bx - 6, by); ctx.lineTo(bx + 6, by); }
    ctx.stroke();
    const d = horiz ? Math.abs(q.x - p.x) : Math.abs(q.y - p.y);
    dimLabel(ctx, 'c/c ' + fmt(d), (ax + bx) / 2, (ay + by) / 2, 1e9, horiz, col, k, false, o.main ? { p, axis: 'c' + side, nb: q } : null, 0);
  }
}
function dimLine(ctx, x1, y1, x2, y2, col, lw, k) {
  ctx.strokeStyle = col; ctx.lineWidth = lw;
  ctx.setLineDash([5 * k, 3 * k]);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.setLineDash([]);
  const t = 7 * k;
  ctx.lineWidth = lw * 1.4;
  ctx.beginPath();
  if (y1 === y2) { ctx.moveTo(x2, y2 - t); ctx.lineTo(x2, y2 + t); }
  else { ctx.moveTo(x2 - t, y2); ctx.lineTo(x2 + t, y2); }
  ctx.stroke();
}
function dimLabel(ctx, txt, cx, cy, len, horiz, col, k, sel, hit, dirSign) {
  const fs = (sel ? 14 : 12) * k;
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  const w = ctx.measureText(txt).width + 12 * k, h = fs + 8 * k;
  // for kort linje: legg merket utenfor veggen
  if (horiz && len < w + 26 * k) cx += dirSign * (len / 2 + w / 2 + 6 * k);
  if (!horiz && len < h + 26 * k) cy += dirSign * (len / 2 + h / 2 + 6 * k);
  const x = cx - w / 2, y = cy - h / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2); else ctx.rect(x, y, w, h);
  ctx.fillStyle = sel ? col : '#fff'; ctx.fill();
  ctx.lineWidth = 1.5 * k; ctx.strokeStyle = col; ctx.stroke();
  ctx.fillStyle = sel ? '#fff' : col;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, cx, cy + 0.5 * k);
  if (hit) labels.push({ ...hit, x: x - 6, y: y - 6, w: w + 12, h: h + 12, sel });
}
function drawSym(ctx, p, sx, sy, r, sel, num, k) {
  const T = TYPES[p.type] || TYPES.downlight;
  ctx.save();
  ctx.translate(sx, sy);
  if (sel) {
    ctx.beginPath(); ctx.arc(0, 0, r + 7 * k, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(37,99,235,.18)'; ctx.fill();
    ctx.lineWidth = 2 * k; ctx.strokeStyle = '#2563eb'; ctx.stroke();
  }
  ctx.lineWidth = 2 * k; ctx.strokeStyle = T.color; ctx.fillStyle = 'rgba(255,255,255,.9)';
  T.draw(ctx, r);
  ctx.font = `700 ${10 * k}px system-ui, sans-serif`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3 * k; ctx.strokeStyle = '#fff'; ctx.strokeText(String(num), r * 0.75, -r * 0.6);
  ctx.fillStyle = '#111'; ctx.fillText(String(num), r * 0.75, -r * 0.6);
  ctx.restore();
}

function drawLoupe(ctx, tgt, isPoint) {
  const R = 70, Z = 3;
  const ps = toScreen(tgt);
  const cx = ps.x > cw / 2 ? R + 14 : cw - R - 14, cy = R + 14;
  const lv = { s: view.s * Z, tx: 0, ty: 0 };
  lv.tx = cx - tgt.x * lv.s; lv.ty = cy - tgt.y * lv.s;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#fff'; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  doc.draw(ctx, lv, dpr, { main: false, k: 1, loupe: true });
  if (!isPoint && tgt.key === 'drag') drawBlock(ctx, lv, dpr, doc.geom(tgt.block), tgt.x, tgt.y, tgt.r, tgt.sx, tgt.sy, aci(doc.r.layers[tgt.li].color), 0.85, 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (isPoint) drawDims(ctx, lv, tgt, { k: 0.9 });
  ctx.strokeStyle = 'rgba(234,88,12,.9)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.lineWidth = 3; ctx.strokeStyle = '#111827'; ctx.stroke();
}

/* ---------------- Visning ---------------- */
function toScreen(u) { return { x: u.x * view.s + view.tx, y: u.y * view.s + view.ty }; }
function toUnit(x, y) { return { x: (x - view.tx) / view.s, y: (y - view.ty) / view.s }; }
function fitS() { const b = doc.bounds; return Math.min(cw / (b.x1 - b.x0), ch / (b.y1 - b.y0)) * 0.94; }
function fitView() {
  if (!doc) return;
  const b = doc.bounds, s = fitS();
  view.s = s;
  view.tx = (cw - (b.x1 - b.x0) * s) / 2 - b.x0 * s;
  view.ty = (ch - (b.y1 - b.y0) * s) / 2 - b.y0 * s;
  afterView();
}
function zoomAt(x, y, f) {
  const fs = fitS();
  const ns = clamp(view.s * f, fs * 0.3, fs * 400);
  const u = toUnit(x, y);
  view.s = ns; view.tx = x - u.x * ns; view.ty = y - u.y * ns;
  req();
}
let hiTimer = 0, viewTimer = 0;
function afterView() {
  req();
  clearTimeout(hiTimer);
  hiTimer = setTimeout(() => { if (doc && !gest) doc.renderHi(view, cw, ch, dpr, req); }, 220);
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { if (P) try { localStorage.setItem('tp-view-' + P.id, JSON.stringify(view)); } catch (e) { } }, 600);
}
function resize() {
  const r = $('#stage').getBoundingClientRect();
  cw = Math.max(1, r.width); ch = Math.max(1, r.height);
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  afterView();
}
window.addEventListener('resize', resize);

/* ---------------- Berøring ---------------- */
const ptrs = new Map();
let gest = null, lpTimer = 0;
function pos(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function hitPoint(x, y) {
  let best = null, bd = 26 * Math.max(1, S.sym);
  for (const p of P.points) {
    const s = toScreen(p), d = Math.hypot(s.x - x, s.y - y) - (p.id === selId ? 4 : 0);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function hitLabel(x, y) {
  let found = null;
  for (const l of labels) if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) { if (!found || l.sel) found = l; }
  return found;
}
cv.addEventListener('pointerdown', e => {
  if (!doc) return;
  try { cv.setPointerCapture(e.pointerId); } catch (er) { }
  const p = pos(e);
  ptrs.set(e.pointerId, p);
  if (ptrs.size === 1 && eqActive() && mode === 'edit') {
    const hk = eqTool === 'sel' ? hitKurs(p.x, p.y) : null;
    const hi = hk ? null : hitItem(p.x, p.y);
    gest = { type: 'pending', x0: p.x, y0: p.y, hi, hk, v0: { ...view } };
    if (hk) lpTimer = setTimeout(() => { if (gest && gest.type === 'pending') { gest.type = 'kdrag'; try { navigator.vibrate && navigator.vibrate(15); } catch (e) { } } }, 380);
    else if (hi) lpTimer = setTimeout(() => startItemDrag(hi, p.x, p.y), 380);
  } else if (ptrs.size === 1) {
    const hp = mode === 'edit' ? hitPoint(p.x, p.y) : null;
    const hl = mode === 'edit' ? hitLabel(p.x, p.y) : null;
    gest = { type: 'pending', x0: p.x, y0: p.y, hp, hl, v0: { ...view } };
    if (hp) lpTimer = setTimeout(() => startDrag(hp, p.x, p.y), 380);
  } else if (ptrs.size === 2) {
    clearTimeout(lpTimer);
    if (gest && gest.type === 'drag') endDrag();
    if (gest && gest.type === 'idrag') endItemDrag();
    const [a, b] = [...ptrs.values()];
    gest = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...view } };
  }
});
cv.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId) || !gest) return;
  const p = pos(e);
  ptrs.set(e.pointerId, p);
  if (gest.type === 'pinch') {
    if (ptrs.size < 2) return;
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const v0 = gest.v0, fs = fitS();
    const ns = clamp(v0.s * d / gest.d0, fs * 0.3, fs * 400);
    const ux = (gest.c0.x - v0.tx) / v0.s, uy = (gest.c0.y - v0.ty) / v0.s;
    view.s = ns; view.tx = c.x - ux * ns; view.ty = c.y - uy * ns;
    req();
    return;
  }
  if (gest.type === 'pending' && Math.hypot(p.x - gest.x0, p.y - gest.y0) > 9) {
    clearTimeout(lpTimer);
    gest.type = 'pan';
  }
  if (gest.type === 'pan') {
    view.tx = gest.v0.tx + (p.x - gest.x0); view.ty = gest.v0.ty + (p.y - gest.y0);
    req();
  } else if (gest.type === 'kdrag') {
    moveKurs(gest.hk, p);
  } else if (gest.type === 'idrag') {
    moveItemDrag(p);
  } else if (gest.type === 'drag') {
    const u = toUnit(p.x + gest.off.x, p.y + gest.off.y);
    dragPt.x = u.x; dragPt.y = u.y; dragPt._d = null;
    applySnap(dragPt);
    alignSnap(dragPt);
    req();
  }
});
function ptrEnd(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  clearTimeout(lpTimer);
  if (!gest) return;
  if (gest.type === 'pending' && e.type === 'pointerup') onTap(gest.x0, gest.y0, gest);
  else if (gest.type === 'drag') endDrag();
  else if (gest.type === 'idrag') endItemDrag();
  else if (gest.type === 'kdrag') save();
  else if (gest.type === 'pinch' && ptrs.size === 1) {
    const [p] = [...ptrs.values()];
    gest = { type: 'pan', x0: p.x, y0: p.y, v0: { ...view } };
    return;
  }
  if (ptrs.size === 0) { gest = null; afterView(); }
}
cv.addEventListener('pointerup', ptrEnd);
cv.addEventListener('pointercancel', ptrEnd);
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const p = pos(e);
  zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  afterView();
}, { passive: false });
cv.addEventListener('contextmenu', e => e.preventDefault());

function onTap(x, y, g) {
  if (mode === 'row') {
    const u = toUnit(x, y);
    const tmp = { x: u.x, y: u.y };
    if (P.mmPerUnit) { applySnap(tmp); }
    alignSnap(tmp); fadeGuides();
    rowPts.push(tmp);
    if (rowPts.length === 1) setBanner('Rad: trykk der raden slutter', 'Avbryt', endRow);
    req();
    if (rowPts.length === 2) setTimeout(rowDialog, 120);
    return;
  }
  if (mode === 'calib') {
    calibPts.push(toUnit(x, y));
    if (calibPts.length === 1) setBanner('Trykk på punkt 2 av 2');
    req();
    if (calibPts.length === 2) setTimeout(finishCalib, 150);
    return;
  }
  if (eqActive()) { eqTap(x, y, g); return; }
  if (g.hl && g.hl.axis[0] === 'c') { editSpacing(g.hl.p, g.hl.nb, g.hl.axis.slice(1)); return; }
  if (g.hl) { select(g.hl.p.id); editDim(g.hl.p, g.hl.axis); return; }
  if (g.hp) { select(selId === g.hp.id ? null : g.hp.id); return; }
  if (!placing) { select(null); return; }
  if (!P.mmPerUnit) { askScale(); return; }
  pushUndo();
  const u = toUnit(x, y);
  const p = { id: uid(), type: curType, x: u.x, y: u.y, lockX: null, lockY: null };
  applySnap(p);
  alignSnap(p); fadeGuides();
  P.points.push(p);
  select(p.id);
  save();
}
function startDrag(hp, x, y) {
  if (!gest || gest.type !== 'pending') return;
  pushUndo();
  gest.type = 'drag';
  dragPt = hp;
  const s = toScreen(hp);
  gest.off = { x: s.x - x, y: s.y - y };
  selId = hp.id; updatePanelVisibility();
  try { navigator.vibrate && navigator.vibrate(15); } catch (e) { }
  req();
}
function endDrag() { dragPt = null; fadeGuides(); save(); req(); }

/* ---------------- Valgt punkt ---------------- */
function select(id) { selId = id; updatePanelVisibility(); req(); }
function updatePanelVisibility() {
  const on = !!(selId && P && P.points.find(p => p.id === selId));
  const el = $('#sel');
  if (el.classList.contains('on') !== on) { el.classList.toggle('on', on); requestAnimationFrame(resize); }
}
function updatePanel() {
  if (!selId) return;
  const i = P.points.findIndex(p => p.id === selId);
  if (i < 0) return;
  const p = P.points[i], d = dimsOf(p);
  $('#selTitle').textContent = `#${i + 1} ${(TYPES[p.type] || TYPES.downlight).name}`;
  const xv = d.xs ? fmt(dist(d, d.xs)) : '–', yv = d.ys ? fmt(dist(d, d.ys)) : '–';
  const xs = d.xs ? `${SIDE_ARW[d.xs]} ${SIDE_TXT[d.xs]}${p.lockX ? ' 🔒' : ''}` : 'ingen vegg funnet';
  const ys = d.ys ? `${SIDE_ARW[d.ys]} ${SIDE_TXT[d.ys]}${p.lockY ? ' 🔒' : ''}` : 'ingen vegg funnet';
  if ($('#selXv').textContent !== xv) $('#selXv').textContent = xv;
  if ($('#selYv').textContent !== yv) $('#selYv').textContent = yv;
  if ($('#selXs').textContent !== xs) $('#selXs').textContent = xs;
  if ($('#selYs').textContent !== ys) $('#selYs').textContent = ys;
}
$('#selClose').onclick = () => select(null);
$('#selDel').onclick = () => {
  pushUndo();
  P.points = P.points.filter(p => p.id !== selId);
  select(null); save();
};
$('#selX').onclick = () => { const p = P.points.find(q => q.id === selId); if (p) editDim(p, 'x'); };
$('#selY').onclick = () => { const p = P.points.find(q => q.id === selId); if (p) editDim(p, 'y'); };

/* ---------------- Angre / lagre ---------------- */
function clean(p) { const { _d, ...r } = p; return r; }
function pushUndo() {
  undoStack.push(JSON.stringify({ p: P.points.map(clean), e: P.eq || null }));
  if (undoStack.length > 60) undoStack.shift();
}
$('#undoBtn').onclick = () => {
  if (!undoStack.length) { toast('Ingenting å angre'); return; }
  const st = JSON.parse(undoStack.pop());
  P.points = st.p;
  if (st.e && doc && doc.kind === 'dxf') { P.eq = st.e; buildItems(); if (eqSel && !EQ.items.find(i => i.key === eqSel && !i.del)) eqSel = null; updateEqBar(); }
  if (selId && !P.points.find(p => p.id === selId)) selId = null;
  updatePanelVisibility(); save(); req();
};
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  updateTitle();
  const proj = P;
  saveTimer = setTimeout(() => {
    proj.updated = Date.now();
    store.put({ ...proj, points: proj.points.map(clean) }).catch(err => toast('Kunne ikke lagre: ' + err));
  }, 300);
}
function flushSave() {
  if (!P) return Promise.resolve();
  clearTimeout(saveTimer);
  P.updated = Date.now();
  return store.put({ ...P, points: P.points.map(clean) }).catch(() => { });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

/* ---------------- Dialoger ---------------- */
let dlgClose = null;
function dialog(html, setup) {
  const m = $('#modal'), d = $('#dlg');
  delete d.dataset.lock;
  d.innerHTML = html;
  m.classList.add('on');
  const close = () => { m.classList.remove('on'); d.innerHTML = ''; dlgClose = null; };
  dlgClose = close;
  if (setup) setup(d, close);
  return close;
}
$('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal' && !$('#dlg').dataset.lock && dlgClose) dlgClose(); });
function confirmDlg(title, text, okTxt, cb, danger) {
  dialog(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="btns"><button data-x>Avbryt</button><button class="${danger ? 'danger' : 'primary'}" data-ok>${esc(okTxt)}</button></div>`,
    (d, close) => { $('[data-x]', d).onclick = close; $('[data-ok]', d).onclick = () => { close(); cb(); }; });
}
function promptDlg(title, label, value, cb) {
  dialog(`<h2>${esc(title)}</h2><label class="f">${esc(label)}</label><input id="pIn" value="${esc(value)}"><div class="btns"><button data-x>Avbryt</button><button class="primary" data-ok>OK</button></div>`,
    (d, close) => {
      const inp = $('#pIn', d); setTimeout(() => { inp.focus(); inp.select(); }, 50);
      const ok = () => { const v = inp.value.trim(); if (v) { close(); cb(v); } };
      $('[data-x]', d).onclick = close; $('[data-ok]', d).onclick = ok;
      inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
    });
}
let toastT = 0;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2400); }
function setBanner(txt, btnTxt, onBtn) {
  const b = $('#banner');
  if (!txt) { b.classList.remove('on'); return; }
  $('#bannerTxt').textContent = txt;
  if (btnTxt !== undefined) {
    $('#bannerBtn').textContent = btnTxt;
    $('#bannerBtn').onclick = onBtn;
  }
  b.classList.add('on');
}
function parseNum(s) { const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return isFinite(v) ? v : NaN; }

/* Skriv inn mål */
function editDim(p, axis) {
  if (!P.mmPerUnit) { askScale(); return; }
  const d = dimsOf(p);
  const sides = axis === 'x' ? ['L', 'R'] : ['U', 'D'];
  let side = (axis === 'x' ? d.xs : d.ys) || sides.find(s => dist(d, s) != null);
  if (!side) { toast('Fant ingen vegg i ' + (axis === 'x' ? 'X' : 'Y') + '-retning'); return; }
  const btn = s => {
    const v = dist(d, s);
    return `<button data-side="${s}" ${v == null ? 'disabled' : ''}>${SIDE_ARW[s]} ${SIDE_TXT[s].replace('fra ', 'Fra ')}<small>${v == null ? 'ingen vegg' : fmt(v) + ' mm'}</small></button>`;
  };
  dialog(`<h2>${axis === 'x' ? 'X-mål ↔' : 'Y-mål ↕'} – punkt ${P.points.indexOf(p) + 1}</h2>
    <div class="seg">${btn(sides[0])}${btn(sides[1])}</div>
    <label class="f">Avstand i mm</label>
    <input id="dIn" class="bigin" inputmode="decimal" autocomplete="off">
    <div class="btns">
      <button class="ghost" data-auto>Nærmeste vegg (auto)</button>
      <button data-x>Avbryt</button><button class="primary" data-ok>Flytt</button>
    </div>`, (el, close) => {
    const inp = $('#dIn', el);
    const setSide = s => {
      side = s;
      el.querySelectorAll('[data-side]').forEach(b => b.classList.toggle('on', b.dataset.side === s));
      inp.value = fmt(dist(d, s));
    };
    setSide(side);
    el.querySelectorAll('[data-side]').forEach(b => b.onclick = () => { setSide(b.dataset.side); inp.focus(); inp.select(); });
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
    const ok = () => {
      const v = parseNum(inp.value);
      if (!(v > 0)) { inp.focus(); return; }
      pushUndo();
      const cur = dist(d, side), delta = v / P.mmPerUnit - cur;
      if (side === 'L') p.x += delta; else if (side === 'R') p.x -= delta;
      else if (side === 'U') p.y += delta; else p.y -= delta;
      if (axis === 'x') p.lockX = side; else p.lockY = side;
      p._d = null;
      close(); save(); req();
    };
    $('[data-ok]', el).onclick = ok;
    inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
    $('[data-x]', el).onclick = close;
    $('[data-auto]', el).onclick = () => {
      pushUndo();
      if (axis === 'x') p.lockX = null; else p.lockY = null;
      p._d = null; close(); save(); req();
    };
  });
}

/* Avstand c/c mellom to punkter på linje */
function editSpacing(p, q, side) {
  const horiz = side === 'L' || side === 'R';
  const cur = horiz ? Math.abs(q.x - p.x) : Math.abs(q.y - p.y);
  select(p.id);
  dialog(`<h2>Avstand c/c</h2><p>Fra punkt ${P.points.indexOf(q) + 1} til punkt ${P.points.indexOf(p) + 1}. Punkt ${P.points.indexOf(p) + 1} flyttes.</p>
    <label class="f">Avstand i mm</label><input id="sIn" class="bigin" inputmode="decimal" value="${fmt(cur)}">
    <div class="btns"><button data-x>Avbryt</button><button class="primary" data-ok>Flytt</button></div>`, (el, close) => {
    const inp = $('#sIn', el); setTimeout(() => { inp.focus(); inp.select(); }, 60);
    const ok = () => {
      const v = parseNum(inp.value);
      if (!(v > 0)) return;
      pushUndo();
      const d = v / P.mmPerUnit;
      if (horiz) p.x = q.x + (side === 'L' ? d : -d); else p.y = q.y + (side === 'U' ? d : -d);
      p._d = null; close(); save(); req();
    };
    $('[data-ok]', el).onclick = ok; inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
    $('[data-x]', el).onclick = close;
  });
}

/* Rad med punkter */
function startRow() {
  if (!P.mmPerUnit) { askScale(); return; }
  mode = 'row'; rowPts = []; rowPreview = null; select(null);
  $('#rowBtn').classList.add('on');
  setBanner(`Rad (${(TYPES[curType] || TYPES.downlight).name}): trykk der raden starter`, 'Avbryt', endRow);
  req();
}
function endRow() {
  mode = 'edit'; rowPts = []; rowPreview = null;
  $('#rowBtn').classList.remove('on');
  setBanner(null); req();
}
function rowDialog() {
  const mpu = P.mmPerUnit;
  let [A, B] = rowPts;
  const ang = Math.atan2(B.y - A.y, B.x - A.x);
  if (Math.abs(Math.sin(ang)) < 0.14) B = { x: B.x, y: A.y };
  else if (Math.abs(Math.cos(ang)) < 0.14) B = { x: A.x, y: B.y };
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  if (L * mpu < 100) { toast('For kort rad'); endRow(); return; }
  const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
  const axH = Math.abs(uy) < 1e-9, axV = Math.abs(ux) < 1e-9;
  let W = null;
  if (axH || axV) {
    const M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const back = doc.ray(M.x, M.y, axH ? (ux > 0 ? 'L' : 'R') : (uy > 0 ? 'U' : 'D'), mpu);
    const fwd = doc.ray(M.x, M.y, axH ? (ux > 0 ? 'R' : 'L') : (uy > 0 ? 'D' : 'U'), mpu);
    if (back != null && fwd != null) W = { s: { x: M.x - ux * back, y: M.y - uy * back }, len: back + fwd };
  }
  let rmode = 'n';
  const calc = (val, walls) => {
    let n, c, m = null, pts = [];
    if (walls && W) {
      if (rmode === 'n') { n = Math.max(1, Math.round(val)); c = W.len / n; }
      else { c = val / mpu; n = Math.max(1, Math.floor(W.len / c + 1e-9)); }
      m = (W.len - (n - 1) * c) / 2;
      for (let i = 0; i < n; i++) pts.push({ x: W.s.x + ux * (m + i * c), y: W.s.y + uy * (m + i * c) });
    } else {
      if (rmode === 'n') { n = Math.max(2, Math.round(val)); c = L / (n - 1); }
      else { c = val / mpu; n = Math.floor(L / c + 1e-9) + 1; }
      for (let i = 0; i < n; i++) pts.push({ x: A.x + ux * i * c, y: A.y + uy * i * c });
    }
    return { pts, n, c, m };
  };
  dialog(`<h2>Rad med ${esc((TYPES[curType] || TYPES.downlight).name.toLowerCase())}</h2>
    <div class="seg"><button data-m="n" class="on">Antall</button><button data-m="cc">Avstand c/c</button></div>
    <input id="rIn" class="bigin" inputmode="decimal" value="3">
    <label class="setrow" style="margin-top:12px"><span>Fordel mellom veggene<br><small style="color:var(--muted)">${W ? 'Halv avstand inn mot vegg' : 'Ingen vegger funnet langs raden'}</small></span>
      <input type="checkbox" id="rW" ${W ? 'checked' : 'disabled'} style="width:24px;height:24px"></label>
    <p id="rSum" style="color:var(--text);font-weight:600"></p>
    <div class="btns"><button data-x>Avbryt</button><button class="primary" data-ok>Lag rad</button></div>`, (el, close) => {
    $('#dlg').dataset.lock = '1';
    const inp = $('#rIn', el), cb = $('#rW', el), sum = $('#rSum', el);
    const upd = () => {
      const v = parseNum(inp.value);
      if (!(v > 0)) { sum.textContent = ''; rowPreview = null; req(); return; }
      const r = calc(v, cb.checked);
      if (r.n > 200) { sum.textContent = 'For mange punkter'; rowPreview = null; req(); return; }
      sum.textContent = `${r.n} stk · c/c ${Math.round(r.c * mpu)} mm` + (r.m != null ? ` · ${Math.round(r.m * mpu)} mm fra vegg` : '');
      rowPreview = r.pts; req();
    };
    el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
      rmode = b.dataset.m;
      el.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b));
      inp.value = rmode === 'n' ? '3' : '1200'; upd(); inp.focus(); inp.select();
    });
    inp.oninput = upd; cb.onchange = upd;
    upd(); setTimeout(() => { inp.focus(); inp.select(); }, 60);
    const fin = () => { delete $('#dlg').dataset.lock; close(); endRow(); };
    $('[data-x]', el).onclick = fin;
    $('[data-ok]', el).onclick = () => {
      if (!rowPreview || !rowPreview.length) return;
      pushUndo();
      for (const q of rowPreview) P.points.push({ id: uid(), type: curType, x: q.x, y: q.y, lockX: null, lockY: null });
      const n = rowPreview.length;
      fin(); save(); toast(n + ' punkter lagt til');
    };
  });
}

/* Målestokk */
function askScale(onDone) {
  const isPdf = P.kind === 'pdf';
  if (!isPdf) { openSettings(); return; }
  const cur = P.scaleText && P.scaleText.startsWith('1:') ? P.scaleText.slice(2) : '50';
  const first = !P.mmPerUnit;
  dialog(`<h2>Målestokk</h2>
    <p>Gjelder når PDF-en er plottet i riktig papirstørrelse og målestokk (f.eks. A3 1:50). Er du usikker – kalibrer mot et kjent mål.</p>
    <div class="quick">${[20, 50, 100, 200].map(n => `<button data-n="${n}">1:${n}</button>`).join('')}</div>
    <label class="f">Målestokk 1 :</label>
    <input id="scIn" inputmode="decimal" value="${esc(cur)}">
    <div class="btns">
      <button data-cal>Kalibrer med to punkter</button>
      ${first ? '' : '<button data-x>Avbryt</button>'}
      <button class="primary" data-ok>OK</button>
    </div>`, (el, close) => {
    if (first) $('#dlg').dataset.lock = '1';
    const inp = $('#scIn', el);
    const fin = () => { delete $('#dlg').dataset.lock; close(); };
    el.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { inp.value = b.dataset.n; });
    $('[data-ok]', el).onclick = () => {
      const n = parseNum(inp.value);
      if (!(n > 0)) return;
      P.mmPerUnit = 25.4 / 72 * n; P.scaleText = '1:' + n;
      fin(); save(); updateTitle(); req(); onDone && onDone();
    };
    $('[data-cal]', el).onclick = () => { fin(); startCalib(); };
    const x = $('[data-x]', el); if (x) x.onclick = fin;
  });
}
function startCalib() {
  mode = 'calib'; calibPts = []; select(null);
  setBanner('Kalibrering: trykk på punkt 1 av 2 (zoom inn for nøyaktighet)', 'Avbryt', () => { mode = 'edit'; calibPts = []; setBanner(null); req(); if (!P.mmPerUnit) askScale(); });
  req();
}
function finishCalib() {
  const [a, b] = calibPts;
  const du = Math.hypot(a.x - b.x, a.y - b.y);
  dialog(`<h2>Kjent avstand</h2><p>Hvor langt er det mellom de to punktene i virkeligheten?</p>
    <label class="f">Avstand i mm</label><input id="cIn" class="bigin" inputmode="decimal">
    <div class="btns"><button data-x>Avbryt</button><button class="primary" data-ok>OK</button></div>`, (el, close) => {
    $('#dlg').dataset.lock = '1';
    const inp = $('#cIn', el); setTimeout(() => inp.focus(), 60);
    const end = () => { delete $('#dlg').dataset.lock; close(); mode = 'edit'; calibPts = []; setBanner(null); req(); };
    const ok = () => {
      const v = parseNum(inp.value);
      if (!(v > 0) || du <= 0) return;
      P.mmPerUnit = v / du; P.scaleText = 'kalibrert';
      end(); save(); updateTitle(); toast('Målestokk satt');
    };
    $('[data-ok]', el).onclick = ok;
    inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
    $('[data-x]', el).onclick = () => { end(); if (!P.mmPerUnit) askScale(); };
  });
}

/* Innstillinger */
function openSettings() {
  const isPdf = P.kind === 'pdf';
  const opt = (arr, cur) => arr.map(([v, t]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${t}</option>`).join('');
  dialog(`<h2>Innstillinger</h2>
    ${isPdf ? `<div class="setrow"><span>Målestokk<br><small style="color:var(--muted)">${esc(P.scaleText || '–')}</small></span><button data-scale>Endre</button></div>`
      : `<div class="setrow"><span>Enhet i DXF</span><select id="sUnit">${opt([['mm', 'mm'], ['cm', 'cm'], ['m', 'meter'], ['in', 'tommer'], ['ft', 'fot']], P.units)}</select></div>
         <div class="setrow"><span>Lag og vegger</span><button data-layers>Velg lag</button></div>`}
    <div class="setrow"><span>Steg ved flytting</span><select id="sSnap">${opt([[0, 'Av'], [1, '1 mm'], [5, '5 mm'], [10, '10 mm'], [50, '50 mm'], [100, '100 mm']], S.snap)}</select></div>
    <div class="setrow"><span>Vis mål</span><select id="sDims">${opt([['all', 'Alle punkter'], ['sel', 'Kun valgt']], S.dims)}</select></div>
    <div class="setrow"><span>Symbolstørrelse</span><input type="range" id="sSym" min="0.7" max="2" step="0.1" value="${S.sym}"></div>
    ${isPdf ? `<p style="margin-top:16px"><b style="color:var(--text)">Veggsøk i PDF</b><br>Målet går til første mørke strek. Juster hvis den stopper på feil streker.</p>
    <div class="setrow"><span>Mørkhetsgrense</span><input type="range" id="sThr" min="40" max="240" step="5" value="${S.thr}"></div>
    <div class="setrow"><span>Ignorer streker tynnere enn</span><select id="sMin">${opt([[0, 'Ingen'], [5, '5 mm'], [10, '10 mm'], [20, '20 mm'], [30, '30 mm'], [50, '50 mm']], S.minStroke)}</select></div>` : ''}
    <div class="btns"><button class="primary" data-x>Ferdig</button></div>`, (el, close) => {
    $('[data-x]', el).onclick = close;
    const sc = $('[data-scale]', el); if (sc) sc.onclick = () => { close(); askScale(); };
    const ly = $('[data-layers]', el); if (ly) ly.onclick = () => { close(); openLayers(); };
    const u = $('#sUnit', el); if (u) u.onchange = () => { P.units = u.value; P.mmPerUnit = UNITS[u.value]; save(); updateTitle(); req(); };
    $('#sSnap', el).onchange = e => { S.snap = +e.target.value; saveS(); };
    $('#sDims', el).onchange = e => { S.dims = e.target.value; saveS(); req(); };
    $('#sSym', el).oninput = e => { S.sym = +e.target.value; saveS(); req(); };
    const t = $('#sThr', el); if (t) t.oninput = () => { S.thr = +t.value; saveS(); invalidateDims(); req(); };
    const mn = $('#sMin', el); if (mn) mn.onchange = () => { S.minStroke = +mn.value; saveS(); invalidateDims(); req(); };
  });
}
function openLayers() {
  const L = doc.r.layers.filter(l => l.count > 0 || l.inserts > 0 || doc.r.texts.some(t => doc.r.layers[t.l] === l));
  const idx = l => doc.r.layers.indexOf(l);
  const rows = L.map(l => {
    const i = idx(l);
    return `<div class="lrow"><div class="n">${esc(l.name)} <small>(${l.count})</small></div>
      <button class="tog ${doc.show[i] ? 'on' : ''}" data-show="${i}">Vis</button>
      <button class="tog wall ${doc.wall[i] ? 'on' : ''}" data-wall="${i}">Vegg</button>
      ${l.inserts ? `<button class="tog ${doc.equip[i] ? 'on' : ''}" data-eq="${i}">Utstyr</button>` : ''}</div>`;
  }).join('');
  dialog(`<h2>Lag og vegger</h2><p>Mål tas til streker på lag merket <b>Vegg</b>. Symboler på lag merket <b>Utstyr</b> kan flyttes.</p>${rows}<div class="btns"><button class="primary" data-x>Ferdig</button></div>`, (el, close) => {
    const setCfg = (i, key, val) => {
      const n = doc.r.layers[i].name;
      P.layers = P.layers || {};
      P.layers[n] = Object.assign({ show: !!doc.show[i], wall: !!doc.wall[i], equip: !!doc.equip[i] }, P.layers[n] || {}, { [key]: val });
    };
    el.querySelectorAll('[data-show]').forEach(b => b.onclick = () => {
      const i = +b.dataset.show; setCfg(i, 'show', !doc.show[i]);
      doc.applyLayers(P); eqInit(); invalidateDims(); save(); req(); close(); openLayers();
    });
    el.querySelectorAll('[data-eq]').forEach(b => b.onclick = () => {
      const i = +b.dataset.eq; setCfg(i, 'equip', !doc.equip[i]);
      doc.applyLayers(P); eqInit(); invalidateDims(); save(); req(); close(); openLayers();
    });
    el.querySelectorAll('[data-wall]').forEach(b => b.onclick = () => {
      const i = +b.dataset.wall; setCfg(i, 'wall', !doc.wall[i]); if (!doc.show[i]) setCfg(i, 'show', true);
      doc.applyLayers(P); eqInit(); invalidateDims(); save(); req(); close(); openLayers();
    });
    $('[data-x]', el).onclick = close;
  });
}

/* Punktliste */
function lineText(p, i) {
  const d = dimsOf(p);
  const x = d.xs ? `${fmt(dist(d, d.xs))} mm ${SIDE_TXT[d.xs]}` : 'X: ingen vegg';
  const y = d.ys ? `${fmt(dist(d, d.ys))} mm ${SIDE_TXT[d.ys]}` : 'Y: ingen vegg';
  return `${i + 1}. ${(TYPES[p.type] || TYPES.downlight).name}: ${x}, ${y}`;
}
function openList() {
  if (!P.points.length) { toast('Ingen punkter ennå'); return; }
  const rows = P.points.map((p, i) => {
    const d = dimsOf(p);
    return `<tr data-id="${p.id}"><td><b>${i + 1}</b> ${esc((TYPES[p.type] || TYPES.downlight).name)}</td>
      <td class="v" style="color:#93c5fd">${d.xs ? SIDE_ARW[d.xs] + ' ' + fmt(dist(d, d.xs)) : '–'}</td>
      <td class="v" style="color:#f0abfc">${d.ys ? SIDE_ARW[d.ys] + ' ' + fmt(dist(d, d.ys)) : '–'}</td></tr>`;
  }).join('');
  dialog(`<h2>Punkter (${P.points.length})</h2><p>Mål i mm. Pil viser hvilken vegg det måles fra.</p>
    <table class="pl">${rows}</table>
    <div class="btns"><button data-copy>Kopier som tekst</button><button class="primary" data-x>Lukk</button></div>`, (el, close) => {
    el.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => {
      const p = P.points.find(q => q.id === tr.dataset.id); close();
      if (p) { select(p.id); const s = toScreen(p); view.tx += cw / 2 - s.x; view.ty += ch / 2 - s.y; afterView(); }
    });
    $('[data-copy]', el).onclick = async () => {
      const txt = P.name + '\n' + P.points.map(lineText).join('\n');
      try { await navigator.clipboard.writeText(txt); toast('Kopiert'); } catch (e) { toast('Kunne ikke kopiere'); }
    };
    $('[data-x]', el).onclick = close;
  });
}

/* Meny */
function openMenu() {
  const isPdf = P.kind === 'pdf';
  dialog(`<h2>${esc(P.name)}</h2><div class="menu">
    <button data-a="list">☰ Punktliste</button>
    <button data-a="fit">⤢ Tilpass visning</button>
    <button data-a="set">⚙ Innstillinger</button>
    ${isPdf ? '<button data-a="scale">📏 Målestokk / kalibrer</button>' : '<button data-a="layers">▤ Lag og vegger</button>'}
    <button data-a="exp">⬇ Eksporter (PDF${isPdf ? '' : ', DXF'} eller bilde)</button>
    <button data-a="bak">💾 Eksporter prosjekt (backup)</button>
    <button data-a="ren">✎ Gi nytt navn</button>
    ${eqActive() ? '<button data-a="eqreset" class="danger">Tilbakestill alt utstyr til prosjektert</button>' : '<button data-a="clr" class="danger">Slett alle punkter</button>'}
  </div><div class="btns"><button data-x>Lukk</button></div>`, (el, close) => {
    $('[data-x]', el).onclick = close;
    el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      close();
      const a = b.dataset.a;
      if (a === 'list') openList();
      else if (a === 'fit') fitView();
      else if (a === 'set') openSettings();
      else if (a === 'scale') askScale();
      else if (a === 'layers') openLayers();
      else if (a === 'exp') openExport();
      else if (a === 'bak') exportBackup(P);
      else if (a === 'ren') promptDlg('Gi nytt navn', 'Navn', P.name, v => { P.name = v; updateTitle(); save(); });
      else if (a === 'eqreset') confirmDlg('Tilbakestille utstyr?', `${changeCount()} endringer forkastes (kan angres).`, 'Tilbakestill', () => { pushUndo(); P.eq = { edits: {}, added: [] }; buildItems(); eqSel = null; updateEqBar(); save(); req(); }, true);
      else if (a === 'clr') confirmDlg('Slette alle punkter?', `${P.points.length} punkter fjernes (kan angres).`, 'Slett', () => { pushUndo(); P.points = []; select(null); save(); }, true);
    });
  });
}

/* Eksport */
async function shareOrDownload(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Lastet ned ' + filename);
}
function safeName(s) { return s.replace(/[^\wæøåÆØÅ\- ]+/g, '').trim().replace(/\s+/g, '_') || 'plan'; }
function renderExportCanvas(maxSide, footer, area) {
  const b = area || doc.bounds, bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  maxSide = maxSide || 3600;
  let s = maxSide / Math.max(bw, bh);
  if (doc.kind === 'pdf') s = Math.min(s, doc.b * 1.5);
  const W = Math.round(bw * s), H = Math.round(bh * s);
  const c = document.createElement('canvas'); c.width = W; c.height = H + (footer === false ? 0 : Math.round(60 * W / 1800));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  const v = { s, tx: -b.x0 * s, ty: -b.y0 * s };
  const k = Math.max(1, Math.max(W, H) / 1500) * S.sym;
  doc.draw(ctx, v, 1, { main: false, k: 1, export: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const saveLabels = labels;
  if (edMode === 'mal' || doc.kind !== 'dxf') drawOverlay(ctx, v, { export: true, k });
  labels = saveLabels;
  if (footer === false) return c;
  // bunntekst
  const fh = Math.round(18 * W / 1800);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, H, W, c.height - H);
  ctx.fillStyle = '#111'; ctx.font = `600 ${fh}px system-ui`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const foot = eqActive() ? `${P.name} – installasjonstegning – ${new Date().toLocaleDateString('no-NO')}` : `${P.name} – ${P.points.length} punkter – mål i mm til vegg (blå = X, lilla = Y) – ${new Date().toLocaleDateString('no-NO')}`;
  ctx.fillText(foot, fh, H + (c.height - H) / 2);
  return c;
}
function exportImage() {
  const c = renderExportCanvas();
  c.toBlob(blob => { if (blob) shareOrDownload(blob, safeName(P.name) + (eqActive() ? '_installasjon.png' : '_takpunkter.png'), P.name); else toast('Bildet ble for stort'); }, 'image/png');
}
function blobToB64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
}
async function exportBackup(proj) {
  if (proj === P) await flushSave();
  const blob = await store.getFile(proj.id);
  const data = { format: 'takpunkter', version: 1, project: { ...proj, points: proj.points.map(clean) }, file: blob ? await blobToB64(blob) : null, fileType: blob ? blob.type : null };
  await shareOrDownload(new Blob([JSON.stringify(data)], { type: 'application/json' }), safeName(proj.name) + '.takp', proj.name);
}

/* ---------------- Prosjekter ---------------- */
async function renderHome() {
  const list = (await store.all()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const el = $('#plist');
  if (!list.length) { el.innerHTML = '<div class="empty">Ingen tegninger ennå.</div>'; return; }
  el.innerHTML = list.map(p => `<div class="card" data-id="${p.id}">
      <div class="ic">${p.kind.toUpperCase()}</div>
      <div class="t"><b>${esc(p.name)}</b><small>${p.points.length} punkter · ${new Date(p.updated || p.created).toLocaleDateString('no-NO')}</small></div>
      <button data-more="${p.id}">⋯</button></div>`).join('');
  el.querySelectorAll('.card').forEach(c => c.onclick = e => {
    if (e.target.dataset.more) return;
    const p = list.find(q => q.id === c.dataset.id); if (p) openProject(p);
  });
  el.querySelectorAll('[data-more]').forEach(b => b.onclick = () => {
    const p = list.find(q => q.id === b.dataset.more);
    dialog(`<h2>${esc(p.name)}</h2><div class="menu">
      <button data-a="ren">✎ Gi nytt navn</button><button data-a="bak">💾 Eksporter backup</button>
      <button data-a="del" class="danger">Slett tegning</button></div><div class="btns"><button data-x>Lukk</button></div>`, (el2, close) => {
      $('[data-x]', el2).onclick = close;
      el2.querySelectorAll('[data-a]').forEach(x => x.onclick = () => {
        close();
        if (x.dataset.a === 'ren') promptDlg('Gi nytt navn', 'Navn', p.name, async v => { p.name = v; await store.put(p); renderHome(); });
        if (x.dataset.a === 'bak') exportBackup(p);
        if (x.dataset.a === 'del') confirmDlg('Slette tegning?', `«${p.name}» og alle punktene slettes fra telefonen.`, 'Slett', async () => { await store.del(p.id); renderHome(); }, true);
      });
    });
  });
}

function show(id) { document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === id)); }
function updateTitle() {
  if (!P) return;
  const sub = P.kind === 'pdf' ? `PDF · ${P.scaleText ? (P.scaleText === 'kalibrert' ? 'kalibrert' : 'målestokk ' + P.scaleText) : 'mangler målestokk'}` : `DXF · ${P.units}`;
  let tail = P.points.length ? P.points.length + ' punkter' : 'trykk for å plassere';
  if (typeof eqActive === 'function' && eqActive()) { const n = changeCount(); tail = n ? n + ' endringer' : 'hold inne for å flytte'; }
  $('#edTitle').innerHTML = `${esc(P.name)}<small>${esc(sub)} · ${esc(tail)}</small>`;
}

async function openProject(p, fresh) {
  P = p; doc = null; selId = null; undoStack = []; mode = 'edit'; calibPts = [];
  P.points.forEach(q => q._d = null);
  show('ed'); setBanner(null); updatePanelVisibility(); updateTitle();
  try { history.pushState({ ed: 1 }, ''); } catch (e) { }
  $('#loading').classList.add('on');
  requestAnimationFrame(resize);
  try {
    const blob = await store.getFile(p.id);
    if (!blob) throw new Error('Fant ikke filen');
    if (p.kind === 'pdf') doc = await PdfDoc.load(blob, p.page);
    else doc = DxfDoc.load(DXF.decodeBytes(await blob.arrayBuffer()), p);
  } catch (e) {
    $('#loading').classList.remove('on');
    toast('Kunne ikke åpne: ' + (e.message || e));
    closeEditor(); return;
  }
  $('#loading').classList.remove('on');
  $('#modeSeg').classList.toggle('on', doc.kind === 'dxf');
  eqSel = null; eqArm = null;
  if (doc.kind === 'dxf') eqInit();
  edMode = 'mal'; setEdMode('mal');
  resize();
  let v = null;
  try { v = JSON.parse(localStorage.getItem('tp-view-' + p.id) || 'null'); } catch (e) { }
  if (v && v.s > 0 && !fresh) { Object.assign(view, v); afterView(); } else fitView();
  if (!P.mmPerUnit) askScale();
  else if (fresh && !P.points.length) toast('Trykk på tegningen for å plassere');
}
async function closeEditor() {
  await flushSave();
  if (doc && doc.pdf) try { doc.pdf.destroy(); } catch (e) { }
  P = null; doc = null; selId = null; setBanner(null); eqSel = null; eqArm = null;
  $('#eqbar').classList.remove('on'); $('#modeSeg').classList.remove('on'); $('#tools').classList.remove('eq');
  show('home'); renderHome();
}
$('#backBtn').onclick = () => { if (history.state && history.state.ed) history.back(); else closeEditor(); };
window.addEventListener('popstate', () => { if (dlgClose) { dlgClose(); try { history.pushState({ ed: 1 }, ''); } catch (e) { } return; } if (P) closeEditor(); });
$('#menuBtn').onclick = () => P && openMenu();
$('#listBtn').onclick = () => P && openList();

/* Verktøylinje */
function buildChips() {
  const el = $('#chips');
  el.innerHTML = Object.entries(TYPES).map(([k, t]) => `<button class="chip ${k === curType ? 'on' : ''}" data-t="${k}"><canvas width="40" height="40"></canvas>${t.name}</button>`).join('');
  el.querySelectorAll('.chip').forEach(b => {
    const c = $('canvas', b).getContext('2d');
    c.translate(20, 20); c.lineWidth = 3.5; c.strokeStyle = TYPES[b.dataset.t].color; c.fillStyle = '#fff';
    TYPES[b.dataset.t].draw(c, 14);
    b.onclick = () => {
      curType = b.dataset.t;
      el.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
      if (selId) { const p = P.points.find(q => q.id === selId); if (p && p.type !== curType) { pushUndo(); p.type = curType; save(); req(); } }
      if (!placing) setPlacing(true);
    };
  });
}
function setPlacing(on) {
  placing = on;
  const b = $('#placeBtn');
  b.classList.toggle('on', on);
  b.textContent = on ? '＋ Plasser' : '✋ Se';
}
$('#rowBtn').onclick = () => { if (mode === 'row') endRow(); else startRow(); };
$('#placeBtn').onclick = () => { setPlacing(!placing); toast(placing ? 'Trykk på tegningen for å plassere' : 'Plassering av – trykk velger bare'); };

/* ---------------- Innlasting av fil ---------------- */
$('#newBtn').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) handleFile(f);
};
async function handleFile(f) {
  const name = f.name.replace(/\.[^.]+$/, '');
  const ext = (f.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
  try {
    if (ext === 'dwg') {
      dialog(`<h2>DWG støttes ikke direkte</h2><p>DWG er et lukket format som ikke kan leses i nettleseren. Åpne tegningen i AutoCAD LT og velg <b>Lagre som → AutoCAD 2018 DXF</b> (eller kommandoen DXFOUT), og last inn DXF-filen her.</p><p>Alternativt: plott til PDF i riktig målestokk.</p><div class="btns"><button class="primary" data-x>OK</button></div>`,
        (el, close) => { $('[data-x]', el).onclick = close; });
      return;
    }
    if (ext === 'takp' || ext === 'json') { await importBackup(f); return; }
    const head = new Uint8Array(await f.slice(0, 5).arrayBuffer());
    const isPdf = ext === 'pdf' || (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46);
    if (isPdf) {
      const data = new Uint8Array(await f.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data: data.slice(), isEvalSupported: false }).promise;
      const n = pdf.numPages; pdf.destroy();
      const create = async page => {
        const p = { id: uid(), name: n > 1 ? `${name} (s. ${page})` : name, kind: 'pdf', fileName: f.name, page, mmPerUnit: null, scaleText: null, points: [], created: Date.now(), updated: Date.now() };
        await store.putFile(p.id, new Blob([data], { type: 'application/pdf' }));
        await store.put(p);
        openProject(p, true);
      };
      if (n > 1) {
        dialog(`<h2>Velg side</h2><p>PDF-en har ${n} sider.</p><div class="quick">${Array.from({ length: Math.min(n, 60) }, (_, i) => `<button data-p="${i + 1}">Side ${i + 1}</button>`).join('')}</div><div class="btns"><button data-x>Avbryt</button></div>`,
          (el, close) => {
            $('[data-x]', el).onclick = close;
            el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { close(); create(+b.dataset.p); });
          });
      } else await create(1);
      return;
    }
    if (ext === 'dxf' || ext === '') {
      const buf = await f.arrayBuffer();
      const hb = new Uint8Array(buf.slice(0, 22));
      if (String.fromCharCode(...hb).startsWith('AutoCAD Binary DXF')) throw new Error('Binær DXF støttes ikke – lagre som ASCII DXF');
      const r = DXF.parseDXF(DXF.decodeBytes(buf));
      if (!r.segs.n) throw new Error('Fant ingen linjer i DXF-filen');
      const unitMap = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
      let units = unitMap[r.insunits];
      if (!units) { const w = r.bounds ? r.bounds.x1 - r.bounds.x0 : 0; units = w > 300 ? 'mm' : 'm'; }
      const layers = {};
      const wallLs = r.layers.filter(l => l.count > 0 && !l.off && WALL_RE.test(l.name));
      r.layers.forEach(l => {
        layers[l.name] = { show: !l.off, wall: wallLs.length ? wallLs.includes(l) : (!l.off && l.count > 0) };
      });
      const p = { id: uid(), name, kind: 'dxf', fileName: f.name, units, mmPerUnit: UNITS[units], layers, points: [], created: Date.now(), updated: Date.now() };
      await store.putFile(p.id, new Blob([buf], { type: 'application/octet-stream' }));
      await store.put(p);
      await openProject(p, true);
      toast(wallLs.length ? `Vegglag: ${wallLs.map(l => l.name).join(', ')}` : 'Alle lag brukes som vegger – velg vegglag i menyen');
      return;
    }
    throw new Error('Ukjent filtype: .' + ext);
  } catch (err) {
    console.error(err);
    dialog(`<h2>Kunne ikke lese filen</h2><p>${esc(err.message || err)}</p><div class="btns"><button class="primary" data-x>OK</button></div>`, (el, close) => { $('[data-x]', el).onclick = close; });
  }
}
async function importBackup(f) {
  const data = JSON.parse(await f.text());
  if (data.format !== 'takpunkter' || !data.project) throw new Error('Ikke en Takpunkter-backup');
  const p = { ...data.project, id: uid(), updated: Date.now() };
  if (data.file) {
    const bin = atob(data.file), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    await store.putFile(p.id, new Blob([u8], { type: data.fileType || 'application/octet-stream' }));
  }
  await store.put(p);
  toast('Importert: ' + p.name);
  renderHome();
}

/* Dra og slipp (PC) */
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && !P) handleFile(f); });

/* ---------------- PWA ---------------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').style.display = ''; });
$('#installBtn').onclick = async () => {
  if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#installBtn').style.display = 'none'; }
};
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (!standalone && /iP(hone|ad|od)/.test(navigator.userAgent)) {
  $('#homeHint').insertAdjacentHTML('beforeend', '<br><br><b>Installer på iPhone:</b> Del-knappen → «Legg til på Hjem-skjerm».');
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}

/* ---------------- Start ---------------- */
(async function init() {
  buildChips();
  try {
    await store.open();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
    await renderHome();
  } catch (e) {
    $('#plist').innerHTML = '<div class="empty">Lagring er ikke tilgjengelig i denne nettleseren (privat modus?).</div>';
  }
})();
