'use strict';
/* Bilder knyttet til takpunkter og utstyr (f.eks. kabler og bjelker før taket kles). */

function photoMap() { return (P.photos = P.photos || {}); }
function photosOf(key) { return (P && P.photos && P.photos[key]) || []; }
function hasPhoto(key) { return photosOf(key).length > 0; }

async function resizeImage(file, max = 1800) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  } finally { URL.revokeObjectURL(url); }
}
async function getPhoto(id) {
  let b = await store.getFile('photo:' + id);
  if (!b && typeof SYNC !== 'undefined' && SYNC.cfg) {
    try {
      const r = await gh('/contents/photos/' + id + '.jpg', { raw: true });
      b = new Blob([await r.arrayBuffer()], { type: 'image/jpeg' });
      await store.putFile('photo:' + id, b);
    } catch (e) { b = null; }
  }
  return b;
}

function openPhotos(key, title) {
  const ids = photosOf(key).slice();
  const urls = [];
  dialog(`<h2>Bilder – ${esc(title)}</h2>
    <div id="phGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0">${ids.length ? '' : '<p style="grid-column:1/-1">Ingen bilder ennå.</p>'}</div>
    <label class="primary" style="display:block;text-align:center;padding:12px;border-radius:10px;background:var(--accent);color:#111;font-weight:600;cursor:pointer">📷 Ta bilde / velg bilde
      <input type="file" id="phIn" accept="image/*" capture="environment" multiple style="display:none"></label>
    <div class="btns"><button data-x>Lukk</button></div>`, (el, close) => {
    const grid = $('#phGrid', el);
    const done = () => { urls.forEach(u => URL.revokeObjectURL(u)); close(); };
    $('[data-x]', el).onclick = done;
    ids.forEach(async id => {
      const cell = document.createElement('button');
      cell.style.cssText = 'padding:0;aspect-ratio:1;overflow:hidden;border-radius:8px;background:#0b1220';
      cell.textContent = '…';
      grid.appendChild(cell);
      const b = await getPhoto(id);
      if (!b) { cell.textContent = 'mangler'; return; }
      const u = URL.createObjectURL(b); urls.push(u);
      cell.innerHTML = `<img src="${u}" style="width:100%;height:100%;object-fit:cover;display:block">`;
      cell.onclick = () => { done(); viewPhoto(key, id, title); };
    });
    $('#phIn', el).onchange = async e => {
      const files = [...e.target.files];
      if (!files.length) return;
      toast('Lagrer bilde …');
      for (const f of files) {
        const blob = await resizeImage(f);
        const id = uid();
        await store.putFile('photo:' + id, blob);
        (photoMap()[key] = photoMap()[key] || []).push(id);
      }
      save(); req(); done(); openPhotos(key, title);
    };
  });
}
async function viewPhoto(key, id, title) {
  const b = await getPhoto(id);
  if (!b) { toast('Fant ikke bildet'); return; }
  const u = URL.createObjectURL(b);
  dialog(`<h2>${esc(title)}</h2><img src="${u}" style="width:100%;border-radius:10px;display:block">
    <div class="btns"><button class="danger" data-del>Slett bilde</button><button data-dl>Last ned</button><button class="primary" data-x>Tilbake</button></div>`, (el, close) => {
    const back = () => { URL.revokeObjectURL(u); close(); openPhotos(key, title); };
    $('[data-x]', el).onclick = back;
    $('[data-dl]', el).onclick = () => downloadBlob(b, safeName(P.name + ' ' + title) + '.jpg');
    $('[data-del]', el).onclick = () => confirmDlg('Slette bildet?', 'Bildet fjernes fra punktet.', 'Slett', async () => {
      const m = photoMap();
      m[key] = (m[key] || []).filter(x => x !== id);
      if (!m[key].length) delete m[key];
      save(); req(); URL.revokeObjectURL(u); openPhotos(key, title);
    }, true);
  });
}
// lite kamera-merke ved symboler med bilde (skjerm, ikke eksport)
function drawPhotoBadge(ctx, sx, sy) {
  ctx.save();
  ctx.beginPath(); ctx.arc(sx, sy, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = '#0ea5e9'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.fillRect(sx - 3.2, sy - 1.8, 6.4, 4.2);
  ctx.beginPath(); ctx.arc(sx, sy + 0.3, 1.4, 0, Math.PI * 2); ctx.fillStyle = '#0ea5e9'; ctx.fill();
  ctx.restore();
}
