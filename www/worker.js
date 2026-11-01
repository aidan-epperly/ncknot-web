// Runs ncknot in a Web Worker so long computations never block the page.
// Messages in:  { id, request }   (request as for `compute` in src/api.rs, or
//                                  with `drawing` in place of `pd`)
// Messages out: { id, result }    (the parsed JSON answer)
//
// A request may carry the drawing itself (with numbers for every parameter);
// expanding bundles and analysing the drawing then happens here, off the
// page's thread, and the page can cancel it by terminating the worker.
import { loadKnots } from "./knot.js";

const ready = loadKnots();

function run(knots, request) {
  if (request.kirby) return knots.kirby(request.kirby); // the Kirby tab
  if (request.drawing) {
    const { drawing, ...rest } = request;
    const a = knots.analyze(drawing);
    if (a.error) return { error: a.error };
    return knots.compute({ ...rest, pd: a.pd, free_loops: a.free_loops });
  }
  if (request.task === "family" && request.items.some((it) => it.drawing)) {
    // analyse each member, keep the failures as rows of their own
    const ok = [];
    const failed = new Map();
    request.items.forEach((it, i) => {
      if (!it.drawing) return ok.push(it);
      const a = knots.analyze(it.drawing);
      if (a.error) failed.set(i, { label: it.label, error: a.error });
      else ok.push({ label: it.label, pd: a.pd, free_loops: a.free_loops });
    });
    const res = ok.length ? knots.compute({ task: "family", items: ok }) : [];
    if (res.error) return res;
    let j = 0;
    return request.items.map((_, i) => (failed.has(i) ? failed.get(i) : res[j++]));
  }
  return knots.compute(request);
}

self.onmessage = async (event) => {
  const knots = await ready;
  const { id, request } = event.data;
  let result;
  try {
    result = run(knots, request);
  } catch (e) {
    // a panic traps the module; let the page replace this worker
    self.postMessage({ id, result: { error: String(e), fatal: true } });
    self.close();
    return;
  }
  self.postMessage({ id, result });
};
