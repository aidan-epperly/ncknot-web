// The Kirby tab's presentation view: the drawing as a figure for a paper.
// Strands get rounded corners, bundles are drawn as hollow ribbons labeled
// with their width, 2-handles carry their framing and dotted circles their
// dot; points and editing marks are left out.  The same picture is written
// as SVG and as TikZ.

/// Everything the figure shows, in drawing coordinates (y down).
/// `chains`: strands as point lists; `pieces`: the over-strand at each
/// crossing; `boxes`, `dots`, `arrows`, `labels`.
export function figure(state, { chains, crossings, color }) {
  const pt = new Map(state.points.map((p) => [p.id, p]));
  const degree = new Map();
  for (const s of state.segs) {
    degree.set(s.a, (degree.get(s.a) ?? 0) + 1);
    degree.set(s.b, (degree.get(s.b) ?? 0) + 1);
  }
  const strands = chains.map((c) => {
    const ids = [c[0].side > 0 ? c[0].seg.a : c[0].seg.b, ...c.map(({ seg, side }) => (side > 0 ? seg.b : seg.a))];
    const closed = ids.length > 2 && ids[0] === ids[ids.length - 1] && degree.get(ids[0]) === 2;
    const s = c[0].seg;
    return {
      points: ids.map((id) => [pt.get(id).x, pt.get(id).y]),
      closed,
      handle: s.handle,
      width: s.width.trim(),
      bundle: s.width.trim() !== "1",
      color: color(s.handle),
      chain: c,
    };
  });
  const segOf = new Map(state.segs.map((s) => [s.id, s]));
  const pieces = crossings.map((x) => {
    const s = segOf.get(x.over);
    const a = pt.get(s.a), b = pt.get(s.b);
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l;
    return { x: x.x, y: x.y, ux, uy, bundle: s.width.trim() !== "1", color: color(s.handle) };
  });
  // a label, arrow or dot sits on the middle segment of a strand
  const marks = strands.map((st) => {
    const c = st.chain;
    const { seg } = c[Math.floor(c.length / 2)];
    const a = pt.get(seg.a), b = pt.get(seg.b);
    const [p, q] = seg.dir > 0 ? [a, b] : [b, a];
    const t = c.length % 2 === 0 && c.length > 1 ? 0.2 : 0.5;
    const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y), ux: (q.x - p.x) / l, uy: (q.y - p.y) / l };
  });
  const dots = [], arrows = [], labels = [];
  const framed = new Set();
  strands.forEach((st, i) => {
    const m = marks[i];
    const h = state.handles[st.handle];
    if (h?.kind === "dotted") dots.push({ x: m.x, y: m.y, color: st.color });
    else arrows.push({ ...m, color: st.color });
    if (st.bundle) labels.push({ x: m.x - m.uy * 24, y: m.y + m.ux * 24, text: st.width, color: st.color });
    if (h?.kind !== "dotted" && !framed.has(st.handle)) {
      // the framing, once per handle, beside its longest straight run
      framed.add(st.handle);
      let best = null;
      for (const { seg } of st.chain) {
        const a = pt.get(seg.a), b = pt.get(seg.b);
        const l = Math.hypot(b.x - a.x, b.y - a.y);
        if (!best || l > best.l) best = { a, b, l };
      }
      const { a, b, l } = best;
      const nx = -(b.y - a.y) / l, ny = (b.x - a.x) / l;
      const off = st.bundle ? 30 : 18;
      labels.push({
        x: (a.x + b.x) / 2 + nx * off + (b.x - a.x) * 0.25,
        y: (a.y + b.y) / 2 + ny * off + (b.y - a.y) * 0.25,
        text: h.framing ?? "0",
        color: st.color,
        framing: true,
      });
    }
  });
  const boxes = state.boxes.map((b) => ({ corners: boxCorners(b), x: (b.p[0] + b.q[0]) / 2, y: (b.p[1] + b.q[1]) / 2, text: b.twists }));
  return { strands, pieces, boxes, dots, arrows, labels };
}

export function boxCorners(b, pad = 16) {
  const dx = b.q[0] - b.p[0], dy = b.q[1] - b.p[1];
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  const nx = -uy * pad, ny = ux * pad;
  const ex = ux * 8, ey = uy * 8;
  return [
    [b.p[0] - ex - nx, b.p[1] - ey - ny],
    [b.q[0] + ex - nx, b.q[1] + ey - ny],
    [b.q[0] + ex + nx, b.q[1] + ey + ny],
    [b.p[0] - ex + nx, b.p[1] - ey + ny],
  ];
}

/// The bounding box of the figure, padded.
export function bounds(fig, pad = 40) {
  const xs = [], ys = [];
  for (const s of fig.strands) for (const [x, y] of s.points) (xs.push(x), ys.push(y));
  for (const b of fig.boxes) for (const [x, y] of b.corners) (xs.push(x), ys.push(y));
  for (const l of fig.labels) (xs.push(l.x), ys.push(l.y));
  if (!xs.length) return { x: 0, y: 0, w: 100, h: 100 };
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
}

/// An SVG path through the points with rounded corners (radius `r`).
function roundedPath(points, closed, r) {
  const n = points.length;
  const pts = closed ? points.slice(0, -1) : points;
  const m = pts.length;
  const corner = (i) => {
    const v = pts[(i + m) % m], a = pts[(i - 1 + m) % m], b = pts[(i + 1) % m];
    const la = Math.hypot(a[0] - v[0], a[1] - v[1]), lb = Math.hypot(b[0] - v[0], b[1] - v[1]);
    const rr = Math.min(r, la / 2, lb / 2);
    return [
      [v[0] + ((a[0] - v[0]) / la) * rr, v[1] + ((a[1] - v[1]) / la) * rr],
      v,
      [v[0] + ((b[0] - v[0]) / lb) * rr, v[1] + ((b[1] - v[1]) / lb) * rr],
    ];
  };
  const f = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  if (closed) {
    const start = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    let d = `M${f(start)}`;
    for (let k = 1; k <= m; k++) {
      const [p1, v, p2] = corner(k);
      d += ` L${f(p1)} Q${f(v)} ${f(p2)}`;
    }
    return d + " Z";
  }
  let d = `M${f(points[0])}`;
  for (let i = 1; i < n - 1; i++) {
    const [p1, v, p2] = corner(i);
    d += ` L${f(p1)} Q${f(v)} ${f(p2)}`;
  }
  return d + ` L${f(points[n - 1])}`;
}

/// Sizes below are for a drawing about 800 units across; `unit` scales them.
const unit = (fig) => {
  const b = bounds(fig, 0);
  return Math.max(b.w, b.h, 300) / 800;
};

const STYLE = {
  strand: 2.4, // stroke of a single strand
  ribbon: 9, // outer width of a bundle
  ribbonInner: 5,
  halo: 9, // the gap at a crossing, beyond the strand
  radius: 22,
  piece: 15, // half-length of an over-strand piece
};

const exprText = (s) => s.replace(/\*/g, "").replace(/-/g, "−");

/// Draws the figure into `svg` (an SVG element), replacing its contents.
export function drawSvg(svg, fig, { colored = true } = {}) {
  const NS = "http://www.w3.org/2000/svg";
  const el = (name, attrs, parent = svg) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e);
    return e;
  };
  svg.replaceChildren();
  const u = unit(fig);
  const S = Object.fromEntries(Object.entries(STYLE).map(([k, v]) => [k, v * u]));
  const ink = (c) => (colored ? c : "#111");
  const stroke = (d, c, bundle, parent) => {
    if (bundle) {
      el("path", { d, fill: "none", stroke: ink(c), "stroke-width": S.ribbon, "stroke-linejoin": "round" }, parent);
      el("path", { d, fill: "none", stroke: "#fff", "stroke-width": S.ribbonInner, "stroke-linejoin": "round" }, parent);
    } else {
      el("path", { d, fill: "none", stroke: ink(c), "stroke-width": S.strand, "stroke-linejoin": "round", "stroke-linecap": "round" }, parent);
    }
  };
  el("rect", { x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: "#fff" });
  for (const s of fig.strands) stroke(roundedPath(s.points, s.closed, S.radius), s.color, s.bundle);
  for (const p of fig.pieces) {
    const L = S.piece + (p.bundle ? 4 : 0);
    const d = `M${p.x - p.ux * L},${p.y - p.uy * L} L${p.x + p.ux * L},${p.y + p.uy * L}`;
    el("path", { d, stroke: "#fff", "stroke-width": (p.bundle ? S.ribbon : S.strand) + S.halo, fill: "none" });
    stroke(d, p.color, p.bundle);
  }
  for (const a of fig.arrows) {
    const k = 7 * u;
    el("polygon", {
      points: `${a.x + a.ux * k},${a.y + a.uy * k} ${a.x - a.ux * k - a.uy * k * 0.65},${a.y - a.uy * k + a.ux * k * 0.65} ${a.x - a.ux * k + a.uy * k * 0.65},${a.y - a.uy * k - a.ux * k * 0.65}`,
      fill: ink(a.color),
    });
  }
  for (const d of fig.dots) el("circle", { cx: d.x, cy: d.y, r: 5.5 * u, fill: ink(d.color) });
  for (const b of fig.boxes) {
    el("polygon", { points: b.corners.map((c) => c.join(",")).join(" "), fill: "#fff", stroke: "#111", "stroke-width": 1.4 * u });
    const t = el("text", { x: b.x, y: b.y, "text-anchor": "middle", "dominant-baseline": "central", "font-size": 20 * u, "font-style": "italic", "font-family": "Cambria Math, STIX Two Math, Georgia, serif", fill: "#111" });
    t.textContent = exprText(b.text);
  }
  for (const l of fig.labels) {
    const t = el("text", {
      x: l.x, y: l.y, "text-anchor": "middle", "dominant-baseline": "central",
      "font-size": (l.framing ? 19 : 18) * u, "font-style": "italic",
      "font-family": "Cambria Math, STIX Two Math, Georgia, serif",
      fill: ink(l.color), "paint-order": "stroke", stroke: "#fff", "stroke-width": 4 * u,
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

/// The figure as a TikZ picture, `width_cm` wide.  Needs
/// `\usepackage{tikz}` and `\usetikzlibrary{arrows.meta}`.
export function tikz(fig, { colored = true, width_cm = 10 } = {}) {
  const b = bounds(fig, 10);
  const s = width_cm / b.w;
  const X = (x) => ((x - b.x) * s).toFixed(3);
  const Y = (y) => ((b.y + b.h - y) * s).toFixed(3);
  const P = (p) => `(${X(p[0])},${Y(p[1])})`;
  const cm = (v) => `${(v * s).toFixed(3)}cm`;
  const colors = new Map();
  const name = (c) => {
    if (!colored) return "black";
    if (!colors.has(c)) colors.set(c, `kh${colors.size}`);
    return colors.get(c);
  };
  const lines = [];
  const u = unit(fig);
  const S = Object.fromEntries(Object.entries(STYLE).map(([k, v]) => [k, v * u]));
  const strandStyle = (c, bundle) =>
    bundle
      ? `draw=${name(c)}, line width=${cm((S.ribbon - S.ribbonInner) / 2)}, double=white, double distance=${cm(S.ribbonInner)}`
      : `draw=${name(c)}, line width=${cm(S.strand)}, line cap=round`;
  for (const st of fig.strands) {
    const pts = st.closed ? st.points.slice(0, -1) : st.points;
    const path = pts.map(P).join(" -- ") + (st.closed ? " -- cycle" : "");
    lines.push(`  \\draw[${strandStyle(st.color, st.bundle)}, rounded corners=${cm(S.radius)}, line join=round] ${path};`);
  }
  for (const p of fig.pieces) {
    const L = S.piece + (p.bundle ? 4 : 0);
    const a = [p.x - p.ux * L, p.y - p.uy * L], c = [p.x + p.ux * L, p.y + p.uy * L];
    lines.push(`  \\draw[white, line width=${cm((p.bundle ? S.ribbon : S.strand) + S.halo)}] ${P(a)} -- ${P(c)};`);
    lines.push(`  \\draw[${strandStyle(p.color, p.bundle)}] ${P(a)} -- ${P(c)};`);
  }
  for (const a of fig.arrows) {
    const k = 7 * u;
    lines.push(`  \\draw[${name(a.color)}, line width=${cm(S.strand)}, -{Stealth[length=${cm(11 * u)}, width=${cm(9 * u)}]}] ${P([a.x - a.ux * k, a.y - a.uy * k])} -- ${P([a.x + a.ux * k, a.y + a.uy * k])};`);
  }
  for (const d of fig.dots) lines.push(`  \\fill[${name(d.color)}] ${P([d.x, d.y])} circle (${cm(5.5 * u)});`);
  for (const bx of fig.boxes) {
    lines.push(`  \\filldraw[fill=white, draw=black, line width=${cm(1.4 * u)}] ${bx.corners.map(P).join(" -- ")} -- cycle;`);
    lines.push(`  \\node at ${P([bx.x, bx.y])} {$${texExpr(bx.text)}$};`);
  }
  for (const l of fig.labels) {
    lines.push(`  \\node[${name(l.color)}, fill=white, inner sep=1pt] at ${P([l.x, l.y])} {$${texExpr(l.text)}$};`);
  }
  const defs = [...colors].map(([c, n]) => `\\definecolor{${n}}{HTML}{${c.replace("#", "").toUpperCase()}}`);
  return [
    "% Kirby diagram from the Knot Workbench (https://aidan-epperly.github.io/ncknot-web/)",
    "% needs \\usepackage{tikz} and \\usetikzlibrary{arrows.meta}",
    ...defs,
    "\\begin{tikzpicture}",
    ...lines,
    "\\end{tikzpicture}",
  ].join("\n");
}

/// A LaTeX document holding just the figure (compiles with pdflatex).
export function texDocument(fig, opts) {
  return [
    "\\documentclass[border=4pt]{standalone}",
    "\\usepackage{tikz}",
    "\\usetikzlibrary{arrows.meta}",
    "\\begin{document}",
    tikz(fig, opts),
    "\\end{document}",
    "",
  ].join("\n");
}
