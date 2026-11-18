'use strict';
/* Bjelkelag/stendere i Takpunkter: tegner bjelkene og varsler når et hull treffer en bjelke. */

function J() { return P && P.joists && P.joists.on ? P.joists : null; }
function jU(v) { return v / (P.mmPerUnit || 1); }
// avstand fra punktets akse-koordinat til nærmeste bjelkesenter
function joistInfo(p) {
  const j = J();
  if (!j || !P.mmPerUnit) return null;
  const cc = jU(j.cc), u = j.dir === 'v' ? p.x : p.y;
  const k = Math.round((u - j.off) / cc), c = j.off + k * cc, d = Math.abs(u - c);
  const clear = jU(j.w / 2 + j.hole / 2);
  return { hit: d < clear, d, clear, gap: j.off + (Math.floor((u - j.off) / cc) + 0.5) * cc, need: clear - d };
}
function joistCentersIn(a, b) {
  const j = J(), cc = jU(j.cc), out = [];
  if (!(cc > 0)) return out;
  let k = Math.ceil((a - j.off) / cc);
  for (let n = 0; n < 2000; n++, k++) { const c = j.off + k * cc; if (c > b) break; out.push(c); }
  return out;
}
// tegnes i skjermkoordinater, under punktene
function drawJoists(ctx, v, o) {
  const j = J();
  if (!j) return;
  const b = doc.bounds, W = ctx.canvas.width / (o.export ? 1 : dpr), H = ctx.canvas.height / (o.export ? 1 : dpr);
  const ux0 = Math.max(b.x0, -v.tx / v.s), ux1 = Math.min(b.x1, (W - v.tx) / v.s);
  const uy0 = Math.max(b.y0, -v.ty / v.s), uy1 = Math.min(b.y1, (H - v.ty) / v.s);
  if (ux1 <= ux0 || uy1 <= uy0) return;
  const hw = jU(j.w) / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(217,119,6,.16)'; ctx.strokeStyle = 'rgba(180,83,9,.55)'; ctx.lineWidth = 1; ctx.setLineDash([8, 5]);
  if (j.dir === 'v') {
    for (const c of joistCentersIn(ux0 - hw, ux1 + hw)) {
      const x = c * v.s + v.tx, y0 = uy0 * v.s + v.ty, y1 = uy1 * v.s + v.ty;
      ctx.fillRect(x - hw * v.s, y0, 2 * hw * v.s, y1 - y0);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    }
  } else {
    for (const c of joistCentersIn(uy0 - hw, uy1 + hw)) {
      const y = c * v.s + v.ty, x0 = ux0 * v.s + v.tx, x1 = ux1 * v.s + v.tx;
      ctx.fillRect(x0, y - hw * v.s, x1 - x0, 2 * hw * v.s);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }
  }
  ctx.restore();
}
function drawJoistWarn(ctx, sx, sy, k) {
  ctx.save();
  ctx.beginPath(); ctx.arc(sx, sy, 17 * k, 0, Math.PI * 2);
  ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 2.5 * k; ctx.setLineDash([4, 3]); ctx.stroke();
  ctx.restore();
}
function moveToGap(p) {
  const ji = joistInfo(p);
  if (!ji) return;
  pushUndo();
  if (P.joists.dir === 'v') p.x = ji.gap; else p.y = ji.gap;
  p._d = null; save(); req();
}
function openJoists() {
  if (!P.mmPerUnit) { askScale(); return; }
  const j = Object.assign({ on: true, dir: 'v', cc: 600, w: 48, hole: 75, off: 0 }, P.joists || {});
  const opt = (arr, cur) => arr.map(([v, t]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${t}</option>`).join('');
  dialog(`<h2>Bjelkelag</h2><p>Bjelkene vises i Takpunkter. Punkter der hullet treffer en bjelke får rød ring.</p>
    <label class="setrow"><span>Vis bjelkelag</span><input type="checkbox" id="jOn" ${j.on ? 'checked' : ''} style="width:24px;height:24px"></label>
    <div class="setrow"><span>Bjelkene går</span><select id="jDir">${opt([['v', '↕ loddrett på tegningen'], ['h', '↔ vannrett på tegningen']], j.dir)}</select></div>
    <div class="setrow"><span>c/c (mm)</span><input type="number" id="jCc" value="${j.cc}"></div>
    <div class="setrow"><span>Bjelkebredde (mm)</span><input type="number" id="jW" value="${j.w}"></div>
    <div class="setrow"><span>Hull Ø (mm)</span><input type="number" id="jHole" value="${j.hole}"></div>
    <div class="btns"><button data-place>Plasser: trykk på en bjelke</button><button data-x>Avbryt</button><button class="primary" data-ok>Lagre</button></div>`, (el, close) => {
    const read = () => Object.assign(j, { on: $('#jOn', el).checked, dir: $('#jDir', el).value, cc: +$('#jCc', el).value || 600, w: +$('#jW', el).value || 48, hole: +$('#jHole', el).value || 0 });
    $('[data-x]', el).onclick = close;
    $('[data-ok]', el).onclick = () => { read(); P.joists = j; close(); save(); req(); };
    $('[data-place]', el).onclick = () => {
      read(); j.on = true; P.joists = j; close();
      mode = 'joist'; select(null);
      setBanner('Trykk midt på en bjelke (zoom inn for nøyaktighet)', 'Avbryt', () => { mode = 'edit'; setBanner(null); req(); });
      req();
    };
  });
}
function joistTap(u) {
  P.joists.off = P.joists.dir === 'v' ? u.x : u.y;
  mode = 'edit'; setBanner(null); save(); req();
  toast('Bjelkelaget er plassert');
}
