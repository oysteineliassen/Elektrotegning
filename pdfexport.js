'use strict';
/* Eksport: PDF (vektor fra DXF i riktig målestokk, eller bilde fra PDF-underlag), DXF og PNG. */

const PAPER = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
const SCALES = [10, 20, 25, 50, 100, 200, 250, 500, 1000];
const MM = 72 / 25.4;

// Mål på takpunktene tas bare med når «Takpunkter med mål» er valgt (eller underlaget er PDF)
function expDims() { return !doc || doc.kind !== 'dxf' || !!(S.exp && S.exp.what === 'mal'); }
function openExport() {
  const isDxf = doc.kind === 'dxf';
  const opt = (arr, cur) => arr.map(([v, t]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${t}</option>`).join('');
  const ex = S.exp || (S.exp = { fmt: 'pdf', paper: 'A3', scale: 'auto', area: 'all' });
  if (!ex.what) ex.what = 'inst';
  const uncal = !isDxf && !P.mmPerUnit;
  dialog(`<h2>Del tegning</h2>
    ${isDxf ? `<div id="xWhat"><label class="f">Hva skal mottakeren få?</label><div class="seg">
      <button data-w="inst">Installasjonstegning – uten mål<small>til kunden ved overlevering</small></button>
      <button data-w="mal">Boreunderlag – takpunkter med mål<small>for utboring etter at taket er kledd</small></button></div></div>`
      : `<label class="f">Mottakeren får</label><p style="color:var(--text);margin:4px 0 8px"><b>Boreunderlag – takpunkter med mål</b></p>`}
    ${uncal ? '<p class="warnbox">Tegningen er ikke kalibrert. Målene blir ikke gyldige før du har satt målestokk.</p>' : ''}
    <label class="f">Format</label>
    <div class="seg" style="grid-template-columns:repeat(${isDxf ? 3 : 2},1fr)">
      <button data-f="pdf">PDF</button>${isDxf ? '<button data-f="dxf">DXF</button>' : ''}<button data-f="png">Bilde</button></div>
    <div id="pdfOpt">
      <div class="setrow"><span>Papir</span><select id="xPaper">${opt(Object.keys(PAPER).map(k => [k, k]), ex.paper)}</select></div>
      <div class="setrow"><span>Målestokk</span><select id="xScale">${opt([['auto', 'Største som får plass']].concat(SCALES.map(n => [n, '1:' + n])), ex.scale)}</select></div>
      <div class="setrow"><span>Utsnitt</span><select id="xArea">${opt([['all', 'Hele tegningen'], ['view', 'Det du ser nå']], ex.area)}</select></div>
      ${isDxf ? `<label class="setrow" id="xListsRow"><span>Materialliste og kursliste på side 2</span><input type="checkbox" id="xLists" ${ex.lists !== false ? 'checked' : ''} style="width:24px;height:24px"></label>` : ''}
      <p id="xInfo" style="color:var(--muted)"></p>
    </div>
    <p id="xSum" class="sumbox"></p>
    <p id="dxfInfo" style="display:none">DXF med alle endringer (flyttet, nytt, slettet, føringer og takpunkter). Åpne i AutoCAD og plott fra arkfanen som før.</p>
    <div class="btns"><button data-x>Avbryt</button><button class="primary" data-ok>Del tegning</button></div>
    <p style="font-size:12px">Sikkerhetskopi av hele prosjektet med bilder ligger i menyen under «Sikkerhetskopi».</p>`, (el, close) => {
    let fmt = isDxf || ex.fmt !== 'dxf' ? ex.fmt : 'pdf';
    const upd = () => {
      el.querySelectorAll('[data-f]').forEach(b => b.classList.toggle('on', b.dataset.f === fmt));
      el.querySelectorAll('[data-w]').forEach(b => b.classList.toggle('on', b.dataset.w === ex.what));
      const xw = $('#xWhat', el); if (xw) xw.style.display = fmt === 'dxf' ? 'none' : '';
      $('#pdfOpt', el).style.display = fmt === 'pdf' ? '' : 'none';
      $('#dxfInfo', el).style.display = fmt === 'dxf' ? '' : 'none';
      ex.paper = $('#xPaper', el).value; ex.scale = $('#xScale', el).value; ex.area = $('#xArea', el).value; ex.fmt = fmt;
      const xl = $('#xLists', el); if (xl) { ex.lists = xl.checked; $('#xListsRow', el).style.display = ex.what === 'mal' ? 'none' : ''; }
      let lay = '';
      if (fmt === 'pdf') {
        const L = pdfLayout(ex);
        lay = L ? `${ex.paper} ${L.land ? 'liggende' : 'stående'} · 1:${L.N}` + (L.fits ? '' : ' · får ikke plass, beskjæres') : 'mangler målestokk';
        $('#xInfo', el).textContent = lay;
      }
      const what = !isDxf || ex.what === 'mal' ? 'Boreunderlag – takpunkter med mål' : 'Installasjonstegning – uten mål';
      const extra = fmt === 'pdf' && isDxf && ex.what !== 'mal' && ex.lists !== false ? ' · med materialliste og kursliste' : '';
      $('#xSum', el).innerHTML = fmt === 'dxf'
        ? '<b>Mottakeren får:</b> DXF-fil med alle endringer, uten mål. Til den som tegner videre i AutoCAD.'
        : `<b>Mottakeren får:</b> ${what} · ${fmt === 'pdf' ? 'PDF ' + lay : 'bilde (PNG)'}${extra}`;
    };
    el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { fmt = b.dataset.f; upd(); });
    el.querySelectorAll('[data-w]').forEach(b => b.onclick = () => { ex.what = b.dataset.w; upd(); });
    el.querySelectorAll('select, input[type=checkbox]').forEach(s => s.onchange = upd);
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
  const m = 10, foot = TB_H + 2, aw = pw - 2 * m, ah = ph - 2 * m - foot;
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
// pages: [{ content, image? }] – alle sider samme størrelse
async function makePdf(pwPt, phPt, content, image) {
  return makePdfPages(pwPt, phPt, [{ content, image }]);
}
async function makePdfPages(pwPt, phPt, pages) {
  const parts = [], offs = [];
  let len = 0;
  const push = x => { const u = typeof x === 'string' ? latin1(x) : x; parts.push(u); len += u.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const obj = (n, body) => { offs[n] = len; push(`${n} 0 obj\n`); for (const b of body) push(b); push('\nendobj\n'); };
  // 1 katalog, 2 sider, 3 F1, 4 F2, deretter 3 objekter per side (side, innhold, bilde)
  const pageIds = pages.map((_, i) => 5 + i * 3);
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, [`<< /Type /Pages /Kids [${pageIds.map(n => n + ' 0 R').join(' ')}] /Count ${pages.length} >>`]);
  obj(3, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
  obj(4, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i], n = pageIds[i];
    const raw = latin1(pg.content), z = await deflate(raw);
    obj(n, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pwPt.toFixed(2)} ${phPt.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${pg.image ? ` /XObject << /Im1 ${n + 2} 0 R >>` : ''} >> /Contents ${n + 1} 0 R >>`]);
    obj(n + 1, [`<< /Length ${(z || raw).length}${z ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, z || raw, '\nendstream']);
    if (pg.image) obj(n + 2, [`<< /Type /XObject /Subtype /Image /Width ${pg.image.w} /Height ${pg.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.image.data.length} >>\nstream\n`, pg.image.data, '\nendstream']);
    else obj(n + 2, ['null']);
  }
  const total = 5 + pages.length * 3;
  const xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------- Tittelfelt og tabeller (papirkoordinater i mm, origo nede til venstre) ---------- */
const TB_H = 30, TB_W = 185;
function pt(v) { return (Math.round(v * MM * 100) / 100).toString(); }
function txt(x, y, s, size, bold) { return `BT 0 0 0 rg /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${pt(x)} ${pt(y)} Tm ${pdfStr(String(s))} Tj ET`; }
function fitTxt(s, size, w) { s = String(s || ''); while (s.length > 1 && textW(s, size) > w * MM) s = s.slice(0, -2) + '…'; return s; }
function titleBlock(L, title) {
  const i = projInfo(), x0 = L.pw - L.m - TB_W, y0 = L.m, o = [];
  const date = new Date().toLocaleDateString('no-NO');
  o.push(`1 1 1 rg ${pt(x0)} ${pt(y0)} ${pt(TB_W)} ${pt(TB_H)} re f 0 0 0 RG 0.5 w [] 0 d ${pt(x0)} ${pt(y0)} ${pt(TB_W)} ${pt(TB_H)} re S`);
  const H = (y) => o.push(`0.3 w ${pt(x0)} ${pt(y0 + y)} m ${pt(x0 + TB_W)} ${pt(y0 + y)} l S`);
  const V = (x, ya, yb) => o.push(`0.3 w ${pt(x0 + x)} ${pt(y0 + ya)} m ${pt(x0 + x)} ${pt(y0 + yb)} l S`);
  H(20); H(10); V(70, 10, 30);
  const cell = (x, y, w, label, val, size, bold) => {
    o.push(`BT 0.35 0.35 0.35 rg /F1 5 Tf 1 0 0 1 ${pt(x0 + x + 1.2)} ${pt(y0 + y - 2.6)} Tm ${pdfStr(label)} Tj ET`);
    o.push(txt(x0 + x + 1.2, y0 + y - 7.6, fitTxt(val, size, w - 2.4), size, bold));
  };
  cell(0, 30, 70, 'Firma', i.firma, 9, true);
  cell(70, 30, 115, 'Prosjekt / anlegg', i.prosjekt, 9, true);
  cell(0, 20, 70, 'Adresse', i.adresse, 8);
  cell(70, 20, 115, 'Tegning', title, 9, true);
  const cols = [['Tegningsnr.', i.tegnr, 32], ['Rev.', i.rev, 14], ['Målestokk', '1:' + L.N + ' (' + L.paper + ')', 32], ['Dato', date, 25], ['Tegnet av', i.tegnetAv, 37], ['Status', i.status, 45]];
  let x = 0;
  cols.forEach(([lb, v, w], k) => { if (k) V(x, 0, 10); cell(x, 10, w, lb, v, 8, k === 0); x += w; });
  return o.join('\n');
}
// enkel tabell; returnerer [innhold, ny y]
function pdfTable(x, y, cols, rows, title) {
  const o = [txt(x, y, title, 12, true)];
  y -= 8;
  const W = cols.reduce((a, c) => a + c[1], 0);
  o.push(`0.92 0.93 0.95 rg ${pt(x)} ${pt(y - 1.8)} ${pt(W)} ${pt(6)} re f`);
  let cx = x;
  for (const [h, w] of cols) { o.push(txt(cx + 1.2, y, h, 8, true)); cx += w; }
  y -= 6.5;
  for (const r of rows) {
    cx = x;
    r.forEach((v, k) => { o.push(txt(cx + 1.2, y, fitTxt(v, 8, cols[k][1] - 2.4), 8, false)); cx += cols[k][1]; });
    o.push(`0.85 0.85 0.85 RG 0.2 w ${pt(x)} ${pt(y - 2)} m ${pt(x + W)} ${pt(y - 2)} l S`);
    y -= 5.5;
  }
  return [o.join('\n'), y - 6];
}
function listsPage(L) {
  const o = [`0.6 0.6 0.6 RG 0.3 w [] 0 d ${pt(L.m)} ${pt(L.m)} ${pt(L.pw - 2 * L.m)} ${pt(L.ph - 2 * L.m)} re S`];
  const top = L.ph - L.m - 12, left = L.m + 8;
  const mat = materialList().map(r => [r.n + ' ' + r.unit, r.name]);
  const kl = doc.kind === 'dxf' ? kursList().map(r => [r.f, r.nr, r.beskr]) : [];
  const colW = (L.pw - 2 * L.m - 24) / 2;
  let [a] = pdfTable(left, top, [['Antall', 22], ['Beskrivelse', colW - 22]], mat, 'Materialliste');
  o.push(a);
  if (kl.length) { const [b] = pdfTable(left + colW + 8, top, [['Fordeling', 22], ['Kurs', 16], ['Beskrivelse', colW - 38]], kl, 'Kursliste'); o.push(b); }
  o.push(titleBlock(L, 'Materialliste og kursliste'));
  return o.join('\n');
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
    if (!doc.show[f.l] || (f.ins >= 0 && doc.eqIns[f.ins]) || (doc.fillIn && !doc.fillIn(f))) continue;
    if (!fills.has(f.l)) fills.set(f.l, []);
    fills.get(f.l).push(...f.loops);
  }
  for (const [l, loops] of fills) pen.fill(doc.wall[l] ? '#b4b8bf' : tint(aci(Ls[l].color), 0.65), loops);
  // bjelkelag (bare på takpunkttegningen)
  if (expDims() && typeof J === 'function' && J()) {
    const j = J(), a = L.area, hw = jU(j.w) / 2, loops = [];
    if (j.dir === 'v') for (const c of joistCentersIn(a.x0 - hw, a.x1 + hw)) loops.push([[c - hw, a.y0], [c + hw, a.y0], [c + hw, a.y1], [c - hw, a.y1]]);
    else for (const c of joistCentersIn(a.y0 - hw, a.y1 + hw)) loops.push([[a.x0, c - hw], [a.x1, c - hw], [a.x1, c + hw], [a.x0, c + hw]]);
    pen.fill('#f6dfc0', loops);
  }
  // varmekabelfelt (installasjonstegning)
  if (!expDims() && typeof vkAreas === 'function') for (const a of vkAreas()) {
    pen.stroke('#b91c1c', 0.35, [3, 2]); pen.poly(a.pts.concat([a.pts[0]]).map(q => ({ x: q[0], y: q[1] })));
    const c = polyCentroid(a.pts); pen.label('#b91c1c', c.x, c.y, 7, `${a.label} · ${vkM2Txt(a)} m²`);
  }
  // linjer per lag
  const byL = Ls.map(() => []);
  const sg = r.segs;
  for (let k = 0; k < sg.n; k++) { if (!doc.show[sg.l[k]] || isEq(k) || (doc.segIn && !doc.segIn(k))) continue; byL[sg.l[k]].push([sg.x1[k], sg.y1[k], sg.x2[k], sg.y2[k]]); }
  byL.forEach((segs, i) => { if (!segs.length) return; pen.stroke(doc.wall[i] ? '#000000' : aci(Ls[i].color), doc.wall[i] ? 0.5 : 0.25); pen.lines(segs); });
  // tekst
  for (const t0 of doc.texts) {
    if (!doc.show[t0.l] || t0.item) continue;
    const t = staticDisp(t0); if (!t) continue;
    pen.text(aci(Ls[t.l].color === 7 ? 8 : Ls[t.l].color), t.x, t.y, t.h, t.rot, t.s, t.ha, t.va);
  }
  for (const k of Object.keys((P.eq && P.eq.notes) || {})) {
    const it = itemByKey(k), d = it && noteDisp(it);
    if (!d) continue;
    pen.text(aci(Ls[d.l].color), d.x, d.y, d.h, 0, d.s, d.ha, d.va);
    const ld = noteLeader(it);
    if (ld) { pen.stroke(aci(Ls[d.l].color), 0.25); pen.lines([[ld.a.x, ld.a.y, ld.b.x, ld.b.y]]); }
  }
  for (const a of ((P.eq && P.eq.texts && P.eq.texts.added) || [])) { const d = addedDisp(a); pen.text(aci(Ls[d.l] ? Ls[d.l].color : 7), d.x, d.y, d.h, 0, d.s, d.ha, d.va); }
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
    const g = igeom(it);
    if (!g) continue;
    const col = aci(Ls[it.li].color), T = itemXf(it);
    if (g.fills && g.fills.length) pen.fill(col, g.fills.flatMap(f => f.loops.map(lp => lp.map(q => T(q[0], q[1])))));
    const segs = [];
    for (let k = 0; k < g.pts.length; k += 4) { const a = T(g.pts[k], g.pts[k + 1]), b = T(g.pts[k + 2], g.pts[k + 3]); segs.push([a[0], a[1], b[0], b[1]]); }
    pen.stroke(col, 0.35); pen.lines(segs);
    for (const t of g.texts) { const p = T(t.x, t.y); pen.text(col, p[0], p[1], t.h * Math.abs(it.sx), t.rot - it.r, t.s, t.ha, t.va); }
    for (const t0 of it.labels) { const t = labelDisp(it, t0); if (t) pen.text(col, t.x, t.y, t.h, t.rot, t.s, t.ha, t.va); }
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
  if (expDims()) {
    for (const p of P.points) {
      const d = dimsOf(p);
      for (const [side, col] of [[d.xs, '#2563eb'], [d.ys, '#c026d3']]) {
        if (!side) continue;
        const dd = dist(d, side), sx = side === 'L' ? -1 : side === 'R' ? 1 : 0, sy = side === 'U' ? -1 : side === 'D' ? 1 : 0;
        const ex = p.x + sx * dd, ey = p.y + sy * dd;
        const locked = (side === d.xs ? p.lockX : p.lockY) === side;
        pen.stroke(col, locked ? 0.4 : 0.3, locked ? undefined : [2, 1.5]); pen.lines([[p.x, p.y, ex, ey]]);
        const t = 1.5 / pen.k * MM;
        pen.stroke(col, 0.4); pen.lines([sx ? [ex, ey - t, ex, ey + t] : [ex - t, ey, ex + t, ey]]);
        pen.label(col, (p.x + ex) / 2, (p.y + ey) / 2, 6.5, (locked ? 'L ' : '') + fmt(dd));
      }
    }
    // c/c til nabopunkt på samme linje, så en flyttet rad ikke ser jevn ut på papiret
    const cc = '#0d9488', off = 4 / pen.k * MM, t = 1.2 / pen.k * MM;
    for (const p of P.points) {
      const nb = neighbors(p);
      for (const side of ['R', 'D']) {
        const q = nb[side];
        if (!q) continue;
        const h = side === 'R';
        const ax = h ? p.x : p.x - off, ay = h ? p.y - off : p.y, bx = h ? q.x : q.x - off, by = h ? q.y - off : q.y;
        pen.stroke(cc, 0.3); pen.lines([[ax, ay, bx, by], h ? [ax, ay - t, ax, ay + t] : [ax - t, ay, ax + t, ay], h ? [bx, by - t, bx, by + t] : [bx - t, by, bx + t, by]]);
        pen.label(cc, (ax + bx) / 2, (ay + by) / 2, 6, 'c/c ' + fmt(h ? Math.abs(q.x - p.x) : Math.abs(q.y - p.y)));
      }
    }
  }
  pen.ops.push('Q');
  pen.ops.push(`0.6 0.6 0.6 RG 0.3 w [] 0 d ${pen.n(L.m * MM)} ${pen.n(L.m * MM)} ${pen.n(L.aw * MM)} ${pen.n((L.ah + L.foot) * MM)} re S`);
  const anyLock = P.points.some(q => q.lockX || q.lockY);
  pen.ops.push(titleBlock(L, expDims() ? 'Takpunkter – mål i mm til vegg' + (anyLock ? ' (L = låst vegg)' : '') : 'Installasjonstegning'));
  return pen.ops.join('\n');
}

async function exportPdf(ex) {
  const L = pdfLayout(ex);
  if (!L) { askScale(); return; }
  toast('Lager PDF …');
  try {
    let bytes;
    const extra = ex.lists && !expDims() ? [{ content: listsPage(L) }] : [];
    if (doc.kind === 'dxf') bytes = await makePdfPages(L.pw * MM, L.ph * MM, [{ content: pdfContent(L) }].concat(extra));
    else {
      // PDF-underlag: bilde av tegningen med punktene, plassert i riktig målestokk
      const a = L.area, wmm = (a.x1 - a.x0) * P.mmPerUnit / L.N, hmm = (a.y1 - a.y0) * P.mmPerUnit / L.N;
      const px = Math.min(5000, Math.round(Math.max(wmm, hmm) / 25.4 * 200));
      const c = renderExportCanvas(px, false, a);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      const data = new Uint8Array(await blob.arrayBuffer());
      const ox = (L.m + L.aw / 2 - wmm / 2) * MM, oy = (L.m + L.foot + L.ah / 2 - hmm / 2) * MM;
      const date = new Date().toLocaleDateString('no-NO');
      void date;
      const content = `q ${(L.m * MM).toFixed(2)} ${((L.m + L.foot) * MM).toFixed(2)} ${(L.aw * MM).toFixed(2)} ${(L.ah * MM).toFixed(2)} re W n `
        + `${(wmm * MM).toFixed(2)} 0 0 ${(hmm * MM).toFixed(2)} ${ox.toFixed(2)} ${oy.toFixed(2)} cm /Im1 Do Q\n`
        + `0.6 0.6 0.6 RG 0.3 w [] 0 d ${pt(L.m)} ${pt(L.m)} ${pt(L.aw)} ${pt(L.ah + L.foot)} re S\n` + titleBlock(L, 'Takpunkter – mål i mm til vegg');
      bytes = await makePdfPages(L.pw * MM, L.ph * MM, [{ content, image: { w: c.width, h: c.height, data } }]);
    }
    await shareOrDownload(new Blob([bytes], { type: 'application/pdf' }), safeName(P.name) + (expDims() ? '_takpunkter' : '_installasjon') + '.pdf', P.name);
  } catch (e) { console.error(e); toast('Kunne ikke lage PDF: ' + (e.message || e)); }
}
