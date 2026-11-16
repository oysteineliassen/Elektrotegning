/* Enkel DXF-leser (ASCII) for Takpunkter.
   Gir linjesegmenter (y nedover), tekster, lag og enheter. */
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
      if (isNaN(code)) { i -= 1; continue; } // ute av takt: prøv neste linje
      const val = lines[i + 1];
      if (code === 0) {
        cur = { type: val.trim(), g: [] };
        recs.push(cur);
      } else if (cur) {
        cur.g.push(code, val);
      }
    }
    return recs;
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
  function str(r, code, def) {
    const v = get(r, code, undefined);
    return v === undefined ? def : v.trim();
  }

  // Matrise [a,b,c,d,e,f]: x' = a*x + c*y + e ; y' = b*x + d*y + f
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
    return s
      .replace(/\\P/g, '\n')
      .replace(/\\S([^;^#\/]*)[\^#\/]([^;]*);/g, '$1/$2')
      .replace(/\\[ACcFfHhQTWp][^;\\]*;/g, '')
      .replace(/\\[LlOoKkNX]/g, '')
      .replace(/\\~/g, ' ')
      .replace(/\\U\+([0-9A-Fa-f]{4})/g, (a, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\\/g, '\\')
      .replace(/[{}]/g, '');
  }
  function cleanText(s) {
    return s
      .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
      .replace(/%%[uUoO]/g, '')
      .replace(/\\U\+([0-9A-Fa-f]{4})/g, (a, h) => String.fromCharCode(parseInt(h, 16)));
  }

  function parseDXF(text) {
    const recs = tokenize(text);
    const layers = new Map(); // navn -> {name, off}
    const blocks = new Map(); // navn -> {bx, by, ents}
    const ents = [];
    let insunits = 0;
    let section = null;
    let curBlock = null;

    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.type === 'SECTION') {
        section = str(r, 2, '');
        if (section === 'HEADER') {
          const g = r.g;
          for (let k = 0; k < g.length; k += 2) {
            if (g[k] === 9 && g[k + 1].trim() === '$INSUNITS') {
              for (let j = k + 2; j < g.length; j += 2) {
                if (g[j] === 70) { insunits = parseInt(g[j + 1], 10) || 0; break; }
                if (g[j] === 9) break;
              }
            }
          }
        }
        continue;
      }
      if (r.type === 'ENDSEC') { section = null; continue; }
      if (r.type === 'EOF') break;

      if (section === 'TABLES') {
        if (r.type === 'LAYER') {
          const name = str(r, 2, '0');
          const color = num(r, 62, 7);
          const flags = num(r, 70, 0);
          layers.set(name, { name, off: color < 0 || (flags & 1) === 1 });
        }
      } else if (section === 'BLOCKS') {
        if (r.type === 'BLOCK') {
          curBlock = { name: str(r, 2, ''), bx: num(r, 10, 0), by: num(r, 20, 0), ents: [] };
          blocks.set(curBlock.name, curBlock);
        } else if (r.type === 'ENDBLK') {
          curBlock = null;
        } else if (curBlock) {
          curBlock.ents.push(r);
        }
      } else if (section === 'ENTITIES') {
        ents.push(r);
      }
    }

    const segX1 = [], segY1 = [], segX2 = [], segY2 = [], segL = [];
    const texts = [];
    const layerIdx = new Map();
    const layerList = [];
    function L(name) {
      let k = layerIdx.get(name);
      if (k === undefined) {
        k = layerList.length;
        layerIdx.set(name, k);
        const info = layers.get(name);
        layerList.push({ name, off: info ? info.off : false, count: 0 });
      }
      return k;
    }
    for (const name of layers.keys()) L(name);

    function seg(m, x1, y1, x2, y2, li) {
      const ax = m[0] * x1 + m[2] * y1 + m[4], ay = m[1] * x1 + m[3] * y1 + m[5];
      const bx = m[0] * x2 + m[2] * y2 + m[4], by = m[1] * x2 + m[3] * y2 + m[5];
      if (!isFinite(ax + ay + bx + by)) return;
      segX1.push(ax); segY1.push(-ay); segX2.push(bx); segY2.push(-by); segL.push(li);
      layerList[li].count++;
    }
    function poly(m, pts, closed, li) {
      for (let k = 0; k + 1 < pts.length; k++) seg(m, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], li);
      if (closed && pts.length > 2) seg(m, pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1], li);
    }
    function arcPts(cx, cy, r, a1, sweep) {
      const n = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * 72));
      const out = [];
      for (let k = 0; k <= n; k++) {
        const a = a1 + sweep * k / n;
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return out;
    }
    function bulgePts(x1, y1, x2, y2, b) {
      const th = 4 * Math.atan(b);
      const dx = x2 - x1, dy = y2 - y1, c = Math.hypot(dx, dy);
      if (c < 1e-12) return [];
      const h = c / (2 * Math.tan(th / 2));
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const cx = mx + (-dy / c) * h, cy = my + (dx / c) * h;
      const r = Math.hypot(x1 - cx, y1 - cy);
      const a1 = Math.atan2(y1 - cy, x1 - cx);
      const pts = arcPts(cx, cy, r, a1, th);
      pts.shift(); pts.pop();
      return pts;
    }
    function scaleOf(m) { return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])); }
    function rotOf(m) { return Math.atan2(m[1], m[0]); }

    function bspline(deg, knots, ctrl) {
      const n = ctrl.length;
      if (n < 2) return ctrl;
      if (!knots || knots.length !== n + deg + 1) return ctrl;
      const out = [];
      const t0 = knots[deg], t1 = knots[n];
      const steps = Math.max(16, n * 8);
      for (let s = 0; s <= steps; s++) {
        let t = t0 + (t1 - t0) * s / steps;
        if (s === steps) t = t1 - 1e-9 * (t1 - t0);
        let k = deg;
        while (k < n - 1 && t >= knots[k + 1]) k++;
        const d = [];
        for (let j = 0; j <= deg; j++) d.push(ctrl[k - deg + j].slice());
        for (let rr = 1; rr <= deg; rr++) {
          for (let j = deg; j >= rr; j--) {
            const i = k - deg + j;
            const den = knots[i + deg - rr + 1] - knots[i];
            const a = den === 0 ? 0 : (t - knots[i]) / den;
            d[j][0] = (1 - a) * d[j - 1][0] + a * d[j][0];
            d[j][1] = (1 - a) * d[j - 1][1] + a * d[j][1];
          }
        }
        out.push(d[deg]);
      }
      return out;
    }

    function emitText(m, x, y, h, rotDeg, s, ha, va, li) {
      if (!s) return;
      const X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
      const H = h * scaleOf(m);
      const rot = rotDeg * Math.PI / 180 + rotOf(m);
      if (!(H > 0) || !isFinite(X + Y)) return;
      texts.push({ x: X, y: -Y, h: H, rot, s, ha, va, l: li });
    }

    function doEnts(list, m, inheritLayer, depth) {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        let lname = str(r, 8, '0');
        if (lname === '0' && inheritLayer) lname = inheritLayer;
        const li = L(lname);
        switch (r.type) {
          case 'LINE':
            seg(m, num(r, 10, 0), num(r, 20, 0), num(r, 11, 0), num(r, 21, 0), li);
            break;
          case 'LWPOLYLINE': {
            const mm = ocs(r, m);
            const v = [];
            const g = r.g;
            for (let k = 0; k < g.length; k += 2) {
              const c = g[k];
              if (c === 10) v.push({ x: parseFloat(g[k + 1]), y: 0, b: 0 });
              else if (c === 20 && v.length) v[v.length - 1].y = parseFloat(g[k + 1]);
              else if (c === 42 && v.length) v[v.length - 1].b = parseFloat(g[k + 1]) || 0;
            }
            const closed = (num(r, 70, 0) & 1) === 1;
            polyWithBulge(mm, v, closed, li);
            break;
          }
          case 'POLYLINE': {
            const flags = num(r, 70, 0);
            const v = [];
            let j = i + 1;
            while (j < list.length && list[j].type === 'VERTEX') {
              const vr = list[j];
              const vf = num(vr, 70, 0);
              if (!(vf & 128) || (vf & 64)) v.push({ x: num(vr, 10, 0), y: num(vr, 20, 0), b: num(vr, 42, 0) });
              j++;
            }
            if (j < list.length && list[j].type === 'SEQEND') j++;
            i = j - 1;
            if (flags & 64 || flags & 16) break; // nett/flater: hopp over
            polyWithBulge(ocs(r, m), v, (flags & 1) === 1, li);
            break;
          }
          case 'CIRCLE': {
            const mm = ocs(r, m);
            poly(mm, arcPts(num(r, 10, 0), num(r, 20, 0), num(r, 40, 0), 0, Math.PI * 2), false, li);
            break;
          }
          case 'ARC': {
            const mm = ocs(r, m);
            const a1 = num(r, 50, 0) * Math.PI / 180;
            let a2 = num(r, 51, 0) * Math.PI / 180;
            let sw = a2 - a1;
            while (sw <= 0) sw += Math.PI * 2;
            poly(mm, arcPts(num(r, 10, 0), num(r, 20, 0), num(r, 40, 0), a1, sw), false, li);
            break;
          }
          case 'ELLIPSE': {
            const cx = num(r, 10, 0), cy = num(r, 20, 0);
            const mx = num(r, 11, 1), my = num(r, 21, 0);
            const ratio = num(r, 40, 1);
            let t1 = num(r, 41, 0), t2 = num(r, 42, Math.PI * 2);
            let sw = t2 - t1;
            while (sw <= 0) sw += Math.PI * 2;
            const nx = -my * ratio, ny = mx * ratio;
            const n = Math.max(12, Math.ceil(sw / (Math.PI * 2) * 72));
            const pts = [];
            for (let k = 0; k <= n; k++) {
              const t = t1 + sw * k / n;
              pts.push([cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t)]);
            }
            poly(num(r, 230, 1) < 0 ? mul(m, MIRX) : m, pts, false, li);
            break;
          }
          case 'SPLINE': {
            const g = r.g;
            const ctrl = [], fit = [], knots = [];
            for (let k = 0; k < g.length; k += 2) {
              const c = g[k], val = parseFloat(g[k + 1]);
              if (c === 10) ctrl.push([val, 0]);
              else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = val;
              else if (c === 11) fit.push([val, 0]);
              else if (c === 21 && fit.length) fit[fit.length - 1][1] = val;
              else if (c === 40) knots.push(val);
            }
            const deg = num(r, 71, 3);
            let pts = ctrl.length >= 2 ? bspline(deg, knots, ctrl) : fit;
            if (pts.length < 2) pts = fit;
            poly(m, pts, (num(r, 70, 0) & 1) === 1, li);
            break;
          }
          case 'SOLID': case 'TRACE': case '3DFACE': {
            const p = [[num(r, 10, 0), num(r, 20, 0)], [num(r, 11, 0), num(r, 21, 0)]];
            const p3 = [num(r, 12, 0), num(r, 22, 0)], p4 = [num(r, 13, p3[0]), num(r, 23, p3[1])];
            const pts = r.type === '3DFACE' ? [p[0], p[1], p3, p4] : [p[0], p[1], p4, p3];
            poly(r.type === '3DFACE' ? m : ocs(r, m), pts, true, li);
            break;
          }
          case 'TEXT': case 'ATTRIB': {
            if (r.type === 'ATTRIB' && (num(r, 70, 0) & 1)) break; // usynlig
            const mm = ocs(r, m);
            const ha = num(r, 72, 0), va = num(r, 73, r.type === 'ATTRIB' ? num(r, 74, 0) : 0);
            const useAlign = ha !== 0 || va !== 0;
            const x = useAlign ? num(r, 11, num(r, 10, 0)) : num(r, 10, 0);
            const y = useAlign ? num(r, 21, num(r, 20, 0)) : num(r, 20, 0);
            emitText(mm, x, y, num(r, 40, 1), num(r, 50, 0), cleanText(str(r, 1, '')),
              ha === 1 || ha === 4 ? 'center' : ha === 2 ? 'right' : 'left',
              va === 3 ? 'top' : va === 2 || ha === 4 ? 'middle' : 'alphabetic', li);
            break;
          }
          case 'MTEXT': {
            let s = '';
            const g = r.g;
            for (let k = 0; k < g.length; k += 2) if (g[k] === 3) s += g[k + 1];
            s += get(r, 1, '');
            let rot = num(r, 50, NaN);
            if (isNaN(rot)) {
              const dx = num(r, 11, 1), dy = num(r, 21, 0);
              rot = Math.atan2(dy, dx) * 180 / Math.PI;
            }
            const at = num(r, 71, 1);
            const col = (at - 1) % 3, row = Math.floor((at - 1) / 3);
            emitText(m, num(r, 10, 0), num(r, 20, 0), num(r, 40, 1), rot, cleanMText(s),
              col === 0 ? 'left' : col === 1 ? 'center' : 'right',
              row === 0 ? 'top' : row === 1 ? 'middle' : 'bottom', li);
            break;
          }
          case 'INSERT': case 'DIMENSION': {
            if (depth > 10) break;
            const b = blocks.get(str(r, 2, ''));
            if (!b) break;
            if (r.type === 'DIMENSION') { doEnts(b.ents, m, lname, depth + 1); break; }
            const sx = num(r, 41, 1), sy = num(r, 42, 1);
            const rot = num(r, 50, 0) * Math.PI / 180;
            const cols = Math.max(1, num(r, 70, 1)), rows = Math.max(1, num(r, 71, 1));
            const cs = num(r, 44, 0), rs = num(r, 45, 0);
            const base = ocs(r, m);
            const cos = Math.cos(rot), sin = Math.sin(rot);
            for (let rr = 0; rr < Math.min(rows, 50); rr++) {
              for (let cc = 0; cc < Math.min(cols, 50); cc++) {
                const ox = cc * cs, oy = rr * rs;
                const ix = num(r, 10, 0) + ox * cos - oy * sin;
                const iy = num(r, 20, 0) + ox * sin + oy * cos;
                let t = [1, 0, 0, 1, -b.bx, -b.by];
                t = mul([sx, 0, 0, sy, 0, 0], t);
                t = mul([cos, sin, -sin, cos, 0, 0], t);
                t = mul([1, 0, 0, 1, ix, iy], t);
                doEnts(b.ents, mul(base, t), lname, depth + 1);
              }
            }
            break;
          }
        }
      }
    }
    function polyWithBulge(m, v, closed, li) {
      if (v.length < 2) return;
      const pts = [];
      const n = v.length;
      const last = closed ? n : n - 1;
      pts.push([v[0].x, v[0].y]);
      for (let k = 0; k < last; k++) {
        const a = v[k], b = v[(k + 1) % n];
        if (a.b) for (const p of bulgePts(a.x, a.y, b.x, b.y, a.b)) pts.push(p);
        pts.push([b.x, b.y]);
      }
      poly(m, pts, false, li);
    }

    doEnts(ents, I, null, 0);

    const N = segX1.length;
    const segs = {
      n: N,
      x1: Float64Array.from(segX1), y1: Float64Array.from(segY1),
      x2: Float64Array.from(segX2), y2: Float64Array.from(segY2),
      l: Int32Array.from(segL)
    };

    // Robuste grenser (ser bort fra løse objekter langt unna)
    let bounds = null;
    if (N) {
      const xs = new Float64Array(N * 2), ys = new Float64Array(N * 2);
      for (let k = 0; k < N; k++) { xs[2 * k] = segX1[k]; xs[2 * k + 1] = segX2[k]; ys[2 * k] = segY1[k]; ys[2 * k + 1] = segY2[k]; }
      xs.sort(); ys.sort();
      const q = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
      const lo = N > 200 ? 0.01 : 0, hi = N > 200 ? 0.99 : 1;
      let x0 = q(xs, lo), x1 = q(xs, hi), y0 = q(ys, lo), y1 = q(ys, hi);
      const px = (x1 - x0) * 0.05 || 1, py = (y1 - y0) * 0.05 || 1;
      bounds = { x0: x0 - px, y0: y0 - py, x1: x1 + px, y1: y1 + py };
    }

    return { segs, texts, layers: layerList, insunits, bounds };
  }

  const api = { parseDXF, decodeBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DXF = api;
})(typeof self !== 'undefined' ? self : this);
