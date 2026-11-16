'use strict';
/* Utstyrsmodus: flytt, legg til og fjern elektroutstyr (blokker) i DXF-tegninger.
   Veggmonterte symboler fester seg til nærmeste vegg og roteres automatisk. */

let edMode = 'mal';
const EQ = { items: [], info: {} };
let eqSel = null, eqArm = null;

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
      x: e.x ?? ins.x, y: e.y ?? ins.y, r: e.r ?? ins.r, del: !!e.del, added: false, labels: []
    });
  }
  for (const a of P.eq.added) {
    EQ.items.push({ key: 'a' + a.id, id: a.id, idx: null, block: a.block, layer: a.layer, li: Math.max(0, layerIndex(a.layer)),
      x: a.x, y: a.y, r: a.r, ox: a.x, oy: a.y, or: a.r, sx: a.sx || 1, sy: a.sy || 1, tmpl: a.tmpl, del: false, added: true, labels: [] });
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
  return EQ.info[block] || (EQ.info[block] = { wall: WALLMOUNT_RE.test(block), local: Math.PI / 2, off: 0 });
}
function isMoved(it) { return !it.added && (Math.abs(it.x - it.ox) > 1e-6 || Math.abs(it.y - it.oy) > 1e-6 || Math.abs(it.r - it.or) > 1e-6); }
function changeCount() { return EQ.items.filter(i => i.added || i.del || isMoved(i)).length; }

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
    if (a) Object.assign(a, { x: it.x, y: it.y, r: it.r });
  } else if (it.del || isMoved(it)) P.eq.edits[it.idx] = { x: it.x, y: it.y, r: it.r, del: it.del || undefined };
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
      for (const t of it.labels) {
        const ax = t.x - it.ox, ay = t.y - it.oy;
        drawText(ctx, t, v, W, H, col, it.x + c * ax - sn * ay - t.x, it.y + sn * ax + c * ay - t.y);
      }
      ctx.restore();
    }
    if (showChg && (moved || it.added)) {
      const c = itemCenter(it);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sx = c.x * v.s + v.tx + Math.max(10, g.rad * v.s * 0.8), sy = c.y * v.s + v.ty - Math.max(10, g.rad * v.s * 0.8);
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = it.added ? '#16a34a' : '#ea580c'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
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
  if (g.hi) { eqSelect(eqSel === g.hi.key ? null : g.hi.key); return; }
  if (eqArm) { addItem(eqArm, toUnit(x, y)); return; }
  eqSelect(null);
}
function templateFor(block) {
  const ins = doc.r.inserts.find(i => i.block === block && doc.eqIns[i.idx]) || doc.r.inserts.find(i => i.block === block);
  return ins || null;
}
function addItem(block, u) {
  pushUndo();
  const t = templateFor(block);
  const layer = t ? t.layer : (doc.r.layers.find((l, i) => doc.equip[i]) || { name: '0' }).name;
  const id = uid();
  const it = { key: 'a' + id, id, idx: null, added: true, block, layer, li: Math.max(0, layerIndex(layer)),
    x: u.x, y: u.y, r: t ? t.r : 0, sx: t ? t.sx : 1, sy: t ? t.sy : 1, tmpl: t ? t.idx : null, del: false, labels: [] };
  placeItem(it, u.x, u.y);
  it.ox = it.x; it.oy = it.y; it.or = it.r;
  EQ.items.push(it);
  P.eq.added.push({ id, block, layer, x: it.x, y: it.y, r: it.r, sx: it.sx, sy: it.sy, tmpl: it.tmpl });
  eqSelect(it.key);
  save();
  return it;
}

/* ---------- Dra ---------- */
function startItemDrag(it, x, y) {
  if (!gest || gest.type !== 'pending') return;
  pushUndo();
  gest.type = 'idrag';
  const s = { x: it.x * view.s + view.tx, y: it.y * view.s + view.ty };
  gest.off = { x: s.x - x, y: s.y - y };
  gest.item = it;
  it.snap = -1;
  eqSel = it.key; updateEqBar();
  try { navigator.vibrate && navigator.vibrate(15); } catch (e) { }
  req();
}
function moveItemDrag(p) {
  const it = gest.item, u = toUnit(p.x + gest.off.x, p.y + gest.off.y);
  placeItem(it, u.x, u.y);
  req();
}
function endItemDrag() {
  const it = gest.item;
  gest.type = 'end';
  delete it.snap;
  if (it.added) { it.ox = it.x; it.oy = it.y; it.or = it.r; }
  commitItem(it); save(); updateEqBar(); req();
}

/* ---------- Handlingslinje for valgt symbol ---------- */
function updateEqBar() {
  const bar = $('#eqbar');
  const it = eqSel && EQ.items.find(i => i.key === eqSel);
  if (!eqActive() || !it || it.del || (gest && gest.type === 'idrag')) { bar.classList.remove('on'); return; }
  $('#eqName').textContent = prettyBlock(it.block) + (it.added ? ' · ny' : isMoved(it) ? ' · flyttet' : '');
  $('#eqReset').style.display = isMoved(it) ? '' : 'none';
  bar.classList.add('on');
  positionEqBar();
}
function positionEqBar() {
  const bar = $('#eqbar');
  if (!bar.classList.contains('on')) return;
  const it = EQ.items.find(i => i.key === eqSel);
  if (!it) return;
  const g = doc.geom(it.block), c = itemCenter(it);
  const sx = c.x * view.s + view.tx, sy = c.y * view.s + view.ty;
  const rr = Math.max(22, (g ? g.rad * Math.abs(it.sx) : 0) * view.s + 10);
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let top = sy - rr - bh - 10;
  if (top < 8) top = sy + rr + 10;
  bar.style.left = clamp(sx - bw / 2, 8, cw - bw - 8) + 'px';
  bar.style.top = clamp(top, 8, ch - bh - 8) + 'px';
}
function eqAction(a) {
  const it = EQ.items.find(i => i.key === eqSel);
  if (!it) return;
  const mpu = P.mmPerUnit || 1;
  if (a === 'rot') { pushUndo(); it.r += Math.PI / 2; }
  else if (a === 'flip') {
    pushUndo();
    // snu til andre siden av veggen
    const info = infoOf(it.block);
    const tw = it.r + info.local, tx = Math.cos(tw), ty = Math.sin(tw);
    const w = doc.nearestWall(it.x + tx * (info.off + 1 / mpu), it.y + ty * (info.off + 1 / mpu), 600 / mpu, -1);
    // finn motsatt flate: gå gjennom veggen
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
    n.ox = n.x; n.oy = n.y; n.or = n.r; commitItem(n);
    toast('Kopi lagt til – hold inne for å flytte den');
  }
  else if (a === 'reset') { pushUndo(); it.x = it.ox; it.y = it.oy; it.r = it.or; }
  else if (a === 'del') {
    pushUndo();
    if (it.added) { P.eq.added = P.eq.added.filter(q => q.id !== it.id); EQ.items = EQ.items.filter(q => q !== it); }
    else it.del = true;
    eqSel = null;
  }
  if (a !== 'dup' && EQ.items.includes(it)) commitItem(it);
  save(); updateEqBar(); updateTitle(); req();
}
document.querySelectorAll('#eqbar [data-a]').forEach(b => b.onclick = () => eqAction(b.dataset.a));

/* ---------- Palett ---------- */
function prettyBlock(n) { return n.replace(/^(E|EL)[-_ ]/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function paletteBlocks() {
  const cnt = new Map();
  for (const it of EQ.items) if (!it.added) cnt.set(it.block, (cnt.get(it.block) || 0) + 1);
  for (const n of doc.r.blockNames) if (!cnt.has(n) && EQ_RE.test(n)) cnt.set(n, 0);
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
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
      const t = templateFor(name), col = t ? aci(doc.r.layers[t.li].color) : '#111';
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
      const t = templateFor(name);
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
  setArm(null);
  eqSel = null; select(null); updateEqBar(); updateTitle(); req();
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
  return { moved, deleted, added, textMoves, textDeletes };
}
async function exportDxf() {
  try {
    const txt = DXF.writeDXF(doc.r, eqChanges());
    await shareOrDownload(new Blob([txt], { type: 'application/dxf' }), safeName(P.name) + '_som-bygget.dxf', P.name);
  } catch (e) { toast('Kunne ikke lage DXF: ' + e.message); }
}
