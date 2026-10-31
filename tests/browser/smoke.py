"""Browser smoke test: python tests/browser/smoke.py [url] [screenshot dir].

Loads the page in Edge (Playwright), checks the trefoil's invariants, draws a
component, flips a crossing, builds a braid and runs Khovanov homology."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "screenshots")
OUT.mkdir(parents=True, exist_ok=True)

def text(page, sel):
    return page.inner_text(sel).replace("−", "-").replace("\n", " ").strip()

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.goto(URL)
    page.wait_for_function("document.querySelector('#jones').textContent.length > 0")
    jones = text(page, "#jones")
    print("trefoil Jones:", jones)
    assert jones == "t + t3 - t4", jones
    print("ident:", text(page, "#ident"))
    assert "3_1" in text(page, "#ident")
    page.screenshot(path=OUT / "trefoil.png")

    # Khovanov over Z
    page.click("#kh-go")
    page.wait_for_function("document.querySelector('#kh-status').textContent.includes('total rank')")
    print("Khovanov:", text(page, "#kh-status"))
    assert "total rank 4" in text(page, "#kh-status")
    assert "ℤ/2" in page.inner_text("#khovanov")
    page.locator(".results").screenshot(path=OUT / "khovanov.png")

    # flip one crossing of the trefoil: unknot
    page.click("circle.xmark >> nth=0")
    page.wait_for_function("document.querySelector('#jones').textContent.trim() === '1'")
    print("after flip:", text(page, "#ident"))

    # figure-eight from the table
    page.select_option("#library", "4_1")
    page.wait_for_function("document.querySelector('#ident').textContent.includes('4_1')")
    print("4_1:", text(page, "#ident"), "| det", text(page, "#stats"))
    page.screenshot(path=OUT / "figure8.png")

    # draw a pentagram by hand, then alternate: cinquefoil
    page.click("#clear")
    box = page.locator("#canvas").bounding_box()
    import math
    cx, cy, r = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, 180
    pts = [(cx + r * math.sin(4 * math.pi * k / 5), cy - r * math.cos(4 * math.pi * k / 5)) for k in range(5)]
    for x, y in pts:
        page.mouse.click(x, y)
    page.mouse.click(*pts[0])
    page.wait_for_function("document.querySelector('#stats').textContent.includes('crossings')")
    page.click("#alternate")
    page.wait_for_function("document.querySelector('#ident').textContent.includes('5_1')")
    print("pentagram:", text(page, "#ident"))
    page.screenshot(path=OUT / "pentagram.png")

    # phone layout
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(300)
    page.screenshot(path=OUT / "phone.png", full_page=True)
    browser.close()
    print("console errors:", errors)
    assert not errors
    print("OK")
