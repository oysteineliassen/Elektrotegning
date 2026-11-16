/* DXF-leser/skriver (ASCII) for Elektrotegning.
   - Linjesegmenter i verdenskoordinater med y nedover
   - Toppnivå-INSERT holdes rede på (for flytting av utstyr)
   - Blokkgeometri i lokale koordinater (y nedover, basispunkt i origo)
   - HATCH (solid) som fyll + kantlinjer
   - Kan skrive tilbake en endret DXF */
(function (root) {
  'use strict';

  function decodeBytes(buf) {
    const u8 = new Uint8Array(buf);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
    catch (e) { return new TextDecoder('windows-1252').decode(u8); }
  }

  function tokenize(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const recs = [];
    let cur = null;
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i], 10);
      if (isNaN(code)) { i -= 1; continue; }
      const val = lines[i + 1];
      if (code === 0) {
        if (cur) cur.lnEnd = i;
        cur = { type: val.trim(), g: [], ln: i, lnEnd: lines.length };
        recs.push(cur);
      } else if (cur) cur.g.push(code, val);
    }
    return { lines, recs };
  }

  function get(r, code, def) {
    const g = r.g;
    for (let i = 0; i < g.length; i += 2) if (g[i] === code) return g[i + 1];
    return def;
  }
  function num(r, code, def) {
    const v = get(r, code, undefined);
    if (v === undefined) return def;
    const n = parseFloat(v);
    return isNaN(n) ? def : n;
  }
  function str(r, code, def) { const v = get(r, code, undefined); return v === undefined ? def : v.trim(); }

  const I = [1, 0, 0, 1, 0, 0];
  function mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }
  const MIRX = [-1, 0, 0, 1, 0, 0];
  function ocs(r, m) { return num(r, 230, 1) < 0 ? mul(m, MIRX) : m; }

  function cleanMText(s) {
    return s.replace(/\\P/g, '\n')
      .replace(/\\S([^;^#\/]*)[\^#\/]([^;]*);/g, '$1/$2')
      .replace(/\\[ACcFfHhQTWp][^;\\]*;/g, '')
      .replace(/\\[LlOoKkNX]/g, '').replace(/\\~/g, ' ')
      .replace(/\\U\+([0-9A-Fa-f]{4})/g, (a, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\\/g, '\\').replace(/[{}]/g, '');
  }
  function cleanText(s) {
    return s.replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoO]/g, '')
      .replace(/\\U\+([0-9A-Fa-f]{4})/g, (a, h) => String.fromCharCode(parseInt(h, 16)));
  }

  function newC() { return { x1: [], y1: [], x2: [], y2: [], l: [], ins: [], texts: [], fills: [] }; }

  function parseDXF(text) {
    const { lines, recs } = tokenize(text);
    const layers = new Map();
    const blocks = new Map();
    const ents = [];
    let insunits = 0, handseedLn = -1, entEndLn = -1;
    let section = null, curBlock = null;

    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.type === 'SECTION') {
        section = str(r, 2, '');
        if (section === 'HEADER') {
          const g = r.g;
          for (let k = 0; k < g.length; k += 2) {
            if (g[k] !== 9) continue;
            const name = g[k + 1].trim();
            if (name === '$INSUNITS') {
              for (let j = k + 2; j < g.length && g[j] !== 9; j += 2) if (g[j] === 70) { insunits = parseInt(g[j + 1], 10) || 0; break; }
            }
            if (name === '$HANDSEED') {
              // finn linjenummer for verdien (kode 5)
              let ln = r.ln + 2, cnt = 0;
              for (let j = 0; j < g.length; j += 2, ln += 2) {
                if (j > k && g[j] === 5) { handseedLn = ln + 1; break; }
                cnt++;
              }
            }
          }
        }
        continue;
      }
      if (r.type === 'ENDSEC') { if (section === 'ENTITIES') entEndLn = r.ln; section = null; continue; }
      if (r.type === 'EOF') break;
      if (section === 'TABLES') {
        if (r.type === 'LAYER') {
          const name = str(r, 2, '0');
          layers.set(name, { name, color: Math.abs(num(r, 62, 7)), off: num(r, 62, 7) < 0 || (num(r, 70, 0) & 1) === 1 });
        }
      } else if (section === 'BLOCKS') {
        if (r.type === 'BLOCK') {
          curBlock = { name: str(r, 2, ''), bx: num(r, 10, 0), by: num(r, 20, 0), flags: num(r, 70, 0), ents: [] };
          blocks.set(curBlock.name, curBlock);
        } else if (r.type === 'ENDBLK') curBlock = null;
        else if (curBlock) curBlock.ents.push(r);
      } else if (section === 'ENTITIES') { if (num(r, 67, 0) !== 1) ents.push(r); }
    }

    const layerIdx = new Map(), layerList = [];
    function L(name) {
      let k = layerIdx.get(name);
      if (k === undefined) {
        k = layerList.length; layerIdx.set(name, k);
        const info = layers.get(name);
        layerList.push({ name, color: info ? info.color : 7, off: info ? info.off : false, count: 0, inserts: 0 });
      }
      return k;
    }
    for (const name of layers.keys()) L(name);

    let C = newC(), curIns = -1, countLayers = true;

    function seg(m, x1, y1, x2, y2, li) {
      const ax = m[0] * x1 + m[2] * y1 + m[4], ay = m[1] * x1 + m[3] * y1 + m[5];
      const bx = m[0] * x2 + m[2] * y2 + m[4], by = m[1] * x2 + m[3] * y2 + m[5];
      if (!isFinite(ax + ay + bx + by)) return;
      C.x1.push(ax); C.y1.push(-ay); C.x2.push(bx); C.y2.push(-by); C.l.push(li); C.ins.push(curIns);
      if (countLayers) layerList[li].count++;
    }
    function poly(m, pts, closed, li) {
      for (let k = 0; k + 1 < pts.length; k++) seg(m, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], li);
      if (closed && pts.length > 2) seg(m, pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1], li);
    }
    function arcPts(cx, cy, r, a1, sweep) {
      const n = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * 72));
      const out = [];
      for (let k = 0; k <= n; k++) { const a = a1 + sweep * k / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      return out;
    }
    function bulgePts(x1, y1, x2, y2, b) {
      const th = 4 * Math.atan(b);
      const dx = x2 - x1, dy = y2 - y1, c = Math.hypot(dx, dy);
      if (c < 1e-12) return [];
      const h = c / (2 * Math.tan(th / 2));
      const cx = (x1 + x2) / 2 + (-dy / c) * h, cy = (y1 + y2) / 2 + (dx / c) * h;
      const pts = arcPts(cx, cy, Math.hypot(x1 - cx, y1 - cy), Math.atan2(y1 - cy, x1 - cx), th);
      pts.shift(); pts.pop();
      return pts;
    }
    function bulgePoly(v, closed) {
      if (v.length < 2) return [];
      const pts = [[v[0].x, v[0].y]], n = v.length, last = closed ? n : n - 1;
      for (let k = 0; k < last; k++) {
        const a = v[k], b = v[(k + 1) % n];
        if (a.b) for (const p of bulgePts(a.x, a.y, b.x, b.y, a.b)) pts.push(p);
        pts.push([b.x, b.y]);
      }
      return pts;
    }
    const scaleOf = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const rotOf = m => Math.atan2(m[1], m[0]);

    function bspline(deg, knots, ctrl) {
      const n = ctrl.length;
      if (n < 2 || !knots || knots.length !== n + deg + 1) return ctrl;
      const out = [], t0 = knots[deg], t1 = knots[n], steps = Math.max(16, n * 8);
      for (let s = 0; s <= steps; s++) {
        let t = t0 + (t1 - t0) * s / steps;
        if (s === steps) t = t1 - 1e-9 * (t1 - t0);
        let k = deg;
        while (k < n - 1 && t >= knots[k + 1]) k++;
        const d = [];
        for (let j = 0; j <= deg; j++) d.push(ctrl[k - deg + j].slice());
        for (let rr = 1; rr <= deg; rr++) for (let j = deg; j >= rr; j--) {
          const i = k - deg + j, den = knots[i + deg - rr + 1] - knots[i];
          const a = den === 0 ? 0 : (t - knots[i]) / den;
          d[j][0] = (1 - a) * d[j - 1][0] + a * d[j][0];
          d[j][1] = (1 - a) * d[j - 1][1] + a * d[j][1];
        }
        out.push(d[deg]);
      }
      return out;
    }

    function emitText(m, x, y, h, rotDeg, s, ha, va, li, rec) {
      if (!s) return;
      const X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
      const H = h * scaleOf(m), rot = rotDeg * Math.PI / 180 + rotOf(m);
      if (!(H > 0) || !isFinite(X + Y)) return;
      C.texts.push({ x: X, y: -Y, h: H, rot, s, ha, va, l: li, ins: curIns, rec });
    }

    // HATCH-grenser -> liste av polygoner (lokale koordinater)
    function hatchLoops(r) {
      const g = r.g; let k = 0;
      const loops = [];
      const seek = (code) => { while (k < g.length && g[k] !== code) k += 2; if (k >= g.length) return null; const v = g[k + 1]; k += 2; return v; };
      const peek = () => g[k];
      const nextVal = () => { const v = parseFloat(g[k + 1]); k += 2; return v; };
      const np = parseInt(seek(91), 10) || 0;
      for (let p = 0; p < np; p++) {
        const type = parseInt(seek(92), 10) || 0;
        const pts = [];
        if (type & 2) {
          const hasB = parseInt(seek(72), 10) || 0, closed = parseInt(seek(73), 10) || 0, n = parseInt(seek(93), 10) || 0;
          const v = [];
          for (let i = 0; i < n; i++) {
            const x = parseFloat(seek(10)), y = parseFloat(seek(20));
            let b = 0;
            if (hasB && peek() === 42) b = nextVal();
            v.push({ x, y, b });
          }
          loops.push(bulgePoly(v, true));
          void closed;
        } else {
          const ne = parseInt(seek(93), 10) || 0;
          for (let e = 0; e < ne; e++) {
            const et = parseInt(seek(72), 10) || 0;
            if (et === 1) {
              const x1 = parseFloat(seek(10)), y1 = parseFloat(seek(20)), x2 = parseFloat(seek(11)), y2 = parseFloat(seek(21));
              if (!pts.length) pts.push([x1, y1]);
              pts.push([x2, y2]);
            } else if (et === 2) {
              const cx = parseFloat(seek(10)), cy = parseFloat(seek(20)), rr = parseFloat(seek(40));
              let a1 = parseFloat(seek(50)), a2 = parseFloat(seek(51));
              const ccw = parseInt(seek(73), 10);
              if (!ccw) { a1 = -a1; a2 = -a2; }
              let sw = (a2 - a1) * Math.PI / 180;
              if (ccw) { while (sw <= 0) sw += Math.PI * 2; } else { while (sw >= 0) sw -= Math.PI * 2; }
              for (const q of arcPts(cx, cy, rr, a1 * Math.PI / 180, sw)) pts.push(q);
            } else if (et === 3) {
              const cx = parseFloat(seek(10)), cy = parseFloat(seek(20)), mx = parseFloat(seek(11)), my = parseFloat(seek(21));
              const ratio = parseFloat(seek(40)); let a1 = parseFloat(seek(50)), a2 = parseFloat(seek(51));
              const ccw = parseInt(seek(73), 10);
              if (!ccw) { a1 = -a1; a2 = -a2; }
              let sw = (a2 - a1) * Math.PI / 180;
              if (ccw) { while (sw <= 0) sw += Math.PI * 2; } else { while (sw >= 0) sw -= Math.PI * 2; }
              const nx = -my * ratio, ny = mx * ratio, n = 48;
              for (let i = 0; i <= n; i++) {
                const t = a1 * Math.PI / 180 + sw * i / n;
                pts.push([cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t)]);
              }
            } else if (et === 4) {
              seek(94); seek(73); seek(74);
              const nk = parseInt(seek(95), 10) || 0, nc = parseInt(seek(96), 10) || 0;
              for (let i = 0; i < nk; i++) seek(40);
              for (let i = 0; i < nc; i++) pts.push([parseFloat(seek(10)), parseFloat(seek(20))]);
            }
          }
          loops.push(pts);
        }
      }
      return loops.filter(l => l.length > 2);
    }

    function doEnts(list, m, inheritLayer, depth, top) {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        let lname = str(r, 8, '0');
        if (lname === '0' && inheritLayer) lname = inheritLayer;
        const li = L(lname);
        switch (r.type) {
          case 'LINE': seg(m, num(r, 10, 0), num(r, 20, 0), num(r, 11, 0), num(r, 21, 0), li); break;
          case 'LWPOLYLINE': {
            const v = [], g = r.g;
            for (let k = 0; k < g.length; k += 2) {
              const c = g[k];
              if (c === 10) v.push({ x: parseFloat(g[k + 1]), y: 0, b: 0 });
              else if (c === 20 && v.length) v[v.length - 1].y = parseFloat(g[k + 1]);
              else if (c === 42 && v.length) v[v.length - 1].b = parseFloat(g[k + 1]) || 0;
            }
            poly(ocs(r, m), bulgePoly(v, (num(r, 70, 0) & 1) === 1), false, li);
            break;
          }
          case 'POLYLINE': {
            const flags = num(r, 70, 0), v = [];
            let j = i + 1;
            while (j < list.length && list[j].type === 'VERTEX') {
              const vr = list[j], vf = num(vr, 70, 0);
              if (!(vf & 128) || (vf & 64)) v.push({ x: num(vr, 10, 0), y: num(vr, 20, 0), b: num(vr, 42, 0) });
              j++;
            }
            if (j < list.length && list[j].type === 'SEQEND') j++;
            i = j - 1;
            if (flags & 64 || flags & 16) break;
            poly(ocs(r, m), bulgePoly(v, (flags & 1) === 1), false, li);
            break;
          }
          case 'CIRCLE': poly(ocs(r, m), arcPts(num(r, 10, 0), num(r, 20, 0), num(r, 40, 0), 0, Math.PI * 2), false, li); break;
          case 'ARC': {
            const a1 = num(r, 50, 0) * Math.PI / 180;
            let sw = num(r, 51, 0) * Math.PI / 180 - a1;
            while (sw <= 0) sw += Math.PI * 2;
            poly(ocs(r, m), arcPts(num(r, 10, 0), num(r, 20, 0), num(r, 40, 0), a1, sw), false, li);
            break;
          }
          case 'ELLIPSE': {
            const cx = num(r, 10, 0), cy = num(r, 20, 0), mx = num(r, 11, 1), my = num(r, 21, 0), ratio = num(r, 40, 1);
            const t1 = num(r, 41, 0);
            let sw = num(r, 42, Math.PI * 2) - t1;
            while (sw <= 0) sw += Math.PI * 2;
            const nx = -my * ratio, ny = mx * ratio, n = Math.max(12, Math.ceil(sw / (Math.PI * 2) * 72)), pts = [];
            for (let k = 0; k <= n; k++) { const t = t1 + sw * k / n; pts.push([cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t)]); }
            poly(ocs(r, m), pts, false, li);
            break;
          }
          case 'SPLINE': {
            const g = r.g, ctrl = [], fit = [], knots = [];
            for (let k = 0; k < g.length; k += 2) {
              const c = g[k], val = parseFloat(g[k + 1]);
              if (c === 10) ctrl.push([val, 0]);
              else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = val;
              else if (c === 11) fit.push([val, 0]);
              else if (c === 21 && fit.length) fit[fit.length - 1][1] = val;
              else if (c === 40) knots.push(val);
            }
            let pts = ctrl.length >= 2 ? bspline(num(r, 71, 3), knots, ctrl) : fit;
            poly(m, pts, (num(r, 70, 0) & 1) === 1, li);
            break;
          }
          case 'SOLID': case 'TRACE': case '3DFACE': {
            const p1 = [num(r, 10, 0), num(r, 20, 0)], p2 = [num(r, 11, 0), num(r, 21, 0)];
            const p3 = [num(r, 12, 0), num(r, 22, 0)], p4 = [num(r, 13, p3[0]), num(r, 23, p3[1])];
            const pts = r.type === '3DFACE' ? [p1, p2, p3, p4] : [p1, p2, p4, p3];
            const mm = r.type === '3DFACE' ? m : ocs(r, m);
            poly(mm, pts, true, li);
            if (r.type !== '3DFACE') fillPoly(mm, [pts], li);
            break;
          }
          case 'HATCH': {
            if (num(r, 70, 0) !== 1) break; // bare solide fyll
            let loops;
            try { loops = hatchLoops(r); } catch (e) { loops = []; }
            const mm = ocs(r, m);
            for (const lp of loops) poly(mm, lp, true, li);
            fillPoly(mm, loops, li);
            break;
          }
          case 'TEXT': case 'ATTRIB': {
            if (r.type === 'ATTRIB' && (num(r, 70, 0) & 1)) break;
            const ha = num(r, 72, 0), va = num(r, 73, r.type === 'ATTRIB' ? num(r, 74, 0) : 0);
            const al = ha !== 0 || va !== 0;
            emitText(ocs(r, m), al ? num(r, 11, num(r, 10, 0)) : num(r, 10, 0), al ? num(r, 21, num(r, 20, 0)) : num(r, 20, 0),
              num(r, 40, 1), num(r, 50, 0), cleanText(str(r, 1, '')),
              ha === 1 || ha === 4 ? 'center' : ha === 2 ? 'right' : 'left',
              va === 3 ? 'top' : va === 2 || ha === 4 ? 'middle' : 'alphabetic', li, top ? r : null);
            break;
          }
          case 'MTEXT': {
            let s = '';
            const g = r.g;
            for (let k = 0; k < g.length; k += 2) if (g[k] === 3) s += g[k + 1];
            s += get(r, 1, '');
            let rot = num(r, 50, NaN);
            if (isNaN(rot)) rot = Math.atan2(num(r, 21, 0), num(r, 11, 1)) * 180 / Math.PI;
            const at = num(r, 71, 1), col = (at - 1) % 3, row = Math.floor((at - 1) / 3);
            emitText(m, num(r, 10, 0), num(r, 20, 0), num(r, 40, 1), rot, cleanMText(s),
              col === 0 ? 'left' : col === 1 ? 'center' : 'right', row === 0 ? 'top' : row === 1 ? 'middle' : 'bottom', li, top ? r : null);
            break;
          }
          case 'INSERT': case 'DIMENSION': {
            if (depth > 10) break;
            const b = blocks.get(str(r, 2, ''));
            if (!b) break;
            if (r.type === 'DIMENSION') { doEnts(b.ents, m, lname, depth + 1, false); break; }
            // attributter som hører til innsettingen
            let j = i + 1;
            const attribs = [];
            if (num(r, 66, 0) === 1) {
              while (j < list.length && list[j].type === 'ATTRIB') { attribs.push(list[j]); j++; }
              if (j < list.length && list[j].type === 'SEQEND') j++;
            }
            const sx = num(r, 41, 1), sy = num(r, 42, 1), rot = num(r, 50, 0) * Math.PI / 180;
            const cols = Math.max(1, num(r, 70, 1)), rows = Math.max(1, num(r, 71, 1));
            const cs = num(r, 44, 0), rs = num(r, 45, 0);
            const base = ocs(r, m), cos = Math.cos(rot), sin = Math.sin(rot);
            const prevIns = curIns;
            if (top && cols === 1 && rows === 1) {
              const mir = num(r, 230, 1) < 0;
              curIns = inserts.length;
              inserts.push({
                idx: curIns, block: b.name, layer: lname, li,
                x: (mir ? -1 : 1) * num(r, 10, 0), y: -num(r, 20, 0),
                r: -(mir ? -rot : rot), sx: mir ? -sx : sx, sy,
                rec: r, attribs, recEnd: j, ln: r.ln, lnEnd: (j > i + 1 ? list[j - 1].lnEnd : r.lnEnd)
              });
              layerList[li].inserts++;
            }
            for (let rr = 0; rr < Math.min(rows, 50); rr++) for (let cc = 0; cc < Math.min(cols, 50); cc++) {
              const ox = cc * cs, oy = rr * rs;
              const ix = num(r, 10, 0) + ox * cos - oy * sin, iy = num(r, 20, 0) + ox * sin + oy * cos;
              let t = [1, 0, 0, 1, -b.bx, -b.by];
              t = mul([sx, 0, 0, sy, 0, 0], t);
              t = mul([cos, sin, -sin, cos, 0, 0], t);
              t = mul([1, 0, 0, 1, ix, iy], t);
              doEnts(b.ents, mul(base, t), lname, depth + 1, false);
            }
            for (const a of attribs) doEnts([a], m, lname, depth + 1, false);
            curIns = prevIns;
            i = j - 1;
            break;
          }
        }
      }
    }
    function fillPoly(m, loops, li) {
      const out = loops.map(lp => lp.map(p => [m[0] * p[0] + m[2] * p[1] + m[4], -(m[1] * p[0] + m[3] * p[1] + m[5])]));
      if (out.length) C.fills.push({ loops: out, l: li, ins: curIns });
    }

    const inserts = [];
    doEnts(ents, I, null, 0, true);
    const W = C;

    // Lokal geometri per blokk (y nedover, basispunkt i origo)
    const geomCache = new Map();
    function blockGeom(name) {
      if (geomCache.has(name)) return geomCache.get(name);
      const b = blocks.get(name);
      if (!b) return null;
      const save = C, saveIns = curIns;
      C = newC(); curIns = -1; countLayers = false;
      doEnts(b.ents, [1, 0, 0, 1, -b.bx, -b.by], null, 1, false);
      const G = C;
      C = save; curIns = saveIns; countLayers = true;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < G.x1.length; k++) {
        x0 = Math.min(x0, G.x1[k], G.x2[k]); x1 = Math.max(x1, G.x1[k], G.x2[k]);
        y0 = Math.min(y0, G.y1[k], G.y2[k]); y1 = Math.max(y1, G.y1[k], G.y2[k]);
      }
      for (const t of G.texts) { x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x + t.h); y0 = Math.min(y0, t.y - t.h); y1 = Math.max(y1, t.y); }
      const res = { segs: G, bbox: isFinite(x0) ? { x0, y0, x1, y1 } : { x0: -100, y0: -100, x1: 100, y1: 100 } };
      geomCache.set(name, res);
      return res;
    }

    const N = W.x1.length;
    const segs = {
      n: N, x1: Float64Array.from(W.x1), y1: Float64Array.from(W.y1),
      x2: Float64Array.from(W.x2), y2: Float64Array.from(W.y2),
      l: Int32Array.from(W.l), ins: Int32Array.from(W.ins)
    };

    let bounds = null;
    if (N) {
      const xs = new Float64Array(N * 2), ys = new Float64Array(N * 2);
      for (let k = 0; k < N; k++) { xs[2 * k] = W.x1[k]; xs[2 * k + 1] = W.x2[k]; ys[2 * k] = W.y1[k]; ys[2 * k + 1] = W.y2[k]; }
      xs.sort(); ys.sort();
      const q = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
      const lo = N > 200 ? 0.01 : 0, hi = N > 200 ? 0.99 : 1;
      const x0 = q(xs, lo), x1 = q(xs, hi), y0 = q(ys, lo), y1 = q(ys, hi);
      const px = (x1 - x0) * 0.05 || 1, py = (y1 - y0) * 0.05 || 1;
      bounds = { x0: x0 - px, y0: y0 - py, x1: x1 + px, y1: y1 + py };
    }

    return {
      segs, texts: W.texts, fills: W.fills, layers: layerList, insunits, bounds,
      inserts, blockGeom, blockNames: [...blocks.keys()].filter(n => !n.startsWith('*')),
      _src: { lines, handseedLn, entEndLn }
    };
  }

  /* ---------- Skriving ----------
     changes: { moved: Map(insIdx -> {x,y,r}), deleted: Set(insIdx),
                added: [{block, layer, x, y, r, sx, sy, tmpl: insIdx|null}],
                textMoves: Map(textRec -> {dx, dy}) }
     Koordinater i appens system (y nedover, r = rotasjon med klokka i radianer). */
  function fmtN(v) { return (Math.round(v * 1e6) / 1e6).toString(); }
  function writeDXF(parsed, changes) {
    const src = parsed._src;
    const lines = src.lines.slice();
    let seed = -1;
    if (src.handseedLn >= 0) seed = parseInt(lines[src.handseedLn].trim(), 16);
    const newHandle = () => { if (seed < 0) return null; const h = seed.toString(16).toUpperCase(); seed++; return h; };

    // erstatninger: liste av {ln, lnEnd, out:[...]} sortert bakfra
    const reps = [];
    const toDxf = (o) => {
      // app (y ned, r med klokka) -> DXF (y opp, grader mot klokka)
      let deg = (-o.r * 180 / Math.PI) % 360; if (deg < 0) deg += 360;
      return { x: o.x, y: -o.y, deg, sx: o.sx, sy: o.sy };
    };
    function recPairs(r) { const out = []; for (let k = 0; k < r.g.length; k += 2) out.push([r.g[k], r.g[k + 1]]); return out; }
    function emit(type, pairs) {
      const out = ['  0', type];
      for (const [c, v] of pairs) { out.push(String(c).padStart(3, ' ')); out.push(v); }
      return out;
    }
    function setPair(pairs, code, val, afterCodes) {
      const i = pairs.findIndex(p => p[0] === code);
      if (i >= 0) { pairs[i][1] = val; return; }
      let at = -1;
      for (const c of afterCodes) { const j = pairs.findIndex(p => p[0] === c); if (j > at) at = j; }
      pairs.splice(at + 1, 0, [code, val]);
    }
    // ny matrise for attributter/tekst: T = M_new * inv(M_old) i DXF-koordinater
    function insMatrix(d) {
      const c = Math.cos(d.deg * Math.PI / 180), s = Math.sin(d.deg * Math.PI / 180);
      return [c, s, -s, c, d.x, d.y];
    }
    function inv(m) {
      const det = m[0] * m[3] - m[1] * m[2];
      const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
      return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
    }
    function moveAttrib(r, T, ddeg, handle) {
      const p = recPairs(r);
      for (const [cx, cy] of [[10, 20], [11, 21]]) {
        const ix = p.findIndex(q => q[0] === cx), iy = p.findIndex(q => q[0] === cy);
        if (ix < 0 || iy < 0) continue;
        const x = parseFloat(p[ix][1]), y = parseFloat(p[iy][1]);
        p[ix][1] = fmtN(T[0] * x + T[2] * y + T[4]); p[iy][1] = fmtN(T[1] * x + T[3] * y + T[5]);
      }
      let rot = (parseFloat((p.find(q => q[0] === 50) || [0, '0'])[1]) + ddeg) % 360; if (rot < 0) rot += 360;
      setPair(p, 50, fmtN(rot), [40, 30, 20]);
      if (handle !== undefined) { const h = p.findIndex(q => q[0] === 5); if (h >= 0) { if (handle) p[h][1] = handle; else p.splice(h, 1); } }
      return p;
    }
    function buildInsert(ins, o, newHandles) {
      const d = toDxf(o);
      const p = recPairs(ins.rec);
      const mir = num(ins.rec, 230, 1) < 0;
      setPair(p, 10, fmtN(d.x), [8, 2]);
      setPair(p, 20, fmtN(d.y), [10]);
      setPair(p, 50, fmtN(d.deg), [43, 42, 41, 30, 20]);
      if (mir) { setPair(p, 41, fmtN(o.sx), [30, 20]); const z = p.findIndex(q => q[0] === 230); if (z >= 0) p[z][1] = '1'; }
      if (o.layer) setPair(p, 8, o.layer, []);
      if (newHandles) { const h = p.findIndex(q => q[0] === 5); if (h >= 0) { const nh = newHandle(); if (nh) p[h][1] = nh; else p.splice(h, 1); } }
      let out = emit('INSERT', p);
      if (ins.attribs.length) {
        const oldD = { x: (mir ? -1 : 1) * ins.x, y: -ins.y, deg: -ins.r * 180 / Math.PI * (mir ? -1 : 1) };
        const T = mul(insMatrix(d), inv(insMatrix({ x: num(ins.rec, 10, 0), y: num(ins.rec, 20, 0), deg: num(ins.rec, 50, 0) })));
        const ddeg = d.deg - num(ins.rec, 50, 0);
        void oldD;
        for (const a of ins.attribs) out = out.concat(emit('ATTRIB', moveAttrib(a, T, ddeg, newHandles ? newHandle() : undefined)));
        // SEQEND
        const seqStart = ins.attribs[ins.attribs.length - 1].lnEnd;
        const seq = src.lines.slice(seqStart, ins.lnEnd);
        if (newHandles) {
          for (let k = 0; k + 1 < seq.length; k += 2) if (parseInt(seq[k], 10) === 5) { const nh = newHandle(); if (nh) seq[k + 1] = nh; }
        }
        out = out.concat(seq);
      }
      return out;
    }

    for (const ins of parsed.inserts) {
      if (changes.deleted && changes.deleted.has(ins.idx)) { reps.push({ ln: ins.ln, lnEnd: ins.lnEnd, out: [] }); continue; }
      const mv = changes.moved && changes.moved.get(ins.idx);
      if (mv) reps.push({ ln: ins.ln, lnEnd: ins.lnEnd, out: buildInsert(ins, { sx: ins.sx, sy: ins.sy, ...mv }, false) });
    }
    if (changes.textDeletes) for (const rec of changes.textDeletes) reps.push({ ln: rec.ln, lnEnd: rec.lnEnd, out: [] });
    if (changes.textMoves) for (const [rec, mv] of changes.textMoves) {
      // mv: {ox, oy, nx, ny, dr} i appens koordinater (y ned): p' = n + R(dr)(p - o)
      const p = recPairs(rec), c = Math.cos(mv.dr || 0), s = Math.sin(mv.dr || 0);
      for (const [cx, cy] of [[10, 20], [11, 21]]) {
        const ix = p.findIndex(q => q[0] === cx), iy = p.findIndex(q => q[0] === cy);
        if (ix < 0 || iy < 0) continue;
        if (cx === 11 && rec.type === 'MTEXT') continue; // retningsvektor
        const ax = parseFloat(p[ix][1]) - mv.ox, ay = -parseFloat(p[iy][1]) - mv.oy;
        p[ix][1] = fmtN(mv.nx + c * ax - s * ay); p[iy][1] = fmtN(-(mv.ny + s * ax + c * ay));
      }
      reps.push({ ln: rec.ln, lnEnd: rec.lnEnd, out: emit(rec.type, p) });
    }
    // nye
    let addOut = [];
    for (const a of (changes.added || [])) {
      const tmpl = parsed.inserts[a.tmpl];
      if (tmpl) addOut = addOut.concat(buildInsert(tmpl, a, true));
      else {
        const d = toDxf(a);
        const h = newHandle();
        const p = [];
        if (h) p.push([5, h]);
        p.push([100, 'AcDbEntity'], [8, a.layer || '0'], [100, 'AcDbBlockReference'], [2, a.block],
          [10, fmtN(d.x)], [20, fmtN(d.y)], [30, '0'], [41, fmtN(a.sx || 1)], [42, fmtN(a.sy || 1)], [43, '1'], [50, fmtN(d.deg)]);
        addOut = addOut.concat(emit('INSERT', p));
      }
    }
    if (addOut.length && src.entEndLn >= 0) reps.push({ ln: src.entEndLn, lnEnd: src.entEndLn, out: addOut });

    reps.sort((a, b) => b.ln - a.ln || b.lnEnd - a.lnEnd);
    for (const r of reps) lines.splice(r.ln, r.lnEnd - r.ln, ...r.out);
    if (seed >= 0 && src.handseedLn >= 0) {
      // handseed-linjen ligger i HEADER, før alle endringer → indeks uendret
      lines[src.handseedLn] = seed.toString(16).toUpperCase();
    }
    return lines.join('\r\n');
  }

  const api = { parseDXF, decodeBytes, writeDXF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DXF = api;
})(typeof self !== 'undefined' ? self : this);
