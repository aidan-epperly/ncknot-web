// Knot Workbench: the editor, the rendering and the invariant panels.
import { loadKnots } from "./knot.js";
import { braidDrawing, parseWord } from "./braid.js";

const COLORS = ["#2f5fd0", "#d1495b", "#0f9b6c", "#b06ab3", "#e08a00", "#3a9fc0", "#6b7280"];
const SVGNS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state

let drawing = { components: [], over: [], boxes: [] }; // what the user edits
let selectedBox = null; // index into drawing.boxes
let selection = new Set(); // strands (segment ids) selected in twist-box mode
let params = {}; // parameter values, e.g. { n: 3, m: 2 }
let showStrands = false; // draw bundles as their parallel copies
let computeAnalysis = null; // analysis of the expanded diagram (what the invariants use)
let band = null; // rubber-band rectangle while selecting
let showTwists = false;
let pending = null; // vertices of a component being drawn
let mode = "edit";
let view = { x: 0, y: 0, w: 800, h: 560 }; // drawing coordinates shown by the canvas
let analysis = null; // last successful analyze_drawing
let lastAnalysis = null; // the last valid one, kept through degenerate frames of a drag
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
  return JSON.stringify({ drawing, pdSource, params });
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
  analysis = lastAnalysis = null; // a new drawing: no choices to carry over
  drawing = o.drawing;
  drawing.boxes = normBoxes(drawing.boxes);
  if (o.params) params = o.params;
  renderParams();
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
  if (!computeAnalysis) return null;
  return { task, pd: computeAnalysis.pd, free_loops: computeAnalysis.free_loops, ...extra };
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
  drawing.boxes = drawing.boxes.filter((b) => b.segs.every((s) => ids.has(s)));
  if (selectedBox !== null && selectedBox >= drawing.boxes.length) selectedBox = null;
  let shown;
  let full;
  try {
    shown = concreteDrawing(false);
    full = concreteDrawing(true);
  } catch (e) {
    analysis = computeAnalysis = null;
    return e.message;
  }
  let res;
  try {
    res = knots.analyze(shown);
  } catch (e) {
    loadKnots().then((k) => (knots = k));
    res = { error: `internal error (${e})` };
  }
  if (res.error) {
    analysis = computeAnalysis = null;
    return res.error;
  }
  if (carryChoices(lastAnalysis, res)) {
    // re-analyse with the carried choices
    shown.over = drawing.over;
    full.over = drawing.over;
    try {
      res = knots.analyze(shown);
    } catch (e) {
      res = { error: `internal error (${e})` };
    }
    if (res.error) {
      analysis = computeAnalysis = null;
      return res.error;
    }
  }
  analysis = lastAnalysis = res;
  computeAnalysis = res;
  if (needsExpansion()) {
    let exp;
    try {
      exp = knots.analyze(full);
    } catch (e) {
      loadKnots().then((k) => (knots = k));
      exp = { error: `internal error (${e})` };
    }
    computeAnalysis = exp.error ? null : exp;
    if (exp.error) return exp.error;
  }
  return null;
}

// ---------------------------------------------------------------- parameters, bundles

/** Evaluates an integer expression in the parameters: + − * ( ), integers, names. */
function evalExpr(text) {
  const src = String(text).trim();
  const tokens = src.match(/\d+|[A-Za-z_][A-Za-z_0-9]*|[-+*()]|\S/g) || [];
  let i = 0;
  const fail = (msg) => {
    throw new Error(`"${src}": ${msg}`);
  };
  const factor = () => {
    const t = tokens[i++];
    if (t === undefined) fail("incomplete expression");
    if (t === "-") return -factor();
    if (t === "(") {
      const v = sum();
      if (tokens[i++] !== ")") fail("missing )");
      return v;
    }
    if (/^\d+$/.test(t)) return Number(t);
    if (/^[A-Za-z_]/.test(t)) {
      if (!(t in params)) fail(`unknown parameter ${t}`);
      return params[t];
    }
    fail(`unexpected ${t}`);
  };
  const product = () => {
    let v = factor();
    while (tokens[i] === "*") {
      i++;
      v *= factor();
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (tokens[i] === "+" || tokens[i] === "-") v = tokens[i++] === "+" ? v + product() : v - product();
    return v;
  };
  if (!tokens.length) fail("empty");
  const v = sum();
  if (i < tokens.length) fail(`unexpected ${tokens[i]}`);
  return v;
}

const multExpr = (c) => (drawing.mult && drawing.mult[c]) || "1";
const boxCount = (b) => (b.expr ? evalExpr(b.expr) : b.n);

function needsExpansion() {
  return drawing.components.some((_, c) => multExpr(c) !== "1") || drawing.boxes.some((b) => b.segs.length < 2);
}

/** The drawing with numbers for every expression: the drawn diagram (bundles
 *  as single strands, boxes on one drawn strand left out) or, with `full`,
 *  everything including multiplicities. */
function concreteDrawing(full) {
  const boxes = drawing.boxes
    .filter((b) => full || b.segs.length >= 2)
    .map((b) => ({ segs: b.segs, n: boxCount(b) }));
  const d = { components: drawing.components, over: drawing.over, boxes };
  if (full) {
    d.mult = drawing.components.map((_, c) => {
      const k = evalExpr(multExpr(c));
      if (!Number.isInteger(k) || k < 0 || k > 64) throw new Error(`multiplicity ${multExpr(c)} = ${k} is not between 0 and 64`);
      return k;
    });
  }
  return d;
}

function renderParams() {
  const box = $("params");
  box.replaceChildren();
  for (const name of Object.keys(params)) {
    const row = document.createElement("span");
    row.className = "param";
    row.innerHTML = `<i>${escapeHTML(name)}</i> = <input type="number" step="1" value="${params[name]}"><button title="decrease">−</button><button title="increase">+</button><button title="remove">×</button>`;
    const [input, minus, plus, remove] = row.querySelectorAll("input, button");
    const set = (v) => {
      if (!Number.isInteger(v)) return;
      params[name] = v;
      input.value = v;
      saveLocal();
      changed();
    };
    input.onchange = () => set(Number(input.value));
    minus.onclick = () => set(params[name] - 1);
    plus.onclick = () => set(params[name] + 1);
    remove.onclick = () => {
      delete params[name];
      renderParams();
      saveLocal();
      changed();
    };
    box.appendChild(row);
  }
  renderSweepRanges();
}

function renderSweepRanges() {
  const names = Object.keys(params);
  $("sweep-card").hidden = names.length === 0;
  const box = $("sweep-ranges");
  const old = {};
  box.querySelectorAll("label").forEach((l) => (old[l.dataset.name] = [l.children[1].value, l.children[2].value]));
  box.replaceChildren();
  for (const name of names) {
    const l = document.createElement("label");
    l.dataset.name = name;
    const [a, b] = old[name] || [params[name], params[name] + 3];
    l.innerHTML = `<i>${escapeHTML(name)}</i><input type="number" step="1" value="${a}" aria-label="${escapeHTML(name)} from"><input type="number" step="1" value="${b}" aria-label="${escapeHTML(name)} to">`;
    box.appendChild(l);
  }
}

$("param-add").onclick = () => {
  const name = $("param-name").value.trim();
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) return flash("A parameter name is a letter followed by letters or digits.");
  if (!(name in params)) params[name] = 1;
  $("param-name").value = "";
  renderParams();
  saveLocal();
  changed();
};
$("param-name").addEventListener("keydown", (e) => e.key === "Enter" && $("param-add").onclick());
$("show-strands").onchange = () => {
  showStrands = $("show-strands").checked;
  render();
};

$("sweep-go").onclick = () => {
  const names = Object.keys(params);
  const ranges = names.map((name) => {
    const l = $("sweep-ranges").querySelector(`label[data-name="${name}"]`);
    let lo = Number(l.children[1].value);
    let hi = Number(l.children[2].value);
    if (lo > hi) [lo, hi] = [hi, lo];
    return [name, lo, hi];
  });
  if (ranges.some(([, lo, hi]) => !Number.isInteger(lo) || !Number.isInteger(hi))) return;
  // every combination, at most 60
  let combos = [{}];
  for (const [name, lo, hi] of ranges) {
    const next = [];
    for (const c of combos) for (let v = lo; v <= hi; v++) next.push({ ...c, [name]: v });
    combos = next;
  }
  if (combos.length > 60) return flash(`${combos.length} combinations; narrow the ranges to at most 60.`);
  const saved = params;
  const items = combos.map((c) => {
    params = c;
    const label = names.map((n) => `${n}=${c[n]}`).join(", ");
    try {
      const a = knots.analyze(concreteDrawing(true));
      return a.error ? { label, pd: [], free_loops: 1, note: a.error } : { label, pd: a.pd, free_loops: a.free_loops };
    } catch (e) {
      return { label, pd: [], free_loops: 1, note: e.message };
    }
  });
  params = saved;
  $("sweep-status").textContent = `computing ${items.length} diagrams…`;
  $("sweep").innerHTML = "";
  runHeavy({ task: "family", items }, (res) => {
    if (res.canceled) return ($("sweep-status").textContent = "canceled");
    if (res.error) return ($("sweep-status").innerHTML = `<span class="err">${escapeHTML(res.error)}</span>`);
    $("sweep-status").textContent = "";
    $("sweep").innerHTML = familyTable(res, names.join(", "));
  }, $("sweep-cancel"));
};

/** The table of a family computation (one row per member). */
function familyTable(res, header) {
  let html = `<table class="fam"><tr><th>${escapeHTML(header)}</th><th>crossings</th><th>det</th><th>σ</th><th>Δ(t)</th><th>V(t)</th><th>matches</th></tr>`;
  for (const r of res) {
    if (r.error) {
      html += `<tr><td>${escapeHTML(r.label)}</td><td colspan="6" class="err">${escapeHTML(r.error)}</td></tr>`;
      continue;
    }
    const what = r.components > 1 ? ` <span class="note">(${r.components} comp.)</span>` : "";
    html += `<tr><td>${escapeHTML(r.label)}</td><td>${r.crossings}${what}</td><td>${r.determinant}</td>` +
      `<td>${r.signature === null ? "—" : fmtInt(r.signature)}</td><td class="poly">${polyHTML(r.alexander)}</td>` +
      `<td class="poly">${polyHTML(r.jones)}</td><td>${tableMatch(r.jones.text, r.alexander.text, r.components)}</td></tr>`;
  }
  return html + "</table>";
}

// A crossing's over/under choice is stored per pair of segments.  When an
// edit slides a crossing onto the next segment of a strand, its pair changes;
// carry the choice over from the matching crossing of the previous analysis
// (same two strands, segments at most two vertices apart, nearby).  Returns
// whether a choice was added.
function carryChoices(prev, next) {
  if (!prev || !next) return false;
  const where = new Map(); // vertex id -> [component, index, length]
  drawing.components.forEach((poly, c) => poly.forEach((v, k) => where.set(v.id, [c, k, poly.length])));
  const key = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  const chosen = new Set(drawing.over.map(([a, b]) => key(a, b)));
  const prevKeys = new Set(prev.crossings.map((x) => key(x.a, x.b)));
  const near = (s, t) => {
    const ws = where.get(s);
    const wt = where.get(t);
    if (!ws || !wt || ws[0] !== wt[0]) return false;
    const d = Math.abs(ws[1] - wt[1]);
    return Math.min(d, ws[2] - d) <= 2;
  };
  const used = new Set();
  let added = false;
  for (const x of next.crossings) {
    const k = key(x.a, x.b);
    if (chosen.has(k) || prevKeys.has(k)) continue; // stored, or unchanged
    let best = null;
    prev.crossings.forEach((y, i) => {
      if (used.has(i)) return;
      // pair x's segments with y's: (a↔a, b↔b) or swapped
      for (const [pa, pb] of [[y.a, y.b], [y.b, y.a]]) {
        if (near(x.a, pa) && near(x.b, pb)) {
          const d = Math.hypot(x.x - y.x, x.y - y.y);
          if (!best || d < best.d) best = { d, i, over: y.over === pa ? x.a : x.b };
        }
      }
    });
    if (best && best.d < 80 / zoom()) {
      used.add(best.i);
      drawing.over.push([x.a, x.b, best.over]);
      added = true;
    }
  }
  return added;
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
  if (showStrands && needsExpansion() && !pdSource && !err) {
    renderStrands();
    return;
  }
  drawing.components.forEach((poly, c) => {
    const color = COLORS[c % COLORS.length];
    const bundled = multExpr(c) !== "1";
    el("polygon", {
      points: poly.map((v) => `${v.x},${v.y}`).join(" "),
      class: bundled ? "strand bundle" : "strand",
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
    if (bundled) {
      // the multiplicity next to the arrow, on the strand's left
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const off = 16 / zoom();
      const t = el("text", {
        x: (a.x + b.x) / 2 + ((b.y - a.y) / len) * off,
        y: (a.y + b.y) / 2 - ((b.x - a.x) / len) * off,
        class: "mlabel",
        "font-size": 15 / zoom(),
        fill: color,
      });
      t.textContent = multExpr(c);
    }
  });
  // over-strands on top: a halo, then the strand again, following the strand
  // through its vertices for a fixed length on both sides of the crossing
  if (analysis) {
    const index = new Map();
    drawing.components.forEach((poly, c) => poly.forEach((v, k) => index.set(v.id, [c, k])));
    for (const x of analysis.crossings) {
      const at = index.get(x.over);
      if (!at) continue;
      const [c, k] = at;
      const pts = overPath(drawing.components[c], k, x, 14 / zoom());
      const points = pts.map((p) => `${p.x},${p.y}`).join(" ");
      el("polyline", { points, class: "halo" });
      el("polyline", { points, class: "strand", stroke: COLORS[c % COLORS.length] });
    }
  }
  drawing.boxes.forEach((b, i) => drawBox(b, i, segs));
  for (const id of selection) {
    const s = segs.get(id);
    if (s) el("line", { x1: s.p.x, y1: s.p.y, x2: s.q.x, y2: s.q.y, class: "pick" });
  }
  if (band) {
    const [x0, x1] = [Math.min(band.a.x, band.b.x), Math.max(band.a.x, band.b.x)];
    const [y0, y1] = [Math.min(band.a.y, band.b.y), Math.max(band.a.y, band.b.y)];
    el("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: "band" });
  }
  updateSelectionPanel();
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
        ? "Twist box: click strands to select them (or drag a rectangle). Make parallel lines them up; Add twist box puts n half-twists on the bundle. Esc clears."
        : "Edit: drag vertices · click a crossing to flip it · click a box to change it · double-click a strand to add a vertex · Alt-click a vertex to delete it.";
}

// Boxes from either format: { segs: [...], n } (older drawings: { a, b, n }).
function normBoxes(list) {
  return (list || []).map((b) => {
    const nb = { segs: b.segs && b.segs.length ? b.segs : [b.a, b.b], n: b.n };
    if (b.expr) nb.expr = b.expr;
    return nb;
  });
}

// a twist box: a rectangle across the midpoints of its strands, with the
// number of half-twists of the bundle or the twists themselves.  Looking
// along the first strand, the strands are ordered left to right; a positive
// half-twist is the braid Δ in which the left strand of each crossing passes
// over (as in Rust).
function boxFrame(b, segs) {
  const ss = b.segs.map((id) => segs.get(id));
  if (!ss.length || ss.some((s) => !s)) return null;
  const mid = (s) => ({ x: (s.p.x + s.q.x) / 2, y: (s.p.y + s.q.y) / 2 });
  const mids = ss.map(mid);
  const ux = ss[0].q.x - ss[0].p.x;
  const uy = ss[0].q.y - ss[0].p.y;
  const ul = Math.hypot(ux, uy) || 1;
  const U = { x: ux / ul, y: uy / ul };
  const Lv = { x: U.y, y: -U.x }; // the viewer's left of U (screen y points down)
  const C = {
    x: mids.reduce((a, m) => a + m.x, 0) / mids.length,
    y: mids.reduce((a, m) => a + m.y, 0) / mids.length,
  };
  const offs = mids.map((m) => (m.x - C.x) * Lv.x + (m.y - C.y) * Lv.y);
  const order = ss.map((_, i) => i).sort((i, j) => offs[j] - offs[i]); // left first
  const pt = (s, l) => ({ x: C.x + s * U.x + l * Lv.x, y: C.y + s * U.y + l * Lv.y });
  return { ss, C, offs, order, pt };
}

function drawBox(b, i, segs) {
  const f = boxFrame(b, segs);
  if (!f) return;
  const z = zoom();
  const k = f.ss.length;
  const delta = [];
  for (let m = k - 1; m >= 1; m--) for (let i = 0; i < m; i++) delta.push(i);
  const word = [];
  for (let t = 0; t < Math.abs(b.n); t++) word.push(...delta);
  // a box on one bundle strand spans the drawn bundle
  const pad = (k === 1 ? 14 : 10) / z;
  const lMax = Math.max(...f.offs) + pad;
  const lMin = Math.min(...f.offs) - pad;
  const minLen = Math.min(...f.ss.map((s) => Math.hypot(s.q.x - s.p.x, s.q.y - s.p.y)));
  const gap = (lMax - lMin) / Math.max(1, k);
  // roughly square crossings, within the strands
  const hh = showTwists
    ? Math.min(0.45 * minLen, Math.max(14 / z, (word.length * Math.max(9 / z, 0.9 * gap)) / 2))
    : 13 / z;
  const corners = [f.pt(-hh, lMin), f.pt(hh, lMin), f.pt(hh, lMax), f.pt(-hh, lMax)];
  const r = el("polygon", {
    points: corners.map((p) => `${p.x},${p.y}`).join(" "),
    class: "tbox" + (i === selectedBox ? " sel" : ""),
  });
  r.dataset.box = i;
  el("title", {}, r).textContent = `twist box: ${b.n} half-twists of ${k} strands`;
  if (showTwists && word.length > 0 && k > 1) {
    const lpos = f.order.map((i) => f.offs[i]); // left to right
    const colors = f.order.map((i) => COLORS[f.ss[i].c % COLORS.length]);
    const line = (seg, cls, color) => {
      const a = el("line", { x1: seg[0].x, y1: seg[0].y, x2: seg[1].x, y2: seg[1].y, class: cls });
      if (color) a.setAttribute("stroke", color);
      a.style.pointerEvents = "none";
    };
    word.forEach((i, j) => {
      const s0 = -hh + (2 * hh * j) / word.length;
      const s1 = -hh + (2 * hh * (j + 1)) / word.length;
      for (let q = 0; q < k; q++)
        if (q !== i && q !== i + 1) line([f.pt(s0, lpos[q]), f.pt(s1, lpos[q])], "strand", colors[q]);
      const lr = [f.pt(s0, lpos[i]), f.pt(s1, lpos[i + 1])]; // left to right
      const rl = [f.pt(s0, lpos[i + 1]), f.pt(s1, lpos[i])]; // right to left
      const [over, overColor, under, underColor] =
        b.n > 0 ? [lr, colors[i], rl, colors[i + 1]] : [rl, colors[i + 1], lr, colors[i]];
      line(under, "strand", underColor);
      line(over, "halo");
      line(over, "strand", overColor);
      [colors[i], colors[i + 1]] = [colors[i + 1], colors[i]];
    });
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
  if (document.activeElement !== $("box-n")) $("box-n").value = b.expr || b.n;
  $("box-minus").disabled = $("box-plus").disabled = !!b.expr;
  $("family-card").hidden = !!b.expr;
  $("box-title").textContent = b.segs.length > 1 ? `Twist box (${b.segs.length} strands)` : "Twist box (bundle)";
  $("box-show").checked = showTwists;
}

function setBoxN(n) {
  const b = drawing.boxes[selectedBox];
  if (!b || !Number.isInteger(n)) return;
  delete b.expr;
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

function updateSelectionPanel() {
  const show = mode === "twist" && selection.size > 0;
  $("sel-panel").hidden = !show;
  if (!show) return;
  $("sel-count").textContent = `${selection.size} strand${selection.size === 1 ? "" : "s"} selected`;
  const bundled = [...selection].some((id) => drawing.components.some((poly, c) => multExpr(c) !== "1" && poly.some((v) => v.id === id)));
  $("sel-parallel").disabled = selection.size < 2;
  $("sel-box").disabled = selection.size < 2 && !bundled;
}

const inSomeBox = (id) => drawing.boxes.some((b) => b.segs.includes(id));

/** Gives every selected strand a short middle section on evenly spaced
 *  parallel tracks (its ends stay put); the new sections become the selection. */
function makeParallel() {
  const ids = [...selection];
  if (ids.length < 2) return;
  if (ids.some(inSomeBox)) return flash("A selected strand already carries a twist box.");
  const segs = segmentById();
  const z = zoom();
  const unit = (v) => {
    const l = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / l, y: v.y / l };
  };
  const S = ids.map((id) => ({ id, ...segs.get(id) }));
  const u0 = unit({ x: S[0].q.x - S[0].p.x, y: S[0].q.y - S[0].p.y });
  const sum = { x: 0, y: 0 };
  for (const s of S) {
    const u = unit({ x: s.q.x - s.p.x, y: s.q.y - s.p.y });
    s.sign = u.x * u0.x + u.y * u0.y >= 0 ? 1 : -1;
    sum.x += s.sign * u.x;
    sum.y += s.sign * u.y;
  }
  const U = unit(sum);
  const Lv = { x: U.y, y: -U.x };
  const mids = S.map((s) => ({ x: (s.p.x + s.q.x) / 2, y: (s.p.y + s.q.y) / 2 }));
  const C = { x: mids.reduce((a, m) => a + m.x, 0) / S.length, y: mids.reduce((a, m) => a + m.y, 0) / S.length };
  S.forEach((s, i) => (s.off = (mids[i].x - C.x) * Lv.x + (mids[i].y - C.y) * Lv.y));
  const order = [...S].sort((a, b) => b.off - a.off); // left to right
  const gap = 26 / z;
  const minLen = Math.min(...S.map((s) => Math.hypot(s.q.x - s.p.x, s.q.y - s.p.y)));
  const h = Math.max(20 / z, Math.min(70 / z, 0.3 * minLen));
  const fresh = [];
  order.forEach((s, rank) => {
    const t = ((S.length - 1) / 2 - rank) * gap;
    const base = { x: C.x + t * Lv.x, y: C.y + t * Lv.y };
    const A = { id: nextId(), x: base.x - s.sign * h * U.x, y: base.y - s.sign * h * U.y };
    const B = { id: nextId(), x: base.x + s.sign * h * U.x, y: base.y + s.sign * h * U.y };
    const poly = drawing.components[s.c];
    const at = poly.findIndex((v) => v.id === s.id);
    poly.splice(at + 1, 0, A, B);
    fresh.push(A.id); // the section A -> B
  });
  selection = new Set(fresh);
  pdSource = null;
  commit();
  changed();
}

function addTwistBox() {
  const ids = [...selection];
  if (!ids.length) return;
  if (ids.some(inSomeBox)) return flash("A selected strand already carries a twist box.");
  drawing.boxes.push({ segs: ids, n: 1 });
  selection.clear();
  commit();
  setMode("edit");
  selectBox(drawing.boxes.length - 1);
  changed();
}

$("sel-parallel").onclick = makeParallel;
$("sel-bundle").onclick = () => {
  const comps = new Set();
  drawing.components.forEach((poly, c) => poly.forEach((v) => selection.has(v.id) && comps.add(c)));
  if (!comps.size) return;
  const first = [...comps][0];
  const text = prompt("Multiplicity of the selected components (a number or an expression such as n or n+1):", multExpr(first));
  if (text === null) return;
  try {
    evalExpr(text);
  } catch (e) {
    return flash(e.message);
  }
  drawing.mult = drawing.components.map((_, c) => multExpr(c));
  for (const c of comps) drawing.mult[c] = text.trim() || "1";
  commit();
  changed();
};
$("sel-box").onclick = addTwistBox;
$("sel-clear").onclick = () => {
  selection.clear();
  render();
};

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

/** The bundles drawn as their parallel copies (read-only view). */
function renderStrands() {
  let dr;
  let an;
  try {
    const res = knots.expand({ drawing: concreteDrawing(true), spacing: 7 / zoom() });
    if (res.error) throw new Error(res.error);
    dr = res.drawing;
    an = knots.analyze({ components: dr.components, over: dr.over, boxes: dr.boxes });
    if (an.error) throw new Error(an.error);
  } catch (e) {
    $("banner").hidden = false;
    $("banner").textContent = `Cannot show the strands: ${e.message}`;
    return;
  }
  const segs = new Map();
  dr.components.forEach((poly, c) =>
    poly.forEach((v, k) => segs.set(v.id, { c, p: v, q: poly[(k + 1) % poly.length] })),
  );
  dr.components.forEach((poly, c) =>
    el("polygon", { points: poly.map((v) => `${v.x},${v.y}`).join(" "), class: "strand thin", stroke: COLORS[c % COLORS.length] }),
  );
  const index = new Map();
  dr.components.forEach((poly, c) => poly.forEach((v, k) => index.set(v.id, [c, k])));
  for (const x of an.crossings) {
    const at = index.get(x.over);
    if (!at) continue;
    const pts = overPath(dr.components[at[0]], at[1], x, 5 / zoom());
    const points = pts.map((p) => `${p.x},${p.y}`).join(" ");
    el("polyline", { points, class: "halo thin" });
    el("polyline", { points, class: "strand thin", stroke: COLORS[at[0] % COLORS.length] });
  }
  dr.boxes.forEach((b, i) => drawBox(b, -1 - i, segs));
  $("hint").textContent = "Showing every strand of the bundles (read-only). Untick “show strands” to edit.";
}

// The piece of the strand within arc length L of the point x on segment k.
function overPath(poly, k, x, L) {
  const n = poly.length;
  const walk = (step) => {
    const out = [];
    let cur = { x: x.x, y: x.y };
    let left = L;
    let i = step > 0 ? (k + 1) % n : k;
    for (let guard = 0; guard < n && left > 0; guard++) {
      const v = poly[i];
      const d = Math.hypot(v.x - cur.x, v.y - cur.y);
      if (d >= left) {
        out.push({ x: cur.x + ((v.x - cur.x) * left) / d, y: cur.y + ((v.y - cur.y) * left) / d });
        break;
      }
      out.push({ x: v.x, y: v.y });
      left -= d;
      cur = v;
      i = (i + step + n) % n;
    }
    return out;
  };
  return [...walk(-1).reverse(), { x: x.x, y: x.y }, ...walk(1)];
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
  if (m !== "twist") selection.clear();
  band = null;
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
  if (drawing.mult) drawing.mult.push("1");
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
      band = { a: p, b: p };
      svg.setPointerCapture(e.pointerId);
      return render();
    }
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    return render();
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
  if (band) {
    band.b = p;
    render();
    return;
  }
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
  if (band) {
    // select the strands whose midpoints lie in the rectangle
    const [x0, x1] = [Math.min(band.a.x, band.b.x), Math.max(band.a.x, band.b.x)];
    const [y0, y1] = [Math.min(band.a.y, band.b.y), Math.max(band.a.y, band.b.y)];
    if (x1 - x0 < 3 / zoom() && y1 - y0 < 3 / zoom()) selection.clear();
    for (const poly of drawing.components)
      poly.forEach((v, k) => {
        const w = poly[(k + 1) % poly.length];
        const m = { x: (v.x + w.x) / 2, y: (v.y + w.y) / 2 };
        if (m.x >= x0 && m.x <= x1 && m.y >= y0 && m.y <= y1) selection.add(v.id);
      });
    band = null;
    render();
    return;
  }
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
  if (drawing.components[c].length <= 3) {
    drawing.components.splice(c, 1);
    if (drawing.mult) drawing.mult.splice(c, 1);
  }
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
  else if (e.key === "Escape" && mode === "twist") { selection.clear(); render(); }
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
$("box-n").onchange = () => {
  const text = $("box-n").value.trim();
  if (/^-?\d+$/.test(text)) return setBoxN(Number(text));
  const b = drawing.boxes[selectedBox];
  try {
    evalExpr(text);
  } catch (e) {
    return flash(e.message);
  }
  b.expr = text;
  commit();
  changed();
};
$("box-delete").onclick = removeBox;
$("box-show").onchange = () => {
  showTwists = $("box-show").checked;
  render();
};

/** Replaces the drawing by the automatic layout of a PD code. */
function drawPD(pd, freeLoops) {
  const res = knots.layout({ pd, free_loops: freeLoops, view, first_id: idCounter });
  if (res.error) return res.error;
  analysis = lastAnalysis = null; // a new drawing: no choices to carry over
  drawing = res.drawing;
  drawing.boxes = normBoxes(drawing.boxes);
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
  analysis = lastAnalysis = null; // a new drawing: no choices to carry over
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
  drawing.boxes = drawing.boxes.map((b) => ({ segs: b.segs.map(endOf), n: b.n }));
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
  analysis = lastAnalysis = null; // a new drawing: no choices to carry over
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
    analysis = lastAnalysis = null; // a new drawing: no choices to carry over
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
    delete d.boxes[selectedBox].expr;
    let a;
    try {
      const saved = drawing;
      drawing = d;
      a = knots.analyze(concreteDrawing(true));
      drawing = saved;
    } catch (e) {
      a = { error: e.message };
    }
    items.push(a.error ? { label: String(n), pd: [], free_loops: 1 } : { label: String(n), pd: a.pd, free_loops: a.free_loops });
  }
  $("fam-status").textContent = `computing ${items.length} diagrams…`;
  $("family").innerHTML = "";
  runHeavy({ task: "family", items }, (res) => {
    if (res.canceled) return ($("fam-status").textContent = "canceled");
    if (res.error) return ($("fam-status").innerHTML = `<span class="err">${escapeHTML(res.error)}</span>`);
    $("fam-status").textContent = "";
    $("family").innerHTML = familyTable(res, "n");
  }, $("fam-cancel"));
};

$("copy-pd").onclick = () => navigator.clipboard?.writeText($("pd").textContent);

// ---------------------------------------------------------------- persistence

function encodeState() {
  const compact = {
    c: drawing.components.map((poly) => poly.map((v) => [v.id, Math.round(v.x), Math.round(v.y)])),
    o: drawing.over,
    b: drawing.boxes.map((b) => (b.expr ? { s: b.segs, n: b.n, e: b.expr } : { s: b.segs, n: b.n })),
    u: drawing.mult,
    p: params,
  };
  return btoa(JSON.stringify(compact)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeState(s) {
  const o = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  return {
    components: o.c.map((poly) => poly.map(([id, x, y]) => ({ id, x, y }))),
    over: o.o || [],
    boxes: (o.b || []).map((x) =>
      Array.isArray(x) ? { segs: [x[0], x[1]], n: x[2] } : x.e ? { segs: x.s, n: x.n, expr: x.e } : { segs: x.s, n: x.n },
    ),
    mult: o.u,
    params: o.p,
  };
}
function saveLocal() {
  try {
    localStorage.setItem("knot-workbench", snapshot());
  } catch {}
}

// ---------------------------------------------------------------- start

// read-only hooks for the browser tests
window.knotWorkbench = {
  state: () => JSON.parse(JSON.stringify({ drawing, analysis })),
  toScreen: (x, y) => {
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const q = pt.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  },
};

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
      analysis = lastAnalysis = null; // a new drawing: no choices to carry over
      drawing = decodeState(hash[1]);
      if (drawing.params) params = drawing.params;
      delete drawing.params;
      renderParams();
      lastCommitted = snapshot();
      fitView();
    } else if (saved) restore(saved);
  } catch {
    analysis = lastAnalysis = null; // a new drawing: no choices to carry over
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
