"""A large parameter must not hang the page, and changing it again restarts
the computation: python tests/browser/restart.py [url] [screenshot dir]."""
import base64
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "screenshots")
OUT.mkdir(parents=True, exist_ok=True)

# two linked loops: A a bundle of n, B a bundle of n+1 with m half-twists
state = {
    "c": [
        [[1, 200, 150], [2, 450, 150], [3, 450, 400], [4, 200, 400]],
        [[11, 320, 260], [12, 640, 260], [13, 640, 560], [14, 320, 560]],
    ],
    "o": [[2, 11, 2], [3, 14, 14]],
    "b": [{"s": [12], "n": 1, "e": "m"}],
    "u": ["n", "n+1"],
    "p": {"n": 2, "m": 1},
}
code = base64.urlsafe_b64encode(json.dumps(state).encode()).decode().rstrip("=")


def stat_crossings(page):
    return page.evaluate("document.querySelector('#stats .stat .v')?.textContent")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    page = browser.new_page(viewport={"width": 1300, "height": 950})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.goto(URL + "#d=" + code)
    page.reload()
    page.wait_for_function("document.querySelector('#stats .stat .v')?.textContent === '15'", timeout=15000)
    print("n = 2: 15 crossings")
    n_input = page.locator(".param").nth(0).locator("input")
    # a large n: 2·40·41 + 41·40/2 = 4100 crossings, far too many to finish quickly
    n_input.fill("40")
    n_input.dispatch_event("change")
    page.wait_for_timeout(1500)
    # nothing new was shown for n = 40 yet: it is still computing
    assert page.evaluate("knotWorkbench.shown().crossings") == 15
    # the page still answers at once
    t0 = time.time()
    page.evaluate("1 + 1")
    responsive = time.time() - t0
    print(f"page answered in {responsive * 1000:.0f} ms while n = 40 was computing")
    assert responsive < 1.0
    assert "computing" in page.inner_text("#ident"), page.inner_text("#ident")
    page.screenshot(path=OUT / "restart_computing.png")
    # back to n = 2: the old computation is abandoned and a new answer comes promptly
    before = page.evaluate("knotWorkbench.shown().count")
    t0 = time.time()
    n_input.fill("2")
    n_input.dispatch_event("change")
    page.wait_for_function(f"knotWorkbench.shown().count > {before} && knotWorkbench.shown().crossings === 15", timeout=15000)
    print(f"n = 2 again: 15 crossings after {time.time() - t0:.1f} s")
    assert time.time() - t0 < 10
    browser.close()
    assert not errors, errors
    print("OK")
