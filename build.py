"""Builds the WebAssembly module into www/ncknot_web.wasm.

    python build.py            # release build
    python build.py --serve    # build, then serve www/ at http://localhost:8000
    python build.py --serve-only [port]
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run(*cmd):
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=True)


def main():
    if "--serve-only" in sys.argv:
        rest = sys.argv[sys.argv.index("--serve-only") + 1 :]
        return serve(int(rest[0]) if rest else 8000)
    run("cargo", "build", "--release", "--target", "wasm32-unknown-unknown")
    wasm = ROOT / "target" / "wasm32-unknown-unknown" / "release" / "ncknot_web.wasm"
    out = ROOT / "www" / "ncknot_web.wasm"
    shutil.copyfile(wasm, out)
    print(f"www/ncknot_web.wasm: {out.stat().st_size / 1024:.0f} KiB")
    stamp()
    if "--serve" in sys.argv:
        serve(8000)


def stamp():
    """Writes a version (a hash of www/'s contents) into the ?v= of the
    Kirby tab's and the stylesheet's URLs, so a browser never mixes files
    of two deploys."""
    import hashlib
    import re

    files = ["index.html", "kirby.js", "kirby-worker.js", "fancy.js", "knot.js", "style.css", "ncknot_web.wasm"]
    pattern = re.compile(rb"\?v=[0-9a-f]+")
    h = hashlib.sha256()
    for f in files:
        h.update(pattern.sub(b"", (ROOT / "www" / f).read_bytes()))
    v = h.hexdigest()[:10].encode()
    for f in ["index.html", "kirby.js", "kirby-worker.js"]:
        path = ROOT / "www" / f
        path.write_bytes(pattern.sub(b"?v=" + v, path.read_bytes()))
    print(f"version {v.decode()}")


def serve(port):
    """Serves www/ (with the application/wasm type) until interrupted."""
    import http.server

    class Handler(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm"}

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / "www"), **kwargs)

    print(f"serving http://localhost:{port} (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("localhost", port), Handler).serve_forever()

if __name__ == "__main__":
    main()
