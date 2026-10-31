# Knot Workbench (ncknot-web)

A browser app for building knots and computing their invariants. Draw a
diagram, build a braid, or pick a knot from the table; the invariants update
as you edit. Everything is computed exactly by [ncknot](https://github.com/aidan-epperly/ncknot),
compiled to WebAssembly. There is no server-side code: the page is static
files.

**Try it:** https://aidan-epperly.github.io/ncknot-web/

## Run it

Cargo fetches [ncknot](https://github.com/aidan-epperly/ncknot) and
[ncalg](https://github.com/aidan-epperly/ncalg) from GitHub.  Then:

```bash
python build.py --serve      # build the .wasm, then serve www/ at http://localhost:8000
python build.py              # build only (www/ncknot_web.wasm)
python build.py --serve-only 8000
```

The build needs Rust's `wasm32-unknown-unknown` target
(`rustup target add wasm32-unknown-unknown`).  No Node, npm or wasm-bindgen.

## Using it

- **Draw** (`D`): click to place vertices, then click the first vertex or
  press Enter to close a component. Repeat for links. Esc cancels.
- **Edit** (`E`):
  - drag vertices;
  - click a crossing to flip it;
  - double-click a strand to add a vertex;
  - Alt-click a vertex to delete it.
- **Toolbar**:
  - **Alternate** makes the diagram alternating;
  - **Mirror** flips every crossing;
  - **Reverse** reverses the orientations;
  - **Fit** zooms the view to the drawing;
  - **Share link** puts the drawing in the URL;
  - **SVG** downloads the picture.

  Undo and redo are Ctrl+Z and Ctrl+Y.
- **Twist boxes** (`T`): click two neighboring strands, with no strand
  between them, to put a box at their midpoints. A box holds n half-twists.
  - Change n with + and −, or type it.
  - "show twists" draws the crossings instead of the number.
  - Looking along the first strand you clicked, the strand coming from the
    left passes over when n > 0. Two parallel strands therefore get positive
    crossings, and n = 3 between two loops is the right-handed trefoil.
  - An odd box reconnects its strands; orientations are re-solved over the
    whole diagram.
  - With a box selected, **Twist family** computes the determinant,
    signature, Alexander and Jones polynomials and table matches for a range
    of n.
- **Braids and the knot table:**
  - press the σᵢ / σᵢ⁻¹ buttons or type a word (`1 -2 1 -2`) to draw a braid
    closure;
  - choosing a table entry draws the knot by automatic layout.
- **PD code:** paste a code and it is drawn by automatic layout. **Tidy**
  redraws the current diagram the same way, expanding twist boxes.
- **Invariants:**
  - updated automatically: the Jones, Alexander and Conway polynomials,
    determinant, signature, Fox p-colorings, H₁ of the double branched
    cover, linking numbers;
  - on demand, with a Cancel button: Khovanov homology (ℤ with torsion, or
    𝔽ₚ) and counts of homomorphisms to Sₘ.
- **Matching:** when the Jones and Alexander polynomials match a table entry
  or its mirror, the panel says so. A match is evidence, not a proof of
  isotopy.

## How the Rust/WebAssembly part works

- **The Rust crate.** It compiles to a `.wasm` module for the target
  `wasm32-unknown-unknown`:
  - `src/geometry.rs` turns a drawing into a PD code;
  - `src/api.rs` answers JSON requests with ncknot.

  ncknot and ncalg build for this target with their default `parallel`
  feature turned off. That feature only switches faer's thread pool;
  WebAssembly in a browser has no OS threads.
- **The interface.** It is four exported functions (`src/lib.rs`; `call` dispatches to five tasks) that pass
  UTF-8 JSON through the module's linear memory:
  1. JavaScript asks for an input buffer;
  2. it writes the request into the buffer;
  3. it calls `call(fn)`;
  4. it reads the answer from `output_ptr` / `output_len`.

  `www/knot.js` is the whole JavaScript side, about 30 lines. Tools like
  wasm-bindgen generate this kind of glue for richer interfaces; strings in,
  strings out don't need them.
- **Two instances.** The page loads the module twice:
  - on the main thread, for analyzing the drawing on every pointer move (well
    under a millisecond);
  - in a Web Worker (`www/worker.js`), for the invariants, so the page stays
    responsive.

  Long jobs (Khovanov homology, representations) run in a second worker,
  which Cancel simply terminates.
- **Panics.** A Rust panic becomes a WebAssembly trap. The page then
  reloads the module (or replaces the worker) and shows an error, instead of
  freezing.

## Automatic layout

`src/layout.rs` and `src/relax.rs`:
1. **Triangulate.** The projection's plane graph (faces from ncknot) is refined:
   every edge is subdivided twice, every crossing corner gets a vertex, and
   every face a center. This is a triangulation, so it is 3-connected even
   with nugatory crossings.
2. **Embed.** Tutte's barycentric embedding draws the triangulation with no
   unwanted crossings: the outer face on a circle, each vertex at the average
   of its neighbors, one LU solve with faer.
3. **Cross.** At each crossing the strands become two short chords that
   cross there, in the PD code's counterclockwise order.
4. **Relax.** Springs, repulsion and smoothing remove Tutte's crowding.
   Nearly straight vertices are then removed. A move is accepted only if every
   segment still crosses the same segments.

The tests lay out every table knot and 60 random braid closures, re-analyze
the drawing, and compare the Jones and Alexander polynomials, signature,
writhe and linking numbers.

## Layout

```
src/geometry.rs   drawing → crossings, signs, PD code; alternating choices
src/api.rs        JSON requests → ncknot invariants, families; the knot table
src/layout.rs     PD code → drawing (Tutte embedding of a triangulation)
src/relax.rs      crossing-preserving relaxation, simplification, fitting
src/lib.rs        the four exports
www/              index.html, style.css, app.js (editor, panels), braid.js
                  (braid closures as drawings), knot.js (wasm loader), worker.js
tests/geometry.rs native tests: pentagram = 5_1 when alternating, Hopf
                  link signs on screen coordinates, degenerate drawings, API
tests/twist_boxes.rs  boxes against integer tangle closures (T(2,n), unknot)
tests/layout.rs   layouts round-trip: table knots, random braids, split links
tests/browser/    smoke.py, features.py, drag.py: Playwright (Edge) end-to-end checks
build.py          build and serve
```

## Tests

```bash
cargo test                                   # geometry and API, native
python build.py --serve-only 8765 &          # then:
python tests/browser/smoke.py http://localhost:8765/ target/screenshots
python tests/browser/features.py http://localhost:8765/ target/screenshots
python tests/browser/drag.py http://localhost:8765/ target/screenshots
```

The browser test runs in Edge and checks:
- the trefoil's Jones polynomial and its integral Khovanov homology (rank 4,
  ℤ/2 torsion);
- that flipping one crossing gives the unknot;
- that the table's 4₁ is identified;
- that a hand-drawn pentagram, made alternating, matches 5₁;
- that the console shows no errors.

It also saves desktop and phone screenshots.

## License

Copyright (C) 2026 Aidan Epperly.  Licensed under the GNU General Public
License, version 3 or (at your option) any later version; see [LICENSE](LICENSE).
