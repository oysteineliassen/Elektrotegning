'use strict';
/* Eksport: PDF (vektor fra DXF i riktig målestokk, eller bilde fra PDF-underlag), DXF og PNG. */

const PAPER = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
const SCALES = [10, 20, 25, 50, 100, 200, 250, 500, 1000];
const MM = 72 / 25.4;

function openExport() {
  const isDxf = doc.kind === 'dxf';
  const what = eqActive() ? 'installasjonstegning (uten mål)' : 'takpunkter med mål';
  const opt = (arr, cur) => arr.map(([v, t]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${t}</option>`).join('');
  const ex = S.exp || (S.exp = { fmt: 'pdf', paper: 'A3', scale: 'auto', area: 'all' });
  dialog(`<h2>Eksporter</h2><p>Eksporterer ${what}. Bytt fane øverst for den andre tegningen.</p>
    <div class="seg" style="grid-template-columns:repeat(${isDxf ? 3 : 2},1fr)">
      <button data-f="pdf">PDF</button>${isDxf ? '<button data-f="dxf">DXF</button>' : ''}<button data-f="png">Bilde</button></div>
    <div id="pdfOpt">
      <div class="setrow"><span>Papir</span><select id="xPaper">${opt(Object.keys(PAPER).map(k => [k, k]), ex.paper)}</select></div>
      <div class="setrow"><span>Målestokk</span><select id="xScale">${opt([['auto', 'Største som får plass']].concat(SCALES.map(n => [n, '1:' + n])), ex.scale)}</select></div>
      <div class="setrow"><span>Utsnitt</span><select id="xArea">${opt([['all', 'Hele tegningen'], ['view', 'Det du ser nå']], ex.area)}</select></div>
      <p id="xInfo" style="color:var(--text);font-weight:600"></p>
    </div>
    <p id="dxfInfo" style="display:none">DXF med alle endringer (flyttet, nytt, slettet, føringer og takpunkter). Åpne i AutoCAD og plott fra arkfanen som før.</p>
    <div class="btns"><button data-x>Avbryt</button><button class="primary" data-ok>Eksporter</button></div>`, (el, close) => {
    let fmt = isDxf || ex.fmt !== 'dxf' ? ex.fmt : 'pdf';
    const upd = () => {
      el.querySelectorAll('[data-f]').forEach(b => b.classList.toggle('on', b.dataset.f === fmt));
      $('#pdfOpt', el).style.display = fmt === 'pdf' ? '' : 'none';
      $('#dxfInfo', el).style.display = fmt === 'dxf' ? '' : 'none';
      ex.paper = $('#xPaper', el).value; ex.scale = $('#xScale', el).value; ex.area = $('#xArea', el).value; ex.fmt = fmt;
      if (fmt === 'pdf') {
        const L = pdfLayout(ex);
        $('#xInfo', el).textContent = L ? `${ex.paper} ${L.land ? 'liggende' : 'stående'} · 1:${L.N}` + (L.fits ? '' : ' · får ikke plass, beskjæres') : 'Mangler målestokk';
      }
    };
    el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { fmt = b.dataset.f; upd(); });
    el.querySelectorAll('select').forEach(s => s.onchange = upd);
    upd();
    $('[data-x]', el).onclick = close;
    $('[data-ok]', el).onclick = async () => {
      saveS(); close();
      if (fmt === 'png') exportImage();
      else if (fmt === 'dxf') exportDxf();
      else exportPdf(ex);
    };
  });
}

function exportArea(ex) {
  if (ex.area === 'view') {
    const a = toUnit(0, 0), b = toUnit(cw, ch);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }
  return doc.bounds;
}
// papir, retning og målestokk
function pdfLayout(ex) {
  const mpu = P.mmPerUnit;
  if (!mpu) return null;
  const a = exportArea(ex), wmm = (a.x1 - a.x0) * mpu, hmm = (a.y1 - a.y0) * mpu;
  const p = PAPER[ex.paper];
  const land = wmm >= hmm;
  const pw = land ? p[0] : p[1], ph = land ? p[1] : p[0];
  const m = 10, foot = 8, aw = pw - 2 * m, ah = ph - 2 * m - foot;
  let N;
  if (ex.scale === 'auto') { N = SCALES.find(n => wmm / n <= aw && hmm / n <= ah) || SCALES[SCALES.length - 1]; }
  else N = +ex.scale;
  return { paper: ex.paper, pw, ph, m, foot, aw, ah, N, land, area: a, fits: wmm / N <= aw + 0.5 && hmm / N <= ah + 0.5 };
}

/* ---------- PDF-skriver ---------- */
const WIN = { '–': 0x96, '—': 0x97, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '…': 0x85, '•': 0x95, '€': 0x80, 'θ': 0x3F };
function pdfStr(s) {
  let out = '';
  for (const ch of s) {
    let c = ch.charCodeAt(0);
    if (c > 255) c = WIN[ch] || 0x3F;
    if (c === 0x28 || c === 0x29 || c === 0x5C) out += '\\' + String.fromCharCode(c);
    else if (c < 32) out += ' ';
    else out += String.fromCharCode(c);
  }
  return '(' + out + ')';
}
function latin1(str) { const u = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 255; return u; }
async function deflate(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate');
    const out = new Response(new Blob([u8]).stream().pipeThrough(cs));
    return new Uint8Array(await out.arrayBuffer());
  } catch (e) { return null; }
}
async function makePdf(pwPt, phPt, content, image) {
  const parts = [], offs = [];
  let len = 0;
  const push = x => { const u = typeof x === 'string' ? latin1(x) : x; parts.push(u); len += u.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const obj = (n, body) => { offs[n] = len; push(`${n} 0 obj\n`); for (const b of body) push(b); push('\nendobj\n'); };
  const raw = latin1(content);
  const z = await deflate(raw);
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
  obj(3, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pwPt.toFixed(2)} ${phPt.toFixed(2)}] /Resources << /Font << /F1 5 0 R >>${image ? ' /XObject << /Im1 6 0 R >>' : ''} >> /Contents 4 0 R >>`]);
  obj(4, [`<< /Length ${(z || raw).length}${z ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, z || raw, '\nendstream']);
  obj(5, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
  if (image) obj(6, [`<< /Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.data.length} >>\nstream\n`, image.data, '\nendstream']);
  const n = image ? 7 : 6;
  const xref = len;
  let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------- Tegneverktøy for PDF-innhold ---------- */
function rgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => parseInt(c + c, 16)) : [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16));
  return v.map(c => (c / 255).toFixed(3)).join(' ');
}
function tint(hex, f) {
  const h = hex.replace('#', ''), v = [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16));
  return '#' + v.map(c => Math.round(c + (255 - c) * f).toString(16).padStart(2, '0')).join('');
}
let _mctx = null;
function textW(s, fs) {
  if (!_mctx) { _mctx = document.createElement('canvas').getContext('2d'); _mctx.font = '100px Helvetica, Arial, sans-serif'; }
  return _mctx.measureText(s).width * fs / 100;
}
class PdfPen {
  constructor(L) {
    this.L = L; this.ops = [];
    const k = P.mmPerUnit / L.N * MM; this.k = k;
    const a = L.area;
    this.cx = (a.x0 + a.x1) / 2; this.cy = (a.y0 + a.y1) / 2;
    this.ox = (L.m + L.aw / 2) * MM; this.oy = (L.m + L.foot + L.ah / 2) * MM;
  }
  X(x) { return this.ox + (x - this.cx) * this.k; }
  Y(y) { return this.oy - (y - this.cy) * this.k; }
  n(v) { return (Math.round(v * 100) / 100).toString(); }
  stroke(col, w, dash) { this.ops.push(`${rgb(col)} RG ${this.n(w)} w ${dash ? '[' + dash.join(' ') + '] 0 d' : '[] 0 d'}`); }
  lines(segs) { // [[x1,y1,x2,y2],...] i verdenskoordinater
    if (!segs.length) return;
    let s = '';
    for (const q of segs) s += `${this.n(this.X(q[0]))} ${this.n(this.Y(q[1]))} m ${this.n(this.X(q[2]))} ${this.n(this.Y(q[3]))} l\n`;
    this.ops.push(s + 'S');
  }
  poly(pts) {
    if (pts.length < 2) return;
    this.ops.push(pts.map((p, i) => `${this.n(this.X(p.x))} ${this.n(this.Y(p.y))} ${i ? 'l' : 'm'}`).join(' ') + ' S');
  }
  fill(col, loops) {
    if (!loops.length) return;
    let s = `${rgb(col)} rg\n`;
    for (const lp of loops) s += lp.map((p, i) => `${this.n(this.X(p[0]))} ${this.n(this.Y(p[1]))} ${i ? 'l' : 'm'}`).join(' ') + ' h\n';
    this.ops.push(s + 'f*');
  }
  // tekst: x,y i verden, h = versalhøyde i verdensenheter, rot = mot klokka (radianer, y opp)
  text(col, x, y, h, rot, str, ha, va) {
    const fs = h * this.k / 0.718;
    if (!(fs > 0.3)) return;
    const lines = String(str).split('\n'), ls = h * this.k * 1.66;
    let y0 = va === 'bottom' ? (lines.length - 1) * ls : va === 'middle' ? (lines.length - 1) * ls / 2 : 0;
    const dy0 = va === 'top' ? -0.718 * fs : va === 'middle' ? -0.359 * fs : va === 'bottom' ? 0.21 * fs : 0;
    const c = Math.cos(rot), s = Math.sin(rot);
    let out = `BT ${rgb(col)} rg /F1 ${this.n(fs)} Tf\n`;
    lines.forEach((ln, i) => {
      const w = textW(ln, fs), dx = ha === 'center' ? -w / 2 : ha === 'right' ? -w : 0, dy = dy0 + y0 - i * ls;
      const px = this.X(x) + c * dx - s * dy, py = this.Y(y) + s * dx + c * dy;
      out += `${c.toFixed(4)} ${s.toFixed(4)} ${(-s).toFixed(4)} ${c.toFixed(4)} ${this.n(px)} ${this.n(py)} Tm ${pdfStr(ln)} Tj\n`;
    });
    this.ops.push(out + 'ET');
  }
  // tekst i papirstørrelse (pt) med hvit bakgrunn – for mål
  label(col, x, y, fs, str) {
    const w = textW(str, fs), px = this.X(x), py = this.Y(y);
    this.ops.push(`1 1 1 rg ${this.n(px - w / 2 - 1.5)} ${this.n(py - fs * 0.5)} ${this.n(w + 3)} ${this.n(fs * 1.1)} re f`);
    this.ops.push(`BT ${rgb(col)} rg /F1 ${this.n(fs)} Tf 1 0 0 1 ${this.n(px - w / 2)} ${this.n(py - fs * 0.33)} Tm ${pdfStr(str)} Tj ET`);
  }
}

function itemXf(it) {
  const c = Math.cos(it.r), s = Math.sin(it.r);
  return (px, py) => [it.x + c * it.sx * px - s * it.sy * py, it.y + s * it.sx * px + c * it.sy * py];
}
function pdfContent(L) {
  const pen = new PdfPen(L), r = doc.r, Ls = r.layers;
  const clip = `${pen.n(L.m * MM)} ${pen.n((L.m + L.foot) * MM)} ${pen.n(L.aw * MM)} ${pen.n(L.ah * MM)} re W n`;
  pen.ops.push('q', clip, '1 J 1 j');
  const isEq = k => r.segs.ins[k] >= 0 && doc.eqIns[r.segs.ins[k]];
  // fyll
  const fills = new Map();
  for (const f of r.fills) {
    if (!doc.show[f.l] || (f.ins >= 0 && doc.eqIns[f.ins])) continue;
    if (!fills.has(f.l)) fills.set(f.l, []);
    fills.get(f.l).push(...f.loops);
  }
  for (const [l, loops] of fills) pen.fill(doc.wall[l] ? '#b4b8bf' : tint(aci(Ls[l].color), 0.65), loops);
  // linjer per lag
  const byL = Ls.map(() => []);
  const sg = r.segs;
  for (let k = 0; k < sg.n; k++) { if (!doc.show[sg.l[k]] || isEq(k)) continue; byL[sg.l[k]].push([sg.x1[k], sg.y1[k], sg.x2[k], sg.y2[k]]); }
  byL.forEach((segs, i) => { if (!segs.length) return; pen.stroke(doc.wall[i] ? '#000000' : aci(Ls[i].color), doc.wall[i] ? 0.5 : 0.25); pen.lines(segs); });
  // tekst
  for (const t of doc.texts) {
    if (!doc.show[t.l] || t.item) continue;
    pen.text(aci(Ls[t.l].color === 7 ? 8 : Ls[t.l].color), t.x, t.y, t.h, t.rot, t.s, t.ha, t.va);
  }
  // føringer
  const runs = (P.eq && P.eq.runs) || [];
  if (runs.length) {
    const li = Ls.findIndex(l => l.name === runLayer());
    pen.stroke(li >= 0 ? aci(Ls[li].color) : '#dc2626', 0.35);
    for (const run of runs) { const g = runGeom(run); if (g) pen.poly(g.pts); }
  }
  // utstyr + takpunkter som blokker
  for (const it of allItems()) {
    if (it.del || !doc.show[it.li]) continue;
    const g = doc.geom(it.block);
    if (!g) continue;
    const col = aci(Ls[it.li].color), T = itemXf(it);
    if (g.fills && g.fills.length) pen.fill(col, g.fills.flatMap(f => f.loops.map(lp => lp.map(q => T(q[0], q[1])))));
    const segs = [];
    for (let k = 0; k < g.pts.length; k += 4) { const a = T(g.pts[k], g.pts[k + 1]), b = T(g.pts[k + 2], g.pts[k + 3]); segs.push([a[0], a[1], b[0], b[1]]); }
    pen.stroke(col, 0.35); pen.lines(segs);
    for (const t of g.texts) { const p = T(t.x, t.y); pen.text(col, p[0], p[1], t.h * Math.abs(it.sx), t.rot - it.r, t.s, t.ha, t.va); }
    const dr = it.r - it.or, c = Math.cos(dr), sn = Math.sin(dr);
    for (let t of it.labels) {
      if (t === it.numLabel) { if (it.n < 2) continue; if (it.n !== it.n0) t = { ...t, s: String(it.n) }; }
      const ax = t.x - it.ox, ay = t.y - it.oy;
      pen.text(col, it.x + c * ax - sn * ay, it.y + sn * ax + c * ay, t.h, t.rot, t.s, t.ha, t.va);
    }
    if (!it.numLabel && it.n >= 2 && EQ.num && EQ.num[it.block]) {
      const q = numPos(it), t = EQ.num[it.block].t;
      pen.text(col, q.x, q.y, t.h, t.rot, String(it.n), t.ha, t.va);
    }
  }
  // kursmerking
  if (P.eq && P.eq.kurs) {
    const col = kursColor();
    for (const key of Object.keys(P.eq.kurs)) {
      const G = kursGeom(key);
      if (!G) continue;
      pen.stroke(col, 0.3); pen.lines([[G.a.x, G.a.y, G.b.x, G.b.y]]);
      const pts = [];
      for (let i = 0; i <= 48; i++) { const t = i / 48 * Math.PI * 2; pts.push({ x: G.cx + G.R * Math.cos(t), y: G.cy + G.R * Math.sin(t) }); }
      pen.stroke(col, 0.4); pen.poly(pts);
      pen.text(col, G.cx, G.cy, G.h, 0, G.lines.join('\n'), 'center', 'middle');
    }
  }
  // mål for takpunkter
  if (edMode === 'mal') {
    for (const p of P.points) {
      const d = dimsOf(p);
      for (const [side, col] of [[d.xs, '#2563eb'], [d.ys, '#c026d3']]) {
        if (!side) continue;
        const dd = dist(d, side), sx = side === 'L' ? -1 : side === 'R' ? 1 : 0, sy = side === 'U' ? -1 : side === 'D' ? 1 : 0;
        const ex = p.x + sx * dd, ey = p.y + sy * dd;
        pen.stroke(col, 0.3, [2, 1.5]); pen.lines([[p.x, p.y, ex, ey]]);
        const t = 1.5 / pen.k * MM;
        pen.stroke(col, 0.4); pen.lines([sx ? [ex, ey - t, ex, ey + t] : [ex - t, ey, ex + t, ey]]);
        pen.label(col, (p.x + ex) / 2, (p.y + ey) / 2, 6.5, fmt(dd));
      }
    }
  }
  pen.ops.push('Q');
  // tittelfelt
  const date = new Date().toLocaleDateString('no-NO');
  const title = `${P.name} – ${edMode === 'mal' ? 'takpunkter, mål i mm til vegg' : 'installasjonstegning'} – målestokk 1:${L.N} (${L.paper}) – ${date}`;
  pen.ops.push(`0.6 0.6 0.6 RG 0.3 w [] 0 d ${pen.n(L.m * MM)} ${pen.n(L.m * MM)} ${pen.n(L.aw * MM)} ${pen.n((L.ah + L.foot) * MM)} re S`);
  pen.ops.push(`${pen.n(L.m * MM)} ${pen.n((L.m + L.foot) * MM)} m ${pen.n((L.m + L.aw) * MM)} ${pen.n((L.m + L.foot) * MM)} l S`);
  pen.ops.push(`BT 0 0 0 rg /F1 8 Tf 1 0 0 1 ${pen.n((L.m + 3) * MM)} ${pen.n((L.m + 2.8) * MM)} Tm ${pdfStr(title)} Tj ET`);
  return pen.ops.join('\n');
}

async function exportPdf(ex) {
  const L = pdfLayout(ex);
  if (!L) { askScale(); return; }
  toast('Lager PDF …');
  try {
    let bytes;
    if (doc.kind === 'dxf') bytes = await makePdf(L.pw * MM, L.ph * MM, pdfContent(L));
    else {
      // PDF-underlag: bilde av tegningen med punktene, plassert i riktig målestokk
      const a = L.area, wmm = (a.x1 - a.x0) * P.mmPerUnit / L.N, hmm = (a.y1 - a.y0) * P.mmPerUnit / L.N;
      const px = Math.min(5000, Math.round(Math.max(wmm, hmm) / 25.4 * 200));
      const c = renderExportCanvas(px, false, a);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      const data = new Uint8Array(await blob.arrayBuffer());
      const ox = (L.m + L.aw / 2 - wmm / 2) * MM, oy = (L.m + L.foot + L.ah / 2 - hmm / 2) * MM;
      const date = new Date().toLocaleDateString('no-NO');
      const content = `q ${(L.m * MM).toFixed(2)} ${((L.m + L.foot) * MM).toFixed(2)} ${(L.aw * MM).toFixed(2)} ${(L.ah * MM).toFixed(2)} re W n `
        + `${(wmm * MM).toFixed(2)} 0 0 ${(hmm * MM).toFixed(2)} ${ox.toFixed(2)} ${oy.toFixed(2)} cm /Im1 Do Q\n`
        + `BT 0 0 0 rg /F1 8 Tf 1 0 0 1 ${((L.m + 3) * MM).toFixed(2)} ${((L.m + 2.8) * MM).toFixed(2)} Tm ${pdfStr(`${P.name} – takpunkter, mål i mm – målestokk 1:${L.N} (${ex.paper}) – ${date}`)} Tj ET`;
      bytes = await makePdf(L.pw * MM, L.ph * MM, content, { w: c.width, h: c.height, data });
    }
    await shareOrDownload(new Blob([bytes], { type: 'application/pdf' }), safeName(P.name) + (edMode === 'utstyr' ? '_installasjon' : '_takpunkter') + '.pdf', P.name);
  } catch (e) { console.error(e); toast('Kunne ikke lage PDF: ' + (e.message || e)); }
}
