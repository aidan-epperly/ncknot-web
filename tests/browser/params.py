"""Parameters, bundles and symbolic boxes: python tests/browser/params.py [url] [screenshot dir].

Two loops crossing twice (a Hopf link).  Loop A becomes a bundle of n
strands, loop B a bundle of n+1 strands with a box of m half-twists on its
copies.  Crossings: the 2 drawn crossings become 2·n·(n+1); the box adds
m·(n+1)·n/2."""
import base64
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "screenshots")
OUT.mkdir(parents=True, exist_ok=True)

loops = [
    [[1, 200, 150], [2, 450, 150], [3, 450, 400], [4, 200, 400]],
    [[11, 320, 260], [12, 640, 260], [13, 640, 560], [14, 320, 560]],
]
code = base64.urlsafe_b64encode(json.dumps({"c": loops, "o": [[2, 11, 2], [3, 14, 14]], "b": []}).encode()).decode().rstrip("=")


def crossings(page):
    return int(page.inner_text("#stats .stat:nth-child(1) .v"))


def expect_crossings(page, want):
    """Wait until the invariants show `want` crossings (or fail after 10 s)."""
    try:
        page.wait_for_function(f"document.querySelector('#stats .stat .v')?.textContent === '{want}'", timeout=10000)
    except Exception:
        raise AssertionError(f"crossings {crossings(page)}, expected {want}")
    return want


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    page = browser.new_page(viewport={"width": 1300, "height": 950})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    answers = []
    page.on("dialog", lambda d: d.accept(answers.pop(0)))
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.goto(URL + "#d=" + code)
    page.reload()
    page.wait_for_function("knotWorkbench.state().analysis && knotWorkbench.state().analysis.crossings.length == 2")
    page.wait_for_function("document.querySelector('#ident').textContent.includes('hopf')")  # the loops are linked
    # n is added by hand (value 1, then + to 2); m is created by using it
    page.fill("#param-name", "n")
    page.click("#param-add")
    page.locator(".param").nth(0).locator("button").nth(1).click()
    page.click("button[data-mode=twist]")

    def select(x, y):
        q = page.evaluate(f"knotWorkbench.toScreen({x}, {y})")
        page.mouse.click(q["x"], q["y"])

    select(325, 150)  # A's top edge
    answers.append("n")
    page.click("#sel-bundle")
    page.click("#sel-clear")
    select(640, 410)  # B's right edge
    answers.append("n+1")
    page.click("#sel-bundle")
    page.click("#sel-box")
    page.wait_for_selector("#box-panel:not([hidden])")
    page.fill("#box-n", "m")
    page.press("#box-n", "Enter")
    page.wait_for_function("document.querySelectorAll('.param').length === 2")  # m was created (= 2)
    assert "Added parameter m = 2" in page.inner_text("#banner"), page.inner_text("#banner")
    page.locator(".param").nth(1).locator("button").nth(0).click()  # m = 1
    label = page.locator("#canvas text.tlabel").text_content()
    assert label == "m", f"box label {label!r}"
    page.click("#mirror")
    page.wait_for_function("document.querySelector('#canvas text.tlabel')?.textContent === '−(m)'")
    page.click("#mirror")
    page.wait_for_function("document.querySelector('#canvas text.tlabel')?.textContent === 'm'")
    c = expect_crossings(page, 2 * 2 * 3 + 1 * 3 * 2 // 2)
    print("n = 2, m = 1: crossings", c)
    page.screenshot(path=OUT / "params_bundles.png")
    page.locator(".param").nth(0).locator("button").nth(1).click()  # n = 3
    c = expect_crossings(page, 2 * 3 * 4 + 1 * 4 * 3 // 2)
    print("n = 3, m = 1: crossings", c)
    page.check("#show-strands")
    page.wait_for_timeout(300)
    assert page.locator("#banner").is_hidden(), page.inner_text("#banner")
    page.locator("#canvas").screenshot(path=OUT / "params_strands.png")
    page.uncheck("#show-strands")
    # sweep n = 1..3, m = 0..1
    ranges = page.locator("#sweep-ranges label")
    for i, (a, b) in enumerate([(1, 3), (0, 1)]):
        ranges.nth(i).locator("input").nth(0).fill(str(a))
        ranges.nth(i).locator("input").nth(1).fill(str(b))
    page.click("#sweep-go")
    page.wait_for_selector("#sweep table", timeout=60000)
    rows = page.locator("#sweep tr").all_inner_texts()
    for r in rows:
        print("  ", r.replace("\t", " | ").replace("−", "-")[:110])
    assert len(rows) == 1 + 6
    # linked bundles: no row is a split link (determinant 0 with Alexander 0
    # only happens for the even-component rows if they were split)
    assert all(" | 0 | 0 | 0 | 0 |" not in r.replace("	", " | ") for r in rows[1:]), rows
    page.locator(".results").screenshot(path=OUT / "params_sweep.png")
    browser.close()
    assert not errors, errors
    print("OK")
