// The Kirby tab: draw a family of Kirby diagrams (handles, bundles of n
// strands, twist boxes), then compute on it for all parameter values at once
// (src/kirby.rs).  The drawing is a graph of straight segments; every
// segment carries a handle, a width (an expression) and a direction.

import { figure, drawSvg, svgFile, tikz, texDocument } from "./fancy.js?v=7160eb960c";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const COLORS = ["#c83737", "#2f6fd0", "#2f9a4a", "#9b4fc0", "#d07a1a", "#1f9090", "#6b7280", "#b0407a"];
const STORE = "knot-workbench-kirby";

// ---------------------------------------------------------------- state

function emptyState() {
  return {
    params: [],
    handles: [{ name: "K", kind: "framed", framing: "0", color: COLORS[1] }],
    points: [],
    segs: [],
    over: [],
    boxes: [],
    moves: [],
    next: 1,
  };
}

let state = emptyState();
let past = [];
let future = [];
let mode = "draw";
let pending = null; // the point a strand being drawn ends at
let cursor = null; // world position of the mouse
let selChain = null; // segment ids of the selected strand
let selBox = null;
let view = { x: 0, y: 0, w: 1200, h: 900 };
let boxDraft = null;
let drag = null;
let fancy = false; // the figure view

function snapshot() {
  past.push(JSON.stringify(state));
  if (past.length > 200) past.shift();
  future = [];
}

function changed() {
  save();
  render();
  requestSummary();
  // results computed from an older diagram
  if (tableRows) {
    $("k-table").classList.add("stale");
    $("k-table-status").textContent = "out of date: compute again";
  }
  $("k-pd").classList.add("stale");
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {}
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && Array.isArray(s.segs)) state = { ...emptyState(), ...s };
  } catch {}
}

function undo() {
  if (!past.length) return;
  future.push(JSON.stringify(state));
  state = JSON.parse(past.pop());
  selChain = selBox = null;
  pending = null;
  changed();
}

function redo() {
  if (!future.length) return;
  past.push(JSON.stringify(state));
  state = JSON.parse(future.pop());
  selChain = selBox = null;
  changed();
}

const pointById = (id) => state.points.find((p) => p.id === id);
const segById = (id) => state.segs.find((s) => s.id === id);
const color = (h) => state.handles[h]?.color ?? COLORS[h % COLORS.length];

// ---------------------------------------------------------------- geometry

function intersect(p0, p1, q0, q1) {
  const r = [p1.x - p0.x, p1.y - p0.y];
  const s = [q1.x - q0.x, q1.y - q0.y];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const qp = [q0.x - p0.x, q0.y - p0.y];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  const eps = 1e-9;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps ? { t, u } : null;
}

function crossings() {
  const out = [];
  const segs = state.segs;
  const overOf = new Map(state.over.map(([a, b, o]) => [`${Math.min(a, b)},${Math.max(a, b)}`, o]));
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i];
      const b = segs[j];
      if (a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b) continue;
      const pa = pointById(a.a), pb = pointById(a.b), qa = pointById(b.a), qb = pointById(b.b);
      const x = intersect(pa, pb, qa, qb);
      if (!x) continue;
      const key = `${Math.min(a.id, b.id)},${Math.max(a.id, b.id)}`;
      const over = overOf.get(key) ?? Math.max(a.id, b.id);
      out.push({
        a: a.id,
        b: b.id,
        over,
        x: pa.x + x.t * (pb.x - pa.x),
        y: pa.y + x.t * (pb.y - pa.y),
      });
    }
  }
  return out;
}

function degree(id) {
  return state.segs.filter((s) => s.a === id || s.b === id).length;
}

/// The strand through a segment: segments joined at points of degree 2,
/// each with the side (+1: a → b) it is walked in.
function chain(segId) {
  const first = segById(segId);
  const out = [{ seg: first, side: 1 }];
  const seen = new Set([segId]);
  for (const dir of [1, -1]) {
    let seg = first;
    let side = dir;
    for (;;) {
      const p = side > 0 ? seg.b : seg.a;
      if (degree(p) !== 2) break;
      const next = state.segs.find((s) => s.id !== seg.id && (s.a === p || s.b === p));
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      side = next.a === p ? 1 : -1;
      seg = next;
      if (dir > 0) out.push({ seg, side });
      else out.unshift({ seg, side: -side });
    }
  }
  return out;
}

function allChains() {
  const done = new Set();
  const out = [];
  for (const s of state.segs) {
    if (done.has(s.id)) continue;
    const c = chain(s.id);
    c.forEach((x) => done.add(x.seg.id));
    out.push(c);
  }
  return out;
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  const q = { x: a.x + t * dx, y: a.y + t * dy };
  return { d: Math.hypot(p.x - q.x, p.y - q.y), t, q };
}

// ---------------------------------------------------------------- picking

const svg = $("k-canvas");

function toWorld(e) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const w = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: w.x, y: w.y };
}

function scale() {
  const r = svg.getBoundingClientRect();
  return view.w / Math.max(1, r.width);
}

function hitPoint(w) {
  const tol = 10 * scale();
  let best = null;
  for (const p of state.points) {
    const d = Math.hypot(p.x - w.x, p.y - w.y);
    if (d < tol && (!best || d < best.d)) best = { p, d };
  }
  return best?.p ?? null;
}

function hitSeg(w) {
  const tol = 8 * scale();
  let best = null;
  for (const s of state.segs) {
    const r = distToSeg(w, pointById(s.a), pointById(s.b));
    if (r.d < tol && (!best || r.d < best.d)) best = { s, ...r };
  }
  return best;
}

function hitCrossing(w) {
  const tol = 9 * scale();
  return crossings().find((c) => Math.hypot(c.x - w.x, c.y - w.y) < tol) ?? null;
}

function boxCorners(b, pad = 16) {
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

function hitBox(w) {
  for (let i = state.boxes.length - 1; i >= 0; i--) {
    const b = state.boxes[i];
    const r = distToSeg(w, { x: b.p[0], y: b.p[1] }, { x: b.q[0], y: b.q[1] });
    if (r.d < 16 * Math.max(1, scale())) return i;
  }
  return null;
}

// ---------------------------------------------------------------- editing

function newPoint(w) {
  const p = { id: state.next++, x: Math.round(w.x), y: Math.round(w.y) };
  state.points.push(p);
  return p.id;
}

/// Splits a segment at `q`, both halves keeping its label; returns the new point.
function splitSeg(s, q) {
  const m = newPoint(q);
  const t = { ...s, id: state.next++, a: m, b: s.b };
  s.b = m;
  state.segs.push(t);
  // crossings set by hand stay with whichever half they are on
  for (const [a, b, o] of [...state.over]) {
    if (a === s.id || b === s.id) {
      const other = a === s.id ? b : a;
      state.over.push([t.id, other, o === s.id ? t.id : o]);
    }
  }
  return m;
}

function addSeg(a, b) {
  state.segs.push({
    id: state.next++,
    a,
    b,
    handle: Number($("k-pen-handle").value) || 0,
    width: $("k-pen-width").value.trim() || "1",
    dir: 1,
  });
}

function removeSegs(ids) {
  const set = new Set(ids);
  state.segs = state.segs.filter((s) => !set.has(s.id));
  state.over = state.over.filter(([a, b]) => !set.has(a) && !set.has(b));
  const used = new Set(state.segs.flatMap((s) => [s.a, s.b]));
  state.points = state.points.filter((p) => used.has(p.id) || p.id === pending);
}

function drawClick(w) {
  const hp = hitPoint(w);
  snapshot();
  let target;
  let existing = true;
  if (hp) target = hp.id;
  else {
    const hs = hitSeg(w);
    if (hs) target = splitSeg(hs.s, hs.q);
    else {
      target = newPoint(w);
      existing = false;
    }
  }
  if (pending === null) {
    pending = target;
  } else if (target !== pending) {
    addSeg(pending, target);
    pending = existing ? null : target;
  }
  changed();
}

function endStrand() {
  if (pending !== null && degree(pending) === 0) {
    state.points = state.points.filter((p) => p.id !== pending);
  }
  pending = null;
  render();
}

function flipCrossing(c) {
  snapshot();
  const key = (x) => Math.min(x[0], x[1]) === Math.min(c.a, c.b) && Math.max(x[0], x[1]) === Math.max(c.a, c.b);
  state.over = state.over.filter((x) => !key(x));
  state.over.push([c.a, c.b, c.over === c.a ? c.b : c.a]);
  changed();
}

function selectChain(segId) {
  const c = chain(segId);
  // make the directions agree along the strand
  const d0 = c[0].seg.dir * c[0].side;
  for (const { seg, side } of c) seg.dir = d0 * side;
  selChain = c.map((x) => x.seg.id);
  selBox = null;
  render();
}

function chainSegs() {
  return (selChain ?? []).map(segById).filter(Boolean);
}

// ---------------------------------------------------------------- render

function el(name, attrs, parent) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

function currentFigure() {
  return figure(state, { chains: allChains(), crossings: crossings(), color });
}

const figureOptions = () => ({ colored: $("k-colored").checked });

function render() {
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  $("k-fancy").setAttribute("aria-pressed", fancy);
  if (fancy) {
    svg.classList.remove("draw");
    drawSvg(svg, currentFigure(), figureOptions());
    renderPanels();
    $("k-strand-panel").hidden = true;
    $("k-box-panel").hidden = true;
    $("k-hint").textContent = "Figure view: drag to move the view, scroll to zoom. Export with SVG, Copy TikZ or .tex; press Figure view again to edit.";
    return;
  }
  svg.classList.toggle("draw", mode === "draw" || mode === "box");
  svg.replaceChildren();
  const xs = crossings();
  const wide = (s) => s.width.trim() !== "1";
  const sel = new Set(selChain ?? []);
  for (const s of state.segs) {
    const a = pointById(s.a), b = pointById(s.b);
    if (sel.has(s.id)) {
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "pick" }, svg);
    }
    el("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: "kseg",
      stroke: color(s.handle),
      "stroke-width": wide(s) ? 7 : 3.2,
    }, svg);
  }
  // the over-strand at each crossing, drawn again over a gap
  for (const c of xs) {
    const s = segById(c.over);
    const a = pointById(s.a), b = pointById(s.b);
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const r = 16 * Math.max(0.6, scale());
    const ux = ((b.x - a.x) / l) * r, uy = ((b.y - a.y) / l) * r;
    const seg = { x1: c.x - ux, y1: c.y - uy, x2: c.x + ux, y2: c.y + uy };
    el("line", { ...seg, class: "halo", "stroke-width": wide(s) ? 19 : 13 }, svg);
    el("line", { ...seg, class: "kseg", stroke: color(s.handle), "stroke-width": wide(s) ? 7 : 3.2 }, svg);
  }
  // labels, arrows and dots, once per strand
  for (const c of allChains()) {
    const mid = c[Math.floor(c.length / 2)];
    const s = mid.seg;
    const a = pointById(s.a), b = pointById(s.b);
    const t = c.length % 2 === 0 && c.length > 1 ? 0.15 : 0.5;
    const [p, q] = s.dir > 0 ? [a, b] : [b, a];
    const x = p.x + t * (q.x - p.x), y = p.y + t * (q.y - p.y);
    const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const ux = (q.x - p.x) / l, uy = (q.y - p.y) / l;
    const h = state.handles[s.handle];
    if (h?.kind === "dotted") {
      el("circle", { cx: x, cy: y, r: 7, fill: color(s.handle) }, svg);
    } else {
      const k = 9;
      el("polygon", {
        points: `${x + ux * k},${y + uy * k} ${x - ux * k - uy * k * 0.7},${y - uy * k + ux * k * 0.7} ${x - ux * k + uy * k * 0.7},${y - uy * k - ux * k * 0.7}`,
        fill: color(s.handle),
        class: "arrow",
      }, svg);
    }
    if (wide(s)) {
      const txt = el("text", { x: x - uy * 22, y: y + ux * 22, class: "mlabel", fill: color(s.handle), "font-size": 18 * Math.max(0.7, scale()) }, svg);
      txt.textContent = s.width;
    }
  }
  // boxes
  state.boxes.forEach((bx, i) => {
    const pts = boxCorners(bx).map((c) => c.join(",")).join(" ");
    el("polygon", { points: pts, class: "tbox" + (selBox === i ? " sel" : "") }, svg);
    const t = el("text", {
      x: (bx.p[0] + bx.q[0]) / 2,
      y: (bx.p[1] + bx.q[1]) / 2,
      class: "tlabel",
      "font-size": 17 * Math.max(0.7, scale()),
    }, svg);
    t.textContent = bx.twists;
  });
  if (boxDraft) {
    el("line", { x1: boxDraft.p[0], y1: boxDraft.p[1], x2: boxDraft.q[0], y2: boxDraft.q[1], class: "pending" }, svg);
  }
  // points
  if (mode !== "box") {
    for (const p of state.points) {
      const deg = degree(p.id);
      if (mode === "draw" || mode === "erase" || deg !== 2 || p.id === pending) {
        el("circle", {
          cx: p.x, cy: p.y, r: (deg >= 3 ? 6 : 4.5) * Math.max(0.7, scale()),
          class: "kpt" + (p.id === pending ? " hot" : ""),
          stroke: "#5d6677",
        }, svg);
      }
    }
  }
  if (pending !== null && cursor && mode === "draw") {
    const p = pointById(pending);
    if (p) el("line", { x1: p.x, y1: p.y, x2: cursor.x, y2: cursor.y, class: "pending" }, svg);
  }
  renderPanels();
  renderHint();
}

function renderHint() {
  const hints = {
    draw: pending === null
      ? "Click to start a strand (on a point or a strand to branch from it)."
      : "Click to add points; click a point or a strand to end there. Esc ends the strand.",
    edit: "Drag a point, a strand or a box to move it. Click a strand to set its handle, width and direction; click a crossing to flip it.",
    box: "Drag a line across the strands to twist.",
    erase: "Click a point, a segment or a box to remove it.",
  };
  $("k-hint").textContent = `${hints[mode]} Move the view: Space+drag, middle-drag or arrow keys (or drag empty space in Edit); scroll to zoom.`;
}

// ---------------------------------------------------------------- panels

function handleOptions(sel, value) {
  sel.replaceChildren(
    ...state.handles.map((h, i) => {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = `${h.name}${h.kind === "dotted" ? " (dotted)" : ""}`;
      return o;
    }),
  );
  if (value !== undefined) sel.value = value;
}

function renderPanels() {
  handleOptions($("k-pen-handle"), Math.min(Number($("k-pen-handle").value) || 0, state.handles.length - 1));
  const segs = chainSegs();
  $("k-strand-panel").hidden = !(mode === "edit" && segs.length);
  if (segs.length) {
    handleOptions($("k-strand-handle"), segs[0].handle);
    if (document.activeElement !== $("k-strand-width")) $("k-strand-width").value = segs[0].width;
  }
  const bx = selBox !== null ? state.boxes[selBox] : null;
  $("k-box-panel").hidden = !bx;
  if (bx) {
    if (document.activeElement !== $("k-box-twists")) $("k-box-twists").value = bx.twists;
    $("k-box-units").value = bx.units;
  }
  for (const b of document.querySelectorAll("[data-kmode]")) {
    b.setAttribute("aria-pressed", b.dataset.kmode === mode);
  }
}

function renderHandles() {
  const box = $("k-handles");
  box.replaceChildren();
  state.handles.forEach((h, i) => {
    const row = document.createElement("div");
    row.className = "khandle";
    row.innerHTML = `<input type="color" class="swatch-pick" value="${color(i)}" aria-label="Color" title="Color">
      <input type="text" class="name" value="${h.name}" aria-label="Name" spellcheck="false">
      <select class="kind" aria-label="Kind"><option value="framed">2-handle</option><option value="dotted">dotted circle</option></select>
      <label class="fr">framing <input type="text" class="num framing" value="${h.framing ?? "0"}" spellcheck="false"></label>
      <button class="del small" title="Remove this handle and its strands">Remove</button>`;
    row.querySelector(".kind").value = h.kind;
    row.querySelector(".swatch-pick").onchange = (e) => {
      h.color = e.target.value;
      save();
      render();
    };
    row.querySelector(".fr").hidden = h.kind === "dotted";
    row.querySelector(".name").onchange = (e) => {
      const name = e.target.value.trim();
      if (!name || state.handles.some((x, j) => j !== i && x.name === name)) return renderHandles();
      snapshot();
      for (const m of state.moves) {
        if (m.dotted === h.name) m.dotted = name;
        if (m.handle === h.name) m.handle = name;
      }
      h.name = name;
      changed();
      renderHandles();
    };
    row.querySelector(".kind").onchange = (e) => {
      snapshot();
      h.kind = e.target.value;
      changed();
      renderHandles();
    };
    row.querySelector(".framing").onchange = (e) => {
      snapshot();
      h.framing = e.target.value.trim() || "0";
      changed();
    };
    row.querySelector(".del").onclick = () => {
      if (state.handles.length === 1) return;
      snapshot();
      removeSegs(state.segs.filter((s) => s.handle === i).map((s) => s.id));
      for (const s of state.segs) if (s.handle > i) s.handle--;
      state.handles.splice(i, 1);
      state.moves = state.moves.filter((m) => m.dotted !== h.name && m.handle !== h.name);
      selChain = null;
      changed();
      renderHandles();
    };
    box.appendChild(row);
  });
}

function addHandle(kind) {
  snapshot();
  const base = kind === "dotted" ? "R" : "K";
  let k = 1;
  while (state.handles.some((h) => h.name === `${base}${k}`)) k++;
  const used = new Set(state.handles.map((_, i) => color(i)));
  const free = COLORS.find((c) => !used.has(c)) ?? COLORS[state.handles.length % COLORS.length];
  state.handles.push({ name: `${base}${k}`, kind, framing: "0", color: kind === "dotted" ? COLORS[0] : free });
  $("k-pen-handle").value = state.handles.length - 1;
  changed();
  renderHandles();
  render();
  $("k-pen-handle").value = state.handles.length - 1;
}

function renderParams() {
  const box = $("k-params");
  box.replaceChildren();
  state.params.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "khandle";
    row.innerHTML = `<span class="expr"><b>${p.name}</b></span>
      <select class="parity" aria-label="Parity"><option value="">any</option><option value="odd">odd</option><option value="even">even</option></select>
      <label>from <input type="number" class="num from" value="${p.from ?? 1}"></label>
      <label>to <input type="number" class="num to" value="${p.to ?? 3}"></label>
      <button class="del small">Remove</button>`;
    row.querySelector(".parity").value = p.parity ?? "";
    row.querySelector(".parity").onchange = (e) => {
      snapshot();
      p.parity = e.target.value;
      changed();
    };
    row.querySelector(".from").onchange = (e) => {
      p.from = Number(e.target.value);
      save();
      renderValues();
      renderRanges();
    };
    row.querySelector(".to").onchange = (e) => {
      p.to = Number(e.target.value);
      save();
      renderRanges();
    };
    row.querySelector(".del").onclick = () => {
      snapshot();
      state.params.splice(i, 1);
      changed();
      renderParams();
    };
    box.appendChild(row);
  });
  renderValues();
}

function renderValues() {
  const box = $("k-values");
  box.replaceChildren();
  for (const p of state.params) {
    const l = document.createElement("label");
    l.className = "expr";
    let v = p.from ?? 1;
    if (p.parity === "odd" && Math.abs(v) % 2 !== 1) v += 1;
    if (p.parity === "even" && Math.abs(v) % 2 !== 0) v += 1;
    l.innerHTML = `${p.name} = <input type="number" class="num" data-name="${p.name}" value="${v}" style="width:4.5em">`;
    box.appendChild(l);
  }
}

// ---------------------------------------------------------------- computing

function request(task, extra = {}) {
  return {
    task,
    drawing: {
      params: state.params.map((p) => ({ name: p.name, parity: p.parity || null })),
      handles: state.handles.map((h) => ({ name: h.name, kind: h.kind, framing: h.framing ?? "0" })),
      points: state.points,
      segs: state.segs,
      over: state.over,
      boxes: state.boxes,
    },
    moves: state.moves,
    ...extra,
  };
}

function makeWorker() {
  return new Worker(new URL("./kirby-worker.js?v=7160eb960c", import.meta.url), { type: "module" });
}

/// A worker that restarts when a new request comes before the last answer.
function channel(onAnswer) {
  let w = makeWorker();
  let busy = false;
  let id = 0;
  return {
    send(req) {
      if (busy) {
        w.terminate();
        w = makeWorker();
      }
      busy = true;
      const my = ++id;
      const cur = w;
      cur.onmessage = (e) => {
        if (cur !== w || e.data.id !== my) return;
        busy = false;
        if (e.data.result.fatal) w = makeWorker();
        onAnswer(e.data.result);
      };
      cur.onerror = () => {
        if (cur !== w) return;
        busy = false;
        w.terminate();
        w = makeWorker();
        onAnswer({ error: "the computation failed" });
      };
      cur.postMessage({ id: my, request: { kirby: req } });
    },
    cancel() {
      if (busy) {
        w.terminate();
        w = makeWorker();
        busy = false;
      }
    },
  };
}

let lastSummary = null;
const summaryChannel = channel(showSummary);
let summaryTimer = 0;
let summaryCount = 0;

function requestSummary() {
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    if (!state.segs.length) return showSummary({ error: "Draw some strands, or load the example." });
    summaryChannel.send(request("summary"));
  }, 150);
}

function exprHtml(s) {
  return s.replace(/\^(-?\d+)/g, (_, k) => `<sup>${k.replace("-", "−")}</sup>`).replace(/\*/g, "").replace(/-/g, "−");
}

function showSummary(res) {
  summaryCount++;
  const status = $("k-status");
  const banner = $("k-banner");
  if (res.error) {
    lastSummary = null;
    status.innerHTML = `<span class="err">${res.error}</span>`;
    banner.hidden = !state.segs.length;
    banner.textContent = res.error;
    $("k-stages").classList.add("stale");
    return;
  }
  banner.hidden = true;
  $("k-stages").classList.remove("stale");
  lastSummary = res;
  status.innerHTML = `<strong>${res.stages[0].handles.length} handles</strong>; checked against the drawn members at small parameter values.`;
  const titles = ["Drawn diagram", ...state.moves.map((m) => `After cancelling ${m.dotted} with ${m.handle}`)];
  const box = $("k-stages");
  box.replaceChildren();
  res.stages.forEach((st, i) => {
    const card = document.createElement("div");
    card.className = "card kstage";
    const rows = st.handles
      .map((h) => `<tr><td><b>${h.name}</b></td><td>${h.dotted ? "dotted circle" : "2-handle"}</td>
        <td class="expr">${h.dotted ? "" : exprHtml(h.framing)}</td><td class="expr">${exprHtml(h.writhe)}</td></tr>`)
      .join("");
    let lk = "";
    if (st.handles.length > 1) {
      const head = st.handles.map((h) => `<th>${h.name}</th>`).join("");
      const body = st.lk
        .map((r, a) => `<tr><th>${st.handles[a].name}</th>${r.map((v, b) => `<td class="expr">${a === b ? "·" : exprHtml(v)}</td>`).join("")}</tr>`)
        .join("");
      lk = `<table><tr><th>lk</th>${head}</tr>${body}</table>`;
    }
    card.innerHTML = `<h2>${titles[i] ?? ""}</h2>
      <table><tr><th>handle</th><th>kind</th><th>framing</th><th>writhe</th></tr>${rows}</table>${lk}`;
    box.appendChild(card);
  });
  // moves offer the handles of the last stage
  const last = res.stages[res.stages.length - 1].handles;
  const fill = (sel, list) => {
    const v = sel.value;
    sel.replaceChildren(...list.map((h) => Object.assign(document.createElement("option"), { value: h.name, textContent: h.name })));
    if (list.some((h) => h.name === v)) sel.value = v;
  };
  fill($("k-move-dotted"), last.filter((h) => h.dotted));
  fill($("k-move-handle"), last.filter((h) => !h.dotted));
  $("k-move-add").disabled = !last.some((h) => h.dotted) || !last.some((h) => !h.dotted);
}

function renderMoves() {
  const ol = $("k-moves");
  ol.replaceChildren();
  state.moves.forEach((m, i) => {
    const li = document.createElement("li");
    li.innerHTML = `Cancel <b>${m.dotted}</b> with <b>${m.handle}</b> <button class="small">Undo from here</button>`;
    li.querySelector("button").onclick = () => {
      snapshot();
      state.moves.splice(i);
      changed();
      renderMoves();
    };
    ol.appendChild(li);
  });
}

// the table of members
let tableRows = null;
const tableChannel = channel(showTable);

function ranges() {
  return state.params.map((p) => [p.from ?? 1, p.to ?? 3]);
}

function renderRanges() {
  const box = $("k-ranges");
  box.className = "row note";
  box.textContent = state.params.length
    ? "Ranges: " + state.params.map((p) => `${p.name} from ${p.from ?? 1} to ${p.to ?? 3}${p.parity ? ` (${p.parity})` : ""}`).join(", ") + " — set them under Parameters."
    : "No parameters: the table has one row.";
}

function showTable(res) {
  $("k-table-cancel").hidden = true;
  $("k-table-go").disabled = false;
  const out = $("k-table");
  if (res.error) {
    $("k-table-status").textContent = "";
    out.innerHTML = `<span class="err">${res.error}</span>`;
    return;
  }
  tableRows = res.rows;
  out.classList.remove("stale");
  $("k-table-csv").hidden = false;
  $("k-table-status").textContent = `${res.rows.length} members`;
  const names = state.params.map((p) => p.name);
  const homs = res.rows.some((r) => r.homs);
  const head = [
    ...names.map((n) => `<th class="expr">${n}</th>`),
    `<th title="crossings of the drawn member">crossings</th>`,
    `<th title="components">comp.</th>`,
    `<th title="writhe">w</th>`,
    `<th title="Seifert circles">s</th>`,
    `<th title="components of the Seifert graph without the negative crossings">c₊</th>`,
    `<th title="components of the Seifert graph without the positive crossings">c₋</th>`,
    `<th>w − s + 2c₊ − 1</th>`,
    `<th>−w − s + 2c₋ − 1</th>`,
    `<th>Δ(t)</th>`,
    homs ? `<th title="homomorphisms of the boundary 3-manifold's group to S_k, at each stage; they must agree">boundary</th>` : "",
  ].join("");
  const body = res.rows
    .map((r) => {
      const vals = r.values.map((v) => `<td>${v}</td>`).join("");
      if (r.error) return `<tr>${vals}<td colspan="9" class="err">${r.error}</td></tr>`;
      const h = r.homs ? `<td>${r.homs.join(" → ")}${new Set(r.homs).size === 1 ? " ✓" : " ✗"}</td>` : homs ? "<td></td>" : "";
      return `<tr>${vals}<td>${r.crossings}</td><td>${r.components}</td><td>${r.writhe}</td><td>${r.seifert}</td><td>${r.cpos}</td><td>${r.cneg}</td>
        <td><b>${r.bound_pos}</b></td><td>${r.bound_neg}</td><td class="poly">${r.alexander ? exprHtml(r.alexander) : ""}</td>${h}</tr>`;
    })
    .join("");
  out.innerHTML = `<table class="fam"><tr>${head}</tr>${body}</table>`;
}

function csv() {
  const names = state.params.map((p) => p.name);
  const cols = ["crossings", "components", "writhe", "seifert", "cpos", "cneg", "bound_pos", "bound_neg", "alexander"];
  const lines = [[...names, ...cols].join(",")];
  for (const r of tableRows ?? []) lines.push([...r.values, ...cols.map((c) => JSON.stringify(r[c] ?? ""))].join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "kirby-family.csv" });
  a.click();
}

const pdChannel = channel((res) => {
  $("k-pd-status").textContent = "";
  if (res.error) return ($("k-pd").innerHTML = `<span class="err">${res.error}</span>`);
  const code = res.pd.map((x) => `X[${x.join(",")}]`).join(", ");
  $("k-pd").textContent = code || "(no crossings)";
  $("k-pd").classList.remove("stale");
  $("k-pd-status").textContent = `${res.crossings} crossings, ${res.components} component${res.components === 1 ? "" : "s"}`;
});

// ---------------------------------------------------------------- example

function example() {
  const P = [
    [1, 200, 430], [2, 820, 430], [3, 820, 500], [4, 200, 500],
    [10, 300, 540], [11, 300, 380], [12, 300, 120], [13, 600, 120], [14, 600, 760],
    [15, 280, 760], [16, 280, 580], [17, 150, 350], [18, 150, 620], [19, 340, 620], [20, 330, 580],
    [30, 760, 580], [31, 760, 370], [32, 910, 370], [33, 910, 530],
    [40, 950, 530], [41, 950, 680], [42, 100, 680], [43, 100, 880], [44, 1080, 880],
    [45, 1080, 40], [46, 100, 40], [47, 100, 200], [48, 950, 200],
  ];
  const segs = [];
  const seg = (id, a, b, handle, width) => segs.push({ id, a, b, handle, width, dir: 1 });
  [[1, 2], [2, 3], [3, 4], [4, 1]].forEach(([a, b], i) => seg(100 + i, a, b, 0, "1"));
  seg(110, 10, 11, 1, "n+1");
  [[11, 12], [12, 13], [13, 14], [14, 15], [15, 16], [16, 10]].forEach(([a, b], i) => seg(111 + i, a, b, 1, "n"));
  [[11, 17], [17, 18], [18, 19], [19, 20], [20, 10]].forEach(([a, b], i) => seg(120 + i, a, b, 1, "1"));
  [[30, 31], [31, 32], [32, 33], [33, 30]].forEach(([a, b], i) => seg(130 + i, a, b, 2, "1"));
  [[40, 41], [41, 42], [42, 43], [43, 44], [44, 45], [45, 46], [46, 47], [47, 48], [48, 40]].forEach(([a, b], i) =>
    seg(140 + i, a, b, 2, "1"),
  );
  return {
    params: [
      { name: "n", parity: "", from: 1, to: 4 },
      { name: "m", parity: "odd", from: -5, to: 5 },
    ],
    handles: [
      { name: "R", kind: "dotted", framing: "0", color: "#c83737" },
      { name: "G", kind: "framed", framing: "0", color: "#2f9a4a" },
      { name: "B", kind: "framed", framing: "0", color: "#2f6fd0" },
    ],
    points: P.map(([id, x, y]) => ({ id, x, y })),
    segs,
    over: [
      [100, 110, 110], [100, 113, 113], [100, 130, 130],
      [102, 110, 102], [102, 113, 102], [102, 130, 102],
      [122, 115, 122],
      [147, 111, 111], [147, 113, 147],
      [141, 113, 141], [141, 115, 115],
    ],
    boxes: [{ p: [880, 450], q: [980, 450], twists: "m", units: "ribbons" }],
    moves: [],
    next: 200,
  };
}

// ---------------------------------------------------------------- view

function fit() {
  if (!state.points.length) {
    view = { x: 0, y: 0, w: 1200, h: 900 };
    return render();
  }
  const xs = state.points.map((p) => p.x), ys = state.points.map((p) => p.y);
  const r = svg.getBoundingClientRect();
  const aspect = r.width / Math.max(1, r.height) || 4 / 3;
  let x0 = Math.min(...xs) - 60, x1 = Math.max(...xs) + 60;
  let y0 = Math.min(...ys) - 60, y1 = Math.max(...ys) + 60;
  let w = x1 - x0, h = y1 - y0;
  if (w / h > aspect) {
    const nh = w / aspect;
    y0 -= (nh - h) / 2;
    h = nh;
  } else {
    const nw = h * aspect;
    x0 -= (nw - w) / 2;
    w = nw;
  }
  view = { x: x0, y: y0, w, h };
  render();
}

// ---------------------------------------------------------------- events

function setMode(m) {
  fancy = false;
  if (mode === "draw" && m !== "draw") endStrand();
  mode = m;
  boxDraft = null;
  if (m !== "edit") selChain = null;
  render();
}

for (const b of document.querySelectorAll("[data-kmode]")) b.onclick = () => setMode(b.dataset.kmode);

let spaceHeld = false;

function startPan(e) {
  drag = { kind: "pan", from: { x: e.clientX, y: e.clientY }, view: { ...view } };
  svg.setPointerCapture(e.pointerId);
  svg.style.cursor = "grabbing";
}

svg.addEventListener("pointerdown", (e) => {
  const w = toWorld(e);
  if (e.button === 1 || spaceHeld || fancy) {
    e.preventDefault();
    return startPan(e);
  }
  if (mode === "draw") {
    if (e.button === 2) return endStrand();
    return drawClick(w);
  }
  if (mode === "erase") {
    const bi = hitBox(w);
    snapshot();
    if (bi !== null) state.boxes.splice(bi, 1);
    else {
      const p = hitPoint(w);
      if (p) {
        removeSegs(state.segs.filter((s) => s.a === p.id || s.b === p.id).map((s) => s.id));
        state.points = state.points.filter((q) => q.id !== p.id);
      } else {
        const s = hitSeg(w);
        if (s) removeSegs([s.s.id]);
        else past.pop();
      }
    }
    selChain = null;
    selBox = null;
    return changed();
  }
  if (mode === "box") {
    const bi = hitBox(w);
    if (bi !== null) {
      selBox = bi;
      return render();
    }
    boxDraft = { p: [w.x, w.y], q: [w.x, w.y] };
    svg.setPointerCapture(e.pointerId);
    return;
  }
  // edit
  const p = hitPoint(w);
  if (p) {
    drag = { kind: "move", points: [p], boxes: [], from: w, start: [[p.x, p.y]], moved: false };
    svg.setPointerCapture(e.pointerId);
    return;
  }
  const bi = hitBox(w);
  if (bi !== null) {
    selBox = bi;
    selChain = null;
    const b = state.boxes[bi];
    drag = { kind: "move", points: [], boxes: [b], from: w, start: [[...b.p, ...b.q]], moved: false };
    svg.setPointerCapture(e.pointerId);
    return render();
  }
  const c = hitCrossing(w);
  if (c) return flipCrossing(c);
  const s = hitSeg(w);
  if (s) {
    // a click selects the strand, a drag moves all of it
    selectChain(s.s.id);
    const ids = new Set(chainSegs().flatMap((x) => [x.a, x.b]));
    const pts = state.points.filter((q) => ids.has(q.id));
    drag = { kind: "move", points: pts, boxes: [], from: w, start: pts.map((q) => [q.x, q.y]), moved: false };
    svg.setPointerCapture(e.pointerId);
    return;
  }
  selChain = null;
  selBox = null;
  startPan(e);
  render();
});

svg.addEventListener("pointermove", (e) => {
  const w = toWorld(e);
  cursor = w;
  if (boxDraft) {
    boxDraft.q = [w.x, w.y];
    return render();
  }
  if (drag?.kind === "move") {
    const dx = w.x - drag.from.x, dy = w.y - drag.from.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 3 * scale()) return;
      snapshot();
      drag.moved = true;
    }
    drag.points.forEach((q, i) => {
      q.x = Math.round(drag.start[i][0] + dx);
      q.y = Math.round(drag.start[i][1] + dy);
    });
    drag.boxes.forEach((b, i) => {
      const [px, py, qx, qy] = drag.start[i];
      b.p = [Math.round(px + dx), Math.round(py + dy)];
      b.q = [Math.round(qx + dx), Math.round(qy + dy)];
    });
    return render();
  }
  if (drag?.kind === "pan") {
    const s = scale();
    view.x = drag.view.x - (e.clientX - drag.from.x) * s;
    view.y = drag.view.y - (e.clientY - drag.from.y) * s;
    return render();
  }
  if (mode === "draw" && pending !== null) render();
});

svg.addEventListener("pointerup", () => {
  if (boxDraft) {
    const b = boxDraft;
    boxDraft = null;
    if (Math.hypot(b.q[0] - b.p[0], b.q[1] - b.p[1]) > 20) {
      snapshot();
      state.boxes.push({ p: b.p.map(Math.round), q: b.q.map(Math.round), twists: "1", units: "ribbons" });
      selBox = state.boxes.length - 1;
      changed();
      $("k-box-twists").focus();
      $("k-box-twists").select();
    } else render();
    return;
  }
  if (drag?.kind === "move" && drag.moved) changed();
  drag = null;
  svg.style.cursor = "";
});

svg.addEventListener("auxclick", (e) => e.button === 1 && e.preventDefault());

svg.addEventListener("contextmenu", (e) => {
  if (mode === "draw") e.preventDefault();
});

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const w = toWorld(e);
  const f = Math.exp(e.deltaY * 0.0015);
  view = { x: w.x - (w.x - view.x) * f, y: w.y - (w.y - view.y) * f, w: view.w * f, h: view.h * f };
  render();
}, { passive: false });

$("k-strand-handle").onchange = (e) => {
  snapshot();
  for (const s of chainSegs()) s.handle = Number(e.target.value);
  changed();
};
$("k-strand-width").onchange = (e) => {
  snapshot();
  for (const s of chainSegs()) s.width = e.target.value.trim() || "1";
  changed();
};
$("k-strand-flip").onclick = () => {
  snapshot();
  for (const s of chainSegs()) s.dir = -s.dir;
  changed();
};
$("k-strand-delete").onclick = () => {
  snapshot();
  removeSegs(selChain ?? []);
  selChain = null;
  changed();
};
$("k-box-twists").onchange = (e) => {
  if (selBox === null) return;
  snapshot();
  state.boxes[selBox].twists = e.target.value.trim() || "0";
  changed();
};
$("k-box-units").onchange = (e) => {
  if (selBox === null) return;
  snapshot();
  state.boxes[selBox].units = e.target.value;
  changed();
};
$("k-box-delete").onclick = () => {
  if (selBox === null) return;
  snapshot();
  state.boxes.splice(selBox, 1);
  selBox = null;
  changed();
};

function download(name, text, type) {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type })),
    download: name,
  });
  a.click();
}

$("k-fancy").onclick = () => {
  if (mode === "draw") endStrand();
  fancy = !fancy;
  selChain = selBox = null;
  render();
};
$("k-colored").onchange = render;
$("k-svg").onclick = () => download("kirby-diagram.svg", svgFile(currentFigure(), figureOptions()), "image/svg+xml");
$("k-tex").onclick = () => download("kirby-diagram.tex", texDocument(currentFigure(), figureOptions()), "text/x-tex");
$("k-tikz").onclick = async () => {
  const text = tikz(currentFigure(), figureOptions());
  try {
    await navigator.clipboard.writeText(text);
    $("k-status").textContent = "Copied the TikZ picture (it needs \\usepackage{tikz}).";
  } catch {
    prompt("Copy the TikZ picture:", text);
  }
};

$("k-undo").onclick = () => (undo(), renderAll());
$("k-redo").onclick = () => (redo(), renderAll());
$("k-fit").onclick = fit;
$("k-clear").onclick = () => {
  snapshot();
  state = emptyState();
  selChain = selBox = null;
  pending = null;
  changed();
  renderAll();
};
$("k-example").onclick = () => {
  snapshot();
  state = example();
  selChain = selBox = null;
  pending = null;
  changed();
  renderAll();
  fit();
};
$("k-export").onclick = async () => {
  const text = JSON.stringify(state);
  try {
    await navigator.clipboard.writeText(text);
    $("k-status").textContent = "Copied the diagram as JSON.";
  } catch {
    prompt("Copy the diagram:", text);
  }
};
$("k-import").onclick = () => {
  const text = prompt("Paste a diagram (JSON):");
  if (!text) return;
  try {
    const s = JSON.parse(text);
    if (!Array.isArray(s.segs)) throw new Error("not a diagram");
    snapshot();
    state = { ...emptyState(), ...s };
    changed();
    renderAll();
    fit();
  } catch (e) {
    $("k-status").innerHTML = `<span class="err">Could not load it: ${e.message}</span>`;
  }
};
$("k-add-framed").onclick = () => addHandle("framed");
$("k-add-dotted").onclick = () => addHandle("dotted");
$("k-param-add").onclick = () => {
  const name = $("k-param-name").value.trim();
  if (!/^[A-Za-z_]\w*$/.test(name) || state.params.some((p) => p.name === name)) return;
  snapshot();
  state.params.push({ name, parity: "", from: 1, to: 3 });
  $("k-param-name").value = "";
  changed();
  renderParams();
  renderRanges();
};
$("k-param-name").addEventListener("keydown", (e) => e.key === "Enter" && $("k-param-add").onclick());
$("k-move-add").onclick = () => {
  const dotted = $("k-move-dotted").value, handle = $("k-move-handle").value;
  if (!dotted || !handle) return;
  snapshot();
  state.moves.push({ op: "cancel", dotted, handle });
  changed();
  renderMoves();
};
$("k-table-go").onclick = () => {
  $("k-table-go").disabled = true;
  $("k-table-cancel").hidden = false;
  $("k-table-status").textContent = "computing…";
  tableChannel.send(request("table", {
    ranges: ranges(),
    alexander_limit: Number($("k-alex").value) || 0,
    boundary_homs: Number($("k-homs").value) || 0,
  }));
};
$("k-table-cancel").onclick = () => {
  tableChannel.cancel();
  $("k-table-cancel").hidden = true;
  $("k-table-go").disabled = false;
  $("k-table-status").textContent = "cancelled";
};
$("k-table-csv").onclick = csv;
$("k-pd-go").onclick = () => {
  const values = state.params.map((p) => Number(document.querySelector(`#k-values input[data-name="${p.name}"]`)?.value ?? 1));
  $("k-pd-status").textContent = "computing…";
  pdChannel.send(request("member", { values }));
};
$("k-pd-copy").onclick = () => navigator.clipboard?.writeText($("k-pd").textContent);

// keys: only while this tab is showing, and before the workbench sees them
window.addEventListener("keydown", (e) => {
  if ($("tab-kirby").hidden || e.target.matches("input, textarea, select")) return;
  let used = true;
  if ((e.ctrlKey || e.metaKey) && e.key === "z") (undo(), renderAll());
  else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "Z"))) (redo(), renderAll());
  else if (e.key === "Escape") {
    endStrand();
    selChain = null;
    selBox = null;
    render();
  } else if (e.key === " ") {
    spaceHeld = true;
    svg.style.cursor = "grab";
  } else if (e.key.startsWith("Arrow")) {
    const k = 0.1;
    view.x += { ArrowLeft: -k, ArrowRight: k }[e.key] * view.w || 0;
    view.y += { ArrowUp: -k, ArrowDown: k }[e.key] * view.h || 0;
    render();
  } else if (e.key === "Enter" && mode === "draw") endStrand();
  else if ((e.key === "Delete" || e.key === "Backspace") && selBox !== null) $("k-box-delete").onclick();
  else if ((e.key === "Delete" || e.key === "Backspace") && selChain) $("k-strand-delete").onclick();
  else if (e.key === "f") $("k-fancy").onclick();
  else if (e.key === "d") setMode("draw");
  else if (e.key === "e") setMode("edit");
  else if (e.key === "t") setMode("box");
  else if (e.key === "x") setMode("erase");
  else used = !(e.ctrlKey || e.metaKey) && e.key.length === 1;
  if (used) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

window.addEventListener("keyup", (e) => {
  if (e.key === " " && spaceHeld) {
    spaceHeld = false;
    if (drag?.kind !== "pan") svg.style.cursor = "";
  }
});

// ---------------------------------------------------------------- tabs

function showTab(name) {
  for (const t of ["workbench", "kirby"]) {
    $(`tab-${t}`).hidden = t !== name;
    $(`tab-btn-${t}`).setAttribute("aria-selected", t === name);
  }
  try {
    localStorage.setItem("knot-workbench-tab", name);
  } catch {}
  if (name === "kirby") render();
}

for (const b of document.querySelectorAll("[data-tab]")) b.onclick = () => showTab(b.dataset.tab);

function renderAll() {
  renderHandles();
  renderParams();
  renderMoves();
  renderRanges();
  render();
}

load();
renderAll();
let firstTab = "workbench";
try {
  firstTab = localStorage.getItem("knot-workbench-tab") || "workbench";
} catch {}
if (location.hash === "#kirby") firstTab = "kirby";
showTab(firstTab);
requestSummary();

// for tests
window.kirbyTab = {
  state: () => state,
  load: (s) => {
    state = { ...emptyState(), ...s };
    changed();
    renderAll();
    fit();
  },
  summary: () => lastSummary,
  tikz: () => tikz(currentFigure(), figureOptions()),
  tex: () => texDocument(currentFigure(), figureOptions()),
  svg: () => svgFile(currentFigure(), figureOptions()),
  summaries: () => summaryCount,
  toScreen: (x, y) => {
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const s = pt.matrixTransform(svg.getScreenCTM());
    return { x: s.x, y: s.y };
  },
  example,
};
