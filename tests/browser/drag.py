"""Dragging a vertex keeps every crossing's over/under choice, even when the
crossing slides onto the next segment of a strand:
python tests/browser/drag.py [url] [screenshot dir]."""
import base64
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "screenshots")
OUT.mkdir(parents=True, exist_ok=True)

# loop A (ids 1-4) and loop B (ids 11-14); segments are named by their first vertex.
# A's top edge (1) crosses B's left side (14); A's right edge (2) crosses B's bottom (13).
# A is chosen on top at both crossings.
state = {
    "c": [
        [[1, 200, 200], [2, 380, 200], [3, 400, 400], [4, 200, 400]],
        [[11, 370, 100], [12, 600, 100], [13, 600, 260], [14, 370, 260]],
    ],
    "o": [[1, 14, 1], [2, 13, 2]],
    "b": [],
}
code = base64.urlsafe_b64encode(json.dumps(state).encode()).decode().rstrip("=")


def over_component(page, a, b):
    st = page.evaluate("knotWorkbench.state()")
    for x in st["analysis"]["crossings"]:
        if {x["a"], x["b"]} == {a, b}:
            return 0 if x["over"] in (1, 2, 3, 4) else 1
    raise AssertionError(f"no crossing between segments {a} and {b}: {st['analysis']['crossings']}")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    page = browser.new_page(viewport={"width": 1300, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.goto(URL + "#d=" + code)
    page.reload()  # a hash-only navigation does not reload the page
    page.wait_for_function("knotWorkbench.state().analysis && knotWorkbench.state().analysis.crossings.length == 2")
    assert over_component(page, 1, 14) == 0 and over_component(page, 2, 13) == 0
    page.locator("#canvas").screenshot(path=OUT / "drag_before.png")
    # drag vertex 2 from (380, 200) to (360, 190) in small steps: the first
    # crossing slides from A's top edge (1) onto A's right edge (2)
    start = page.evaluate("knotWorkbench.toScreen(380, 200)")
    page.mouse.move(start["x"], start["y"])
    page.mouse.down()
    for t in range(1, 21):
        q = page.evaluate(f"knotWorkbench.toScreen({380 - t}, {200 - t / 2})")
        page.mouse.move(q["x"], q["y"])
    page.mouse.up()
    page.wait_for_timeout(200)
    page.locator("#canvas").screenshot(path=OUT / "drag_after.png")
    a = over_component(page, 2, 14)
    b = over_component(page, 2, 13)
    print("after the drag: A over at the slid crossing:", a == 0, "and at the other:", b == 0)
    assert a == 0 and b == 0, "a crossing changed when its vertex was dragged"
    browser.close()
    assert not errors, errors
    print("OK")
