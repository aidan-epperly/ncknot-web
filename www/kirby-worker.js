// The Kirby tab's worker: runs src/kirby.rs requests off the page's thread.
// Messages in: { id, request: { kirby: request } }; out: { id, result }.
// The ?v= stamps (written by build.py) keep a new deploy from mixing with
// cached files of an older one.
import { loadKnots } from "./knot.js?v=5625af5cb8";

const ready = loadKnots(new URL("./ncknot_web.wasm?v=5625af5cb8", import.meta.url));

self.onmessage = async (event) => {
  const knots = await ready;
  const { id, request } = event.data;
  try {
    self.postMessage({ id, result: knots.kirby(request.kirby) });
  } catch (e) {
    // a panic traps the module; let the page replace this worker
    self.postMessage({ id, result: { error: String(e), fatal: true } });
    self.close();
  }
};
