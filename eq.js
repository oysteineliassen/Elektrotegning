'use strict';
/* Utstyrsmodus: flytt, legg til og fjern elektroutstyr (blokker) i DXF-tegninger.
   Veggmonterte symboler fester seg til nærmeste vegg og roteres automatisk. */

let edMode = 'mal';
const EQ = { items: [], info: {} };
let eqSel = null, eqArm = null;
let eqTool = 'sel', runStart = null, runSel = null;

/* ---------- Symbolbibliotek (blokker som ikke finnes i tegningen) ----------
   Koordinater i mm, y opp, veggen i origo og symbolet ut fra veggen (+y) – som E_BRYTER. */
const LIB = [
  { name: 'E_DIMMER', like: /bryter|switch/i, ents: [
    { t: 'L', a: [0, 0], b: [0, 50] }, { t: 'C', c: [0, 100], r: 50 },
    { t: 'L', a: [30, 140], b: [75, 240] }, { t: 'L', a: [75, 240], b: [135, 205] },
    { t: 'P', pts: [[20, 210], [20, 168], [100, 172]], closed: true }] },
  { name: 'E_TERMOSTAT', like: /bryter|switch/i, ents: [
    { t: 'L', a: [0, 0], b: [0, 40] },
    { t: 'P', pts: [[-75, 40], [75, 40], [75, 190], [-75, 190]], closed: true },
    { t: 'T', p: [0, 115], h: 60, s: '°C' }] }
];
const f6 = v => String(Math.round(v * 1e6) / 1e6);
function libPairs(e) {
  if (e.t === 'L') return { type: 'LINE', pairs: [[100, 'AcDbEntity'], [8, '0'], [100, 'AcDbLine'], [10, f6(e.a[0])], [20, f6(e.a[1])], [30, '0'], [11, f6(e.b[0])], [21, f6(e.b[1])], [31, '0']] };
  if (e.t === 'C') return { type: 'CIRCLE', pairs: [[100, 'AcDbEntity'], [8, '0'], [100, 'AcDbCircle'], [10, f6(e.c[0])], [20, f6(e.c[1])], [30, '0'], [40, f6(e.r)]] };
  if (e.t === 'P') {
    const p = [[100, 'AcDbEntity'], [8, '0'], [100, 'AcDbPolyline'], [90, String(e.pts.length)], [70, e.closed ? '1' : '0']];
    for (const q of e.pts) p.push([10, f6(q[0])], [20, f6(q[1])]);
    return { type: 'LWPOLYLINE', pairs: p };
  }
  return { type: 'TEXT', pairs: [[100, 'AcDbEntity'], [8, '0'], [100, 'AcDbText'], [10, f6(e.p[0])], [20, f6(e.p[1])], [30, '0'], [40, f6(e.h)], [1, e.s], [72, '1'], [11, f6(e.p[0])], [21, f6(e.p[1])], [31, '0'], [100, 'AcDbText'], [73, '2']] };
}
let LIBP = null;
function libGeom(name) {
  if (!LIB.some(b => b.name === name)) return null;
  if (!LIBP) {
    const L = ['0', 'SECTION', '2', 'BLOCKS'];
    for (const b of LIB) {
      L.push('0', 'BLOCK', '2', b.name, '10', '0', '20', '0');
      for (const e of b.ents) { const q = libPairs(e); L.push('0', q.type); for (const [c, v] of q.pairs) L.push(String(c), v); }
      L.push('0', 'ENDBLK');
    }
    L.push('0', 'ENDSEC', '0', 'EOF');
    LIBP = DXF.parseDXF(L.join('\n'));
  }
  return LIBP.blockGeom(name);
}
function libDef(name) { return LIB.find(b => b.name === name); }

function eqActive() { return edMode === 'utstyr' && doc && doc.kind === 'dxf'; }

/* ---------- Oppbygging ---------- */
function eqInit() {
  if (!doc || doc.kind !== 'dxf') return;
  P.eq = P.eq || { edits: {}, added: [] };
  buildItems();
  learnBlocks();
  buildPalette();
}
function layerIndex(name) { return doc.r.layers.findIndex(l => l.name === name); }
function buildItems() {
  const r = doc.r, mpu = P.mmPerUnit || 1;
  EQ.items = [];
  for (const t of r.texts) t.item = null;
  for (const ins of r.inserts) {
    if (!doc.eqIns[ins.idx]) continue;
    const e = P.eq.edits[ins.idx] || {};
    EQ.items.push({
      key: 'i' + ins.idx, idx: ins.idx, block: ins.block, layer: ins.layer, li: ins.li,
      ox: ins.x, oy: ins.y, or: ins.r, sx: ins.sx, sy: ins.sy,
      x: e.x ?? ins.x, y: e.y ?? ins.y, r: e.r ?? ins.r, del: !!e.del, added: false, labels: [], stackOn: e.stackOn || null
    });
  }
  for (const a of P.eq.added) {
    EQ.items.push({ key: 'a' + a.id, id: a.id, idx: null, block: a.block, layer: a.layer, li: Math.max(0, layerIndex(a.layer)),
      x: a.x, y: a.y, r: a.r, ox: a.x, oy: a.y, or: a.r, sx: a.sx || 1, sy: a.sy || 1, tmpl: a.tmpl, del: false, added: true, labels: [], stackOn: a.stackOn || null });
  }
  // knytt løse tekster (f.eks. «o/benk», «?») til nærmeste utstyr
  const orig = EQ.items.filter(i => !i.added), lim = 700 / mpu;
  for (const t of r.texts) {
    if (!t.rec || t.ins !== -1) continue;
    const ln = r.layers[t.l];
    if (!(doc.equip[t.l] || /tekst|text|^e[-_ .]/i.test(ln.name))) continue;
    let best = null, bd = lim;
    for (const it of orig) { const d = Math.hypot(it.ox - t.x, it.oy - t.y); if (d < bd) { bd = d; best = it; } }
    if (best) { t.item = best.key; best.labels.push(t); }
  }
  // antall uttak (tallet ved stikkontakten)
  EQ.num = {};
  for (const it of EQ.items) {
    it.numLabel = it.labels.find(t => /^\d+$/.test(t.s.trim())) || null;
    if (it.added) { const a = P.eq.added.find(q => q.id === it.id); it.n = a && a.n != null ? a.n : 1; it.n0 = it.n; continue; }
    it.n0 = it.numLabel ? parseInt(it.numLabel.s, 10) : 1;
    const e = P.eq.edits[it.idx];
    it.n = e && e.n != null ? e.n : it.n0;
    if (it.numLabel) {
      const N = EQ.num[it.block] || (EQ.num[it.block] = { counts: {} });
      if (!N.t) {
        const t = it.numLabel, dx = t.x - it.ox, dy = t.y - it.oy, c = Math.cos(-it.or), sn = Math.sin(-it.or);
        N.t = t; N.lx = c * dx - sn * dy; N.ly = sn * dx + c * dy;
      }
      N.counts[it.n0] = (N.counts[it.n0] || 0) + 1;
    }
  }
  P.eq.runs = P.eq.runs || [];
  resolveStacks();
}
function countable(block) { return !!(EQ.num && EQ.num[block]) || /stikk|socket|uttak/i.test(block); }
function defaultN(block) {
  const N = EQ.num && EQ.num[block];
  if (N) return +Object.entries(N.counts).sort((a, b) => b[1] - a[1])[0][0];
  return countable(block) ? 2 : 1;
}
function numPos(it) {
  const N = EQ.num[it.block];
  const c = Math.cos(it.r), sn = Math.sin(it.r);
  return { x: it.x + c * N.lx - sn * N.ly, y: it.y + sn * N.lx + c * N.ly };
}
function itemCenter(it, useOrig) {
  const g = doc.geom(it.block);
  const x = useOrig ? it.ox : it.x, y = useOrig ? it.oy : it.y, r = useOrig ? it.or : it.r;
  if (!g) return { x, y };
  const cx = g.cx * it.sx, cy = g.cy * it.sy, c = Math.cos(r), s = Math.sin(r);
  return { x: x + c * cx - s * cy, y: y + s * cx + c * cy };
}
function circMean(a) { let sx = 0, sy = 0; for (const v of a) { sx += Math.cos(v); sy += Math.sin(v); } return Math.atan2(sy, sx); }
function median(a) { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; }
function learnBlocks() {
  const mpu = P.mmPerUnit || 1, lim = 500 / mpu, acc = {};
  for (const it of EQ.items) {
    if (it.added) continue;
    const m = acc[it.block] || (acc[it.block] = { n: 0, angs: [], offs: [] });
    m.n++;
    const w = doc.nearestWall(it.ox, it.oy, lim, -1);
    if (!w) continue;
    let tx, ty;
    if (w.d > 5 / mpu) { tx = -w.nx; ty = -w.ny; }
    else {
      const c = itemCenter(it, true), nx = -w.ty, ny = w.tx;
      const sgn = Math.sign((c.x - it.ox) * nx + (c.y - it.oy) * ny) || 1;
      tx = -sgn * nx; ty = -sgn * ny;
    }
    m.angs.push(Math.atan2(ty, tx) - it.or);
    m.offs.push(w.d);
  }
  EQ.info = {};
  for (const [b, m] of Object.entries(acc)) {
    const off = median(m.offs);
    EQ.info[b] = m.angs.length >= Math.max(1, m.n * 0.5) && (off * mpu <= 150 || WALLMOUNT_RE.test(b))
      ? { wall: true, local: circMean(m.angs), off }
      : { wall: false, local: Math.PI / 2, off: 0 };
  }
}
function infoOf(block) {
  if (!EQ.info[block] && libDef(block)) EQ.info[block] = { wall: true, local: Math.PI / 2, off: 0 };
  return EQ.info[block] || (EQ.info[block] = { wall: WALLMOUNT_RE.test(block), local: Math.PI / 2, off: 0 });
}
function isMoved(it) { return !it.added && (Math.abs(it.x - it.ox) > 1e-6 || Math.abs(it.y - it.oy) > 1e-6 || Math.abs(it.r - it.or) > 1e-6); }
function isChanged(it) { return isMoved(it) || (!it.added && (it.n !== it.n0 || !!it.stackOn)); }
function changeCount() { return EQ.items.filter(i => i.added || i.del || isChanged(i)).length + (P.eq.runs || []).length; }

/* ---------- Plassering med vegg-magnet ---------- */
function placeItem(it, ux, uy) {
  const info = infoOf(it.block), mpu = P.mmPerUnit || 1;
  if (!info.wall) { it.x = ux; it.y = uy; it.snap = -1; return; }
  const w = doc.nearestWall(ux, uy, Math.max(900 / mpu, 45 / view.s), it.snap ?? -1);
  if (!w) { it.x = ux; it.y = uy; it.snap = -1; return; }
  it.x = w.px + w.nx * info.off; it.y = w.py + w.ny * info.off;
  it.r = Math.atan2(-w.ny, -w.nx) - info.local;
  if (it.snap !== w.k && it.snap !== undefined) { try { navigator.vibrate && navigator.vibrate(8); } catch (e) { } }
  it.snap = w.k;
}
function commitItem(it) {
  if (it.added) {
    const a = P.eq.added.find(q => q.id === it.id);
    if (a) Object.assign(a, { x: it.x, y: it.y, r: it.r, n: it.n, stackOn: it.stackOn || undefined });
  } else if (it.del || isChanged(it)) P.eq.edits[it.idx] = { x: it.x, y: it.y, r: it.r, del: it.del || undefined, n: it.n !== it.n0 ? it.n : undefined, stackOn: it.stackOn || undefined };
  else delete P.eq.edits[it.idx];
}

/* ---------- Tegning ---------- */
function drawBlock(ctx, v, dpr, g, x, y, r, sx, sy, col, alpha, k) {
  ctx.save();
  ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
  ctx.translate(x, y); ctx.rotate(r); ctx.scale(sx, sy);
  ctx.globalAlpha = alpha;
  if (g.fill) { ctx.fillStyle = col; ctx.fill(g.fill, 'evenodd'); }
  ctx.strokeStyle = col; ctx.lineWidth = 1.5 * k / (v.s * Math.abs(sx || 1));
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.stroke(g.path);
  for (const t of g.texts) drawText(ctx, t, v, 0, 0, col, 0, 0);
  ctx.restore();
}
function drawEquip(ctx, v, dpr, o, W, H) {
  const L = doc.r.layers, k = o.k || 1;
  const showChg = !o.export && S.showChg !== false && edMode === 'utstyr';
  drawRuns(ctx, v, dpr, o);
  for (const it of EQ.items) {
    if (!doc.show[it.li]) continue;
    const g = doc.geom(it.block);
    if (!g) continue;
    const col = aci(L[it.li].color);
    const moved = isMoved(it);
    if (showChg && (moved || it.del)) {
      ctx.save();
      ctx.setLineDash([4 / v.s, 3 / v.s]);
      drawBlock(ctx, v, dpr, g, it.ox, it.oy, it.or, it.sx, it.sy, it.del ? '#dc2626' : '#6b7280', 0.35, k);
      ctx.restore();
      const c0 = itemCenter(it, true);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const s0 = { x: c0.x * v.s + v.tx, y: c0.y * v.s + v.ty };
      if (it.del) {
        ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(s0.x - 9, s0.y - 9); ctx.lineTo(s0.x + 9, s0.y + 9); ctx.moveTo(s0.x + 9, s0.y - 9); ctx.lineTo(s0.x - 9, s0.y + 9); ctx.stroke();
      } else {
        const c1 = itemCenter(it), s1 = { x: c1.x * v.s + v.tx, y: c1.y * v.s + v.ty };
        ctx.strokeStyle = 'rgba(234,88,12,.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    if (it.del) continue;
    const f = o.export ? 1 : clamp(11 / Math.max(1e-9, g.rad * Math.abs(it.sx) * v.s), 1, 4);
    drawBlock(ctx, v, dpr, g, it.x, it.y, it.r, it.sx * f, it.sy * f, col, 1, k);
    if (it.labels.length) {
      ctx.save();
      ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
      const dr = it.r - it.or, c = Math.cos(dr), sn = Math.sin(dr);
      for (let t of it.labels) {
        if (t === it.numLabel) { if (it.n < 2) continue; if (it.n !== it.n0) t = { ...t, s: String(it.n) }; }
        const ax = t.x - it.ox, ay = t.y - it.oy;
        drawText(ctx, t, v, W, H, col, it.x + c * ax - sn * ay - t.x, it.y + sn * ax + c * ay - t.y);
      }
      ctx.restore();
    }
    if (!it.numLabel && it.n >= 2 && EQ.num[it.block]) {
      const q = numPos(it);
      ctx.save();
      ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
      drawText(ctx, { ...EQ.num[it.block].t, x: q.x, y: q.y, s: String(it.n) }, v, W, H, col, 0, 0);
      ctx.restore();
    }
    if (showChg && (moved || it.added || it.n !== it.n0)) {
      const c = itemCenter(it);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sx = c.x * v.s + v.tx - Math.max(10, g.rad * v.s * 0.8), sy = c.y * v.s + v.ty - Math.max(10, g.rad * v.s * 0.8);
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = it.added ? '#16a34a' : '#ea580c'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
  }
  if (!o.export && edMode === 'utstyr' && runStart) {
    const it = EQ.items.find(i => i.key === runStart);
    if (it) {
      const c = itemCenter(it);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath(); ctx.arc(c.x * v.s + v.tx, c.y * v.s + v.ty, 20, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(220,38,38,.15)'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#dc2626'; ctx.stroke();
    }
  }
  if (!o.export && edMode === 'utstyr' && eqSel) {
    const it = EQ.items.find(i => i.key === eqSel);
    if (it && !it.del) {
      const g = doc.geom(it.block), c = itemCenter(it);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const r = Math.max(22, (g ? g.rad * Math.abs(it.sx) : 0) * v.s + 10);
      ctx.beginPath(); ctx.arc(c.x * v.s + v.tx, c.y * v.s + v.ty, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(37,99,235,.12)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#2563eb'; ctx.stroke();
    }
  }
}

/* ---------- Treff og valg ---------- */
function hitItem(x, y) {
  let best = null, bd = Infinity;
  for (const it of EQ.items) {
    if (it.del || !doc.show[it.li]) continue;
    const g = doc.geom(it.block), c = itemCenter(it);
    const sx = c.x * view.s + view.tx, sy = c.y * view.s + view.ty;
    const rr = Math.max(26, (g ? g.rad * Math.abs(it.sx) : 0) * view.s + 8);
    const d = Math.hypot(sx - x, sy - y);
    if (d < rr && d / rr < bd) { bd = d / rr; best = it; }
  }
  return best;
}
function eqSelect(key) { eqSel = key; updateEqBar(); req(); }

function eqTap(x, y, g) {
  if (eqTool === 'run') {
    if (g.hi) {
      if (!runStart) runStart = g.hi.key;
      else if (runStart !== g.hi.key) { addRun(runStart, g.hi.key); runStart = g.hi.key; }
      runBanner(); req(); return;
    }
    const hr = hitRun(x, y);
    if (hr) { runSel = hr.id; eqSel = null; updateEqBar(); req(); return; }
    runStart = null; runSel = null; runBanner(); updateEqBar(); req(); return;
  }
  if (g.hi) { runSel = null; eqSelect(eqSel === g.hi.key ? null : g.hi.key); return; }
  const hr = hitRun(x, y);
  if (hr && !eqArm) { runSel = hr.id; eqSel = null; updateEqBar(); req(); return; }
  runSel = null;
  if (eqArm) { addItem(eqArm, toUnit(x, y)); return; }
  eqSelect(null);
}
function templateFor(block) {
  const ins = doc.r.inserts.find(i => i.block === block && doc.eqIns[i.idx]) || doc.r.inserts.find(i => i.block === block);
  return ins || null;
}
// for bibliotekssymboler: et innsatt symbol av lignende type (lag, skala, retning)
function likeFor(block) {
  const d = libDef(block);
  if (!d) return null;
  return doc.r.inserts.find(i => doc.eqIns[i.idx] && d.like.test(i.block)) || null;
}
function addItem(block, u) {
  pushUndo();
  const t = templateFor(block), like = t || likeFor(block);
  const layer = like ? like.layer : (doc.r.layers.find((l, i) => doc.equip[i]) || { name: '0' }).name;
  const id = uid();
  const it = { key: 'a' + id, id, idx: null, added: true, block, layer, li: Math.max(0, layerIndex(layer)),
    x: u.x, y: u.y, r: like ? like.r : 0, sx: like ? like.sx : 1, sy: like ? like.sy : 1, tmpl: t ? t.idx : null, del: false, labels: [], numLabel: null };
  it.n = it.n0 = defaultN(block);
  placeItem(it, u.x, u.y);
  it.ox = it.x; it.oy = it.y; it.or = it.r;
  EQ.items.push(it);
  P.eq.added.push({ id, block, layer, x: it.x, y: it.y, r: it.r, sx: it.sx, sy: it.sy, tmpl: it.tmpl, n: it.n });
  eqSelect(it.key);
  save();
  return it;
}

/* ---------- Stabling (flere symboler over hverandre på samme sted) ---------- */
function commitAll() { for (const it of EQ.items) commitItem(it); }
function stackH(it) {
  const g = doc.geom(it.block), info = infoOf(it.block), mpu = P.mmPerUnit || 1;
  if (!g) return 200 / mpu;
  const a = info.local + Math.PI, ux = Math.cos(a), uy = Math.sin(a), band = 85 / mpu;
  let h = 0;
  for (let k = 0; k < g.pts.length; k += 2) {
    const x = g.pts[k], y = g.pts[k + 1];
    if (Math.abs(-uy * x + ux * y) <= band) h = Math.max(h, ux * x + uy * y);
  }
  return h * Math.abs(it.sx || 1) + 18 / mpu;
}
function above(it) { return EQ.items.filter(q => q.stackOn === it.key && !q.del); }
function chainUp(it) { const out = []; let cur = above(it); while (cur.length) { out.push(...cur); cur = cur.flatMap(above); } return out; }
function topOf(it, skip) { let t = it; for (let i = 0; i < 20; i++) { const a = above(t).filter(q => q !== skip); if (!a.length) break; t = a[0]; } return t; }
function resolveStacks() {
  const by = new Map(EQ.items.map(i => [i.key, i]));
  for (let pass = 0; pass < 12; pass++) {
    for (const it of EQ.items) {
      if (!it.stackOn) continue;
      const b = by.get(it.stackOn);
      if (!b || b.del || b === it) { it.stackOn = null; continue; }
      const ib = infoOf(b.block), ii = infoOf(it.block), a = b.r + ib.local + Math.PI, h = stackH(b);
      it.x = b.x + Math.cos(a) * h; it.y = b.y + Math.sin(a) * h; it.r = b.r + ib.local - ii.local;
    }
  }
}
// ta symbolet ut av stabelen; de over flyttes ned
function unstack(it) {
  const up = above(it);
  for (const a of up) {
    a.stackOn = it.stackOn;
    if (!it.stackOn) { a.x = it.x; a.y = it.y; a.r = it.r + infoOf(it.block).local - infoOf(a.block).local; }
  }
  it.stackOn = null;
  resolveStacks();
}
function swapDown(it) {
  let lower, upper;
  if (it.stackOn) { lower = EQ.items.find(q => q.key === it.stackOn); upper = it; }
  else { lower = it; upper = above(it)[0]; }
  if (!lower || !upper) return;
  const upAbove = above(upper);
  upper.stackOn = lower.stackOn;
  if (!lower.stackOn) { upper.x = lower.x; upper.y = lower.y; upper.r = lower.r + infoOf(lower.block).local - infoOf(upper.block).local; }
  for (const a of upAbove) a.stackOn = lower.key;
  lower.stackOn = upper.key;
  resolveStacks();
}
function inStack(it) { return !!it.stackOn || above(it).length > 0; }

/* ---------- Dra ---------- */
function startItemDrag(it, x, y) {
  if (!gest || gest.type !== 'pending') return;
  pushUndo();
  gest.type = 'idrag';
  const s = { x: it.x * view.s + view.tx, y: it.y * view.s + view.ty };
  gest.off = { x: s.x - x, y: s.y - y };
  gest.item = it;
  it.snap = -1;
  if (it.stackOn) unstack(it);
  gest.chain = new Set(chainUp(it).map(q => q.key));
  gest.stackTo = null;
  eqSel = it.key; updateEqBar();
  try { navigator.vibrate && navigator.vibrate(15); } catch (e) { }
  req();
}
function moveItemDrag(p) {
  const it = gest.item, u = toUnit(p.x + gest.off.x, p.y + gest.off.y);
  // slipp oppå et annet veggsymbol = stable
  let target = null;
  if (infoOf(it.block).wall) {
    let bd = 28;
    for (const q of EQ.items) {
      if (q === it || q.del || gest.chain.has(q.key) || !infoOf(q.block).wall || !doc.show[q.li]) continue;
      const c = itemCenter(q), d = Math.hypot(c.x * view.s + view.tx - p.x, c.y * view.s + view.ty - p.y);
      if (d < bd) { bd = d; target = q; }
    }
  }
  if (target) {
    const top = topOf(target, it);
    if (it.stackOn !== top.key) { try { navigator.vibrate && navigator.vibrate([10, 40, 10]); } catch (e) { } }
    it.stackOn = top.key; gest.stackTo = top;
  } else {
    it.stackOn = null; gest.stackTo = null;
    placeItem(it, u.x, u.y);
  }
  resolveStacks();
  req();
}
function endItemDrag() {
  const it = gest.item;
  gest.type = 'end';
  delete it.snap;
  if (it.added) { it.ox = it.x; it.oy = it.y; it.or = it.r; }
  if (gest.stackTo) toast('Stablet');
  commitAll(); save(); updateEqBar(); updateTitle(); req();
}

/* ---------- Handlingslinje for valgt symbol / føring ---------- */
function updateEqBar() {
  const bar = $('#eqbar');
  $('#npick').classList.remove('on');
  const run = runSel && (P.eq.runs || []).find(r => r.id === runSel);
  const it = !run && eqSel && EQ.items.find(i => i.key === eqSel);
  if (!eqActive() || (!run && (!it || it.del)) || (gest && gest.type === 'idrag')) { bar.classList.remove('on'); bar.dataset.k = ''; return; }
  let html;
  if (run) html = `<b>Føring</b><button data-a="rflip" title="Bøy andre veien">⇅</button><button data-a="rbend" title="Mer/mindre bue">⌒</button><button data-a="rdel" title="Slett">🗑</button>`;
  else html = `<b>${esc(prettyBlock(it.block))}${it.added ? ' · ny' : isMoved(it) ? ' · flyttet' : ''}</b>`
    + (countable(it.block) ? `<button class="num" data-a="n" title="Antall uttak">${it.n}×</button>` : '')
    + (inStack(it) ? `<button data-a="swap" title="Bytt plass i stabelen">⇵</button>` : `<button data-a="rot" title="Roter 90°">⟳</button><button data-a="flip" title="Snu til andre siden av veggen">⇅</button>`)
    + `<button data-a="dup" title="Kopier">⧉</button>`
    + (isMoved(it) ? `<button data-a="reset" title="Tilbake til prosjektert">↺</button>` : '')
    + `<button data-a="del" title="Slett">🗑</button>`;
  if (bar.dataset.k !== html) {
    bar.innerHTML = html; bar.dataset.k = html;
    bar.querySelectorAll('[data-a]').forEach(b => b.onclick = () => eqAction(b.dataset.a));
  }
  bar.classList.add('on');
  positionEqBar();
}
function selAnchor() {
  const run = runSel && (P.eq.runs || []).find(r => r.id === runSel);
  if (run) { const g = runGeom(run); return g ? { x: g.apex.x * view.s + view.tx, y: g.apex.y * view.s + view.ty, r: 14 } : null; }
  const it = EQ.items.find(i => i.key === eqSel);
  if (!it) return null;
  const g = doc.geom(it.block), c = itemCenter(it);
  return { x: c.x * view.s + view.tx, y: c.y * view.s + view.ty, r: Math.max(22, (g ? g.rad * Math.abs(it.sx) : 0) * view.s + 10) };
}
function positionEqBar() {
  const bar = $('#eqbar');
  if (!bar.classList.contains('on')) return;
  const a = selAnchor();
  if (!a) return;
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let top = a.y - a.r - bh - 10;
  if (top < 8) top = a.y + a.r + 10;
  bar.style.left = clamp(a.x - bw / 2, 8, cw - bw - 8) + 'px';
  bar.style.top = clamp(top, 8, ch - bh - 8) + 'px';
  const np = $('#npick');
  if (np.classList.contains('on')) {
    const below = top < a.y;
    np.style.left = clamp(a.x - np.offsetWidth / 2, 8, cw - np.offsetWidth - 8) + 'px';
    np.style.top = clamp(below ? top - np.offsetHeight - 6 : top + bh + 6, 8, ch - np.offsetHeight - 8) + 'px';
  }
}
function openNPick(it) {
  const np = $('#npick');
  np.innerHTML = [1, 2, 3, 4, 5, 6].map(n => `<button data-n="${n}" class="${n === it.n ? 'on' : ''}">${n}</button>`).join('');
  np.querySelectorAll('[data-n]').forEach(b => b.onclick = () => {
    pushUndo(); it.n = +b.dataset.n; commitItem(it); save();
    np.classList.remove('on'); updateEqBar(); updateTitle(); req();
  });
  np.classList.add('on');
  positionEqBar();
}
function eqAction(a) {
  if (a[0] === 'r' && a !== 'rot' && a !== 'reset') return runAction(a);
  const it = EQ.items.find(i => i.key === eqSel);
  if (!it) return;
  const mpu = P.mmPerUnit || 1;
  if (a === 'n') { if ($('#npick').classList.contains('on')) $('#npick').classList.remove('on'); else openNPick(it); return; }
  if (a === 'swap') { pushUndo(); swapDown(it); commitAll(); save(); updateEqBar(); req(); return; }
  if (a === 'rot') { pushUndo(); it.r += Math.PI / 2; }
  else if (a === 'flip') {
    pushUndo();
    const info = infoOf(it.block);
    const tw = it.r + info.local, tx = Math.cos(tw), ty = Math.sin(tw);
    const w = doc.nearestWall(it.x + tx * (info.off + 1 / mpu), it.y + ty * (info.off + 1 / mpu), 600 / mpu, -1);
    let moved = false;
    if (w) {
      for (let d = 20; d < 800; d += 10) {
        const px = it.x + tx * d / mpu, py = it.y + ty * d / mpu;
        const w2 = doc.nearestWall(px, py, 2 / mpu, -1);
        if (w2 && w2.k !== w.k && Math.abs(w2.tx * w.tx + w2.ty * w.ty) > 0.95) {
          it.x = w2.px + tx * info.off; it.y = w2.py + ty * info.off; it.r += Math.PI; moved = true; break;
        }
      }
    }
    if (!moved) it.r += Math.PI;
  }
  else if (a === 'dup') {
    const c = Math.cos(it.r), s = Math.sin(it.r), d = 500 / mpu;
    const n = addItem(it.block, { x: it.x + c * d, y: it.y + s * d });
    if (!infoOf(it.block).wall) n.r = it.r;
    n.n = it.n;
    n.ox = n.x; n.oy = n.y; n.or = n.r; commitItem(n);
    toast('Kopi lagt til – hold inne for å flytte den');
  }
  else if (a === 'reset') { pushUndo(); if (it.stackOn) unstack(it); it.x = it.ox; it.y = it.oy; it.r = it.or; }
  else if (a === 'del') {
    pushUndo();
    if (inStack(it)) { unstack(it); commitAll(); }
    if (it.added) { P.eq.added = P.eq.added.filter(q => q.id !== it.id); EQ.items = EQ.items.filter(q => q !== it); }
    else it.del = true;
    eqSel = null;
  }
  if (a !== 'dup' && EQ.items.includes(it)) commitItem(it);
  resolveStacks(); commitAll();
  save(); updateEqBar(); updateTitle(); req();
}

/* ---------- Føringer (buet strek = skjult anlegg) ---------- */
function itemByKey(k) { return EQ.items.find(i => i.key === k && !i.del); }
function itemRad(it) { const g = doc.geom(it.block); return g ? g.rad * Math.abs(it.sx) * 0.85 : 0; }
function arcPoints(p1, p2, b, n) {
  const th = 4 * Math.atan(b), dx = p2.x - p1.x, dy = p2.y - p1.y, c = Math.hypot(dx, dy);
  if (Math.abs(b) < 1e-6) return [p1, p2];
  const h = c / (2 * Math.tan(th / 2));
  const cx = (p1.x + p2.x) / 2 + (-dy / c) * h, cy = (p1.y + p2.y) / 2 + (dx / c) * h;
  const r = Math.hypot(p1.x - cx, p1.y - cy), a1 = Math.atan2(p1.y - cy, p1.x - cx);
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a1 + th * i / n; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
  return out;
}
function runGeom(run) {
  const A = itemByKey(run.a), B = itemByKey(run.b);
  if (!A || !B) return null;
  const ca = itemCenter(A), cb = itemCenter(B);
  const d = Math.hypot(cb.x - ca.x, cb.y - ca.y);
  if (d < 1e-6) return null;
  const ux = (cb.x - ca.x) / d, uy = (cb.y - ca.y) / d;
  const ra = Math.min(itemRad(A), d * 0.3), rb = Math.min(itemRad(B), d * 0.3);
  const p1 = { x: ca.x + ux * ra, y: ca.y + uy * ra }, p2 = { x: cb.x - ux * rb, y: cb.y - uy * rb };
  const pts = arcPoints(p1, p2, run.bu, 32);
  return { p1, p2, pts, apex: pts[Math.floor(pts.length / 2)] };
}
function runLayer() {
  const L = doc.r.layers;
  const l = L.find(l => /f[øo]ring|r[øo]r|conduit|kabel[-_ ]?f/i.test(l.name)) || L.find(l => /^E[-_ ]/i.test(l.name));
  return l ? l.name : 'E-FØRING';
}
function addRun(a, b) {
  pushUndo();
  const run = { id: uid(), a, b, bu: 0.4 };
  // bøy bort fra nærmeste vegg
  const mpu = P.mmPerUnit || 1;
  const score = bb => {
    run.bu = bb; const g = runGeom(run); if (!g) return 0;
    const w = doc.nearestWall(g.apex.x, g.apex.y, 4000 / mpu, -1);
    return w ? w.d : 4000 / mpu;
  };
  run.bu = score(0.4) >= score(-0.4) ? 0.4 : -0.4;
  P.eq.runs.push(run);
  save(); updateTitle();
  try { navigator.vibrate && navigator.vibrate(10); } catch (e) { }
}
function hitRun(x, y) {
  let best = null, bd = 14;
  for (const run of (P.eq.runs || [])) {
    const g = runGeom(run);
    if (!g) continue;
    for (let i = 0; i + 1 < g.pts.length; i++) {
      const a = g.pts[i], b = g.pts[i + 1];
      const ax = a.x * view.s + view.tx, ay = a.y * view.s + view.ty, bx = b.x * view.s + view.tx, by = b.y * view.s + view.ty;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1);
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d < bd) { bd = d; best = run; }
    }
  }
  return best;
}
function drawRuns(ctx, v, dpr, o) {
  const runs = P.eq && P.eq.runs;
  if (!runs || !runs.length) return;
  const li = doc.r.layers.findIndex(l => l.name === runLayer());
  const col = li >= 0 ? aci(doc.r.layers[li].color) : '#dc2626';
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  for (const run of runs) {
    const g = runGeom(run);
    if (!g) continue;
    const sel = !o.export && run.id === runSel;
    ctx.strokeStyle = sel ? '#2563eb' : col;
    ctx.lineWidth = (sel ? 3 : 1.6) * (o.k || 1);
    ctx.beginPath();
    g.pts.forEach((p, i) => { const x = p.x * v.s + v.tx, y = p.y * v.s + v.ty; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.restore();
}
function runAction(a) {
  const i = P.eq.runs.findIndex(r => r.id === runSel);
  if (i < 0) return;
  const run = P.eq.runs[i];
  pushUndo();
  if (a === 'rflip') run.bu = -run.bu;
  else if (a === 'rbend') { const lv = [0.2, 0.4, 0.7], k = lv.findIndex(x => Math.abs(Math.abs(run.bu) - x) < 0.01); run.bu = Math.sign(run.bu || 1) * lv[(k + 1) % lv.length]; }
  else if (a === 'rdel') { P.eq.runs.splice(i, 1); runSel = null; }
  save(); updateEqBar(); updateTitle(); req();
}
function runBanner() {
  if (eqTool !== 'run') return;
  setBanner(runStart ? 'Trykk på neste punkt – eller i tomt område for å avslutte' : 'Føring: trykk på første punkt', 'Ferdig', () => setRunTool(false));
}
function setRunTool(on) {
  eqTool = on ? 'run' : 'sel';
  runStart = null;
  $('#runBtn').classList.toggle('on', on);
  if (on) { setArm(null); eqSel = null; runSel = null; updateEqBar(); runBanner(); }
  else setBanner(null);
  req();
}
$('#runBtn').onclick = () => setRunTool(eqTool !== 'run');

/* ---------- Palett ---------- */
function prettyBlock(n) { return n.replace(/^(E|EL)[-_ ]/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function paletteBlocks() {
  const cnt = new Map();
  for (const it of EQ.items) if (!it.added) cnt.set(it.block, (cnt.get(it.block) || 0) + 1);
  for (const n of doc.r.blockNames) if (!cnt.has(n) && EQ_RE.test(n)) cnt.set(n, 0);
  const list = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  for (const b of LIB) {
    if (list.includes(b.name)) continue;
    const i = list.findIndex(n => b.like.test(n));
    list.splice(i >= 0 ? i + 1 : list.length, 0, b.name);
  }
  return list;
}
function buildPalette() {
  const el = $('#pal');
  const names = paletteBlocks();
  if (!names.length) { el.innerHTML = '<span class="paltip">Fant ingen utstyrsblokker – velg utstyrslag i menyen</span>'; return; }
  el.innerHTML = names.map(n => `<button class="pchip ${n === eqArm ? 'on' : ''}" data-b="${esc(n)}"><canvas width="88" height="88"></canvas><span>${esc(prettyBlock(n))}</span></button>`).join('');
  el.querySelectorAll('.pchip').forEach(b => {
    const name = b.dataset.b, g = doc.geom(name), c = $('canvas', b).getContext('2d');
    if (g) {
      const bb = g.bbox, w = bb.x1 - bb.x0 || 1, h = bb.y1 - bb.y0 || 1, s = 70 / Math.max(w, h);
      const t = templateFor(name) || likeFor(name), col = t ? aci(doc.r.layers[t.li].color) : '#111';
      c.setTransform(s, 0, 0, s, 44 - (bb.x0 + w / 2) * s, 44 - (bb.y0 + h / 2) * s);
      c.strokeStyle = col; c.lineWidth = 3.2 / s; c.lineCap = 'round';
      if (g.fill) { c.fillStyle = col; c.fill(g.fill, 'evenodd'); }
      c.stroke(g.path);
      for (const tx of g.texts) drawText(c, tx, { s, tx: 0, ty: 0 }, 0, 0, col, 0, 0);
    }
    palPointer(b, name);
  });
}
function setArm(name) {
  if (name && eqTool === 'run') setRunTool(false);
  eqArm = name;
  document.querySelectorAll('#pal .pchip').forEach(b => b.classList.toggle('on', b.dataset.b === name));
  if (name) setBanner(`Trykk på tegningen for å sette inn «${prettyBlock(name)}»`, 'Ferdig', () => setArm(null));
  else setBanner(null);
}
// Dra et symbol opp fra paletten og slipp det på tegningen
let palDrag = null;
function palPointer(btn, name) {
  let st = null;
  btn.addEventListener('pointerdown', e => {
    st = { x: e.clientX, y: e.clientY, id: e.pointerId, drag: false };
    if (e.pointerType === 'mouse') try { btn.setPointerCapture(e.pointerId); } catch (er) { }
  });
  btn.addEventListener('pointermove', e => {
    if (!st || st.id !== e.pointerId) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (!st.drag && dy < -14 && Math.abs(dy) > Math.abs(dx) * 0.6) {
      st.drag = true;
      try { btn.setPointerCapture(e.pointerId); } catch (er) { }
      const t = templateFor(name) || likeFor(name);
      palDrag = { key: 'drag', block: name, layer: t ? t.layer : '0', li: t ? t.li : 0, x: 0, y: 0, r: t ? t.r : 0, sx: t ? t.sx : 1, sy: t ? t.sy : 1, labels: [], added: true, snap: -1 };
      try { navigator.vibrate && navigator.vibrate(10); } catch (er) { }
    }
    if (st.drag) {
      const rc = cv.getBoundingClientRect();
      const px = e.clientX - rc.left, py = e.clientY - rc.top - 46; // litt over fingeren
      palDrag.inside = px >= 0 && py >= -46 && px <= rc.width && py <= rc.height;
      const u = toUnit(px, py);
      placeItem(palDrag, u.x, u.y);
      req();
    }
  });
  const end = e => {
    if (!st || st.id !== e.pointerId) return;
    if (st.drag) {
      if (palDrag && palDrag.inside && e.type === 'pointerup') {
        const p = palDrag; palDrag = null;
        const it = addItem(p.block, { x: p.x, y: p.y });
        it.x = p.x; it.y = p.y; it.r = p.r; it.ox = p.x; it.oy = p.y; it.or = p.r; commitItem(it); save();
        updateEqBar();
      }
      palDrag = null; req();
    } else if (e.type === 'pointerup' && Math.hypot(e.clientX - st.x, e.clientY - st.y) < 10) {
      setArm(eqArm === name ? null : name);
    }
    st = null;
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
}
function drawPalDrag(ctx) {
  if (!palDrag || !palDrag.inside) return;
  const g = doc.geom(palDrag.block);
  if (!g) return;
  drawBlock(ctx, view, dpr, g, palDrag.x, palDrag.y, palDrag.r, palDrag.sx, palDrag.sy, aci(doc.r.layers[palDrag.li].color), 0.85, 1);
}

/* ---------- Modus ---------- */
function setEdMode(m) {
  if (m === 'utstyr' && (!doc || doc.kind !== 'dxf')) {
    toast('Utstyr kan flyttes i DXF-tegninger. Lagre som DXF i AutoCAD.');
    return;
  }
  edMode = m;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('#tools').classList.toggle('eq', m === 'utstyr');
  setArm(null); if (eqTool === 'run') setRunTool(false);
  eqSel = null; runSel = null; select(null); updateEqBar(); updateTitle(); req();
}
document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => setEdMode(b.dataset.m));
$('#chgBtn').onclick = () => {
  S.showChg = S.showChg === false; saveS();
  $('#chgBtn').classList.toggle('on', S.showChg !== false);
  toast(S.showChg !== false ? 'Viser endringer mot prosjektert' : 'Skjuler endringer');
  req();
};

/* ---------- Eksport som DXF ---------- */
function eqChanges() {
  const moved = new Map(), deleted = new Set(), textMoves = new Map(), textDeletes = new Set();
  for (const it of EQ.items) {
    if (it.added) continue;
    if (it.del) { deleted.add(it.idx); it.labels.forEach(t => textDeletes.add(t.rec)); continue; }
    if (isMoved(it)) {
      moved.set(it.idx, { x: it.x, y: it.y, r: it.r });
      it.labels.forEach(t => textMoves.set(t.rec, { ox: it.ox, oy: it.oy, nx: it.x, ny: it.y, dr: it.r - it.or }));
    }
  }
  const added = P.eq.added.map(a => ({ ...a }));
  const textEdits = new Map(), addedTexts = [], addedRaw = [];
  for (const it of EQ.items) {
    if (it.del) continue;
    const N = EQ.num[it.block];
    if (!it.added && it.n === it.n0) continue;
    if (it.numLabel && !it.added) {
      if (it.n < 2) textDeletes.add(it.numLabel.rec); else textEdits.set(it.numLabel.rec, String(it.n));
    } else if (it.n >= 2 && N && N.t.rec) {
      const q = numPos(it);
      addedTexts.push({ rec: N.t.rec, x: q.x, y: q.y, s: String(it.n) });
    }
  }
  const layer = runLayer(), f = DXF.fmtN;
  for (const run of (P.eq.runs || [])) {
    const g = runGeom(run);
    if (!g) continue;
    addedRaw.push({ type: 'LWPOLYLINE', pairs: [[100, 'AcDbEntity'], [8, layer], [6, 'Continuous'], [100, 'AcDbPolyline'], [90, '2'], [70, '0'],
      [10, f(g.p1.x)], [20, f(-g.p1.y)], [42, f(-run.bu)], [10, f(g.p2.x)], [20, f(-g.p2.y)]] });
  }
  const newBlocks = [];
  for (const it of EQ.items) {
    if (!it.added || it.del || doc.r.blockNames.includes(it.block) || newBlocks.some(b => b.name === it.block)) continue;
    const d = libDef(it.block);
    if (d) newBlocks.push({ name: d.name, ents: d.ents.map(libPairs) });
  }
  return { moved, deleted, added, textMoves, textDeletes, textEdits, addedTexts, addedRaw, newBlocks };
}
async function exportDxf() {
  try {
    const txt = DXF.writeDXF(doc.r, eqChanges());
    await shareOrDownload(new Blob([txt], { type: 'application/dxf' }), safeName(P.name) + '_som-bygget.dxf', P.name);
  } catch (e) { toast('Kunne ikke lage DXF: ' + e.message); }
}
