// Loads ncknot_web.wasm and wraps its byte interface (see src/lib.rs):
// write a UTF-8 JSON request into the module's memory, call a function,
// read the UTF-8 JSON answer back.  This is all the "glue" there is.

export async function loadKnots(url = new URL("./ncknot_web.wasm", import.meta.url)) {
  const response = fetch(url);
  let module;
  try {
    module = await WebAssembly.instantiateStreaming(response, {});
  } catch {
    // servers that do not send application/wasm
    module = await WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), {});
  }
  const ex = module.instance.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  function call(fn, text) {
    const bytes = encoder.encode(text);
    const ptr = ex.input_buffer(bytes.length);
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    const len = ex.call(fn);
    return JSON.parse(decoder.decode(new Uint8Array(ex.memory.buffer, ex.output_ptr(), len)));
  }
  return {
    analyze: (drawing) => call(0, JSON.stringify(drawing)),
    alternating: (drawing) => call(1, JSON.stringify(drawing)),
    compute: (request) => call(2, JSON.stringify(request)),
    table: () => call(3, ""),
    layout: (request) => call(4, JSON.stringify(request)),
    expand: (request) => call(5, JSON.stringify(request)),
  };
}
