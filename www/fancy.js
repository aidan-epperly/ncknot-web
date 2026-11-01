// The Kirby tab's figure view: the drawing as a figure for a paper, in the
// style of hand-drawn Kirby diagrams.  A bundle of n strands is drawn as a
// few parallel strands numbered 1, 2, …, n−1, n with "⋯" between them;
// where a bundle splits, its parts leave from their side of it; every drawn
// strand gets its own gap at a crossing; twist boxes show their crossings.
// The figure is a list of polylines, marks and labels, written as SVG or TikZ.

// ---------------------------------------------------------------- expressions

/// The value of a width expression (as accepted by the Kirby tab) at the
/// given parameter values; NaN if it cannot be read.
function evaluate(text, values) {
  const s = text.replace(/\s+/g, "");
  let i = 0;
  const peek = () => s[i];
  const sum = () => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = s[i++] === "+" ? v + product() : v - product();
    return v;
  };
  const product = () => {
    let v = power();
    for (;;) {
      const c = peek();
      if (c === "*") (i++, (v *= power()));
      else if (c === "/") (i++, (v /= power()));
      else if (c === "(" || /[A-Za-z_]/.test(c ?? "")) v *= power();
      else return v;
    }
  };
  const power = () => {
    if (peek() === "-") return (i++, -power());
    const b = atom();
    if (peek() === "^") {
      i++;
      const m = /^\d+/.exec(s.slice(i));
      if (!m) return NaN;
      i += m[0].length;
      return b ** Number(m[0]);
    }
    return b;
  };
  const atom = () => {
    const c = peek();
    if (c === "(") {
      i++;
      const v = sum();
      return peek() === ")" ? (i++, v) : NaN;
    }
    const num = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (num) return (i += num[0].length, Number(num[0]));
    const name = /^[A-Za-z_]\w*/.exec(s.slice(i));
    if (name) {
      i += name[0].length;
      if (name[0] in values) return values[name[0]];
      // a run of one-letter names: nm
      return [...name[0]].reduce((p, ch) => p * (ch in values ? values[ch] : NaN), 1);
    }
    return NaN;
  };
  const v = sum();
  return i === s.length ? v : NaN;
}

const isConstant = (text) => !/[A-Za-z_]/.test(text);

// ---------------------------------------------------------------- geometry

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (a) => Math.hypot(a[0], a[1]);

/// Samples a polyline with rounded corners (radius up to `r`): points every
/// `step` units.  Closed curves start at the middle of their first segment.
function sampleRounded(points, closed, r, step) {
  const pts = closed ? points.slice(0, -1) : points;
  const m = pts.length;
  const out = [];
  const line = (a, b) => {
    const n = Math.max(1, Math.ceil(len(sub(b, a)) / step));
    for (let k = out.length ? 1 : 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  };
  const quad = (a, v, b) => {
    const n = Math.max(4, Math.ceil((len(sub(v, a)) + len(sub(b, v))) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * v[0] + t * t * b[0], u * u * a[1] + 2 * u * t * v[1] + t * t * b[1]]);
    }
  };
  const corner = (i) => {
    const v = pts[(i + m) % m], a = pts[(i - 1 + m) % m], b = pts[(i + 1) % m];
    const la = len(sub(a, v)), lb = len(sub(b, v));
    const rr = Math.min(r, la / 2, lb / 2);
    return [[v[0] + ((a[0] - v[0]) / la) * rr, v[1] + ((a[1] - v[1]) / la) * rr], v, [v[0] + ((b[0] - v[0]) / lb) * rr, v[1] + ((b[1] - v[1]) / lb) * rr]];
  };
  if (closed) {
    let cur = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    out.push(cur);
    for (let k = 1; k <= m; k++) {
      const [p1, v, p2] = corner(k);
      line(cur, p1);
      quad(p1, v, p2);
      cur = p2;
    }
    line(cur, out[0]);
  } else {
    let cur = points[0];
    out.push(cur);
    for (let i = 1; i < points.length - 1; i++) {
      const [p1, v, p2] = corner(i);
      line(cur, p1);
      quad(p1, v, p2);
      cur = p2;
    }
    line(cur, points[points.length - 1]);
  }
  // drop repeated points
  return out.filter((p, k) => k === 0 || len(sub(p, out[k - 1])) > 1e-6);
}

/// Unit normals pointing right of the direction of travel (y down).
function normals(c) {
  return c.map((_, k) => {
    const a = c[Math.max(0, k - 1)], b = c[Math.min(c.length - 1, k + 1)];
    const d = sub(b, a);
    const l = len(d) || 1;
    return [-d[1] / l, d[0] / l];
  });
}

function arcLengths(c) {
  const s = [0];
  for (let k = 1; k < c.length; k++) s.push(s[k - 1] + len(sub(c[k], c[k - 1])));
  return s;
}

function segIntersect(p0, p1, q0, q1) {
  const r = sub(p1, p0), s = sub(q1, q0);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const qp = sub(q0, p0);
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  return t >= 0 && t < 1 && u >= 0 && u < 1 ? [t, u] : null;
}

// ---------------------------------------------------------------- the figure

const SIZE = {
  spacing: 15, // between the drawn strands of a bundle
  radius: 46, // rounded corners
  stroke: 2, // pen width
  gap: 7, // half a gap at a crossing
  fan: 60, // how far a bundle's part takes to leave its side
};

/// Everything the figure shows, in drawing coordinates (y down).
export function figure(state, { chains, crossings, color }) {
  const pt = new Map(state.points.map((p) => [p.id, [p.x, p.y]]));
  const degree = new Map();
  for (const s of state.segs) {
    degree.set(s.a, (degree.get(s.a) ?? 0) + 1);
    degree.set(s.b, (degree.get(s.b) ?? 0) + 1);
  }
  // values for the parameters that make coincidences unlikely
  const values = Object.fromEntries(state.params.map((p, k) => [p.name, [7, 11, 13, 17, 19, 23][k % 6] + (p.parity === "even" ? 1 : 0)]));
  const strands = chains.map((c) => {
    const ids = [c[0].side > 0 ? c[0].seg.a : c[0].seg.b, ...c.map(({ seg, side }) => (side > 0 ? seg.b : seg.a))];
    const closed = ids.length > 2 && ids[0] === ids[ids.length - 1] && degree.get(ids[0]) === 2;
    const s = c[0].seg;
    const width = s.width.trim();
    return {
      ids,
      points: ids.map((id) => pt.get(id)),
      closed,
      handle: s.handle,
      width,
      value: evaluate(width, values),
      color: color(s.handle),
      segs: c.map((x) => x.seg.id),
      dir: s.dir * c[0].side, // +1: the strands run along the walk
      pattern: null,
    };
  });
  const chainOfSeg = new Map();
  strands.forEach((st, i) => st.segs.forEach((id) => chainOfSeg.set(id, i)));

  // what each strand shows: "s" strands and "d" dots, with labels
  const symbolic = (w) => [
    { kind: "s", label: "1" },
    { kind: "s", label: "2" },
    { kind: "d" },
    { kind: "s", label: minus(w, 1) },
    { kind: "s", label: w },
  ];
  for (const st of strands) {
    if (isConstant(st.width) && Number.isInteger(st.value) && st.value >= 0 && st.value <= 6) {
      st.pattern = Array.from({ length: st.value }, () => ({ kind: "s", label: null }));
    }
  }
  // junctions: the whole bundle and its parts, left to right
  const junctions = [];
  for (const [id, deg] of degree) {
    if (deg < 3) continue;
    const ends = [];
    strands.forEach((st, i) => {
      if (st.closed) return;
      if (st.ids[0] === id) ends.push({ chain: i, atStart: true });
      if (st.ids[st.ids.length - 1] === id) ends.push({ chain: i, atStart: false });
    });
    const total = ends.reduce((a, e) => a + strands[e.chain].value, 0);
    const whole = ends.find((e) => Math.abs(2 * strands[e.chain].value - total) < 1e-9);
    if (!whole) continue;
    const at = pt.get(id);
    const away = (e) => {
      const st = strands[e.chain];
      const q = e.atStart ? st.points[1] : st.points[st.points.length - 2];
      return sub(q, at);
    };
    const into = away(whole).map((v) => -v); // heading of the whole into the junction
    const parts = ends
      .filter((e) => e !== whole)
      .map((e) => {
        const d = away(e);
        const cr = into[0] * d[1] - into[1] * d[0];
        const dot = into[0] * d[0] + into[1] * d[1];
        return { ...e, angle: Math.atan2(cr, dot) };
      })
      .sort((a, b) => a.angle - b.angle);
    junctions.push({ id, whole, parts });
  }
  // a whole bundle shows its parts side by side (when they are known)
  for (let round = 0; round < 4; round++) {
    for (const j of junctions) {
      const w = strands[j.whole.chain];
      if (w.pattern || j.parts.some((p) => !strands[p.chain].pattern)) continue;
      let pat = [];
      for (const p of j.parts) {
        const pp = strands[p.chain].pattern.map((x) => ({ ...x, label: null }));
        pat = pat.concat(p.atStart ? pp : pp.reverse()); // left to right, leaving the junction
      }
      w.pattern = j.whole.atStart ? pat.reverse() : pat;
    }
    for (const st of strands) if (!st.pattern && round === 1 && !junctions.some((j) => j.whole.chain === strands.indexOf(st))) st.pattern = symbolic(st.width);
  }
  for (const st of strands) if (!st.pattern) st.pattern = symbolic(st.width);

  const maxHalf = Math.max(0, ...strands.map((st) => ((st.pattern.length - 1) / 2) * SIZE.spacing));
  const radius = Math.max(SIZE.radius, maxHalf + 22);
  // centerlines, and the sideways shift of a part leaving its side of a bundle
  for (const st of strands) {
    st.center = sampleRounded(st.points, st.closed, radius, 3);
    st.normal = normals(st.center);
    st.s = arcLengths(st.center);
    st.shiftStart = 0;
    st.shiftEnd = 0;
  }
  for (const j of junctions) {
    const w = strands[j.whole.chain];
    const n = w.pattern.length;
    let k = 0;
    for (const p of j.parts) {
      const st = strands[p.chain];
      const m = st.pattern.length;
      const mid = k + (m - 1) / 2 - (n - 1) / 2;
      k += m;
      // right of the whole's heading = right of the part leaving the junction
      if (p.atStart) st.shiftStart = mid * SIZE.spacing;
      else st.shiftEnd = -mid * SIZE.spacing;
    }
  }
  const smooth = (t) => (t <= 0 ? 1 : t >= 1 ? 0 : 1 - t * t * (3 - 2 * t));
  // the drawn strands
  const curves = [];
  strands.forEach((st, ci) => {
    const n = st.pattern.length;
    const total = st.s[st.s.length - 1];
    st.pattern.forEach((item, j) => {
      if (item.kind !== "s") return;
      const off = (j - (n - 1) / 2) * SIZE.spacing;
      const pts = st.center.map((c, k) => {
        const extra = st.shiftStart * smooth(st.s[k] / SIZE.fan) + st.shiftEnd * smooth((total - st.s[k]) / SIZE.fan);
        const o = off + extra;
        return [c[0] + st.normal[k][0] * o, c[1] + st.normal[k][1] * o];
      });
      curves.push({ chain: ci, points: pts, color: st.color, gaps: [] });
    });
  });

  // crossings: every drawn pair that meets near a crossing of the diagram
  const model = crossings.map((x) => ({
    ...x,
    ca: chainOfSeg.get(x.a),
    cb: chainOfSeg.get(x.b),
    overSeg: state.segs.find((s) => s.id === x.over),
  }));
  const cell = 24;
  const grid = new Map();
  curves.forEach((cv, i) => {
    cv.s = arcLengths(cv.points);
    for (let k = 0; k + 1 < cv.points.length; k++) {
      const [a, b] = [cv.points[k], cv.points[k + 1]];
      const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
      const y0 = Math.floor(Math.min(a[1], b[1]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell);
      for (let gx = x0; gx <= x1; gx++)
        for (let gy = y0; gy <= y1; gy++) {
          const key = `${gx},${gy}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push([i, k]);
        }
    }
  });
  const seen = new Set();
  const reach = 2 * maxHalf + 30;
  for (const list of grid.values()) {
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        let [i, k] = list[x], [j, l] = list[y];
        if (i === j && Math.abs(k - l) <= 2) continue;
        if (i > j || (i === j && k > l)) [i, k, j, l] = [j, l, i, k];
        const key = `${i},${k},${j},${l}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = curves[i], B = curves[j];
        const hit = segIntersect(A.points[k], A.points[k + 1], B.points[l], B.points[l + 1]);
        if (!hit) continue;
        const X = [A.points[k][0] + hit[0] * (A.points[k + 1][0] - A.points[k][0]), A.points[k][1] + hit[0] * (A.points[k + 1][1] - A.points[k][1])];
        // the diagram's crossing this belongs to
        let best = null;
        for (const c of model) {
          const same = (c.ca === A.chain && c.cb === B.chain) || (c.ca === B.chain && c.cb === A.chain);
          if (!same) continue;
          const d = len(sub([c.x, c.y], X));
          if (d < reach && (!best || d < best.d)) best = { c, d };
        }
        if (!best) continue;
        // the drawn strand running along the over-segment is over
        const os = best.c.overSeg;
        const od = sub(pt.get(os.b), pt.get(os.a));
        const cosTo = (cv, q) => {
          const t = sub(cv.points[q + 1], cv.points[q]);
          return Math.abs(t[0] * od[0] + t[1] * od[1]) / ((len(t) * len(od)) || 1);
        };
        const under = cosTo(A, k) >= cosTo(B, l) ? [B, l, hit[1]] : [A, k, hit[0]];
        const [cv, q, t] = under;
        const at = cv.s[q] + t * (cv.s[q + 1] - cv.s[q]);
        cv.gaps.push([at - SIZE.gap, at + SIZE.gap]);
      }
  }
  const pieces = [];
  for (const cv of curves) pieces.push(...cut(cv));

  // marks along each strand: arrows, numbers and dots
  const arrows = [], labels = [], dots = [], ellipses = [];
  // a calm place on each strand for its marks: straight, and as far as
  // possible from crossings, junctions, boxes and the marks placed so far
  const obstacles = [
    ...model.map((c) => [c.x, c.y]),
    ...junctions.map((j) => pt.get(j.id)),
    ...state.boxes.map((b) => [(b.p[0] + b.q[0]) / 2, (b.p[1] + b.q[1]) / 2]),
  ];
  const order = strands.map((_, i) => i).sort((a, b) => strands[b].pattern.length - strands[a].pattern.length);
  const markAt = new Map();
  for (const i of order) {
    const st = strands[i];
    const total = st.s[st.s.length - 1];
    let best = null;
    for (let k = 0; k < st.center.length; k += 3) {
      if (!st.closed && (st.s[k] < 45 || total - st.s[k] < 45)) continue;
      const a = st.normal[Math.max(0, k - 6)], b = st.normal[Math.min(st.center.length - 1, k + 6)];
      if (a[0] * b[0] + a[1] * b[1] < 0.995) continue; // on a curve
      const c = st.center[k];
      const room = Math.min(1e9, ...obstacles.map((o) => len(sub(o, c))));
      if (!best || room > best.room) best = { k, room };
    }
    const q = best ? best.k : Math.floor(st.center.length / 2);
    markAt.set(i, q);
    obstacles.push(st.center[q]);
  }
  strands.forEach((st, i) => {
    const q = markAt.get(i);
    const c = st.center[q], nrm = st.normal[q];
    const tan = [nrm[1], -nrm[0]]; // direction of the walk
    const n = st.pattern.length;
    const h = state.handles[st.handle];
    const dirSign = st.dir;
    st.pattern.forEach((item, j) => {
      const off = (j - (n - 1) / 2) * SIZE.spacing;
      const p = [c[0] + nrm[0] * off, c[1] + nrm[1] * off];
      if (item.kind === "d") {
        ellipses.push({ x: p[0], y: p[1], nx: nrm[0], ny: nrm[1], color: st.color });
        return;
      }
      if (h?.kind === "dotted") return;
      arrows.push({ x: p[0], y: p[1], ux: tan[0] * dirSign, uy: tan[1] * dirSign, color: st.color });
      if (item.label) {
        labels.push({ x: p[0] - tan[0] * dirSign * 20, y: p[1] - tan[1] * dirSign * 20, text: item.label, color: st.color, small: true });
      }
    });
    if (h?.kind === "dotted") dots.push({ x: c[0], y: c[1], color: st.color });
    // a single strand's width (other than 1) as a label
    if (n && st.pattern.every((x) => !x.label) && st.width !== "1" && !isConstant(st.width)) {
      labels.push({ x: c[0] - nrm[0] * (maxHalf + 18), y: c[1] - nrm[1] * (maxHalf + 18), text: st.width, color: st.color });
    }
  });
  // framings, once per 2-handle, beside its longest straight run
  const framed = new Set();
  strands.forEach((st) => {
    const h = state.handles[st.handle];
    if (h?.kind === "dotted" || framed.has(st.handle)) return;
    framed.add(st.handle);
    let best = null;
    strands
      .filter((x) => x.handle === st.handle)
      .forEach((x) => {
        for (let k = 0; k + 1 < x.points.length; k++) {
          const l = len(sub(x.points[k + 1], x.points[k]));
          if (!best || l > best.l) best = { a: x.points[k], b: x.points[k + 1], l, half: ((x.pattern.length - 1) / 2) * SIZE.spacing };
        }
      });
    const { a, b, l, half } = best;
    const nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l;
    const off = half + 20;
    labels.push({
      x: a[0] + (b[0] - a[0]) * 0.8 + nx * off,
      y: a[1] + (b[1] - a[1]) * 0.8 + ny * off,
      text: h.framing ?? "0",
      color: st.color,
      framing: true,
    });
  });

  // twist boxes: a white box over the strands, two crossings and ⋮ inside
  const boxes = state.boxes.map((bx) => {
    const p = bx.p, q = bx.q;
    const d = sub(q, p);
    const l = len(d) || 1;
    const u = [d[0] / l, d[1] / l];
    const top = [u[1], -u[0]]; // from the box's bottom side to its top side
    // cover the drawn strands of the bundles through it
    let half = 0;
    const enter = []; // where strands meet the box line, from its middle
    for (const st of strands) {
      for (let k = 0; k + 1 < st.points.length; k++) {
        const hit = segIntersect(st.points[k], st.points[k + 1], p, q);
        if (!hit) continue;
        const h = ((st.pattern.length - 1) / 2) * SIZE.spacing;
        half = Math.max(half, h);
        enter.push((hit[1] - 0.5) * l - h, (hit[1] - 0.5) * l + h);
      }
    }
    const ext = 12 + half;
    const depth = 34;
    const P = (a, v) => [(p[0] + q[0]) / 2 + u[0] * a + top[0] * v, (p[1] + q[1]) / 2 + u[1] * a + top[1] * v];
    const hw = l / 2 + ext;
    const corners = [P(-hw, -depth), P(hw, -depth), P(hw, depth), P(-hw, depth)];
    // two half-twists: the strand from the bottom left passes over
    // the crossings run between the outermost strands, centered on them
    const lo = enter.length ? Math.min(...enter) : -16, hi = enter.length ? Math.max(...enter) : 16;
    const shift = (lo + hi) / 2;
    const w = Math.max(6, (hi - lo) / 2);
    const S = (a0, v0, a1, v1) =>
      Array.from({ length: 13 }, (_, k) => {
        const t = k / 12, e = t * t * (3 - 2 * t);
        return P(shift + a0 + (a1 - a0) * e, v0 + (v1 - v0) * t);
      });
    const glyph = [];
    const negative = /^\s*-/.test(bx.twists) || evaluate(bx.twists, values) < 0;
    for (const [v0, v1] of [[-depth, -depth / 3], [depth / 3, depth]]) {
      const over = negative ? S(w, v0, -w, v1) : S(-w, v0, w, v1);
      const under = negative ? S(-w, v0, w, v1) : S(w, v0, -w, v1);
      glyph.push(over, under.slice(0, 5), under.slice(8));
    }
    const vdots = [-6, 0, 6].map((v) => P(shift, v));
    const label = P(hw + 14, 0);
    return { corners, glyph, vdots, x: label[0], y: label[1], ux: u[0], text: bx.twists };
  });
  const size = SIZE;
  return { pieces, arrows, labels, dots, ellipses, boxes, size };
}

/// `w − k` written nicely: `n` → `n−1`, `n+1` → `n`, `5` → `4`.
function minus(w, k) {
  const t = w.replace(/\s+/g, "");
  if (/^\d+$/.test(t)) return String(Number(t) - k);
  const m = /^(.*)\+(\d+)$/.exec(t);
  if (m) {
    const c = Number(m[2]) - k;
    return c === 0 ? m[1] : c > 0 ? `${m[1]}+${c}` : `${m[1]}-${-c}`;
  }
  return /[+-]/.test(t.slice(1)) ? `(${t})-${k}` : `${t}-${k}`;
}

/// A polyline with gaps cut out: its pieces.
function cut(cv) {
  if (!cv.gaps.length) return [{ points: cv.points, color: cv.color }];
  const gaps = cv.gaps.sort((a, b) => a[0] - b[0]);
  const s = cv.s;
  const at = (x) => {
    let k = 0;
    while (k + 2 < s.length && s[k + 1] < x) k++;
    const t = (x - s[k]) / ((s[k + 1] - s[k]) || 1);
    const a = cv.points[k], b = cv.points[k + 1];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  };
  const out = [];
  let from = 0;
  const end = s[s.length - 1];
  for (const [g0, g1] of [...gaps, [end + 1, end + 1]]) {
    if (g0 > from) {
      const pts = [at(from), ...cv.points.filter((_, k) => s[k] > from && s[k] < Math.min(g0, end)), at(Math.min(g0, end))];
      if (pts.length >= 2) out.push({ points: pts, color: cv.color });
    }
    from = Math.max(from, g1);
  }
  return out;
}

/// The bounding box of the figure, padded.
export function bounds(fig, pad = 30) {
  const xs = [], ys = [];
  for (const p of fig.pieces) for (const [x, y] of p.points) (xs.push(x), ys.push(y));
  for (const b of fig.boxes) for (const [x, y] of b.corners) (xs.push(x), ys.push(y));
  for (const l of fig.labels) (xs.push(l.x), ys.push(l.y));
  for (const b of fig.boxes) (xs.push(b.x + 20), ys.push(b.y));
  if (!xs.length) return { x: 0, y: 0, w: 100, h: 100 };
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
}

const exprText = (s) => s.replace(/\*/g, "").replace(/-/g, "−");
const FONT = "Cambria Math, STIX Two Math, Latin Modern Math, Georgia, serif";

/// Draws the figure into an SVG element, replacing its contents.
export function drawSvg(svg, fig, { colored = true } = {}) {
  const NS = "http://www.w3.org/2000/svg";
  const el = (name, attrs) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.appendChild(e);
    return e;
  };
  svg.replaceChildren();
  const ink = (c) => (colored ? c : "#111");
  const path = (pts) => "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L");
  const sw = fig.size.stroke;
  el("rect", { x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: "#fff" });
  for (const p of fig.pieces) {
    el("path", { d: path(p.points), fill: "none", stroke: ink(p.color), "stroke-width": sw, "stroke-linecap": "round", "stroke-linejoin": "round" });
  }
  for (const a of fig.arrows) {
    const k = 5.5;
    el("polygon", {
      points: `${a.x + a.ux * k},${a.y + a.uy * k} ${a.x - a.ux * k - a.uy * k * 0.7},${a.y - a.uy * k + a.ux * k * 0.7} ${a.x - a.ux * k + a.uy * k * 0.7},${a.y - a.uy * k - a.ux * k * 0.7}`,
      fill: ink(a.color),
    });
  }
  for (const e of fig.ellipses) for (const t of [-3.2, 0, 3.2]) el("circle", { cx: e.x + e.nx * t, cy: e.y + e.ny * t, r: 1.3, fill: ink(e.color) });
  for (const d of fig.dots) el("circle", { cx: d.x, cy: d.y, r: 5, fill: ink(d.color) });
  for (const b of fig.boxes) {
    el("polygon", { points: b.corners.map((c) => c.join(",")).join(" "), fill: "#fff", stroke: "#111", "stroke-width": sw * 0.8 });
    for (const g of b.glyph) el("path", { d: path(g), fill: "none", stroke: "#111", "stroke-width": sw * 0.8, "stroke-linecap": "round" });
    for (const v of b.vdots) el("circle", { cx: v[0], cy: v[1], r: 1.2, fill: "#111" });
    const t = el("text", { x: b.x, y: b.y, "text-anchor": b.ux >= 0 ? "start" : "end", "dominant-baseline": "central", "font-size": 19, "font-style": "italic", "font-family": FONT, fill: "#111" });
    t.textContent = exprText(b.text);
  }
  for (const l of fig.labels) {
    const t = el("text", {
      x: l.x, y: l.y, "text-anchor": "middle", "dominant-baseline": "central",
      "font-size": l.small ? 12 : 17, "font-style": "italic", "font-family": FONT,
      fill: ink(l.color), "paint-order": "stroke", stroke: "#fff", "stroke-width": 3,
    });
    t.textContent = exprText(l.text);
  }
}

/// A standalone SVG file of the figure.
export function svgFile(fig, opts) {
  const b = bounds(fig);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`);
  svg.setAttribute("width", Math.round(b.w));
  svg.setAttribute("height", Math.round(b.h));
  drawSvg(svg, fig, opts);
  return new XMLSerializer().serializeToString(svg);
}

/// The expression in TeX: `2*n*m` → `2nm`, `n^10` → `n^{10}`.
function texExpr(s) {
  return s.replace(/\*/g, "").replace(/\^(-?\d+)/g, "^{$1}");
}

/// The figure as a TikZ picture, `width_cm` wide (the drawing's own size
/// sets the line widths and fonts relative to it, as on screen).
export function tikz(fig, { colored = true, width_cm = 11 } = {}) {
  const b = bounds(fig, 6);
  const s = width_cm / b.w;
  const X = (x) => ((x - b.x) * s).toFixed(2);
  const Y = (y) => ((b.y + b.h - y) * s).toFixed(2);
  const P = (p) => `(${X(p[0])},${Y(p[1])})`;
  const cm = (v) => `${(v * s).toFixed(3)}cm`;
  const colors = new Map();
  const name = (c) => {
    if (!colored) return "black";
    if (!colors.has(c)) colors.set(c, `kh${colors.size}`);
    return colors.get(c);
  };
  const pen = cm(fig.size.stroke);
  // thin out the samples: a point every ~6 units is plenty in print
  const thin = (pts) => pts.filter((_, k) => k === 0 || k === pts.length - 1 || k % 2 === 0);
  const lines = [];
  for (const p of fig.pieces) {
    lines.push(`  \\draw[${name(p.color)}, line width=${pen}, line cap=round, line join=round] ${thin(p.points).map(P).join(" -- ")};`);
  }
  for (const a of fig.arrows) {
    const k = 5.5;
    lines.push(`  \\fill[${name(a.color)}] ${P([a.x + a.ux * k, a.y + a.uy * k])} -- ${P([a.x - a.ux * k - a.uy * k * 0.7, a.y - a.uy * k + a.ux * k * 0.7])} -- ${P([a.x - a.ux * k + a.uy * k * 0.7, a.y - a.uy * k - a.ux * k * 0.7])} -- cycle;`);
  }
  for (const e of fig.ellipses) for (const t of [-3.2, 0, 3.2]) lines.push(`  \\fill[${name(e.color)}] ${P([e.x + e.nx * t, e.y + e.ny * t])} circle (${cm(1.3)});`);
  for (const d of fig.dots) lines.push(`  \\fill[${name(d.color)}] ${P([d.x, d.y])} circle (${cm(5)});`);
  for (const bx of fig.boxes) {
    lines.push(`  \\filldraw[fill=white, draw=black, line width=${cm(fig.size.stroke * 0.8)}] ${bx.corners.map(P).join(" -- ")} -- cycle;`);
    for (const g of bx.glyph) lines.push(`  \\draw[line width=${cm(fig.size.stroke * 0.8)}, line cap=round] ${g.map(P).join(" -- ")};`);
    for (const v of bx.vdots) lines.push(`  \\fill ${P(v)} circle (${cm(1.2)});`);
    lines.push(`  \\node[anchor=${bx.ux >= 0 ? "west" : "east"}] at ${P([bx.x, bx.y])} {$${texExpr(bx.text)}$};`);
  }
  for (const l of fig.labels) {
    const size = l.small ? "\\scriptsize" : "";
    lines.push(`  \\node[${name(l.color)}, inner sep=1pt] at ${P([l.x, l.y])} {${size}$${texExpr(l.text)}$};`);
  }
  const defs = [...colors].map(([c, n]) => `\\definecolor{${n}}{HTML}{${c.replace("#", "").toUpperCase()}}`);
  return [
    "% Kirby diagram from the Knot Workbench (https://aidan-epperly.github.io/ncknot-web/)",
    "% needs \\usepackage{tikz}",
    ...defs,
    "\\begin{tikzpicture}",
    ...lines,
    "\\end{tikzpicture}",
  ].join("\n");
}

/// A LaTeX document holding just the figure (compiles with pdflatex).
export function texDocument(fig, opts) {
  return ["\\documentclass[border=4pt]{standalone}", "\\usepackage{tikz}", "\\begin{document}", tikz(fig, opts), "\\end{document}", ""].join("\n");
}
