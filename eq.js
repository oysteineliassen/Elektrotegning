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
    { t: 'T', p: [0, 115], h: 60, s: '°C' }] },
  // takpunkter (sentrert, takmontert)
  { name: 'E_DOWNLIGHT', like: /lys|light/i, ceil: true, ents: [{ t: 'C', c: [0, 0], r: 75 }, { t: 'L', a: [-53, -53], b: [53, 53] }, { t: 'L', a: [-53, 53], b: [53, -53] }] },
  { name: 'E_SPOT', like: /lys|light/i, ceil: true, ents: [{ t: 'C', c: [0, 0], r: 55 }, { t: 'L', a: [-39, -39], b: [39, 39] }, { t: 'L', a: [-39, 39], b: [39, -39] }, { t: 'C', c: [0, 0], r: 14 }] },
  { name: 'E_LAMPEPUNKT', like: /lys|light/i, ceil: true, ents: [{ t: 'C', c: [0, 0], r: 120 }, { t: 'L', a: [-85, -85], b: [85, 85] }, { t: 'L', a: [-85, 85], b: [85, -85] }] },
  { name: 'E_ROYKVARSLER', like: /lys|light/i, ceil: true, ents: [{ t: 'C', c: [0, 0], r: 75 }, { t: 'T', p: [0, 0], h: 70, s: 'R' }] },
  { name: 'E_HOYTTALER', like: /lys|light/i, ceil: true, ents: [{ t: 'C', c: [0, 0], r: 75 }, { t: 'T', p: [0, 0], h: 70, s: 'H' }] },
  { name: 'E_KOBLINGSBOKS', like: /lys|light/i, ceil: true, ents: [{ t: 'P', pts: [[-60, -60], [60, -60], [60, 60], [-60, 60]], closed: true }, { t: 'C', c: [0, 0], r: 18 }] }
];
const PT_BLOCK = { downlight: 'E_DOWNLIGHT', spot: 'E_SPOT', lampe: 'E_LAMPEPUNKT', royk: 'E_ROYKVARSLER', hoyttaler: 'E_HOYTTALER', boks: 'E_KOBLINGSBOKS' };
// takpunkter som utstyr (vises uten mål i Utstyr-modus)
function ptItems() {
  if (!P || !P.points) return [];
  const like = doc.r.inserts.find(i => doc.eqIns[i.idx] && /lys|light/i.test(i.block) && !/vegg/i.test(i.block));
  const layer = like ? like.layer : (doc.r.layers.find((l, i) => doc.equip[i]) || { name: '0' }).name;
  const li = Math.max(0, layerIndex(layer));
  return P.points.map(p => ({ key: 'p' + p.id, pt: p, isPt: true, block: PT_BLOCK[p.type] || 'E_DOWNLIGHT', layer, li,
    x: p.x, y: p.y, r: 0, ox: p.x, oy: p.y, or: 0, sx: 1, sy: 1, labels: [], n: 1, n0: 1, added: true, del: false, numLabel: null }));
}
function allItems() { return eqActive() || (doc && doc.kind === 'dxf') ? EQ.items.concat(ptItems()) : EQ.items; }
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
  if (!EQ.info[block] && libDef(block)) EQ.info[block] = { wall: !libDef(block).ceil, local: Math.PI / 2, off: 0 };
  return EQ.info[block] || (EQ.info[block] = { wall: WALLMOUNT_RE.test(block), local: Math.PI / 2, off: 0 });
}
function isMoved(it) { return !it.added && (Math.abs(it.x - it.ox) > 1e-6 || Math.abs(it.y - it.oy) > 1e-6 || Math.abs(it.r - it.or) > 1e-6); }
function isChanged(it) { return isMoved(it) || (!it.added && (it.n !== it.n0 || !!it.stackOn)); }
function changeCount() { return EQ.items.filter(i => i.added || i.del || isChanged(i)).length + (P.eq.runs || []).length; }

/* ---------- Plassering med vegg-magnet ---------- */
function placeItem(it, ux, uy) {
  const info = infoOf(it.block), mpu = P.mmPerUnit || 1;
  if (!info.wall || S.noSnap) { it.x = ux; it.y = uy; it.snap = -1; it._wn = null; return; }
  const w = doc.nearestWall(ux, uy, Math.max(900 / mpu, 45 / view.s), it.snap ?? -1);
  if (!w) { it.x = ux; it.y = uy; it.snap = -1; return; }
  it.x = w.px + w.nx * info.off; it.y = w.py + w.ny * info.off;
  it.r = Math.atan2(-w.ny, -w.nx) - info.local;
  it._wn = { px: w.px, py: w.py, nx: w.nx, ny: w.ny };
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
  drawKursHl(ctx, v, dpr, o);
  drawRuns(ctx, v, dpr, o);
  drawKurs(ctx, v, dpr, o);
  const list = (o.export ? !expDims() : edMode === 'utstyr') ? allItems() : EQ.items;
  for (const it of list) {
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
    const f = o.export || S.minSym === false ? 1 : clamp(11 / Math.max(1e-9, g.rad * Math.abs(it.sx) * v.s), 1, 4);
    drawBlock(ctx, v, dpr, g, it.x, it.y, it.r, it.sx * f, it.sy * f, col, 1, k);
    if (!o.export && typeof hasPhoto === 'function' && hasPhoto(it.key)) {
      const c = itemCenter(it); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const rr = Math.max(10, g.rad * f * Math.abs(it.sx) * v.s * 0.8);
      drawPhotoBadge(ctx, c.x * v.s + v.tx - rr, c.y * v.s + v.ty + rr);
    }
    if (it.labels.length) {
      ctx.save();
      ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
      for (const t of it.labels) { const d = labelDisp(it, t); if (d) drawText(ctx, d, v, W, H, col, 0, 0); }
      ctx.restore();
    }
    if (!it.numLabel && it.n >= 2 && EQ.num[it.block]) {
      const q = numPos(it);
      ctx.save();
      ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
      drawText(ctx, { ...EQ.num[it.block].t, x: q.x, y: q.y, s: String(it.n) }, v, W, H, col, 0, 0);
      ctx.restore();
    }
    if (showChg && !it.isPt && (moved || it.added || it.n !== it.n0)) {
      const c = itemCenter(it);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sx = c.x * v.s + v.tx - Math.max(10, g.rad * v.s * 0.8), sy = c.y * v.s + v.ty - Math.max(10, g.rad * v.s * 0.8);
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = it.added ? '#16a34a' : '#ea580c'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
  }
  drawAddedTexts(ctx, v, dpr, W, H);
  drawNotes(ctx, v, dpr, W, H);
  if (!o.export && edMode === 'utstyr' && txtSel) drawTextSel(ctx, v, dpr);
  if (!o.export && edMode === 'utstyr' && runStart) {
    const it = itemByKey(runStart);
    if (it) {
      const c = itemCenter(it);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath(); ctx.arc(c.x * v.s + v.tx, c.y * v.s + v.ty, 20, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(220,38,38,.15)'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#dc2626'; ctx.stroke();
    }
  }
  if (!o.export && edMode === 'utstyr' && eqSet.size > 1) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const it of groupItems()) {
      const g = doc.geom(it.block), c = itemCenter(it), r = Math.max(18, (g ? g.rad * Math.abs(it.sx) : 0) * v.s + 8);
      ctx.beginPath(); ctx.arc(c.x * v.s + v.tx, c.y * v.s + v.ty, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(37,99,235,.12)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#2563eb'; ctx.stroke();
    }
  } else if (!o.export && edMode === 'utstyr' && eqSel) {
    const it = itemByKey(eqSel);
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
  for (const it of allItems()) {
    if (it.del || !doc.show[it.li]) continue;
    const g = doc.geom(it.block), c = itemCenter(it);
    const sx = c.x * view.s + view.tx, sy = c.y * view.s + view.ty;
    const rr = Math.max(26, (g ? g.rad * Math.abs(it.sx) : 0) * view.s + 8);
    const d = Math.hypot(sx - x, sy - y);
    if (d < rr && d / rr < bd) { bd = d / rr; best = it; }
  }
  return best;
}
let eqSet = new Set();
function eqSelect(key, add) {
  if (add && key) { if (eqSet.size === 0 && eqSel) eqSet.add(eqSel); if (eqSet.has(key)) eqSet.delete(key); else eqSet.add(key); eqSel = eqSet.size ? [...eqSet].pop() : null; if (eqSet.size < 2) eqSet.clear(); }
  else { eqSet.clear(); eqSel = key; }
  updateEqBar(); req();
}
function groupItems() { return [...eqSet].map(itemByKey).filter(Boolean); }

function eqTap(x, y, g) {
  if (eqTool === 'text') { textTap(x, y, g); return; }
  if (g.hk) { runSel = null; eqSelect(g.hk); return; }
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
  if (eqArm) { runSel = null; addItem(eqArm, toUnit(x, y)); req(); return; }
  if (g.hi) { runSel = null; if (g.mod) eqSelect(g.hi.key, true); else eqSelect(eqSel === g.hi.key && !eqSet.size ? null : g.hi.key); return; }
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
  if (!eqArm) eqSelect(it.key);
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
  if (eqSet.size > 1 && eqSet.has(it.key)) {
    pushUndo();
    gest.type = 'gdrag'; gest.u0 = toUnit(x, y);
    gest.grp = groupItems().map(q => { if (q.stackOn && !eqSet.has(q.stackOn)) unstack(q); return { q, x: q.x, y: q.y }; });
    try { navigator.vibrate && navigator.vibrate(15); } catch (e) { }
    updateEqBar(); req();
    return;
  }
  pushUndo();
  gest.type = 'idrag';
  const s = { x: it.x * view.s + view.tx, y: it.y * view.s + view.ty };
  gest.off = { x: s.x - x, y: s.y - y };
  gest.item = it;
  it.snap = -1;
  if (it.stackOn) unstack(it);
  gest.chain = new Set(it.isPt ? [] : chainUp(it).map(q => q.key));
  gest.stackTo = null;
  eqSel = it.key; updateEqBar();
  try { navigator.vibrate && navigator.vibrate(15); } catch (e) { }
  req();
}
function moveItemDrag(p) {
  const it = gest.item, u = toUnit(p.x + gest.off.x, p.y + gest.off.y);
  // slipp oppå et annet veggsymbol = stable. Måles fra der symbolet vil havne (ikke fingeren),
  // med lav terskel og litt slakk når stabling allerede vises, så det ikke stables ved et uhell.
  let target = null;
  if (infoOf(it.block).wall) {
    const sx = p.x + gest.off.x, sy = p.y + gest.off.y;
    let bd = gest.stackTo ? STACK_KEEP : STACK_PX;
    for (const q of EQ.items) {
      if (q === it || q.del || gest.chain.has(q.key) || !infoOf(q.block).wall || !doc.show[q.li]) continue;
      const c = { x: q.x * view.s + view.tx, y: q.y * view.s + view.ty }, d = Math.hypot(c.x - sx, c.y - sy);
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
  if (it.isPt) { it.pt.x = it.x; it.pt.y = it.y; it.pt._d = null; }
  resolveStacks();
  req();
}
function moveGroup(p) {
  const u = toUnit(p.x, p.y), dx = u.x - gest.u0.x, dy = u.y - gest.u0.y;
  for (const { q, x, y } of gest.grp) {
    if (q.stackOn && eqSet.has(q.stackOn)) continue;
    q.x = x + dx; q.y = y + dy;
    if (q.isPt) { q.pt.x = q.x; q.pt.y = q.y; q.pt._d = null; }
  }
  resolveStacks(); req();
}
function endGroupDrag() {
  gest.type = 'end';
  for (const { q } of gest.grp) if (q.added && !q.isPt) { q.ox = q.x; q.oy = q.y; }
  commitAll(); save(); updateEqBar(); updateTitle(); req();
}
function groupDelete() {
  pushUndo();
  for (const it of groupItems()) {
    if (it.isPt) { P.points = P.points.filter(q => q !== it.pt); continue; }
    if (inStack(it)) unstack(it);
    if (it.added) { P.eq.added = P.eq.added.filter(q => q.id !== it.id); EQ.items = EQ.items.filter(q => q !== it); }
    else it.del = true;
  }
  eqSet.clear(); eqSel = null;
  commitAll(); save(); updateEqBar(); updateTitle(); req();
}
function endItemDrag() {
  const it = gest.item;
  gest.type = 'end';
  delete it.snap;
  if (it.added) { it.ox = it.x; it.oy = it.y; it.or = it.r; }
  if (gest.stackTo) toast('Stablet på ' + cap(prettyBlock(gest.stackTo.block)));
  gest.stackTo = null;
  commitAll(); save(); updateEqBar(); updateTitle(); req();
}

/* ---------- Handlingslinje for valgt symbol / føring ---------- */
const ICP = {
  photo: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  note: '<path d="M4 5h16v11H9l-5 4z"/>',
  rot: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  flip: '<path d="M4 12h16M8 8l-4 4l4 4M16 8l4 4l-4 4"/>',
  swap: '<path d="M8 4v16M4 16l4 4l4-4M16 20V4M12 8l4-4l4 4"/>',
  dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  reset: '<path d="M4 4v6h6"/><path d="M4.5 15a8 8 0 1 0 1.9-8.3L4 10"/>',
  del: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  multi: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M13 7h4v4M7 13v4h4"/>',
  bend: '<path d="M4 18C6 8 18 8 20 18"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'
};
function ic(n) { return `<svg class="ic" viewBox="0 0 24 24">${ICP[n] || ''}</svg>`; }
function abtn(a, icon, label, cls) { return `<button data-a="${a}" class="${cls || ''}">${icon && icon[0] === '<' ? icon : ic(icon)}<span>${label}</span></button>`; }
function eqDragging() { return gest && (gest.type === 'idrag' || gest.type === 'tdrag' || gest.type === 'gdrag'); }
function setEqSheet(on) {
  const bar = $('#eqbar'), was = bar.classList.contains('on');
  if (was === on) return;
  bar.classList.toggle('on', on);
  $('#ed').classList.toggle('eqsel', on);
  if (!on) bar.dataset.k = '';
  requestAnimationFrame(() => { resize(); if (on) ensureSelVisible(); });
}
function ensureSelVisible() {
  const a = selAnchor();
  if (!a) return;
  const m = Math.min(60, ch * 0.15);
  let dx = 0, dy = 0;
  if (a.y - a.r < m || (a.yb != null ? a.yb : a.y) + a.r > ch - m) dy = ch * 0.42 - a.y;
  if (a.x < m || a.x > cw - m) dx = cw / 2 - a.x;
  if (dx || dy) { view.tx += dx; view.ty += dy; afterView(); }
}
let hlKurs = null; // { key, keys:Set } – utstyr på samme kurs som valgt symbol
function findKurs(it) {
  if (!it || typeof circuitItems !== 'function') return null;
  const ks = Object.keys(P.eq.kurs || {});
  const order = kursOf(it.key) ? [it.key, ...ks] : ks;
  for (const k of order) {
    if (!itemByKey(k)) continue;
    const items = circuitItems(k);
    if (items.some(q => q.key === it.key)) return { key: k, keys: new Set(items.map(q => q.key)) };
  }
  return null;
}
function drawKursHl(ctx, v, dpr, o) {
  if (o.export || !hlKurs) return;
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(249,115,22,.45)'; ctx.lineWidth = 9;
  for (const run of (P.eq.runs || [])) {
    if (!hlKurs.keys.has(run.a) || !hlKurs.keys.has(run.b)) continue;
    const g = runGeom(run); if (!g) continue;
    ctx.beginPath(); g.pts.forEach((p, i) => { const x = p.x * v.s + v.tx, y = p.y * v.s + v.ty; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(249,115,22,.22)'; ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2;
  for (const k of hlKurs.keys) {
    const it = itemByKey(k); if (!it || it.del) continue;
    const c = itemCenter(it), r = Math.max(14, itemRad(it) * v.s + 6);
    ctx.beginPath(); ctx.arc(c.x * v.s + v.tx, c.y * v.s + v.ty, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}
function updateEqBar() {
  const bar = $('#eqbar');
  if (eqDragging()) return;
  const run = runSel && (P.eq.runs || []).find(r => r.id === runSel);
  const it = !run && eqSel && itemByKey(eqSel);
  const te = eqTool === 'text' && txtSel && allTextDisp().find(q => q.key === txtSel);
  let title = '', sub = '', acts = '', hint = '';
  hlKurs = it && !it.del && eqSet.size <= 1 ? findKurs(it) : null;
  if (eqSet.size > 1 && eqTool === 'sel' && eqActive()) {
    title = `${eqSet.size} symboler valgt`;
    hint = 'Dra ett av dem for å flytte alle samlet.';
    acts = abtn('gdel', 'del', 'Slett alle', 'dz') + abtn('gnone', 'x', 'Fjern valg');
  } else if (!eqActive() || (!te && !run && (!it || it.del))) {
    $('#npick').classList.remove('on');
    setEqSheet(false); return;
  } else if (te) {
    const sel = selTexts(), n = sel.length;
    title = n > 1 ? n + ' tekster valgt' : 'Tekst';
    sub = n === 1 ? (te.text || '').replace(/\n/g, ' ').slice(0, 60) : '';
    acts = (n === 1 ? abtn('tedit', 'edit', 'Endre') : '')
      + (sel.some(q => (q.note ? notesMap()[q.note.key].lx != null : !q.added && txtEd(q.key))) ? abtn('treset', 'reset', 'Original') : '')
      + abtn('tmulti', 'multi', 'Velg flere', txtMulti ? 'on' : '') + abtn('tdel', 'del', 'Slett', 'dz');
  } else if (run) {
    title = 'Føring'; sub = 'Skjult anlegg';
    acts = abtn('rflip', 'flip', 'Bøy motsatt') + abtn('rbend', 'bend', 'Mer/mindre bue') + abtn('rdel', 'del', 'Slett', 'dz');
  } else {
    const k = kursOf(it.key);
    const hk = hlKurs && kursOf(hlKurs.key);
    const kt = hk ? kursText(hk).replace('\n', ' ') + ` (${hlKurs.keys.size} på kursen)` : '';
    const room = typeof roomOf === 'function' ? roomOf(it) : '';
    const nph = typeof photosOf === 'function' ? photosOf(it.key).length : 0;
    const kb = abtn('kurs', `<b>${k ? esc(kursText(k).split('\n').pop()) : '-F'}</b>`, k ? 'Kurs' : 'Kursmerke', k ? 'on' : '');
    const pb = abtn('photo', 'photo', nph ? `Bilder (${nph})` : 'Bilde');
    const nb = abtn('note', 'note', notesMap()[it.key] ? 'Endre notat' : 'Kommentar');
    if (it.isPt) {
      title = (TYPES[it.pt.type] || TYPES.downlight).name;
      sub = [room, kt, 'takpunkt'].filter(Boolean).join(' · ');
      acts = pb + nb + kb + abtn('del', 'del', 'Slett', 'dz');
    } else {
      title = cap(prettyBlock(it.block)) + (countable(it.block) ? `, ${it.n} uttak` : '');
      sub = [room, kt, it.added ? 'lagt til' : isMoved(it) ? 'flyttet' : 'som prosjektert', inStack(it) ? 'i stabel' : ''].filter(Boolean).join(' · ');
      acts = pb + nb
        + (countable(it.block) ? abtn('n', `<b>${it.n}×</b>`, 'Uttak') : '') + kb
        + (inStack(it) ? abtn('swap', 'swap', 'Bytt i stabel') : abtn('rot', 'rot', 'Roter') + abtn('flip', 'flip', 'Snu'))
        + abtn('dup', 'dup', 'Kopier')
        + (isMoved(it) ? abtn('reset', 'reset', 'Prosjektert') : '')
        + abtn('del', 'del', 'Slett', 'dz');
    }
  }
  const html = `<div class="hd"><div class="tt"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div><button class="ib" data-a="close" aria-label="Lukk">${ic('x')}</button></div>`
    + (hint ? `<p class="hint">${hint}</p>` : '') + `<div class="acts">${acts}</div>`;
  if (bar.dataset.k !== html) {
    bar.innerHTML = html; bar.dataset.k = html;
    bar.querySelectorAll('[data-a]').forEach(b => b.onclick = () => eqAction(b.dataset.a));
  }
  setEqSheet(true);
}
function selAnchor() {
  if (eqSet.size > 1 && eqTool === 'sel') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of groupItems()) { const c = itemCenter(it), X = c.x * view.s + view.tx, Y = c.y * view.s + view.ty; x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y); }
    return { x: (x0 + x1) / 2, y: y0, r: 20, yb: y1 };
  }
  if (eqTool === 'text' && txtSel) return txtAnchor();
  const run = runSel && (P.eq.runs || []).find(r => r.id === runSel);
  if (run) { const g = runGeom(run); return g ? { x: g.apex.x * view.s + view.tx, y: g.apex.y * view.s + view.ty, r: 14 } : null; }
  const it = itemByKey(eqSel);
  if (!it) return null;
  const g = doc.geom(it.block), c = itemCenter(it);
  return { x: c.x * view.s + view.tx, y: c.y * view.s + view.ty, r: Math.max(22, (g ? g.rad * Math.abs(it.sx) : 0) * view.s + 10) };
}
function positionEqBar() { }
function openNPick(it) {
  const np = $('#npick');
  np.innerHTML = [1, 2, 3, 4, 5, 6].map(n => `<button data-n="${n}" class="${n === it.n ? 'on' : ''}">${n}</button>`).join('');
  np.querySelectorAll('[data-n]').forEach(b => b.onclick = () => {
    pushUndo(); it.n = +b.dataset.n; commitItem(it); save();
    np.classList.remove('on'); updateEqBar(); updateTitle(); req();
  });
  np.classList.add('on');
}
function eqAction(a) {
  if (a === 'close') { $('#npick').classList.remove('on'); if (eqTool === 'text') { txtClear(); } eqSet.clear(); eqSel = null; runSel = null; updateEqBar(); req(); return; }
  if (a === 'gdel') return groupDelete();
  if (a === 'gnone') { eqSet.clear(); eqSel = null; updateEqBar(); req(); return; }
  if (a === 'tedit' || a === 'treset' || a === 'tdel' || a === 'tmulti') return textAction(a);
  if (a[0] === 'r' && a !== 'rot' && a !== 'reset') return runAction(a);
  const it = itemByKey(eqSel);
  if (!it) return;
  if (a === 'kurs') { editKurs(it.key); return; }
  if (a === 'note') { noteDlg(it); return; }
  if (a === 'photo') { openPhotos(it.key, it.isPt ? (TYPES[it.pt.type] || TYPES.downlight).name : cap(prettyBlock(it.block))); return; }
  if (it.isPt) {
    if (a === 'del') { pushUndo(); P.points = P.points.filter(q => q !== it.pt); eqSel = null; save(); updateEqBar(); updateTitle(); req(); }
    return;
  }
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

/* ---------- Kursnummer ved første boks etter tavla (sirkel med -F3, ev. =433.11) ---------- */
const KURS_H = 100; // teksthøyde i mm
function kursMap() { return (P.eq.kurs = P.eq.kurs || {}); }
function kursOf(key) { return P.eq && P.eq.kurs && P.eq.kurs[key]; }
function kursText(k) { return (k.f ? k.f + '\n' : '') + '-F' + k.k; }
function tavlePos() {
  const t = EQ.items.find(i => !i.del && /tavle|sikring|fordeling/i.test(i.block));
  return t ? itemCenter(t) : null;
}
function kursGeom(key) {
  const k = kursOf(key), it = itemByKey(key);
  if (!k || !it) return null;
  const mpu = P.mmPerUnit || 1, h = KURS_H / mpu;
  const lines = kursText(k).split('\n');
  const fs = h / 0.718, w = Math.max(...lines.map(l => textW(l, fs)));
  const R = Math.hypot(w / 2, lines.length * 1.66 * h / 2 * 0.9) + 0.35 * h;
  const c = itemCenter(it), g = doc.geom(it.block), ir = g ? g.rad * Math.abs(it.sx) : 100 / mpu;
  let dx = k.dx, dy = k.dy;
  if (dx == null) {
    const t = tavlePos();
    let ux = -0.7071, uy = -0.7071;
    if (t) { const d = Math.hypot(t.x - c.x, t.y - c.y); if (d > 1e-6) { ux = (t.x - c.x) / d; uy = (t.y - c.y) / d; } }
    const dist = ir + R + 250 / mpu;
    dx = ux * dist; dy = uy * dist;
  }
  const cx = c.x + dx, cy = c.y + dy, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  return { cx, cy, R, h, lines, a: { x: c.x + ux * ir * 0.9, y: c.y + uy * ir * 0.9 }, b: { x: cx - ux * R, y: cy - uy * R }, col: '#dc2626' };
}
function kursColor() {
  const li = doc.r.layers.findIndex(l => l.name === runLayer());
  return li >= 0 ? aci(doc.r.layers[li].color) : '#dc2626';
}
function drawKurs(ctx, v, dpr, o) {
  const m = P.eq && P.eq.kurs;
  if (!m) return;
  const col = kursColor();
  for (const key of Object.keys(m)) {
    const G = kursGeom(key);
    if (!G) continue;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = col; ctx.lineWidth = 1.2 * (o.k || 1);
    ctx.beginPath(); ctx.moveTo(G.a.x * v.s + v.tx, G.a.y * v.s + v.ty); ctx.lineTo(G.b.x * v.s + v.tx, G.b.y * v.s + v.ty); ctx.stroke();
    ctx.lineWidth = 1.6 * (o.k || 1);
    ctx.beginPath(); ctx.arc(G.cx * v.s + v.tx, G.cy * v.s + v.ty, G.R * v.s, 0, Math.PI * 2); ctx.stroke();
    ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
    drawText(ctx, { x: G.cx, y: G.cy, h: G.h, rot: 0, s: G.lines.join('\n'), ha: 'center', va: 'middle' }, v, 0, 0, col, 0, 0);
    ctx.restore();
  }
}
function hitKurs(x, y) {
  const m = P && P.eq && P.eq.kurs;
  if (!m) return null;
  for (const key of Object.keys(m)) {
    const G = kursGeom(key);
    if (G && Math.hypot(G.cx * view.s + view.tx - x, G.cy * view.s + view.ty - y) < Math.max(22, G.R * view.s + 6)) return key;
  }
  return null;
}
function moveKurs(key, p) {
  const k = kursOf(key), it = itemByKey(key);
  if (!k || !it) return;
  const u = toUnit(p.x, p.y), c = itemCenter(it);
  k.dx = u.x - c.x; k.dy = u.y - c.y;
  req();
}
function nextKurs() {
  const nums = Object.values(kursMap()).map(k => parseInt(k.k, 10)).filter(n => !isNaN(n));
  return nums.length ? String(Math.max(...nums) + 1) : '1';
}
function editKurs(key) {
  const cur = kursOf(key);
  const lastF = P.eq.lastFord || '';
  dialog(`<h2>Kursnummer</h2><p>Merker første punkt etter sikringsskapet.</p>
    <label class="f">Kurs</label>
    <div style="display:flex;align-items:center;gap:8px"><span class="bigin" style="flex:none">-F</span><input id="kIn" class="bigin" inputmode="numeric" autocomplete="off" value="${esc(cur ? cur.k : nextKurs())}"></div>
    <label class="f">Fordeling – bare ved flere tavler (f.eks. =433.11)</label>
    <input id="fIn" autocomplete="off" placeholder="Tom = ikke vis" value="${esc(cur ? (cur.f || '') : lastF)}">
    <p id="kPrev" style="color:var(--text);font-weight:600"></p>
    <div class="btns">${cur ? '<button class="danger" data-del>Fjern</button>' : ''}<button data-x>Avbryt</button><button class="primary" data-ok>OK</button></div>`, (el, close) => {
    const ki = $('#kIn', el), fi = $('#fIn', el), pv = $('#kPrev', el);
    const norm = () => { let f = fi.value.trim(); if (f && f[0] !== '=') f = '=' + f; return f; };
    const upd = () => { pv.textContent = ki.value.trim() ? 'Vises som: ' + (norm() ? norm() + ' ' : '') + '-F' + ki.value.trim() : ''; };
    ki.oninput = upd; fi.oninput = upd; upd();
    setTimeout(() => { ki.focus(); ki.select(); }, 60);
    const ok = () => {
      const k = ki.value.trim().replace(/^-?F/i, '');
      if (!k) return;
      pushUndo();
      const f = norm();
      kursMap()[key] = Object.assign(cur || {}, { k, f: f || undefined });
      P.eq.lastFord = f;
      close(); save(); updateEqBar(); req();
    };
    $('[data-ok]', el).onclick = ok;
    ki.onkeydown = e => { if (e.key === 'Enter') ok(); };
    $('[data-x]', el).onclick = close;
    const d = $('[data-del]', el);
    if (d) d.onclick = () => { pushUndo(); delete kursMap()[key]; close(); save(); updateEqBar(); req(); };
  });
}
function kursExport(layer) {
  const out = [], f = DXF.fmtN, m = (P.eq && P.eq.kurs) || {};
  for (const key of Object.keys(m)) {
    const G = kursGeom(key);
    if (!G) continue;
    const base = [[100, 'AcDbEntity'], [8, layer], [6, 'Continuous']];
    out.push({ type: 'LINE', pairs: base.concat([[100, 'AcDbLine'], [10, f(G.a.x)], [20, f(-G.a.y)], [30, '0'], [11, f(G.b.x)], [21, f(-G.b.y)], [31, '0']]) });
    out.push({ type: 'CIRCLE', pairs: base.concat([[100, 'AcDbCircle'], [10, f(G.cx)], [20, f(-G.cy)], [30, '0'], [40, f(G.R)]]) });
    const ls = 1.66 * G.h, n = G.lines.length;
    G.lines.forEach((ln, i) => {
      const y = G.cy - (n - 1) * ls / 2 + i * ls;
      out.push({ type: 'TEXT', pairs: base.concat([[100, 'AcDbText'], [10, f(G.cx)], [20, f(-y)], [30, '0'], [40, f(G.h)], [1, ln], [72, '1'], [11, f(G.cx)], [21, f(-y)], [31, '0'], [100, 'AcDbText'], [73, '2']]) });
    });
  }
  return out;
}

/* ---------- Tekster: flytt, endre, slett og legg til ---------- */
let txtSel = null, txtSet = new Set(), txtMulti = false;
function txtClear() { txtSel = null; txtSet.clear(); }
function txtSelect(key, add) {
  if (add) { if (txtSet.has(key)) { txtSet.delete(key); txtSel = [...txtSet].pop() || null; } else { txtSet.add(key); txtSel = key; } }
  else { txtSet = new Set([key]); txtSel = key; }
}
function selTexts() { const all = allTextDisp(); return all.filter(e => txtSet.has(e.key)); }
function txtStore() { if (!P.eq) P.eq = { edits: {}, added: [] }; return (P.eq.texts = P.eq.texts || { edits: {}, added: [] }); }
function tKey(t) { return t && t.rec ? 't' + t.rec.ln : null; }
function txtEd(k) { return k && P && P.eq && P.eq.texts ? P.eq.texts.edits[k] : null; }
function staticDisp(t) {
  const e = txtEd(tKey(t));
  if (!e) return t;
  if (e.del) return null;
  return { ...t, x: t.x + (e.dx || 0), y: t.y + (e.dy || 0), s: e.s != null ? e.s : t.s };
}
function labelDisp(it, t) {
  const e = txtEd(tKey(t)) || {};
  if (e.del) return null;
  let s = e.s != null ? e.s : t.s;
  if (t === it.numLabel) { if (it.n < 2) return null; s = String(it.n); }
  const dr = it.r - it.or, c = Math.cos(dr), sn = Math.sin(dr), ax = t.x - it.ox, ay = t.y - it.oy;
  return { ...t, x: it.x + c * ax - sn * ay + (e.dx || 0), y: it.y + sn * ax + c * ay + (e.dy || 0), s };
}
function addedDisp(a) { return { x: a.x, y: a.y, h: a.h, rot: 0, ha: 'left', va: 'alphabetic', s: a.s, l: Math.max(0, layerIndex(a.layer)) }; }
/* Kommentarer på utstyr («Komfyrvakt», «o/benk» …) – følger symbolet */
const NOTE_SUGG = ['Komfyrvakt', 'o/benk', 'Kjøl/frys', 'Oppvaskmaskin', 'Stekeovn', 'Mikro', 'Vaskemaskin', 'Tørketrommel', 'VVB', 'IP44', 'Utvendig', 'TV', 'Data'];
function notesMap() { return (P.eq.notes = P.eq.notes || {}); }
function noteH() { const hs = doc.texts.filter(t => t.item).map(t => t.h).sort((a, b) => a - b); return hs.length ? hs[hs.length >> 1] : 100 / (P.mmPerUnit || 1); }
function noteLayer(it) { const l = doc.r.layers.find(l => /tekst|text/i.test(l.name) && /^e/i.test(l.name)); return l ? l.name : it.layer; }
function noteDefault(it) {
  const mpu = P.mmPerUnit || 1, g = doc.geom(it.block), rad = g ? g.rad * Math.abs(it.sx) : 100 / mpu, info = infoOf(it.block);
  if (info.wall) { const a = info.local + Math.PI, d = rad + 260 / mpu; return { lx: Math.cos(a) * d, ly: Math.sin(a) * d }; }
  return { lx: rad + 260 / mpu, ly: -rad * 0.6 };
}
function noteDisp(it) {
  const n = P.eq && P.eq.notes && P.eq.notes[it.key];
  if (!n || it.del) return null;
  const loc = n.lx != null ? n : noteDefault(it), c = itemCenter(it), cs = Math.cos(it.r), sn = Math.sin(it.r);
  const li = Math.max(0, layerIndex(noteLayer(it)));
  return { x: c.x + cs * loc.lx - sn * loc.ly, y: c.y + sn * loc.lx + cs * loc.ly, h: noteH(), rot: 0, ha: 'center', va: 'middle', s: n.s, l: li };
}
// strek fra kommentar til symbol: alltid / aldri / automatisk (når kommentaren er flyttet et stykke unna)
function noteLeader(it) {
  const n = P.eq.notes[it.key], d = noteDisp(it);
  if (!d || n.leader === false) return null;
  const mpu = P.mmPerUnit || 1, g = doc.geom(it.block), rad = g ? g.rad * Math.abs(it.sx) : 100 / mpu, c = itemCenter(it);
  const dx = c.x - d.x, dy = c.y - d.y, L = Math.hypot(dx, dy);
  if (n.leader !== true && (n.lx == null || L < rad + 450 / mpu)) return null;
  if (L < 1e-6) return null;
  const ux = dx / L, uy = dy / L, pad = d.h * 0.35;
  const hw = textW(d.s, d.h * 100 / 70) / 2 + pad, hh = d.h / 2 + pad;
  const t = Math.min(Math.abs(ux) > 1e-9 ? hw / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? hh / Math.abs(uy) : Infinity);
  if (t >= L - rad) return null;
  return { a: { x: d.x + ux * t, y: d.y + uy * t }, b: { x: c.x - ux * rad * 0.9, y: c.y - uy * rad * 0.9 } };
}
function setNoteWorld(it, w) {
  const n = notesMap()[it.key], c = itemCenter(it), cs = Math.cos(-it.r), sn = Math.sin(-it.r), dx = w.x - c.x, dy = w.y - c.y;
  n.lx = cs * dx - sn * dy; n.ly = sn * dx + cs * dy;
}
function drawNotes(ctx, v, dpr, W, H) {
  const m = P.eq && P.eq.notes;
  if (!m) return;
  ctx.save();
  ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
  for (const k of Object.keys(m)) {
    const it = itemByKey(k), d = it && noteDisp(it);
    if (!d) continue;
    const col = aci(doc.r.layers[d.l].color);
    drawText(ctx, d, v, W, H, col, 0, 0);
    const ld = noteLeader(it);
    if (ld) { ctx.strokeStyle = col; ctx.lineWidth = 1 / v.s; ctx.beginPath(); ctx.moveTo(ld.a.x, ld.a.y); ctx.lineTo(ld.b.x, ld.b.y); ctx.stroke(); }
  }
  ctx.restore();
}
function noteDlg(it) {
  const cur = P.eq.notes && P.eq.notes[it.key];
  dialog(`<h2>Kommentar</h2><p>Vises ved symbolet og følger det når det flyttes.</p>
    <div class="quick">${NOTE_SUGG.map(s => `<button data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <input id="nIn" autocomplete="off" placeholder="Egen tekst, f.eks. plasseres over benk" value="${esc(cur ? cur.s : '')}">
    <div class="setrow"><span>Strek til symbolet</span><select id="nLd"><option value="auto">Automatisk</option><option value="on">Alltid</option><option value="off">Aldri</option></select></div>
    <p style="font-size:13px">Automatisk: strek når kommentaren er flyttet et stykke bort fra symbolet (med tekstverktøyet T).</p>
    <div class="btns">${cur ? '<button class="danger" data-del>Fjern</button>' : ''}<button data-x>Avbryt</button><button class="primary" data-ok>OK</button></div>`, (el, close) => {
    const inp = $('#nIn', el), ld = $('#nLd', el);
    ld.value = !cur || cur.leader == null ? 'auto' : cur.leader ? 'on' : 'off';
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => inp.focus(), 60);
    const ok = () => {
      const v = inp.value.trim();
      if (!v) return;
      pushUndo();
      const m = notesMap();
      m[it.key] = Object.assign(m[it.key] || {}, { s: v, leader: ld.value === 'auto' ? undefined : ld.value === 'on' });
      close(); save(); updateEqBar(); req();
    };
    el.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { inp.value = b.dataset.s; ok(); });
    $('[data-ok]', el).onclick = ok; inp.onkeydown = ev => { if (ev.key === 'Enter') ok(); };
    $('[data-x]', el).onclick = close;
    const d = $('[data-del]', el);
    if (d) d.onclick = () => { pushUndo(); delete notesMap()[it.key]; close(); save(); updateEqBar(); req(); };
  });
}

// alle tekster som kan velges, med posisjonen de vises på
function allTextDisp() {
  const out = [];
  for (const t of doc.texts) {
    if (t.item || !t.rec || !doc.show[t.l]) continue;
    const d = staticDisp(t); if (d) out.push({ key: tKey(t), d, base: t });
  }
  for (const it of EQ.items) {
    if (it.del || !doc.show[it.li]) continue;
    for (const t of it.labels) { const d = labelDisp(it, t); if (d) out.push({ key: tKey(t), d, base: t, item: it }); }
  }
  for (const a of ((P.eq && P.eq.texts && P.eq.texts.added) || [])) out.push({ key: 'n' + a.id, d: addedDisp(a), added: a });
  for (const k of Object.keys((P.eq && P.eq.notes) || {})) { const it = itemByKey(k), d = it && noteDisp(it); if (d && doc.show[it.li]) out.push({ key: 'c' + k, d, note: it }); }
  return out;
}
// tekstens grenser i dens eget (roterte) koordinatsystem
function textBox(d) {
  const fs = d.h * 100 / 70, lines = String(d.s).split('\n'), ls = 1.66 * d.h;
  const w = Math.max(...lines.map(l => textW(l, fs))), hh = d.h + (lines.length - 1) * ls;
  const x0 = d.ha === 'center' ? -w / 2 : d.ha === 'right' ? -w : 0;
  const y0 = d.va === 'top' ? 0 : d.va === 'middle' ? -hh / 2 : d.va === 'bottom' ? -hh : -d.h;
  return { x0, y0, x1: x0 + w, y1: y0 + hh };
}
function hitText(x, y) {
  const u = toUnit(x, y), pad = 8 / view.s;
  let best = null, bd = Infinity;
  for (const e of allTextDisp()) {
    const d = e.d, b = textBox(d), c = Math.cos(d.rot), s = Math.sin(d.rot);
    const px = u.x - d.x, py = u.y - d.y, lx = c * px - s * py, ly = s * px + c * py;
    if (lx < b.x0 - pad || lx > b.x1 + pad || ly < b.y0 - pad || ly > b.y1 + pad) continue;
    const cd = Math.hypot(lx - (b.x0 + b.x1) / 2, ly - (b.y0 + b.y1) / 2);
    if (cd < bd) { bd = cd; best = e; }
  }
  return best;
}
function drawAddedTexts(ctx, v, dpr, W, H) {
  const list = (P.eq && P.eq.texts && P.eq.texts.added) || [];
  if (!list.length) return;
  ctx.save();
  ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
  for (const a of list) { const d = addedDisp(a); drawText(ctx, d, v, W, H, aci(doc.r.layers[d.l] ? doc.r.layers[d.l].color : 7), 0, 0); }
  ctx.restore();
}
function drawTextSel(ctx, v, dpr) {
  for (const e of selTexts()) drawTextBox(ctx, v, dpr, e);
}
function drawTextBox(ctx, v, dpr, e) {
  const d = e.d, b = textBox(d), c = Math.cos(-d.rot), s = Math.sin(-d.rot), pad = 4 / v.s;
  const P4 = [[b.x0 - pad, b.y0 - pad], [b.x1 + pad, b.y0 - pad], [b.x1 + pad, b.y1 + pad], [b.x0 - pad, b.y1 + pad]]
    .map(([lx, ly]) => [(d.x + c * lx - s * ly) * v.s + v.tx, (d.y + s * lx + c * ly) * v.s + v.ty]);
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
  ctx.beginPath(); P4.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke();
  ctx.restore();
}
// ramme rundt alle valgte tekster (skjerm) – handlingslinjen legges utenfor den
function txtAnchor() {
  const sel = selTexts();
  if (!sel.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of sel) {
    const d = e.d, b = textBox(d), c = Math.cos(-d.rot), s = Math.sin(-d.rot);
    for (const [lx, ly] of [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]) {
      const X = (d.x + c * lx - s * ly) * view.s + view.tx, Y = (d.y + s * lx + c * ly) * view.s + view.ty;
      x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
    }
  }
  return { x: (x0 + x1) / 2, y: y0, r: 6, yb: y1 };
}
function setTextTool(on) {
  if (on) { if (eqTool === 'run') setRunTool(false); setArm(null); eqSel = null; runSel = null; }
  eqTool = on ? 'text' : 'sel';
  txtClear(); txtMulti = false;
  $('#txtBtn').classList.toggle('on', on); updToolsBtn();
  if (on) setBanner('Tekst: trykk = endre · hold og dra = flytt · tomt sted = ny tekst', 'Ferdig', () => setTextTool(false));
  else setBanner(null);
  updateEqBar(); req();
}
$('#txtBtn').onclick = () => setTextTool(eqTool !== 'text');
function textTap(x, y, g) {
  if (g.ht) { txtSelect(g.ht.key, txtMulti || g.mod); updateEqBar(); req(); return; }
  if (txtSel) { txtClear(); txtMulti = false; updateEqBar(); req(); return; }
  newTextAt(toUnit(x, y));
}
function startTextDrag(e) {
  if (!gest || gest.type !== 'pending') return;
  pushUndo();
  gest.type = 'tdrag'; gest.u0 = toUnit(gest.x0, gest.y0);
  if (!txtSet.has(e.key)) txtSelect(e.key, txtMulti || gest.mod);
  else txtSel = e.key;
  gest.txts = selTexts().map(q => ({ q, o0: q.note ? { x: q.d.x, y: q.d.y } : q.added ? { x: q.added.x, y: q.added.y } : (() => { const ed = txtStore().edits[q.key] || {}; return { x: ed.dx || 0, y: ed.dy || 0 }; })() }));
  updateEqBar();
  try { navigator.vibrate && navigator.vibrate(15); } catch (er) { }
  req();
}
function moveText(p) {
  const u = toUnit(p.x, p.y), dx = u.x - gest.u0.x, dy = u.y - gest.u0.y, st = txtStore();
  for (const { q, o0 } of gest.txts) {
    if (q.note) setNoteWorld(q.note, { x: o0.x + dx, y: o0.y + dy });
    else if (q.added) { q.added.x = o0.x + dx; q.added.y = o0.y + dy; }
    else { const ed = st.edits[q.key] || (st.edits[q.key] = {}); ed.dx = o0.x + dx; ed.dy = o0.y + dy; }
  }
  req();
}
function endTextDrag() { gest.type = 'end'; save(); updateEqBar(); req(); }
function textAction(a) {
  const sel = selTexts();
  if (!sel.length && a !== 'tmulti') return;
  const st = txtStore();
  if (a === 'tmulti') { txtMulti = !txtMulti; updateEqBar(); toast(txtMulti ? 'Trykk på flere tekster for å velge dem' : 'Velger én om gangen'); return; }
  if (a === 'tedit') { if (sel.length === 1) editTextDlg(sel[0]); return; }
  pushUndo();
  for (const e of sel) {
    if (e.note) {
      const n = notesMap()[e.note.key];
      if (a === 'tdel') delete notesMap()[e.note.key];
      else if (a === 'treset' && n) { delete n.lx; delete n.ly; }
      continue;
    }
    if (a === 'tdel') {
      if (e.added) st.added = st.added.filter(q => q !== e.added);
      else st.edits[e.key] = Object.assign(st.edits[e.key] || {}, { del: true });
    } else if (a === 'treset') delete st.edits[e.key];
  }
  if (a === 'tdel') { txtClear(); txtMulti = false; }
  save(); updateEqBar(); req();
}
function editTextDlg(e) {
  if (e.item && e.base === e.item.numLabel) { toast('Tallet styres av antall uttak – trykk på stikkontakten for å endre'); return; }
  dialog(`<h2>Endre tekst</h2><input id="tIn" value="${esc(e.d.s)}" autocomplete="off">
    <div class="btns"><button data-x>Avbryt</button><button class="primary" data-ok>OK</button></div>`, (el, close) => {
    const inp = $('#tIn', el); setTimeout(() => { inp.focus(); inp.select(); }, 60);
    const ok = () => {
      const v = inp.value;
      if (!v.trim()) return;
      pushUndo();
      if (e.note) notesMap()[e.note.key].s = v;
      else if (e.added) e.added.s = v;
      else { const st = txtStore(); st.edits[e.key] = Object.assign(st.edits[e.key] || {}, { s: v }); }
      close(); save(); updateEqBar(); req();
    };
    $('[data-ok]', el).onclick = ok; inp.onkeydown = ev => { if (ev.key === 'Enter') ok(); };
    $('[data-x]', el).onclick = close;
  });
}
function newTextAt(u) {
  const L = doc.r.layers;
  const tl = L.find(l => /tekst|text/i.test(l.name) && /^e/i.test(l.name)) || L.find((l, i) => doc.equip[i]) || { name: '0' };
  const hs = doc.texts.filter(t => t.item).map(t => t.h).sort((a, b) => a - b);
  const h = hs.length ? hs[Math.floor(hs.length / 2)] : 100 / (P.mmPerUnit || 1);
  dialog(`<h2>Ny tekst</h2><input id="tIn" autocomplete="off" placeholder="Tekst">
    <div class="btns"><button data-x>Avbryt</button><button class="primary" data-ok>Legg til</button></div>`, (el, close) => {
    const inp = $('#tIn', el); setTimeout(() => inp.focus(), 60);
    const ok = () => {
      const v = inp.value.trim();
      if (!v) return;
      pushUndo();
      const a = { id: uid(), x: u.x, y: u.y, h, s: v, layer: tl.name };
      txtStore().added.push(a);
      txtSelect('n' + a.id, false);
      close(); save(); updateEqBar(); req();
    };
    $('[data-ok]', el).onclick = ok; inp.onkeydown = ev => { if (ev.key === 'Enter') ok(); };
    $('[data-x]', el).onclick = close;
  });
}

/* ---------- Føringer (buet strek = skjult anlegg) ---------- */
function itemByKey(k) { return allItems().find(i => i.key === k && !i.del); }
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
  if (on && eqTool === 'text') setTextTool(false);
  eqTool = on ? 'run' : 'sel';
  runStart = null;
  $('#runBtn').classList.toggle('on', on); updToolsBtn();
  if (on) { setArm(null); eqSel = null; runSel = null; updateEqBar(); runBanner(); }
  else setBanner(null);
  req();
}
$('#runBtn').onclick = () => setRunTool(eqTool !== 'run');
function updToolsBtn() {
  const st = { sel: eqTool === 'sel' && !eqArm, run: eqTool === 'run', txt: eqTool === 'text' };
  for (const [id, on] of [['selBtn', st.sel], ['runBtn', st.run], ['txtBtn', st.txt]]) {
    const b = $('#' + id); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const c = $('#chgBtn'), con = S.showChg !== false;
  c.classList.toggle('on', con); c.setAttribute('aria-checked', con ? 'true' : 'false');
  $('small', c).textContent = con ? 'vises' : 'skjult';
}
$('#selBtn').onclick = () => {
  setArm(null);
  if (eqTool === 'run') setRunTool(false);
  if (eqTool === 'text') setTextTool(false);
  updToolsBtn();
};

/* ---------- Palett ---------- */
function prettyBlock(n) { return n.replace(/^(E|EL)[-_ ]/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function paletteBlocks() {
  const cnt = new Map();
  for (const it of EQ.items) if (!it.added) cnt.set(it.block, (cnt.get(it.block) || 0) + 1);
  for (const n of doc.r.blockNames) if (!cnt.has(n) && EQ_RE.test(n)) cnt.set(n, 0);
  const list = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  for (const b of LIB) {
    if (list.includes(b.name) || b.ceil) continue;
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
  if (name && eqTool === 'text') setTextTool(false);
  eqArm = name;
  document.querySelectorAll('#pal .pchip').forEach(b => b.classList.toggle('on', b.dataset.b === name));
  if (name) { eqSel = null; eqSet.clear(); runSel = null; updateEqBar(); setBanner(`<b>Plasserer: ${esc(cap(prettyBlock(name)))}</b><small>Trykk i tegningen for hvert symbol</small>`, 'Ferdig', () => setArm(null), true); }
  else setBanner(null);
  updToolsBtn(); req();
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
const STACK_PX = 14, STACK_KEEP = 22;
// Tilbakemelding under dra: vegg symbolet fester seg til, retning, og om slipp vil stable
function drawDragFx(ctx) {
  const tag = $('#dragTag');
  const it = gest && gest.type === 'idrag' && !gest.item.isPt ? gest.item : (palDrag && palDrag.inside ? palDrag : null);
  if (!it || !doc) { if (tag.classList.contains('on')) tag.classList.remove('on'); return; }
  const S_ = v => ({ x: v.x * view.s + view.tx, y: v.y * view.s + view.ty });
  const wall = infoOf(it.block).wall, stackTo = it === palDrag ? null : gest.stackTo;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let txt, cls = '';
  if (stackTo) {
    const c = S_(itemCenter(stackTo)), g = doc.geom(stackTo.block), r = Math.max(18, (g ? g.rad * Math.abs(stackTo.sx) : 0) * view.s + 8);
    ctx.strokeStyle = '#f97316'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
    txt = 'Stables på ' + cap(prettyBlock(stackTo.block)); cls = 'stack';
  } else if (wall && it.snap >= 0 && it._wn) {
    const sg = doc.r.segs, k = it.snap;
    const a = S_({ x: sg.x1[k], y: sg.y1[k] }), b = S_({ x: sg.x2[k], y: sg.y2[k] });
    ctx.strokeStyle = 'rgba(37,99,235,.55)'; ctx.lineWidth = 9; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    // retning: pil fra veggen og inn i rommet, slik symbolet blir stående
    const f = S_({ x: it._wn.px, y: it._wn.py }), L = 30, nx = it._wn.nx, ny = it._wn.ny;
    const e = { x: f.x + nx * L, y: f.y + ny * L };
    ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(e.x, e.y);
    ctx.moveTo(e.x - nx * 8 - ny * 6, e.y - ny * 8 + nx * 6); ctx.lineTo(e.x, e.y); ctx.lineTo(e.x - nx * 8 + ny * 6, e.y - ny * 8 - nx * 6); ctx.stroke();
    txt = 'Festes til vegg';
  } else txt = S.noSnap ? 'Fritt – festes ikke' : wall ? 'Ingen vegg i nærheten' : 'Plasseres fritt';
  ctx.restore();
  const c = S_(itemCenter(it));
  if (tag.textContent !== txt) tag.textContent = txt;
  tag.className = 'on ' + cls;
  tag.style.left = clamp(c.x - tag.offsetWidth / 2, 6, cw - tag.offsetWidth - 6) + 'px';
  tag.style.top = clamp(c.y - 70, 6, ch - 40) + 'px';
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
  if (mode === 'row') endRow();
  edMode = m;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('#tools').classList.toggle('eq', m === 'utstyr');
  setArm(null); if (eqTool === 'run') setRunTool(false); if (eqTool === 'text') setTextTool(false);
  eqSel = null; runSel = null; eqSet.clear(); select(null); updateEqBar(); updToolsBtn(); updateTitle(); req();
}
document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => setEdMode(b.dataset.m));
$('#chgBtn').onclick = () => {
  S.showChg = S.showChg === false; saveS();
  updToolsBtn();
  toast(S.showChg !== false ? 'Viser endringer mot prosjektert' : 'Skjuler endringer');
  req();
};

/* ---------- Eksport som DXF ---------- */
function eqChanges() {
  const moved = new Map(), deleted = new Set(), textMoves = new Map(), textDeletes = new Set();
  for (const it of EQ.items) {
    if (it.added) continue;
    if (it.del) { deleted.add(it.idx); it.labels.forEach(t => textDeletes.add(t.rec)); continue; }
    if (isMoved(it)) moved.set(it.idx, { x: it.x, y: it.y, r: it.r });
  }
  const textEdits = new Map();
  // tekster ved symbolene: følger symbolet + egen flytting/endring/sletting
  for (const it of EQ.items) {
    if (it.added || it.del) continue;
    for (const t of it.labels) {
      const e = txtEd(tKey(t)) || {};
      if (e.del) { textDeletes.add(t.rec); continue; }
      if (isMoved(it) || e.dx || e.dy) textMoves.set(t.rec, { ox: it.ox, oy: it.oy, nx: it.x + (e.dx || 0), ny: it.y + (e.dy || 0), dr: it.r - it.or });
      if (e.s != null && t !== it.numLabel) textEdits.set(t.rec, e.s);
    }
  }
  // øvrige tekster i tegningen
  for (const t of doc.texts) {
    if (t.item || !t.rec) continue;
    const e = txtEd(tKey(t));
    if (!e) continue;
    if (e.del) { textDeletes.add(t.rec); continue; }
    if (e.dx || e.dy) textMoves.set(t.rec, { ox: 0, oy: 0, nx: e.dx || 0, ny: e.dy || 0, dr: 0 });
    if (e.s != null) textEdits.set(t.rec, e.s);
  }
  const added = P.eq.added.map(a => ({ ...a }));
  const addedTexts = [], addedRaw = [];
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
  // takpunkter som innsatte blokker (lampepunkt bruker tegningens lysblokk hvis den finnes)
  for (const it of ptItems()) {
    let block = it.block, tmpl = null;
    if (it.pt.type === 'lampe') { const t = doc.r.inserts.find(i => doc.eqIns[i.idx] && /^E_LYS$|lys$/i.test(i.block) && !/vegg/i.test(i.block)); if (t) { block = t.block; tmpl = t.idx; } }
    added.push({ block, layer: it.layer, x: it.x, y: it.y, r: 0, sx: 1, sy: 1, tmpl, _pt: true });
  }
  const newBlocks = [];
  for (const it of EQ.items.concat(added.filter(a => a._pt).map(a => ({ added: true, block: a.block })))) {
    if (!it.added || it.del || doc.r.blockNames.includes(it.block) || newBlocks.some(b => b.name === it.block)) continue;
    const d = libDef(it.block);
    if (d) newBlocks.push({ name: d.name, ents: d.ents.map(libPairs) });
  }
  addedRaw.push(...kursExport(layer));
  for (const k of Object.keys(P.eq.notes || {})) {
    const it = itemByKey(k), d = it && noteDisp(it);
    if (!d) continue;
    addedRaw.push({ type: 'TEXT', pairs: [[100, 'AcDbEntity'], [8, noteLayer(it)], [100, 'AcDbText'], [10, f(d.x)], [20, f(-d.y)], [30, '0'], [40, f(d.h)], [1, d.s], [72, '1'], [11, f(d.x)], [21, f(-d.y)], [31, '0'], [100, 'AcDbText'], [73, '2']] });
    const ld = noteLeader(it);
    if (ld) addedRaw.push({ type: 'LINE', pairs: [[100, 'AcDbEntity'], [8, noteLayer(it)], [100, 'AcDbLine'], [10, f(ld.a.x)], [20, f(-ld.a.y)], [30, '0'], [11, f(ld.b.x)], [21, f(-ld.b.y)], [31, '0']] });
  }
  for (const a of txtStore().added) {
    const lines = a.s.split('\n'), ls = 1.66 * a.h;
    lines.forEach((ln, i) => addedRaw.push({ type: 'TEXT', pairs: [[100, 'AcDbEntity'], [8, a.layer], [100, 'AcDbText'], [10, f(a.x)], [20, f(-(a.y + i * ls))], [30, '0'], [40, f(a.h)], [1, ln], [100, 'AcDbText']] }));
  }
  return { moved, deleted, added, textMoves, textDeletes, textEdits, addedTexts, addedRaw, newBlocks };
}
async function exportDxf() {
  try {
    const txt = DXF.writeDXF(doc.r, eqChanges());
    await shareOrDownload(new Blob([txt], { type: 'application/dxf' }), safeName(P.name) + '_som-bygget.dxf', P.name);
  } catch (e) { toast('Kunne ikke lage DXF: ' + e.message); }
}
