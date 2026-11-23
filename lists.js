'use strict';
/* Prosjektinfo (tittelfelt), materialliste og kursliste (med eksport til Kursfortegnelse-appen). */

/* ---------- Prosjektinfo ---------- */
const STATUSER = ['Som bygget', 'Arbeidstegning', 'For godkjenning', 'Forprosjekt'];
function projInfo() {
  const g = S.info || {};
  const i = Object.assign({ prosjekt: P.name, adresse: '', kunde: '', tegnr: '', rev: '', status: 'Som bygget', tegnetAv: g.tegnetAv || '', firma: g.firma || '' }, P.info || {});
  if (!i.tegnetAv) i.tegnetAv = g.tegnetAv || '';
  if (!i.firma) i.firma = g.firma || '';
  return i;
}
function openInfo() {
  const i = projInfo();
  const f = (k, l, ph) => `<label class="f">${l}</label><input data-k="${k}" value="${esc(i[k] || '')}" placeholder="${esc(ph || '')}" autocomplete="off">`;
  dialog(`<h2>Prosjektinfo</h2><p>Brukes i tittelfeltet på PDF og i eksport til Kursfortegnelse.</p>
    ${f('prosjekt', 'Prosjekt / anlegg')}${f('adresse', 'Adresse')}${f('kunde', 'Kunde / byggherre')}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px">${f('tegnr', 'Tegningsnr.', 'E-01')}${f('rev', 'Revisjon', 'A')}</div>
    <label class="f">Status</label><select data-k="status">${STATUSER.map(s => `<option ${s === i.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
    ${f('tegnetAv', 'Tegnet av')}${f('firma', 'Firma')}
    <p style="font-size:13px">«Tegnet av» og «Firma» huskes til nye prosjekter.</p>
    <div class="btns"><button data-x>Avbryt</button><button class="primary" data-ok>Lagre</button></div>`, (el, close) => {
    $('[data-x]', el).onclick = close;
    $('[data-ok]', el).onclick = () => {
      const o = {};
      el.querySelectorAll('[data-k]').forEach(x => o[x.dataset.k] = x.value.trim());
      P.info = o;
      S.info = { tegnetAv: o.tegnetAv, firma: o.firma }; saveS();
      close(); save(); toast('Prosjektinfo lagret');
    };
  });
}

/* ---------- Rom (fra romnavnene i tegningen) ---------- */
let _rooms = null, _roomsDoc = null;
function roomLabels() {
  if (_roomsDoc === doc && _rooms) return _rooms;
  const T = (doc.texts || []).filter(t => !t.item && t.s && doc.show[t.l]);
  const hs = T.map(t => t.h).sort((a, b) => a - b), med = hs.length ? hs[hs.length >> 1] : 0;
  _rooms = T.filter(t => t.h >= med * 1.25 && /^[A-ZÆØÅ][A-ZÆØÅ /()\-]{1,}[A-ZÆØÅ)]$/.test(t.s.trim()) && !/^(PAX|WC|HS|VM|TT)$/.test(t.s.trim()))
    .map(t => ({ name: t.s.trim().replace(/\s*\(.*?\)\s*/g, ' ').trim(), full: t.s.trim(), x: t.x, y: t.y }));
  _roomsDoc = doc;
  return _rooms;
}
function roomOf(it) {
  const R = roomLabels();
  if (!R.length) return '';
  const c = itemCenter(it), mpu = P.mmPerUnit || 1;
  let best = null, bd = 7000 / mpu;
  for (const r of R) { const d = Math.hypot(r.x - c.x, r.y - c.y); if (d < bd) { bd = d; best = r; } }
  return best ? best.full : '';
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;

/* ---------- Materialliste ---------- */
function itemLabel(it) {
  if (it.isPt) return (TYPES[it.pt.type] || TYPES.downlight).name;
  let n = cap(prettyBlock(it.block));
  if (countable(it.block)) n += ` ${it.n || 1}-uttak`;
  return n;
}
function runLength() {
  let L = 0;
  for (const run of (P.eq && P.eq.runs) || []) {
    const g = runGeom(run);
    if (!g) continue;
    for (let i = 1; i < g.pts.length; i++) L += Math.hypot(g.pts[i].x - g.pts[i - 1].x, g.pts[i].y - g.pts[i - 1].y);
  }
  return L * (P.mmPerUnit || 1) / 1000;
}
function materialList() {
  const rows = new Map();
  const add = (k, n = 1) => rows.set(k, (rows.get(k) || 0) + n);
  if (doc.kind === 'dxf') for (const it of allItems()) { if (!it.del) add(itemLabel(it)); }
  else for (const p of P.points) add((TYPES[p.type] || TYPES.downlight).name);
  const out = [...rows.entries()].map(([name, n]) => ({ name, n: String(n), unit: 'stk' })).sort((a, b) => a.name.localeCompare(b.name, 'no'));
  if (doc.kind === 'dxf') {
    const L = runLength();
    if (L > 0) out.push({ name: 'Føringer skjult anlegg (ca. lengde mellom punkter)', n: L.toFixed(1).replace('.', ','), unit: 'm' });
    if (typeof vkAreas === 'function') for (const a of vkAreas()) out.push({ name: `Varmekabel ${a.label} (gulvareal)`, n: vkM2Txt(a), unit: 'm²' });
  }
  return out;
}
function openMaterialList() {
  const rows = materialList();
  if (!rows.length) { toast('Ingen symboler å telle'); return; }
  dialog(`<h2>Materialliste</h2><p>Telt fra tegningen, slik den står nå.</p>
    <table class="pl">${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="v">${esc(r.n)} ${r.unit}</td></tr>`).join('')}</table>
    <div class="btns"><button data-copy>Kopier</button><button data-csv>CSV</button><button class="primary" data-x>Lukk</button></div>`, (el, close) => {
    $('[data-x]', el).onclick = close;
    $('[data-copy]', el).onclick = async () => {
      try { await navigator.clipboard.writeText(P.name + ' – materialliste\n' + rows.map(r => `${r.n} ${r.unit}\t${r.name}`).join('\n')); toast('Kopiert'); } catch (e) { toast('Kunne ikke kopiere'); }
    };
    $('[data-csv]', el).onclick = () => { close(); shareOrDownload(csvBlob([['Beskrivelse', 'Antall', 'Enhet'], ...rows.map(r => [r.name, r.n, r.unit])]), safeName(P.name) + '_materialliste.csv', P.name); };
  });
}
function csvBlob(rows) {
  const q = v => { v = String(v ?? ''); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return new Blob(['﻿' + rows.map(r => r.map(q).join(';')).join('\r\n')], { type: 'text/csv' });
}

/* ---------- Kursliste ---------- */
const SHORT = [[/dimmer/i, 'dimmer'], [/termostat/i, 'termostat'], [/bryter|switch/i, 'bryter'], [/vegglys/i, 'vegglys'], [/downlight/i, 'downlight'], [/spot/i, 'spot'],
  [/vifte/i, 'vifte'], [/tavle/i, 'tavle'], [/r[øo]yk/i, 'røykvarsler'], [/h[øo]yttaler/i, 'høyttaler'], [/boks/i, 'koblingsboks'], [/lys|lampe|light/i, 'lys'], [/stikk|socket|uttak/i, 'stikk']];
function shortName(it) {
  const s = it.isPt ? (TYPES[it.pt.type] || TYPES.downlight).name : it.block;
  for (const [re, n] of SHORT) if (re.test(s)) return n;
  return prettyBlock(s).toLowerCase();
}
// alt som henger sammen med første boks via føringer (stopper ved andre kursmerkede bokser)
function circuitItems(key) {
  const adj = new Map();
  for (const r of (P.eq.runs || [])) {
    if (!adj.has(r.a)) adj.set(r.a, []); if (!adj.has(r.b)) adj.set(r.b, []);
    adj.get(r.a).push(r.b); adj.get(r.b).push(r.a);
  }
  const marked = new Set(Object.keys(P.eq.kurs || {}));
  const seen = new Set([key]), q = [key];
  while (q.length) {
    const k = q.shift();
    for (const n of adj.get(k) || []) {
      if (seen.has(n) || (marked.has(n) && n !== key)) continue;
      seen.add(n); q.push(n);
    }
  }
  return [...seen].map(itemByKey).filter(Boolean);
}
function kursList() {
  const out = [];
  for (const [key, k] of Object.entries((P.eq && P.eq.kurs) || {})) {
    const it = itemByKey(key);
    if (!it) continue;
    const items = circuitItems(key);
    const cnt = new Map();
    for (const i of items) cnt.set(shortName(i), (cnt.get(shortName(i)) || 0) + 1);
    const rooms = [...new Set(items.map(roomOf).filter(Boolean))];
    const auto = [...cnt.entries()].map(([n, c]) => `${c} ${n}`).join(', ') + (rooms.length ? ' – ' + rooms.map(cap).join(', ') : '');
    out.push({ key, f: k.f || '', k: k.k, nr: '-F' + k.k, beskr: k.d || auto, auto, items: items.length });
  }
  const num = s => { const m = String(s).match(/\d+/); return m ? +m[0] : 1e9; };
  return out.sort((a, b) => a.f.localeCompare(b.f) || num(a.k) - num(b.k) || String(a.k).localeCompare(String(b.k)));
}
function openKursList() {
  const L = kursList();
  if (!L.length) { toast('Ingen kurs er merket ennå – trykk på første boks etter tavla og velg «Kurs»'); return; }
  const many = new Set(L.map(r => r.f)).size > 1 || L.some(r => r.f);
  dialog(`<h2>Kursliste</h2><p>Beskrivelsen lages fra det som er koblet sammen med føringer. Trykk på en linje for å skrive egen beskrivelse.</p>
    <table class="pl">${L.map(r => `<tr data-k="${esc(r.key)}"><td style="white-space:nowrap"><b>${esc((many ? r.f + ' ' : '') + r.nr)}</b></td><td>${esc(r.beskr)}</td></tr>`).join('')}</table>
    <div class="btns"><button data-copy>Kopier</button><button data-csv>CSV</button><button data-kf>Til Kursfortegnelse</button><button class="primary" data-x>Lukk</button></div>`, (el, close) => {
    $('[data-x]', el).onclick = close;
    el.querySelectorAll('tr[data-k]').forEach(tr => tr.onclick = () => {
      const r = L.find(q => q.key === tr.dataset.k);
      close();
      promptDlg('Beskrivelse for ' + r.nr, 'Tom = automatisk (' + r.auto + ')', P.eq.kurs[r.key].d || '', v => { P.eq.kurs[r.key].d = v; save(); openKursList(); });
    });
    $('[data-copy]', el).onclick = async () => {
      try { await navigator.clipboard.writeText(L.map(r => `${(many ? r.f + ' ' : '') + r.nr}\t${r.beskr}`).join('\n')); toast('Kopiert'); } catch (e) { toast('Kunne ikke kopiere'); }
    };
    $('[data-csv]', el).onclick = () => { close(); shareOrDownload(csvBlob([['Fordeling', 'Kurs', 'Beskrivelse'], ...L.map(r => [r.f, r.nr, r.beskr])]), safeName(P.name) + '_kursliste.csv', P.name); };
    $('[data-kf]', el).onclick = () => { close(); exportKursfortegnelse(L); };
  });
}
// Fil som Kursfortegnelse-appen kan importere (Importer fil)
function exportKursfortegnelse(L) {
  const i = projInfo(), groups = new Map();
  for (const r of L) { if (!groups.has(r.f)) groups.set(r.f, []); groups.get(r.f).push(r); }
  const boards = [...groups.entries()].map(([f, rows]) => ({
    mal: f ? 'naering' : 'bolig', fordeling: f, anlegg: i.prosjekt, adresse: i.adresse, kunde: i.kunde || i.prosjekt, tavle: f,
    kurser: rows.map(r => ({ nr: f ? r.nr : String(r.k), beskr: r.beskr }))
  }));
  const blob = new Blob([JSON.stringify({ app: 'kursfortegnelse', version: 1, boards }, null, 2)], { type: 'application/json' });
  shareOrDownload(blob, safeName(P.name) + '_kurser.json', P.name).then(() => toast('Åpne Kursfortegnelse → Importer fil'));
}
