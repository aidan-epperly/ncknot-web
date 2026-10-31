// Knot Workbench: the editor, the rendering and the invariant panels.
import { loadKnots } from "./knot.js";
import { braidDrawing, parseWord } from "./braid.js";

const COLORS = ["#2f5fd0", "#d1495b", "#0f9b6c", "#b06ab3", "#e08a00", "#3a9fc0", "#6b7280"];
const SVGNS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state

let drawing = { components: [], over: [], boxes: [] }; // what the user edits
let selectedBox = null; // index into drawing.boxes
let twistPick = null; // first strand picked in twist-box mode
let showTwists = false;
let pending = null; // vertices of a component being drawn
let mode = "edit";
let view = { x: 0, y: 0, w: 800, h: 560 }; // drawing coordinates shown by the canvas
let analysis = null; // last successful analyze_drawing
let pdSource = null; // a PD code entered as text (no picture)
let idCounter = 1;
const nextId = () => idCounter++;
const undoStack = [];
const redoStack = [];
let table = [];
let knots = null; // the main-thread module

// a trap (Rust panic) leaves the module unusable: reload it
async function guarded(fn) {
  try {
    return fn();
  } catch (e) {
    knots = await loadKnots();
    return { error: `internal error (${e}); please report the drawing` };
  }
}

function snapshot() {
  return JSON.stringify({ drawing, pdSource });
}
function commit(fromTable = false) {
  if (!fromTable) $("library").value = "";
  undoStack.push(lastCommitted);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  lastCommitted = snapshot();
  saveLocal();
}
let lastCommitted = snapshot();
function restore(s) {
  const o = JSON.parse(s);
  drawing = o.drawing;
  drawing.boxes ||= [];
  pdSource = o.pdSource;
  selectedBox = null;
  for (const c of drawing.components) for (const v of c) idCounter = Math.max(idCounter, v.id + 1);
  lastCommitted = s;
  changed();
}

// ---------------------------------------------------------------- workers

// Fast worker: the cheap invariants, recomputed after every edit (latest wins).
// Heavy worker: Khovanov homology and representations, cancelable.
function makeWorker() {
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
}
let fast = makeWorker();
let fastBusy = false;
let fastQueued = null;
let requestId = 0;
let diagramKey = ""; // identifies the diagram the panels describe

function sendFast(request) {
  if (fastBusy) {
    fastQueued = request;
    return;
  }
  fastBusy = true;
  const id = ++requestId;
  fast.onmessage = (e) => {
    fastBusy = false;
    if (e.data.id === id) showBasic(e.data.result, request);
    if (fastQueued) {
      const q = fastQueued;
      fastQueued = null;
      sendFast(q);
    }
  };
  fast.onerror = () => {
    fastBusy = false;
    fast.terminate();
    fast = makeWorker();
    showBasic({ error: "the computation failed" }, request);
  };
  fast.postMessage({ id, request });
}

const heavy = { worker: null };
function runHeavy(request, onDone, cancelButton) {
  if (heavy.worker) heavy.worker.terminate();
  heavy.worker = makeWorker();
  const key = diagramKey;
  cancelButton.hidden = false;
  const finish = () => {
    cancelButton.hidden = true;
    heavy.worker?.terminate();
    heavy.worker = null;
  };
  heavy.worker.onmessage = (e) => {
    finish();
    if (key === diagramKey) onDone(e.data.result);
  };
  heavy.worker.onerror = () => {
    finish();
    onDone({ error: "the computation failed (out of memory?)" });
  };
  cancelButton.onclick = () => {
    finish();
    onDone({ canceled: true });
  };
  heavy.worker.postMessage({ id: 0, request });
}

// ---------------------------------------------------------------- analysis

let debounce = 0;
function changed() {
  pending = mode === "draw" ? pending : null;
  render();
  updateButtons();
  clearTimeout(debounce);
  debounce = setTimeout(requestBasic, 60);
}

function currentRequest(task, extra = {}) {
  if (pdSource) return { task, pd: pdSource.pd, free_loops: pdSource.free_loops, ...extra };
  if (!analysis) return null;
  return { task, pd: analysis.pd, free_loops: analysis.free_loops, ...extra };
}

function requestBasic() {
  const req = currentRequest("basic", { p: Number($("prime").value) });
  const key = req ? JSON.stringify([req.pd, req.free_loops]) : "";
  if (key !== diagramKey) {
    diagramKey = key;
    clearHeavyPanels();
  }
  if (!req) {
    if (!drawing.components.length) showEmpty();
    else document.querySelector(".results").classList.add("stale");
    return;
  }
  sendFast(req);
}

function analyze() {
  if (!drawing.components.length) {
    analysis = null;
    return null;
  }
  const ids = new Set(drawing.components.flat().map((v) => v.id));
  drawing.boxes = drawing.boxes.filter((b) => ids.has(b.a) && ids.has(b.b));
  if (selectedBox !== null && selectedBox >= drawing.boxes.length) selectedBox = null;
  let res;
  try {
    res = knots.analyze(drawing);
  } catch (e) {
    loadKnots().then((k) => (knots = k));
    res = { error: `internal error (${e})` };
  }
  if (res.error) {
    analysis = null;
    return res.error;
  }
  analysis = res;
  return null;
}

// ---------------------------------------------------------------- rendering

const svg = $("canvas");
function el(name, attrs = {}, parent = svg) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent.appendChild(e);
  return e;
}

function segmentById() {
  const map = new Map();
  drawing.components.forEach((poly, c) =>
    poly.forEach((v, k) => map.set(v.id, { c, p: v, q: poly[(k + 1) % poly.length] })),
  );
  return map;
}

function render() {
  const err = pdSource ? null : analyze();
  svg.replaceChildren();
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  const banner = $("banner");
  if (pdSource) {
    banner.hidden = false;
    banner.textContent = "Showing invariants of the PD code you entered (no picture). Draw or load a braid to edit.";
  } else if (err) {
    banner.hidden = false;
    banner.textContent = err;
  } else banner.hidden = true;

  const segs = segmentById();
  drawing.components.forEach((poly, c) => {
    const color = COLORS[c % COLORS.length];
    el("polygon", {
      points: poly.map((v) => `${v.x},${v.y}`).join(" "),
      class: "strand",
      stroke: color,
    });
    // orientation arrow on the longest segment
    let best = 0;
    let bestLen = -1;
    poly.forEach((v, k) => {
      const w = poly[(k + 1) % poly.length];
      const len = Math.hypot(w.x - v.x, w.y - v.y);
      if (len > bestLen) [best, bestLen] = [k, len];
    });
    const a = poly[best];
    const b = poly[(best + 1) % poly.length];
    arrow(a, b, color);
  });
  // over-strands on top: a halo, then the strand again
  if (analysis) {
    for (const x of analysis.crossings) {
      const s = segs.get(x.over);
      if (!s) continue;
      const dx = s.q.x - s.p.x;
      const dy = s.q.y - s.p.y;
      const len = Math.hypot(dx, dy) || 1;
      const L = Math.min(14 / zoom(), len / 2);
      const p1 = { x: x.x - (dx / len) * L, y: x.y - (dy / len) * L };
      const p2 = { x: x.x + (dx / len) * L, y: x.y + (dy / len) * L };
      el("line", { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: "halo" });
      el("line", {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        class: "strand",
        stroke: COLORS[s.c % COLORS.length],
      });
    }
  }
  drawing.boxes.forEach((b, i) => drawBox(b, i, segs));
  if (twistPick !== null && segs.get(twistPick)) {
    const s = segs.get(twistPick);
    el("line", { x1: s.p.x, y1: s.p.y, x2: s.q.x, y2: s.q.y, class: "pick" });
  }
  updateBoxPanel();
  if (mode === "edit") {
    if (analysis) {
      for (const x of analysis.crossings) {
        const m = el("circle", { cx: x.x, cy: x.y, r: 12 / zoom(), class: "xmark" });
        m.dataset.crossing = JSON.stringify([x.a, x.b, x.over]);
        el("title", {}, m).textContent = `crossing (${x.sign > 0 ? "+" : "−"}); click to flip`;
      }
    }
    drawing.components.forEach((poly, c) =>
      poly.forEach((v) => {
        const h = el("circle", {
          cx: v.x, cy: v.y, r: 4.5 / zoom(),
          class: "vertex",
          stroke: COLORS[c % COLORS.length],
        });
        h.dataset.vertex = v.id;
      }),
    );
  }
  if (pending) {
    const color = COLORS[drawing.components.length % COLORS.length];
    if (pending.points.length) {
      const pts = [...pending.points, pending.cursor].filter(Boolean);
      el("polyline", { points: pts.map((v) => `${v.x},${v.y}`).join(" "), class: "pending" });
      pending.points.forEach((v, i) =>
        el("circle", {
          cx: v.x, cy: v.y, r: (i === 0 ? 7 : 4) / zoom(),
          class: "vertex",
          stroke: color,
          fill: i === 0 && pending.points.length >= 3 ? color : "#fff",
        }),
      );
    }
  }
  $("hint").textContent =
    mode === "draw"
      ? "Draw: click to place vertices; click the first vertex (or press Enter) to close the component. Esc cancels."
      : mode === "twist"
        ? "Twist box: click two neighboring strands (no strand between them). The box sits at their midpoints; + and − change the twists."
        : "Edit: drag vertices · click a crossing to flip it · click a box to change it · double-click a strand to add a vertex · Alt-click a vertex to delete it.";
}

// a twist box: a rectangle across the midpoints of its two strands, with
// the number of half-twists or the twists themselves.  Looking along strand
// a, the strand coming from the left passes over when n > 0 (as in Rust).
function boxFrame(b, segs) {
  const sa = segs.get(b.a);
  const sb = segs.get(b.b);
  if (!sa || !sb) return null;
  const mid = (s) => ({ x: (s.p.x + s.q.x) / 2, y: (s.p.y + s.q.y) / 2 });
  const P = mid(sa);
  const Q = mid(sb);
  const ux = sa.q.x - sa.p.x;
  const uy = sa.q.y - sa.p.y;
  const ul = Math.hypot(ux, uy) || 1;
  const U = { x: ux / ul, y: uy / ul };
  const Lv = { x: U.y, y: -U.x }; // the viewer's left of U (screen y points down)
  const C = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
  const la = (P.x - C.x) * Lv.x + (P.y - C.y) * Lv.y;
  const pt = (s, l) => ({ x: C.x + s * U.x + l * Lv.x, y: C.y + s * U.y + l * Lv.y });
  return { sa, sb, C, la, lb: -la, pt };
}

function drawBox(b, i, segs) {
  const f = boxFrame(b, segs);
  if (!f) return;
  const z = zoom();
  const k = Math.abs(b.n);
  const hw = Math.abs(f.la) + 10 / z;
  const lenA = Math.hypot(f.sa.q.x - f.sa.p.x, f.sa.q.y - f.sa.p.y);
  // roughly square crossings, within the strand
  const hh = showTwists ? Math.min(0.45 * lenA, Math.max(14 / z, k * Math.max(9 / z, 0.45 * hw))) : 13 / z;
  const corners = [f.pt(-hh, -hw), f.pt(hh, -hw), f.pt(hh, hw), f.pt(-hh, hw)];
  const r = el("polygon", {
    points: corners.map((p) => `${p.x},${p.y}`).join(" "),
    class: "tbox" + (i === selectedBox ? " sel" : ""),
  });
  r.dataset.box = i;
  el("title", {}, r).textContent = `twist box: ${b.n} half-twists`;
  if (showTwists && k > 0) {
    const lL = Math.max(f.la, f.lb);
    const lR = Math.min(f.la, f.lb);
    let leftColor = COLORS[(f.la > f.lb ? f.sa : f.sb).c % COLORS.length];
    let rightColor = COLORS[(f.la > f.lb ? f.sb : f.sa).c % COLORS.length];
    for (let j = 0; j < k; j++) {
      const s0 = -hh + (2 * hh * j) / k;
      const s1 = -hh + (2 * hh * (j + 1)) / k;
      const lr = [f.pt(s0, lL), f.pt(s1, lR)]; // left to right
      const rl = [f.pt(s0, lR), f.pt(s1, lL)]; // right to left
      const [over, overColor, under, underColor] =
        b.n > 0 ? [lr, leftColor, rl, rightColor] : [rl, rightColor, lr, leftColor];
      const line = (seg, cls, color) => {
        const a = el("line", { x1: seg[0].x, y1: seg[0].y, x2: seg[1].x, y2: seg[1].y, class: cls });
        if (color) a.setAttribute("stroke", color);
        a.style.pointerEvents = "none";
      };
      line(under, "strand", underColor);
      line(over, "halo");
      line(over, "strand", overColor);
      [leftColor, rightColor] = [rightColor, leftColor];
    }
  } else {
    const t = el("text", { x: f.C.x, y: f.C.y, class: "tlabel", "font-size": 13 / z });
    t.textContent = fmtInt(b.n);
  }
}

function updateBoxPanel() {
  const panel = $("box-panel");
  const b = selectedBox !== null ? drawing.boxes[selectedBox] : null;
  panel.hidden = !b;
  $("hint").classList.toggle("with-panel", !!b);
  $("family-card").hidden = !b;
  if (!b) return;
  if (document.activeElement !== $("box-n")) $("box-n").value = b.n;
  $("box-show").checked = showTwists;
}

function setBoxN(n) {
  const b = drawing.boxes[selectedBox];
  if (!b || !Number.isInteger(n)) return;
  b.n = Math.max(-60, Math.min(60, n));
  commit();
  changed();
}

function selectBox(i) {
  const changedSel = selectedBox !== i;
  selectedBox = i;
  if (i !== null && changedSel) {
    const n = drawing.boxes[i].n;
    $("fam-from").value = n - 3;
    $("fam-to").value = n + 3;
    $("family").innerHTML = "";
    $("fam-status").textContent = "";
  }
  render();
}

function nearestSegment(p) {
  let best = null;
  drawing.components.forEach((poly) =>
    poly.forEach((v, k) => {
      const w = poly[(k + 1) % poly.length];
      const dx = w.x - v.x;
      const dy = w.y - v.y;
      const t = Math.max(0, Math.min(1, ((p.x - v.x) * dx + (p.y - v.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(v.x + t * dx - p.x, v.y + t * dy - p.y);
      if (!best || d < best.d) best = { d, id: v.id };
    }),
  );
  return best && best.d < 12 / zoom() ? best.id : null;
}

function arrow(a, b, color) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const s = 9 / zoom();
  const pts = [
    [mx + s * Math.cos(ang), my + s * Math.sin(ang)],
    [mx + s * Math.cos(ang + 2.5), my + s * Math.sin(ang + 2.5)],
    [mx + s * Math.cos(ang - 2.5), my + s * Math.sin(ang - 2.5)],
  ];
  el("polygon", { points: pts.map((p) => p.join(",")).join(" "), class: "arrow", fill: color });
}

// ---------------------------------------------------------------- editing

// screen → drawing coordinates, and the zoom (screen pixels per unit)
function point(e) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const q = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: q.x, y: q.y };
}
const zoom = () => svg.getScreenCTM()?.a || 1;

function setMode(m) {
  twistPick = null;
  if (m !== "draw") pending = null;
  else pending = pending || { points: [], cursor: null };
  mode = m;
  document.querySelectorAll("button.mode").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  svg.classList.toggle("draw", m === "draw");
  render();
}

function closePending() {
  if (!pending || pending.points.length < 3) return;
  drawing.components.push(pending.points.map((p) => ({ id: nextId(), x: p.x, y: p.y })));
  pdSource = null;
  pending = { points: [], cursor: null };
  commit();
  changed();
}

let drag = null;
svg.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const p = point(e);
  if (mode === "draw") {
    const pts = pending.points;
    if (pts.length >= 3 && Math.hypot(p.x - pts[0].x, p.y - pts[0].y) < 12 / zoom()) closePending();
    else {
      pts.push(p);
      render();
    }
    return;
  }
  const t = e.target;
  if (t.dataset.box !== undefined) {
    selectBox(Number(t.dataset.box));
    return;
  }
  if (mode === "twist") {
    const id = nearestSegment(p);
    if (id === null) {
      twistPick = null;
      return render();
    }
    const inBox = (s) => drawing.boxes.some((b) => b.a === s || b.b === s);
    if (inBox(id)) return flash("That strand already has a twist box; add a vertex to split it.");
    if (twistPick === null || twistPick === id) {
      twistPick = id;
      return render();
    }
    drawing.boxes.push({ a: twistPick, b: id, n: 1 });
    twistPick = null;
    commit();
    setMode("edit");
    selectBox(drawing.boxes.length - 1);
    changed();
    return;
  }
  if (selectedBox !== null && !t.dataset.vertex && !t.dataset.crossing) selectBox(null);
  if (t.dataset.vertex) {
    const id = Number(t.dataset.vertex);
    if (e.altKey) return deleteVertex(id);
    drag = { id, moved: false };
    svg.setPointerCapture(e.pointerId);
  } else if (t.dataset.crossing) {
    flip(JSON.parse(t.dataset.crossing));
  }
});

svg.addEventListener("pointermove", (e) => {
  const p = point(e);
  if (mode === "draw" && pending) {
    pending.cursor = p;
    render();
    return;
  }
  if (!drag) return;
  for (const poly of drawing.components)
    for (const v of poly)
      if (v.id === drag.id) {
        v.x = p.x;
        v.y = p.y;
      }
  drag.moved = true;
  changed();
});

svg.addEventListener("pointerup", () => {
  if (drag?.moved) commit();
  drag = null;
});

svg.addEventListener("dblclick", (e) => {
  if (mode !== "edit") return;
  const p = point(e);
  // insert a vertex on the nearest segment
  let best = null;
  drawing.components.forEach((poly) =>
    poly.forEach((v, k) => {
      const w = poly[(k + 1) % poly.length];
      const dx = w.x - v.x;
      const dy = w.y - v.y;
      const t = Math.max(0, Math.min(1, ((p.x - v.x) * dx + (p.y - v.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(v.x + t * dx - p.x, v.y + t * dy - p.y);
      if (!best || d < best.d) best = { d, poly, k, x: v.x + t * dx, y: v.y + t * dy };
    }),
  );
  if (best && best.d < 10 / zoom()) {
    best.poly.splice(best.k + 1, 0, { id: nextId(), x: best.x, y: best.y });
    commit();
    changed();
  }
});

svg.addEventListener("contextmenu", (e) => {
  if (mode === "draw") {
    e.preventDefault();
    pending = { points: [], cursor: null };
    render();
  }
});

function deleteVertex(id) {
  const c = drawing.components.findIndex((poly) => poly.some((v) => v.id === id));
  if (c < 0) return;
  if (drawing.components[c].length <= 3) drawing.components.splice(c, 1);
  else drawing.components[c] = drawing.components[c].filter((v) => v.id !== id);
  commit();
  changed();
}

function flip([a, b, over]) {
  const key = (x, y) => `${Math.min(x, y)}:${Math.max(x, y)}`;
  drawing.over = drawing.over.filter(([x, y]) => key(x, y) !== key(a, b));
  drawing.over.push([a, b, over === a ? b : a]);
  commit();
  changed();
}

function pruneOver() {
  if (!analysis) return;
  const live = new Set(analysis.crossings.map((x) => `${Math.min(x.a, x.b)}:${Math.max(x.a, x.b)}`));
  drawing.over = analysis.crossings.map((x) => [x.a, x.b, x.over]).filter(([a, b]) => live.has(`${Math.min(a, b)}:${Math.max(a, b)}`));
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "Z"))) { e.preventDefault(); redo(); }
  else if (e.key === "Escape" && mode === "draw") { pending = { points: [], cursor: null }; render(); }
  else if (e.key === "Enter" && mode === "draw") closePending();
  else if (e.key === "d") setMode("draw");
  else if (e.key === "t") setMode("twist");
  else if (selectedBox !== null && (e.key === "+" || e.key === "=")) setBoxN(drawing.boxes[selectedBox].n + 1);
  else if (selectedBox !== null && e.key === "-") setBoxN(drawing.boxes[selectedBox].n - 1);
  else if (selectedBox !== null && (e.key === "Delete" || e.key === "Backspace")) removeBox();
  else if (e.key === "e") setMode("edit");
});

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

function updateButtons() {
  $("undo").disabled = !undoStack.length;
  $("redo").disabled = !redoStack.length;
  const has = drawing.components.length > 0 && !pdSource;
  for (const id of ["alternate", "mirror", "reverse", "tidy", "fit", "svg"]) $(id).disabled = !has;
}

// toolbar
document.querySelectorAll("button.mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("undo").onclick = undo;
$("redo").onclick = redo;
function removeBox() {
  drawing.boxes.splice(selectedBox, 1);
  selectedBox = null;
  commit();
  changed();
}
$("box-minus").onclick = () => setBoxN(drawing.boxes[selectedBox].n - 1);
$("box-plus").onclick = () => setBoxN(drawing.boxes[selectedBox].n + 1);
$("box-n").onchange = () => setBoxN(Number($("box-n").value));
$("box-delete").onclick = removeBox;
$("box-show").onchange = () => {
  showTwists = $("box-show").checked;
  render();
};

/** Replaces the drawing by the automatic layout of a PD code. */
function drawPD(pd, freeLoops) {
  const res = knots.layout({ pd, free_loops: freeLoops, view, first_id: idCounter });
  if (res.error) return res.error;
  drawing = res.drawing;
  drawing.boxes ||= [];
  idCounter = res.next_id;
  pdSource = null;
  selectedBox = null;
  return null;
}

$("tidy").onclick = () => {
  if (!analysis) return;
  if (drawing.boxes.length && !confirm("Tidy redraws the diagram with every twist box expanded into crossings. Continue?")) return;
  const err = drawPD(analysis.pd, analysis.free_loops);
  if (err) return flash(err);
  commit();
  setMode("edit");
  changed();
};

$("clear").onclick = () => {
  drawing = { components: [], over: [], boxes: [] };
  pdSource = null;
  commit();
  changed();
  setMode("draw");
};
$("alternate").onclick = async () => {
  const res = await guarded(() => knots.alternating(drawing));
  if (res.error) return flash(res.error);
  drawing.over = res.over;
  commit();
  changed();
};
$("mirror").onclick = () => {
  if (!analysis) return;
  pruneOver();
  drawing.over = drawing.over.map(([a, b, o]) => [a, b, o === a ? b : a]);
  for (const b of drawing.boxes) b.n = -b.n;
  commit();
  changed();
};
$("reverse").onclick = () => {
  if (!analysis) return;
  pruneOver();
  // reversing a polygon changes which vertex starts each segment: re-key
  const segs = segmentById();
  const endOf = (id) => segs.get(id).q.id; // after reversal, the segment starts at its old end
  drawing.over = drawing.over.map(([a, b, o]) => [endOf(a), endOf(b), endOf(o)]);
  drawing.boxes = drawing.boxes.map((b) => ({ a: endOf(b.a), b: endOf(b.b), n: b.n }));
  drawing.components = drawing.components.map((poly) => [...poly].reverse());
  commit();
  changed();
};
$("fit").onclick = () => {
  fitView();
  render();
};
$("share").onclick = async () => {
  const url = `${location.origin}${location.pathname}#d=${encodeState()}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    flash("Link copied to the clipboard.");
  } catch {
    flash("Link is in the address bar.");
  }
};
$("svg").onclick = () => {
  const clone = svg.cloneNode(true);
  clone.querySelectorAll(".vertex, .xmark, .pending").forEach((n) => n.remove());
  clone.setAttribute("xmlns", SVGNS);
  const style = `<style>.strand{fill:none;stroke-width:3.2;stroke-linejoin:round;stroke-linecap:round}.halo{fill:none;stroke:#fff;stroke-width:13}</style>`;
  const text = clone.outerHTML.replace(/<svg([^>]*)>/, `<svg$1>${style}`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
  a.download = "knot.svg";
  a.click();
};

/** Zooms the view to the drawing's bounding box. */
function fitView() {
  const pts = drawing.components.flat();
  if (!pts.length) return;
  const [x0, x1] = [Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x))];
  const [y0, y1] = [Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y))];
  const pad = 0.08 * Math.max(x1 - x0, y1 - y0, 50);
  view = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  localStorage.setItem("knot-workbench-view", JSON.stringify(view));
}

let flashTimer = 0;
function flash(msg) {
  const b = $("banner");
  b.hidden = false;
  b.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => render(), 2600);
}

// ---------------------------------------------------------------- braids, table, PD

function generatorButtons() {
  const n = Number($("strands").value);
  const box = $("generators");
  box.replaceChildren();
  for (let i = 1; i < n; i++)
    for (const s of [1, -1]) {
      const b = document.createElement("button");
      b.innerHTML = `σ<sub>${i}</sub>${s < 0 ? "<sup>−1</sup>" : ""}`;
      b.title = s > 0 ? `σ${i}: strand ${i} over strand ${i + 1}` : `σ${i}⁻¹`;
      b.onclick = () => {
        const w = $("word").value.trim();
        $("word").value = (w ? w + " " : "") + String(s * i);
        drawBraid();
      };
      box.appendChild(b);
    }
}

function drawBraid() {
  const n = Number($("strands").value);
  let word;
  try {
    word = parseWord($("word").value, n);
  } catch (err) {
    return flash(err.message);
  }
  drawing = braidDrawing(n, word, view, nextId);
  pdSource = null;
  commit($("library").value !== "" && $("word").value.trim() === table.find((t) => t.name === $("library").value)?.word.join(" "));
  setMode("edit");
  changed();
}

$("strands").onchange = () => {
  const n = Math.max(2, Math.min(8, Number($("strands").value) || 2));
  $("strands").value = n;
  generatorButtons();
};
$("draw-braid").onclick = drawBraid;
$("word").addEventListener("keydown", (e) => e.key === "Enter" && drawBraid());
$("clear-word").onclick = () => {
  $("word").value = "";
};
$("library").onchange = () => {
  const entry = table.find((t) => t.name === $("library").value);
  if (!entry) return;
  if (entry.name === "0_1") {
    const c = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    const R = Math.min(view.w, view.h) * 0.3;
    drawing = {
      components: [[...Array(6).keys()].map((k) => ({ id: nextId(), x: c.x + R * Math.cos(k * Math.PI / 3), y: c.y + R * Math.sin(k * Math.PI / 3) }))],
      over: [],
      boxes: [],
    };
    pdSource = null;
    commit(true);
    setMode("edit");
    return changed();
  }
  $("strands").value = entry.strands;
  generatorButtons();
  $("word").value = entry.word.join(" ");
  const err = drawPD(entry.pd, 0);
  if (err) return drawBraid();
  commit(true);
  setMode("edit");
  changed();
};
$("use-pd").onclick = () => {
  const nums = ($("pd-input").value.match(/-?\d+/g) || []).map(Number);
  if (!nums.length || nums.length % 4) return flash("A PD code is a list of X[a,b,c,d] with four labels each.");
  const pd = [];
  for (let i = 0; i < nums.length; i += 4) pd.push(nums.slice(i, i + 4));
  const err = drawPD(pd, 0);
  if (err) {
    // not drawable (or not valid): show what the code alone gives
    pdSource = { pd, free_loops: 0 };
    flash(err);
  }
  commit();
  setMode("edit");
  changed();
};
$("prime").onchange = requestBasic;

// ---------------------------------------------------------------- results

function polyHTML(p) {
  if (!p || !p.terms.length) return "0";
  const v = p.var;
  return p.terms
    .map(([num, den, c], i) => {
      const neg = c.startsWith("-");
      const mag = neg ? c.slice(1) : c;
      const g = gcd(Math.abs(num), den);
      const [n, d] = [num / g, den / g];
      const exp = n === 0 ? "" : d === 1 ? (n === 1 ? "" : `<sup>${fmtInt(n)}</sup>`) : `<sup>${fmtInt(n)}/${d}</sup>`;
      const mono = n === 0 ? "" : `<i>${v}</i>${exp}`;
      const coef = mag === "1" && mono ? "" : mag;
      const sign = i === 0 ? (neg ? "−" : "") : neg ? " − " : " + ";
      return sign + coef + mono;
    })
    .join("");
}
const fmtInt = (n) => (n < 0 ? "−" + -n : String(n));
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

function stat(k, v) {
  return `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}

function showEmpty() {
  $("stats").innerHTML = "";
  $("ident").textContent = "Draw a component or pick a knot from the table.";
  for (const id of ["jones", "alexander", "conway", "colorings", "cover", "linking", "pd"]) $(id).textContent = "";
}

function showBasic(res, req) {
  document.querySelector(".results").classList.remove("stale");
  if (res.error) {
    $("ident").innerHTML = `<span class="err">${escapeHTML(res.error)}</span>`;
    return;
  }
  const sig = res.signature.Ok ?? "—";
  $("stats").innerHTML =
    stat("crossings", res.crossings) +
    stat("components", res.components) +
    stat("writhe", fmtInt(res.writhe)) +
    stat("determinant", res.determinant) +
    stat("signature", typeof sig === "number" ? fmtInt(sig) : sig);
  $("jones").innerHTML = polyHTML(res.jones);
  $("alexander").innerHTML = polyHTML(res.alexander);
  $("alex-note").textContent = res.alexander_note;
  $("conway-card").hidden = !res.conway;
  if (res.conway) $("conway").innerHTML = polyHTML(res.conway);
  $("colorings").textContent =
    res.colorings.Ok !== undefined ? `${res.colorings.Ok} (${res.p}-colorings, trivial ones included)` : res.colorings.Err;
  $("cover").innerHTML = coverHTML(res.double_cover);
  $("linking-card").hidden = res.components < 2;
  $("linking").innerHTML =
    `<table class="matrix">` +
    res.linking.map((row) => `<tr>${row.map((x) => `<td>${fmtInt(x)}</td>`).join("")}</tr>`).join("") +
    `</table>`;
  $("pd").textContent = res.pd.length ? res.pd.map((x) => `X[${x.join(",")}]`).join(", ") : "(no crossings)";
  identify(res);
}

function coverHTML(factors) {
  if (!factors.length) return "0 (trivial)";
  return factors.map((f) => (f === "0" ? "ℤ" : `ℤ/${f}`)).join(" ⊕ ");
}

function identify(res) {
  const j = res.jones.text;
  const hits = [];
  for (const t of table) {
    if (t.components !== res.components) continue;
    if (t.jones === j && t.alexander === res.alexander.text) hits.push(`<strong>${t.name}</strong>`);
    else if (t.jones_mirror === j && t.alexander === res.alexander.text) hits.push(`<strong>${t.name}</strong> (mirror)`);
  }
  const what = res.components === 1 ? "knot" : `${res.components}-component link`;
  $("ident").innerHTML = hits.length
    ? `A ${what} whose Jones and Alexander polynomials match ${hits.join(", ")}.`
    : `A ${what} with ${res.crossings} crossings in this diagram${res.components === 1 && j === "1" ? " (Jones polynomial 1, as for the unknot)" : ""}.`;
}

function escapeHTML(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function clearHeavyPanels() {
  $("khovanov").innerHTML = "";
  $("kh-status").textContent = "";
  $("homs").textContent = "";
  if (heavy.worker) {
    heavy.worker.terminate();
    heavy.worker = null;
    $("kh-cancel").hidden = true;
    $("homs-cancel").hidden = true;
  }
}

$("kh-go").onclick = () => {
  const req = currentRequest("khovanov", { ring: $("ring").value });
  if (!req) return;
  $("khovanov").innerHTML = "";
  $("kh-status").textContent = `computing (${req.pd.length} crossings, 2^${req.pd.length} states)…`;
  const t0 = performance.now();
  runHeavy(req, (res) => {
    if (res.canceled) return ($("kh-status").textContent = "canceled");
    if (res.error) return ($("kh-status").innerHTML = `<span class="err">${escapeHTML(res.error)}</span>`);
    $("kh-status").textContent = `total rank ${res.total} · ${((performance.now() - t0) / 1000).toFixed(2)} s`;
    $("khovanov").innerHTML = khovanovTable(res, req.ring);
  }, $("kh-cancel"));
};

function khovanovTable(res, ring) {
  if (!res.ranks.length && !res.torsion.length) return "<p class='note'>zero</p>";
  const cells = new Map();
  const add = (h, q, s, cls) => {
    const k = `${h},${q}`;
    const c = cells.get(k) || { parts: [], cls: "" };
    c.parts.push(s);
    c.cls = c.cls || cls;
    cells.set(k, c);
  };
  const field = ring === "Z" ? "ℤ" : `𝔽<sub>${ring}</sub>`;
  for (const [h, q, r] of res.ranks) add(h, q, r === 1 ? field : `${field}<sup>${r}</sup>`, "nz");
  for (const [h, q, ts] of res.torsion) for (const t of ts) add(h, q, `ℤ/${t}`, "tor");
  const hs = [...res.ranks, ...res.torsion].map((x) => x[0]);
  const qs = [...res.ranks, ...res.torsion].map((x) => x[1]);
  const [h0, h1] = [Math.min(...hs), Math.max(...hs)];
  const [q0, q1] = [Math.min(...qs), Math.max(...qs)];
  let html = `<table class="kh"><tr><th>q \\ h</th>`;
  for (let h = h0; h <= h1; h++) html += `<th>${fmtInt(h)}</th>`;
  html += "</tr>";
  for (let q = q1; q >= q0; q -= 1) {
    if ((q - q0) % 2) continue; // q has one parity per link
    html += `<tr><th>${fmtInt(q)}</th>`;
    for (let h = h0; h <= h1; h++) {
      const c = cells.get(`${h},${q}`);
      html += c ? `<td class="${c.cls}">${c.parts.join(" ⊕ ")}</td>` : "<td></td>";
    }
    html += "</tr>";
  }
  return html + "</table>";
}

$("homs-go").onclick = () => {
  const req = currentRequest("homs", { m: Number($("sym-m").value), transitive: $("sym-trans").checked });
  if (!req) return;
  $("homs").textContent = "counting…";
  runHeavy(req, (res) => {
    if (res.canceled) return ($("homs").textContent = "canceled");
    if (res.error) return ($("homs").innerHTML = `<span class="err">${escapeHTML(res.error)}</span>`);
    $("homs").innerHTML = `${res.count} homomorphisms to <i>S</i><sub>${res.m}</sub>${res.transitive ? " with transitive image" : ""}`;
  }, $("homs-cancel"));
};

function tableMatch(jones, alexander, components) {
  for (const t of table) {
    if (t.components !== components || t.alexander !== alexander) continue;
    if (t.jones === jones) return t.name;
    if (t.jones_mirror === jones) return `${t.name} (mirror)`;
  }
  return "";
}

$("fam-go").onclick = () => {
  if (selectedBox === null) return;
  let lo = Number($("fam-from").value);
  let hi = Number($("fam-to").value);
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return;
  if (lo > hi) [lo, hi] = [hi, lo];
  hi = Math.min(hi, lo + 40);
  const items = [];
  for (let n = lo; n <= hi; n++) {
    const d = JSON.parse(JSON.stringify(drawing));
    d.boxes[selectedBox].n = n;
    const a = knots.analyze(d);
    items.push(a.error ? { label: String(n), pd: [], free_loops: 1 } : { label: String(n), pd: a.pd, free_loops: a.free_loops });
  }
  $("fam-status").textContent = `computing ${items.length} diagrams…`;
  $("family").innerHTML = "";
  runHeavy({ task: "family", items }, (res) => {
    if (res.canceled) return ($("fam-status").textContent = "canceled");
    if (res.error) return ($("fam-status").innerHTML = `<span class="err">${escapeHTML(res.error)}</span>`);
    $("fam-status").textContent = "";
    let html = `<table class="fam"><tr><th>n</th><th>crossings</th><th>det</th><th>σ</th><th>Δ(t)</th><th>V(t)</th><th>matches</th></tr>`;
    for (const r of res) {
      if (r.error) {
        html += `<tr><td>${fmtInt(Number(r.label))}</td><td colspan="6" class="err">${escapeHTML(r.error)}</td></tr>`;
        continue;
      }
      const what = r.components > 1 ? ` <span class="note">(${r.components} comp.)</span>` : "";
      html += `<tr><td>${fmtInt(Number(r.label))}</td><td>${r.crossings}${what}</td><td>${r.determinant}</td>` +
        `<td>${r.signature === null ? "—" : fmtInt(r.signature)}</td><td class="poly">${polyHTML(r.alexander)}</td>` +
        `<td class="poly">${polyHTML(r.jones)}</td><td>${tableMatch(r.jones.text, r.alexander.text, r.components)}</td></tr>`;
    }
    $("family").innerHTML = html + "</table>";
  }, $("fam-cancel"));
};

$("copy-pd").onclick = () => navigator.clipboard?.writeText($("pd").textContent);

// ---------------------------------------------------------------- persistence

function encodeState() {
  const compact = {
    c: drawing.components.map((poly) => poly.map((v) => [v.id, Math.round(v.x), Math.round(v.y)])),
    o: drawing.over,
    b: drawing.boxes.map((b) => [b.a, b.b, b.n]),
  };
  return btoa(JSON.stringify(compact)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeState(s) {
  const o = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  return {
    components: o.c.map((poly) => poly.map(([id, x, y]) => ({ id, x, y }))),
    over: o.o || [],
    boxes: (o.b || []).map(([a, b, n]) => ({ a, b, n })),
  };
}
function saveLocal() {
  try {
    localStorage.setItem("knot-workbench", snapshot());
  } catch {}
}

// ---------------------------------------------------------------- start

async function main() {
  knots = await loadKnots();
  table = knots.table();
  for (const t of table) {
    const o = document.createElement("option");
    o.value = t.name;
    o.textContent = t.name;
    $("library").appendChild(o);
  }
  generatorButtons();
  const r = svg.getBoundingClientRect();
  view = { x: 0, y: 0, w: r.width, h: r.height };
  try {
    view = JSON.parse(localStorage.getItem("knot-workbench-view")) || view;
  } catch {}
  new ResizeObserver(() => render()).observe(svg);
  const hash = location.hash.match(/#d=([\w-]+)/);
  const saved = localStorage.getItem("knot-workbench");
  try {
    if (hash) {
      drawing = decodeState(hash[1]);
      lastCommitted = snapshot();
      fitView();
    } else if (saved) restore(saved);
  } catch {
    drawing = { components: [], over: [] };
  }
  for (const c of drawing.components) for (const v of c) idCounter = Math.max(idCounter, v.id + 1);
  setMode("edit");
  if (!drawing.components.length && !pdSource) {
    $("library").value = "3_1";
    $("library").onchange();
  } else changed();
}
main();
