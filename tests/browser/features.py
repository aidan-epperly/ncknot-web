"""Browser test of twist boxes, families and layout:
python tests/browser/features.py [url] [screenshot dir]."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "screenshots")
OUT.mkdir(parents=True, exist_ok=True)


def text(page, sel):
    return page.inner_text(sel).replace("−", "-").replace("\n", " ").strip()


def wait_ident(page, needle):
    page.wait_for_function(f"document.querySelector('#ident').textContent.includes({needle!r})", timeout=10000)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    page = browser.new_page(viewport={"width": 1400, "height": 950})
    errors = []
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.goto(URL)
    wait_ident(page, "3_1")
    page.screenshot(path=OUT / "layout_3_1.png")
    for name in ["7_7", "8_19", "borromean"]:
        page.select_option("#library", name)
        wait_ident(page, name)
        page.locator("#canvas").screenshot(path=OUT / f"layout_{name}.png")
        print(name, "->", text(page, "#ident"))

    # two rectangles and a twist box on their facing sides
    page.click("#clear")
    box = page.locator("#canvas").bounding_box()
    x0, y0 = box["x"] + box["width"] / 2 - 160, box["y"] + 90
    for rect in [(x0, y0, 120, 300), (x0 + 200, y0, 120, 300)]:
        x, y, w, h = rect
        for px, py in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]:
            page.mouse.click(px, py)
        page.mouse.click(x, y)
    page.wait_for_function("document.querySelector('#stats').textContent.includes('components')")
    print("two rectangles:", text(page, "#ident"))
    page.click("button[data-mode=twist]")
    page.mouse.click(x0 + 120, y0 + 150)  # right side of the first
    page.mouse.click(x0 + 200, y0 + 150)  # left side of the second
    page.click("#sel-box")
    page.wait_for_selector("#box-panel:not([hidden])")
    wait_ident(page, "0_1")  # one half-twist: the unknot
    page.click("#box-plus")
    page.click("#box-plus")
    wait_ident(page, "3_1")
    print("n = 3:", text(page, "#ident"))
    page.check("#box-show")
    page.screenshot(path=OUT / "twist_box.png")
    page.fill("#fam-from", "1")
    page.fill("#fam-to", "6")
    page.click("#fam-go")
    page.wait_for_selector("#family table", timeout=20000)
    rows = page.locator("#family tr").all_inner_texts()
    for r in rows:
        print("  ", r.replace("\t", " | ").replace("−", "-"))
    dets = [r.split("\t")[2] for r in rows[1:]]
    assert dets == ["1", "2", "3", "4", "5", "6"], dets
    page.locator(".results").screenshot(path=OUT / "family.png")

    # tidy a braid closure
    page.select_option("#library", "")
    page.fill("#strands", "4")
    page.dispatch_event("#strands", "change")
    page.fill("#word", "1 -2 3 1 -2 3 -2 1 3 -2")
    page.click("#draw-braid")
    page.wait_for_function("document.querySelector('#stats').textContent.includes('10')")
    before = text(page, "#jones")
    page.click("#tidy")
    page.wait_for_timeout(400)
    assert text(page, "#jones") == before, (before, text(page, "#jones"))
    page.locator("#canvas").screenshot(path=OUT / "tidy.png")

    # a PD code is drawn
    page.click("summary:has-text('PD code')")
    page.fill("#pd-input", "X[1,4,2,5], X[3,6,4,1], X[5,2,6,3]")
    page.click("#use-pd")
    wait_ident(page, "3_1 (mirror)")
    print("PD:", text(page, "#ident"))
    assert page.locator("#banner").is_hidden()
    browser.close()
    print("console errors:", errors)
    assert not errors
    print("OK")
