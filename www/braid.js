// Braid closures as drawings: strands run upward, the closing arcs nest
// around the right-hand side, and σᵢ puts the strand at position i over the
// one at i + 1 (a positive crossing, as in ncknot).

/** Parses "1 -2 1" or "1,-2,1" into a word; throws on bad generators. */
export function parseWord(text, strands) {
  const word = text
    .split(/[\s,;]+/)
    .filter((t) => t.length > 0)
    .map((t) => {
      const g = Number(t.replace("−", "-"));
      if (!Number.isInteger(g) || g === 0 || Math.abs(g) >= strands) {
        throw new Error(`"${t}" is not σᵢ^±1 with 1 ≤ i < ${strands}`);
      }
      return g;
    });
  return word;
}

/**
 * The closure of a braid as a drawing { components, over } fitted to the
 * box { x, y, w, h }.  `nextId()` hands out vertex ids.
 */
export function braidDrawing(strands, word, box, nextId) {
  const n = strands;
  const L = Math.max(word.length, 1);
  const margin = 0.08;
  const loopRoom = 0.38; // share of the width taken by the closing arcs
  const left = box.x + box.w * margin;
  const usableW = box.w * (1 - 2 * margin);
  const strandW = usableW * (1 - loopRoom);
  const gap = n > 1 ? strandW / (n - 1) : 0;
  const right = left + strandW;
  const loopGap = (usableW * loopRoom) / (n + 0.5);
  const top = box.y + box.h * margin + n * loopGap * 0.55;
  const bottom = box.y + box.h * (1 - margin) - n * loopGap * 0.55;
  const dy = (bottom - top) / L;
  const xs = (p) => left + p * gap;
  const ys = (k) => bottom - k * dy;
  const vSpace = loopGap * 0.55;

  // the path of the strand starting at bottom position p: points per level
  // segPaths[p] = list of { x, y, crossing: [level, which] }
  const pos = [...Array(n).keys()]; // pos[s] = position of strand s
  const paths = [...Array(n)].map((_, s) => [{ x: xs(s), y: ys(0) }]);
  const crossings = []; // { level, leftStrand, rightStrand, positive }
  word.forEach((g, k) => {
    const i = Math.abs(g) - 1;
    const sl = pos.indexOf(i);
    const sr = pos.indexOf(i + 1);
    for (let s = 0; s < n; s++) {
      if (s === sl) pos[s] = i + 1;
      else if (s === sr) pos[s] = i;
      paths[s].push({ x: xs(pos[s]), y: ys(k + 1), level: k });
    }
    crossings.push({ level: k, sl, sr, positive: g > 0 });
  });
  if (word.length === 0) {
    for (let s = 0; s < n; s++) paths[s].push({ x: xs(s), y: ys(1) });
  }
  // top position j closes onto bottom position j through the nested arcs
  const closure = (j) => {
    const h = (n - j) * vSpace;
    const r = right + (n - j) * loopGap;
    return [
      { x: xs(j), y: top - h },
      { x: r, y: top - h },
      { x: r, y: bottom + h },
      { x: xs(j), y: bottom + h },
    ];
  };

  // components: follow strands through closures
  const used = new Array(n).fill(false);
  const components = [];
  const segOf = new Map(); // `${strand}:${level}` -> id of the vertex starting that level's segment
  for (let s0 = 0; s0 < n; s0++) {
    if (used[s0]) continue;
    const poly = [];
    let s = s0;
    while (!used[s]) {
      used[s] = true;
      const path = paths[s];
      for (let k = 0; k < path.length - 1; k++) {
        const id = nextId();
        poly.push({ id, x: path[k].x, y: path[k].y });
        segOf.set(`${s}:${k}`, id);
      }
      const end = path[path.length - 1];
      const j = Math.round((end.x - left) / (gap || 1));
      poly.push({ id: nextId(), x: end.x, y: end.y });
      for (const p of closure(n > 1 ? j : 0)) poly.push({ id: nextId(), x: p.x, y: p.y });
      s = n > 1 ? j : 0; // the strand starting at bottom position j is strand j
    }
    components.push(poly);
  }
  const over = crossings.map((c) => {
    const a = segOf.get(`${c.sl}:${c.level}`);
    const b = segOf.get(`${c.sr}:${c.level}`);
    // σᵢ: the strand coming from position i (left) is on top
    return [a, b, c.positive ? a : b];
  });
  return { components, over, boxes: [] };
}
