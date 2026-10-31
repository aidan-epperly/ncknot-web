// Runs ncknot in a Web Worker so long computations never block the page.
// Messages in:  { id, request }   (request as for `compute` in src/api.rs)
// Messages out: { id, result }    (the parsed JSON answer)
import { loadKnots } from "./knot.js";

const ready = loadKnots();

self.onmessage = async (event) => {
  const knots = await ready;
  const { id, request } = event.data;
  let result;
  try {
    result = knots.compute(request);
  } catch (e) {
    // a panic traps the module; let the page replace this worker
    result = { error: String(e) };
    self.postMessage({ id, result });
    self.close();
    return;
  }
  self.postMessage({ id, result });
};
