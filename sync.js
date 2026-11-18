'use strict';
/* Synk av prosjekter mellom enheter via et privat GitHub-repo.
   projects/<id>.json = prosjektet (punkter, utstyr, innstillinger)
   files/<id>         = tegningsfilen (PDF/DXF), lastes opp én gang
   Nyeste endring vinner ved konflikt. Slettede prosjekter blir en «gravstein». */

const SYNC = {
  cfg: (() => { try { return JSON.parse(localStorage.getItem('tp-sync-cfg') || 'null'); } catch (e) { return null; } })(),
  meta: (() => { try { return JSON.parse(localStorage.getItem('tp-sync-meta') || '{}'); } catch (e) { return {}; } })(),
  busy: false, again: false, timer: 0, last: 0, status: ''
};
function syncSaveMeta() { try { localStorage.setItem('tp-sync-meta', JSON.stringify(SYNC.meta)); } catch (e) { } }
function syncSaveCfg() { try { localStorage.setItem('tp-sync-cfg', JSON.stringify(SYNC.cfg)); } catch (e) { } }
function syncStatus(t) {
  SYNC.status = t;
  const el = $('#syncState');
  if (el) el.textContent = t;
}

// marker lokale endringer
const _put = store.put.bind(store), _del = store.del.bind(store);
store.put = function (p, fromSync) {
  if (!fromSync && p && p.id) { const m = SYNC.meta[p.id] || (SYNC.meta[p.id] = {}); m.dirty = Date.now(); syncSaveMeta(); scheduleSync(4000); }
  return _put(p);
};
store.del = function (id, fromSync) {
  if (!fromSync) { SYNC.meta[id] = { deleted: true, dirty: Date.now() }; syncSaveMeta(); scheduleSync(1000); }
  return _del(id);
};

function scheduleSync(ms) {
  if (!SYNC.cfg) return;
  clearTimeout(SYNC.timer);
  SYNC.timer = setTimeout(syncNow, ms);
}

async function gh(path, opt = {}) {
  const headers = { Authorization: 'Bearer ' + SYNC.cfg.token, 'X-GitHub-Api-Version': '2022-11-28', Accept: opt.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' };
  if (opt.body) headers['Content-Type'] = 'application/json';
  const r = await fetch('https://api.github.com/repos/' + SYNC.cfg.repo + path, { method: opt.method || 'GET', headers, body: opt.body, cache: 'no-store' });
  if (r.status === 404 && opt.allow404) return null;
  if (!r.ok) {
    let msg = r.status + '';
    try { msg += ' ' + (await r.json()).message; } catch (e) { }
    if (r.status === 401) msg = 'ugyldig token';
    if (r.status === 403 || r.status === 404) msg = 'ingen tilgang til repoet (sjekk navn og at tokenet har Contents: Read and write)';
    throw new Error(msg);
  }
  return opt.raw ? r : r.json();
}
async function ghList(dir) { const r = await gh('/contents/' + dir, { allow404: true }); return Array.isArray(r) ? r : []; }
async function ghPut(path, b64, sha) {
  const r = await gh('/contents/' + encodeURI(path), { method: 'PUT', body: JSON.stringify({ message: 'Elektrotegning: ' + path, content: b64, sha: sha || undefined }) });
  return r.content.sha;
}
function b64utf8(s) {
  const u = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < u.length; i += 0x8000) out += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(out);
}
function cleanProject(p) {
  const { _d, ...r } = p;
  return { ...r, points: (p.points || []).map(q => { const { _d, ...x } = q; return x; }) };
}

async function syncNow() {
  if (!SYNC.cfg || !navigator.onLine) { if (SYNC.cfg) syncStatus('Synk venter på nett'); return; }
  if (SYNC.busy) { SYNC.again = true; return; }
  SYNC.busy = true; SYNC.again = false;
  syncStatus('Synker …');
  let changedLocal = false;
  try {
    const [rp, rf] = await Promise.all([ghList('projects'), ghList('files')]);
    const rsha = {}, fsha = {};
    for (const f of rp) if (f.name.endsWith('.json')) rsha[f.name.slice(0, -5)] = f.sha;
    for (const f of rf) fsha[f.name] = f.sha;
    const locals = await store.all(), lmap = {};
    for (const p of locals) lmap[p.id] = p;
    const ids = new Set([...Object.keys(rsha), ...Object.keys(lmap), ...Object.keys(SYNC.meta).filter(k => SYNC.meta[k].deleted)]);

    const uploadJson = async (L, sha) => {
      const t0 = Date.now();
      if (!fsha[L.id]) {
        const blob = await store.getFile(L.id);
        if (blob) fsha[L.id] = await ghPut('files/' + L.id, await blobToB64(blob), null);
      }
      const nsha = await ghPut(`projects/${L.id}.json`, b64utf8(JSON.stringify(cleanProject(L))), sha);
      const m = SYNC.meta[L.id] || (SYNC.meta[L.id] = {});
      m.sha = nsha; if (!m.dirty || m.dirty <= t0) m.dirty = 0;
      syncSaveMeta();
    };
    const getRemote = async id => JSON.parse(await (await gh(`/contents/projects/${id}.json`, { raw: true })).text());
    const applyRemote = async (R, sha) => {
      if (!(await store.getFile(R.id))) {
        if (!fsha[R.id]) return; // filen er ikke lastet opp ennå
        const buf = await (await gh('/contents/files/' + R.id, { raw: true })).arrayBuffer();
        await store.putFile(R.id, new Blob([buf], { type: R.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream' }));
      }
      await store.put(R, true);
      SYNC.meta[R.id] = { sha, dirty: 0 };
      syncSaveMeta();
      changedLocal = true;
      if (P && P.id === R.id) refreshOpenProject(R);
    };

    for (const id of ids) {
      const m = SYNC.meta[id] || {}, L = lmap[id], rs = rsha[id];
      if (m.deleted) {
        if (rs && m.sha === rs) continue;
        if (rs) await ghPut(`projects/${id}.json`, b64utf8(JSON.stringify({ id, deleted: true, updated: Date.now() })), rs).then(sha => { SYNC.meta[id] = { deleted: true, sha }; });
        else SYNC.meta[id] = { deleted: true };
        syncSaveMeta();
        continue;
      }
      if (L && !rs) { await uploadJson(L, null); continue; }
      if (!L && rs) {
        const R = await getRemote(id);
        if (R.deleted) { SYNC.meta[id] = { deleted: true, sha: rs }; syncSaveMeta(); continue; }
        await applyRemote(R, rs);
        continue;
      }
      if (!L) continue;
      if (rs === m.sha) { if (m.dirty) await uploadJson(L, rs); continue; }
      // endret på en annen enhet
      const R = await getRemote(id);
      if (R.deleted) {
        if (m.dirty) await uploadJson(L, rs);
        else { await _del(id); SYNC.meta[id] = { deleted: true, sha: rs }; syncSaveMeta(); changedLocal = true; if (P && P.id === id) closeEditor(); }
      } else if (m.dirty && (L.updated || 0) > (R.updated || 0)) await uploadJson(L, rs);
      else await applyRemote(R, rs);
    }
    SYNC.last = Date.now();
    syncStatus('Synket ' + new Date().toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' }));
  } catch (e) {
    console.error(e);
    syncStatus('Synk feilet: ' + (e.message || e));
  }
  SYNC.busy = false;
  if (changedLocal && !P) renderHome();
  if (SYNC.again) scheduleSync(500);
}

// prosjektet er åpent og ble endret på en annen enhet
function refreshOpenProject(R) {
  if (gest || dragPt) return;
  const keep = { id: P.id };
  Object.assign(P, R, keep);
  P.points.forEach(q => q._d = null);
  if (doc && doc.kind === 'dxf') { doc.applyLayers(P); eqInit(); }
  invalidateDims(); updateTitle(); updatePanelVisibility();
  if (typeof updateEqBar === 'function') updateEqBar();
  req();
  toast('Oppdatert fra annen enhet');
}

function openSyncSetup() {
  const c = SYNC.cfg || { repo: 'oysteineliassen/elektrotegning-data', token: '' };
  dialog(`<h2>Synk mellom enheter</h2>
    <p>Prosjektene lagres i et <b>privat</b> GitHub-repo, så de er like på PC og telefon. Gjør dette én gang:</p>
    <ol style="margin:0 0 8px;padding-left:20px;color:var(--muted);font-size:14px">
      <li>Lag et tomt, privat repo, f.eks. <b>elektrotegning-data</b>.</li>
      <li>Lag en <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" style="color:#93c5fd">fine-grained token</a> med tilgang bare til det repoet og <b>Contents: Read and write</b>. Sett lang utløpstid.</li>
      <li>Lim inn under – på hver enhet du vil synke.</li>
    </ol>
    <label class="f">Repo (eier/navn)</label><input id="syRepo" value="${esc(c.repo)}" autocomplete="off">
    <label class="f">Token</label><input id="syTok" type="password" value="${esc(c.token)}" autocomplete="off" placeholder="github_pat_…">
    <p id="syMsg" style="color:var(--text)"></p>
    <div class="btns">${SYNC.cfg ? '<button class="danger" data-off>Slå av</button>' : ''}<button data-x>Avbryt</button><button class="primary" data-ok>Lagre og synk</button></div>`, (el, close) => {
    $('[data-x]', el).onclick = close;
    const off = $('[data-off]', el);
    if (off) off.onclick = () => { SYNC.cfg = null; localStorage.removeItem('tp-sync-cfg'); syncStatus(''); close(); renderSyncState(); };
    $('[data-ok]', el).onclick = async () => {
      const repo = $('#syRepo', el).value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      const token = $('#syTok', el).value.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) { $('#syMsg', el).textContent = 'Fyll inn repo og token.'; return; }
      const prev = SYNC.cfg;
      SYNC.cfg = { repo, token };
      $('#syMsg', el).textContent = 'Tester tilgang …';
      try {
        const info = await gh('');
        if (!info.private) $('#syMsg', el).textContent = 'Advarsel: repoet er offentlig – gjør det privat.';
        if (!info.permissions || !info.permissions.push) throw new Error('tokenet har ikke skrivetilgang');
        syncSaveCfg(); close(); renderSyncState(); syncNow();
      } catch (e) { SYNC.cfg = prev; $('#syMsg', el).textContent = 'Feil: ' + e.message; }
    };
  });
}
function renderSyncState() {
  const b = $('#syncBtn');
  if (b) b.classList.toggle('on', !!SYNC.cfg);
  syncStatus(SYNC.cfg ? (SYNC.status || 'Synk på') : '');
}
$('#syncBtn').onclick = () => openSyncSetup();
document.addEventListener('visibilitychange', () => { if (!document.hidden && SYNC.cfg && Date.now() - SYNC.last > 20000) scheduleSync(300); });
window.addEventListener('online', () => scheduleSync(500));
renderSyncState();
if (SYNC.cfg) setTimeout(syncNow, 1500);
