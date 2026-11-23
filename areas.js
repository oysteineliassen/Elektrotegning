'use strict';
/* ---------- Varmekabelfelt ----------
   Trykk inne i et rom: feltet finnes automatisk fra veggene (dører lukkes), litt innenfor kantene.
   Hjørnene kan dras, og nye hjørner legges til med +-merkene midt på kantene. */
const VK_INSET = 100;     // mm fra vegg
const VK_DOOR = 550;      // mm: åpninger smalere enn 2×dette regnes som dør og lukkes
const VK_COL = '#b91c1c';
let areaSel = null;

function vkAreas() { P.eq.areas = P.eq.areas || []; return P.eq.areas; }
function vkStop() { }
function vkById(id) { return vkAreas().find(a => a.id === id); }
function polyArea(pts) { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }
function vkM2(a) { const mpu = P.mmPerUnit || 1; return polyArea(a.pts) * mpu * mpu / 1e6; }
function vkM2Txt(a) { return vkM2(a).toFixed(1).replace('.', ','); }
function polyCentroid(pts) {
  let cx = 0, cy = 0, A = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length], c = a[0] * b[1] - b[0] * a[1]; A += c; cx += (a[0] + b[0]) * c; cy += (a[1] + b[1]) * c; }
  if (!A) return { x: pts[0][0], y: pts[0][1] };
  return { x: cx / (3 * A), y: cy / (3 * A) };
}
function inPoly(x, y, pts) {
  let o = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) o = !o;
  }
  return o;
}
function nextVkLabel() { let n = 1; const used = new Set(vkAreas().map(a => a.label)); while (used.has('VK' + n)) n++; return 'VK' + n; }

// Avstandstransform i rutenett (sjakkbrett-avstand: gir rette hjørner og stopper ved døråpningen); frø = celler med verdi 1
function chamfer(seed, W, H) {
  const INF = 1e9, d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = seed[i] ? 0 : INF;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 3);
    if (y > 0) { v = Math.min(v, d[i - W] + 3); if (x > 0) v = Math.min(v, d[i - W - 1] + 3); if (x < W - 1) v = Math.min(v, d[i - W + 1] + 3); }
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = d[i];
    if (x < W - 1) v = Math.min(v, d[i + 1] + 3);
    if (y < H - 1) { v = Math.min(v, d[i + W] + 3); if (x < W - 1) v = Math.min(v, d[i + W + 1] + 3); if (x > 0) v = Math.min(v, d[i + W - 1] + 3); }
    d[i] = v;
  }
  for (let i = 0; i < W * H; i++) d[i] /= 3; // i celler
  return d;
}
// Romfelt rundt punkt u (tegningsenheter). Gir polygon [[x,y],...] eller null.
function roomPoly(u, insetMm) {
  const mpu = P.mmPerUnit || 1, cell = 40 / mpu, R = 12000 / mpu, b = doc.bounds;
  const x0 = Math.max(b.x0, u.x - R) - cell * 3, y0 = Math.max(b.y0, u.y - R) - cell * 3;
  const x1 = Math.min(b.x1, u.x + R) + cell * 3, y1 = Math.min(b.y1, u.y + R) + cell * 3;
  const W = Math.ceil((x1 - x0) / cell), H = Math.ceil((y1 - y0) / cell);
  if (W < 4 || H < 4 || W * H > 2.5e6) return null;
  const blk = new Uint8Array(W * H), sg = doc.r.segs;
  const mark = (x, y) => { const cx = Math.floor((x - x0) / cell), cy = Math.floor((y - y0) / cell); if (cx >= 0 && cy >= 0 && cx < W && cy < H) blk[cy * W + cx] = 1; };
  for (const k of doc.wallIdx) {
    const ax = sg.x1[k], ay = sg.y1[k], bx = sg.x2[k], by = sg.y2[k];
    if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cell * 0.5)));
    for (let i = 0; i <= n; i++) mark(ax + (bx - ax) * i / n, ay + (by - ay) * i / n);
  }
  const dw = chamfer(blk, W, H);
  const sx = Math.floor((u.x - x0) / cell), sy = Math.floor((u.y - y0) / cell), s0 = sy * W + sx;
  for (const doorMm of [VK_DOOR, VK_DOOR * 0.6, 150]) {
    const D = doorMm / mpu / cell;
    if (dw[s0] <= D) continue;
    // fyll rommet med dørene «lukket»
    const reg = new Uint8Array(W * H), q = [s0]; reg[s0] = 1; let open = false;
    while (q.length) {
      const i = q.pop(), x = i % W, y = (i - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { open = true; break; }
      for (const j of [i - 1, i + 1, i - W, i + W]) if (!reg[j] && dw[j] > D) { reg[j] = 1; q.push(j); }
    }
    if (open) return null;
    // vokse tilbake ut mot veggene, men holde avstand til dem
    const dr = chamfer(reg, W, H), ins = Math.max(1, (insetMm ?? VK_INSET) / mpu / cell);
    // alt utenfor rommet (vegger og døråpninger) regnes som kant, så avstanden holdes også mot døråpningen
    const ex = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) ex[i] = blk[i] || dr[i] > D ? 1 : 0;
    const de = chamfer(ex, W, H);
    const m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) m[i] = dr[i] <= D && de[i] > ins ? 1 : 0;
    // bare den sammenhengende delen der brukeren trykket
    const keep = new Uint8Array(W * H); let st = s0;
    if (!m[st]) { let best = 1e9; for (let i = 0; i < W * H; i++) if (m[i] && reg[i]) { const x = i % W, y = (i - x) / W, d = (x - sx) ** 2 + (y - sy) ** 2; if (d < best) { best = d; st = i; } } }
    if (!m[st]) return null;
    const q2 = [st]; keep[st] = 1;
    while (q2.length) { const i = q2.pop(); for (const j of [i - 1, i + 1, i - W, i + W]) if (j >= 0 && j < W * H && m[j] && !keep[j]) { keep[j] = 1; q2.push(j); } }
    const loop = traceMask(keep, W, H);
    if (!loop || loop.length < 3) return null;
    const simp = rdp(loop, 1.2);
    return simp.map(([x, y]) => [x0 + x * cell, y0 + y * cell]);
  }
  return null;
}
// ytre kontur av en maske som hjørnepunkter (cellekanter), lengste løkke
function traceMask(m, W, H) {
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x];
  const next = new Map(), key = (x, y) => y * (W + 1) + x;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) next.set(key(x, y), [x + 1, y]);
    if (!at(x + 1, y)) next.set(key(x + 1, y), [x + 1, y + 1]);
    if (!at(x, y + 1)) next.set(key(x + 1, y + 1), [x, y + 1]);
    if (!at(x - 1, y)) next.set(key(x, y + 1), [x, y]);
  }
  let best = null;
  const seen = new Set();
  for (const [k0] of next) {
    if (seen.has(k0)) continue;
    const loop = []; let k = k0, guard = 0;
    while (!seen.has(k) && next.has(k) && guard++ < 1e6) {
      seen.add(k); const x = k % (W + 1), y = (k - x) / (W + 1); loop.push([x, y]);
      const n = next.get(k); k = key(n[0], n[1]);
    }
    if (!best || loop.length > best.length) best = loop;
  }
  return best;
}
function rdp(pts, eps) {
  // lukket løkke: del i to ved det fjerneste punktet fra start
  const closedRdp = (p) => {
    if (p.length < 3) return p;
    const a = p[0], b = p[p.length - 1];
    let dm = 0, im = 0;
    for (let i = 1; i < p.length - 1; i++) {
      const d = segDist(p[i], a, b);
      if (d > dm) { dm = d; im = i; }
    }
    if (dm <= eps) return [a, b];
    const l = closedRdp(p.slice(0, im + 1)), r = closedRdp(p.slice(im));
    return l.slice(0, -1).concat(r);
  };
  let far = 0, fd = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = closedRdp(pts.slice(0, far + 1)), b = closedRdp(pts.slice(far).concat([pts[0]]));
  return a.slice(0, -1).concat(b.slice(0, -1));
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  if (!L) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function vkTap(u) {
  const poly = roomPoly(u, VK_INSET);
  if (!poly) { toast('Fant ikke et lukket rom her. Sjekk vegglagene, eller trykk midt i rommet.'); return; }
  pushUndo();
  const a = { id: uid(), label: nextVkLabel(), pts: poly, seed: [u.x, u.y], inset: VK_INSET };
  vkAreas().push(a);
  save(); setArm(null);
  selectArea(a.id);
  toast(`${a.label}: ${vkM2Txt(a)} m² – dra hjørnene for å justere`);
}
function selectArea(id) {
  areaSel = id;
  if (id) { eqSel = null; eqSet.clear(); runSel = null; }
  updateEqBar(); req();
}
function hitArea(u) { const l = vkAreas(); for (let i = l.length - 1; i >= 0; i--) if (inPoly(u.x, u.y, l[i].pts)) return l[i]; return null; }
// håndtak på valgt felt: hjørner (v) og midtpunkter (m)
function areaHandles(a) {
  const out = [];
  a.pts.forEach((p, i) => {
    out.push({ t: 'v', i, x: p[0], y: p[1] });
    const q = a.pts[(i + 1) % a.pts.length];
    out.push({ t: 'm', i, x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2 });
  });
  return out;
}
function hitAreaHandle(px, py) {
  const a = areaSel && vkById(areaSel);
  if (!a) return null;
  let best = null, bd = 22;
  for (const h of areaHandles(a)) {
    const d = Math.hypot(h.x * view.s + view.tx - px, h.y * view.s + view.ty - py);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}
function areaHandleTap(h) {
  const a = vkById(areaSel);
  if (!a || h.t !== 'm') return;
  pushUndo(); a.pts.splice(h.i + 1, 0, [h.x, h.y]); save(); updateEqBar(); req();
}
function areaVertexDrag(h, p) {
  const a = vkById(areaSel);
  if (!a) return;
  if (h.t === 'm' && !h.added) { a.pts.splice(h.i + 1, 0, [h.x, h.y]); h.t = 'v'; h.i = h.i + 1; h.added = true; }
  const u = toUnit(p.x, p.y);
  a.pts[h.i] = [u.x, u.y]; req();
}
function drawAreas(ctx, v, dpr, o) {
  const list = vkAreas();
  if (!list.length) return;
  if (vkSplit && vkSplit.pts.length && !o.export) {
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.strokeStyle = '#111'; ctx.lineWidth = 2.5;
    for (const p of vkSplit.pts) { const x = p[0] * v.s + v.tx, y = p[1] * v.s + v.ty; ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke(); }
    ctx.restore();
  }
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const k = o.k || 1;
  for (const a of list) {
    const sel = !o.export && a.id === areaSel;
    ctx.strokeStyle = VK_COL; ctx.lineWidth = (sel ? 2.4 : 1.6) * k; ctx.setLineDash([8 * k, 5 * k]);
    ctx.fillStyle = sel ? 'rgba(185,28,28,.10)' : 'rgba(185,28,28,.04)';
    ctx.beginPath(); a.pts.forEach((p, i) => { const x = p[0] * v.s + v.tx, y = p[1] * v.s + v.ty; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath();
    ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    const c = polyCentroid(a.pts), cx = c.x * v.s + v.tx, cy = c.y * v.s + v.ty;
    ctx.font = `700 ${13 * k}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const t = `${a.label} · ${vkM2Txt(a)} m²`, w = ctx.measureText(t).width + 10 * k;
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(cx - w / 2, cy - 9 * k, w, 18 * k);
    ctx.fillStyle = VK_COL; ctx.fillText(t, cx, cy);
    if (sel) for (const h of areaHandles(a)) {
      const x = h.x * v.s + v.tx, y = h.y * v.s + v.ty;
      ctx.beginPath(); ctx.arc(x, y, h.t === 'v' ? 8 : 6, 0, Math.PI * 2);
      ctx.fillStyle = h.t === 'v' ? '#fff' : VK_COL; ctx.fill(); ctx.strokeStyle = VK_COL; ctx.lineWidth = 2; ctx.stroke();
      if (h.t === 'm') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x - 3.5, y); ctx.lineTo(x + 3.5, y); ctx.moveTo(x, y - 3.5); ctx.lineTo(x, y + 3.5); ctx.stroke(); }
    }
  }
  ctx.restore();
}
function areaSheet() {
  const a = vkById(areaSel);
  if (!a) { areaSel = null; return null; }
  return {
    title: 'Varmekabel ' + a.label,
    sub: `${vkM2Txt(a)} m² · ${a.inset ?? VK_INSET} mm fra vegg`,
    hint: 'Dra de hvite hjørnene. Dra eller trykk på + for å legge til et hjørne.',
    acts: abtn('vkname', 'edit', 'Navn') + abtn('vksplit', '<svg class="ic" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="1" stroke-dasharray="3 2"/><path d="M14 2L10 22"/></svg>', 'Del i to') + abtn('vkinset', '<b>mm</b>', 'Avstand til vegg') + abtn('vkdel', 'del', 'Slett', 'dz')
  };
}
function areaAction(act) {
  const a = vkById(areaSel);
  if (!a) return;
  if (act === 'vksplit') { vkSplit = { id: a.id, pts: [] }; setBanner(`<b>Del ${esc(a.label)}</b><small>Trykk to punkter tvers over feltet der det skal deles</small>`, 'Avbryt', () => { vkSplit = null; setBanner(null); req(); }, true); req(); return; }
  if (act === 'vkdel') { pushUndo(); P.eq.areas = vkAreas().filter(q => q !== a); areaSel = null; save(); updateEqBar(); req(); return; }
  if (act === 'vkname') return promptDlg('Navn på feltet', 'Navn', a.label, v => { pushUndo(); a.label = v.trim() || a.label; save(); updateEqBar(); req(); });
  if (act === 'vkinset') return promptDlg('Avstand fra vegg (mm)', 'mm – feltet finnes på nytt fra veggene', String(a.inset ?? VK_INSET), v => {
    const n = Math.max(0, Math.round(+String(v).replace(',', '.')));
    if (!isFinite(n)) return;
    const poly = a.seed && roomPoly({ x: a.seed[0], y: a.seed[1] }, n);
    if (!poly) { toast('Fant ikke rommet igjen – juster hjørnene for hånd'); return; }
    pushUndo(); a.pts = poly; a.inset = n; save(); updateEqBar(); req();
  });
}
// Dele et felt i to langs en strek brukeren trykker opp (to punkter)
let vkSplit = null;
function vkSplitTap(u) {
  vkSplit.pts.push([u.x, u.y]);
  if (vkSplit.pts.length < 2) { setBanner(`<b>Del feltet</b><small>Trykk punkt nummer to på andre siden</small>`, 'Avbryt', () => { vkSplit = null; setBanner(null); req(); }, true); req(); return; }
  const a = vkById(vkSplit.id), [A, B] = vkSplit.pts;
  vkSplit = null; setBanner(null);
  const parts = a && splitPoly(a.pts, A, B);
  if (!parts) { toast('Streken må gå tvers over feltet – prøv igjen'); req(); return; }
  pushUndo();
  parts.sort((p, q) => polyArea(q) - polyArea(p));
  a.pts = parts[0];
  const b = { id: uid(), label: nextVkLabel(), pts: parts[1], inset: a.inset };
  vkAreas().push(b);
  save(); updateEqBar(); req();
  toast(`Delt: ${a.label} ${vkM2Txt(a)} m² og ${b.label} ${vkM2Txt(b)} m²`);
}
// skjær polygonet langs linja gjennom A–B, mellom de to kantene nærmest midt på streken
function splitPoly(pts, A, B) {
  const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  const ux = dx / L, uy = dy / L, mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
  if (!inPoly(mx, my, pts)) return null;
  const hits = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const ex = q[0] - p[0], ey = q[1] - p[1], den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p[0] - mx) * ey - (p[1] - my) * ex) / den;       // langs streken fra midtpunktet
    const s = ((p[0] - mx) * uy - (p[1] - my) * ux) / den;       // langs kanten
    if (s < -1e-9 || s > 1 + 1e-9) continue;
    hits.push({ i, t, x: mx + ux * t, y: my + uy * t });
  }
  const neg = hits.filter(h => h.t < 0).sort((a, b) => b.t - a.t)[0], pos = hits.filter(h => h.t > 0).sort((a, b) => a.t - b.t)[0];
  if (!neg || !pos) return null;
  let [h1, h2] = neg.i < pos.i ? [neg, pos] : [pos, neg];
  const X = [h1.x, h1.y], Y = [h2.x, h2.y];
  const p1 = [X, ...pts.slice(h1.i + 1, h2.i + 1), Y];
  const p2 = [Y, ...pts.slice(h2.i + 1), ...pts.slice(0, h1.i + 1), X];
  const clean = p => p.filter((q, i) => { const r = p[(i + 1) % p.length]; return Math.hypot(q[0] - r[0], q[1] - r[1]) > 1e-6; });
  const c1 = clean(p1), c2 = clean(p2);
  if (c1.length < 3 || c2.length < 3 || polyArea(c1) < 1e-6 || polyArea(c2) < 1e-6) return null;
  return [c1, c2];
}
// eksport til DXF: lukket polylinje + tekst
function areasDxf(f) {
  const out = [];
  for (const a of vkAreas()) {
    const p = [[100, 'AcDbEntity'], [8, 'E-VARMEKABEL'], [100, 'AcDbPolyline'], [90, String(a.pts.length)], [70, '1']];
    for (const q of a.pts) p.push([10, f(q[0])], [20, f(-q[1])]);
    out.push({ type: 'LWPOLYLINE', pairs: p });
    const c = polyCentroid(a.pts), h = 120 / (P.mmPerUnit || 1);
    out.push({ type: 'TEXT', pairs: [[100, 'AcDbEntity'], [8, 'E-VARMEKABEL'], [100, 'AcDbText'], [10, f(c.x)], [20, f(-c.y)], [30, '0'], [40, f(h)], [1, `${a.label} ${vkM2Txt(a)} m2`], [72, '1'], [11, f(c.x)], [21, f(-c.y)], [31, '0'], [100, 'AcDbText'], [73, '2']] });
  }
  return out;
}
