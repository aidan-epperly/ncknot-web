"""Select strands with a rectangle, make them parallel, put a twist box on the
bundle: python tests/browser/bundle.py [url] [screenshot dir]."""
import base64
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "screenshots")
OUT.mkdir(parents=True, exist_ok=True)

# three concentric loops; their right sides are the strands to bundle
loops = []
for j in range(3):
    g = 30 * j
    loops.append([[10 * j, 300 - g, 100 - g], [10 * j + 1, 500 + g, 100 - g], [10 * j + 2, 500 + g, 400 + g], [10 * j + 3, 300 - g, 400 + g]])
code = base64.urlsafe_b64encode(json.dumps({"c": loops, "o": [], "b": []}).encode()).decode().rstrip("=")


def state(page):
    return page.evaluate("knotWorkbench.state()")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    page = browser.new_page(viewport={"width": 1300, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.goto(URL + "#d=" + code)
    page.reload()
    page.wait_for_function("knotWorkbench.state().analysis !== null")
    assert len(state(page)["analysis"]["crossings"]) == 0
    page.click("button[data-mode=twist]")
    # rubber band around the three right sides (midpoints at x = 500, 530, 560; y = 250)
    a = page.evaluate("knotWorkbench.toScreen(480, 200)")
    b = page.evaluate("knotWorkbench.toScreen(580, 300)")
    page.mouse.move(a["x"], a["y"])
    page.mouse.down()
    page.mouse.move(b["x"], b["y"], steps=8)
    page.mouse.up()
    count = page.inner_text("#sel-count")
    print("selected:", count)
    assert count.startswith("3 strands")
    page.click("#sel-parallel")
    page.wait_for_timeout(200)
    page.screenshot(path=OUT / "bundle_parallel.png")
    assert page.inner_text("#sel-count").startswith("3 strands")
    page.click("#sel-box")
    page.wait_for_selector("#box-panel:not([hidden])")
    print("box:", page.inner_text("#box-title"))
    page.click("#box-plus")  # n = 2: a full twist
    page.wait_for_function("knotWorkbench.state().analysis && knotWorkbench.state().analysis.box_crossings === 6")
    page.wait_for_function("document.querySelector('#stats').textContent.includes('components3')")
    st = state(page)
    print("box crossings:", st["analysis"]["box_crossings"], "components:", st["analysis"]["components"])
    page.check("#box-show")
    page.wait_for_timeout(200)
    page.screenshot(path=OUT / "bundle_full_twist.png")
    print("ident:", page.inner_text("#ident"))
    browser.close()
    assert not errors, errors
    print("OK")
