"""The Kirby tab: python tests/browser/kirby.py [url] [screenshot dir].

Loads the example family, cancels its dotted circle, tabulates members and
gets a PD code; then draws a diagram by hand; then checks that the
Workbench tab still works."""
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "screenshots")
OUT.mkdir(parents=True, exist_ok=True)


def wait_summary(page, before):
    page.wait_for_function(f"kirbyTab.summaries() > {before}", timeout=15000)
    return page.evaluate("kirbyTab.summary()")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    page = browser.new_page(viewport={"width": 1400, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.reload()
    page.click("#tab-btn-kirby")
    assert page.is_visible("#k-canvas") and not page.is_visible("#canvas")

    # the example: R dotted, G and B 0-framed
    n0 = page.evaluate("kirbyTab.summaries()")
    page.click("#k-example")
    s = wait_summary(page, n0)
    assert s, page.inner_text("#k-status")
    hs = {h["name"]: h for h in s["stages"][0]["handles"]}
    assert hs["G"]["writhe"] == "n" and hs["B"]["writhe"] == "m", hs
    print("example:", page.inner_text("#k-status"))

    def viewbox():
        return [float(v) for v in page.get_attribute("#k-canvas", "viewBox").split()]

    def all_points_inside():
        x, y, w, h = viewbox()
        pts = page.evaluate("kirbyTab.state().points.map(p => [p.x, p.y])")
        return all(x <= px <= x + w and y <= py <= y + h for px, py in pts), w

    # Fit: zoom far in, then Fit shows the whole drawing again
    box = page.locator("#k-canvas").bounding_box()
    page.mouse.move(box["x"] + 200, box["y"] + 200)
    for _ in range(8):
        page.mouse.wheel(0, -400)
    assert not all_points_inside()[0]
    page.click("#k-fit")
    inside, w = all_points_inside()
    assert inside and w < 1600, viewbox()
    print("fit:", viewbox())
    # pan with Space + drag, in Draw mode
    before = viewbox()
    nsegs = page.evaluate("kirbyTab.state().segs.length")
    page.keyboard.down(" ")
    page.mouse.move(box["x"] + 300, box["y"] + 300)
    page.mouse.down()
    page.mouse.move(box["x"] + 400, box["y"] + 350, steps=5)
    page.mouse.up()
    page.keyboard.up(" ")
    after = viewbox()
    assert after[0] < before[0] - 50 and after[1] < before[1] - 20, (before, after)
    assert page.evaluate("kirbyTab.state().segs.length") == nsegs  # nothing was drawn
    # arrow keys pan too
    page.keyboard.press("ArrowRight")
    assert viewbox()[0] > after[0]
    page.click("#k-fit")
    page.screenshot(path=OUT / "kirby_example.png")

    # cancel R with B
    n0 = page.evaluate("kirbyTab.summaries()")
    page.select_option("#k-move-dotted", "R")
    page.select_option("#k-move-handle", "B")
    page.click("#k-move-add")
    s = wait_summary(page, n0)
    assert len(s["stages"]) == 2, s
    g = s["stages"][1]["handles"][0]
    assert (g["name"], g["framing"], g["writhe"]) == ("G", "0", "2*n*m + n + m"), g
    print("after the cancellation:", g)

    # the members' table: n 1..4, m odd in -5..5
    page.fill("#k-alex", "30")
    page.click("#k-table-go")
    page.wait_for_selector("#k-table table", timeout=60000)
    rows = page.locator("#k-table tr").all_inner_texts()
    assert len(rows) == 1 + 4 * 6, len(rows)
    for r in rows[1:]:
        cells = r.split("\t")
        n, m, bound = int(cells[0]), int(cells[1]), int(cells[8])
        want = m - 2 * n - 1 if m > 0 else 6 * n * m - m - 2 * n - 1
        assert bound == want, (r, want)
    print("table:", len(rows) - 1, "members; first:", rows[1].replace("\t", " | ")[:100])
    page.locator("#k-table").screenshot(path=OUT / "kirby_table.png")

    # a PD code
    page.fill("#k-values input[data-name=n]", "1")
    page.fill("#k-values input[data-name=m]", "1")
    page.click("#k-pd-go")
    page.wait_for_function("document.querySelector('#k-pd').textContent.startsWith('X[')", timeout=15000)
    print("PD code:", page.inner_text("#k-pd-status"))
    assert page.inner_text("#k-pd-status").startswith("28 crossings, 1 component")

    # draw by hand: clear, then a square with one kink that crosses itself
    page.click("#k-clear")
    page.click("button[data-kmode=draw]")

    def click(x, y):
        q = page.evaluate(f"kirbyTab.toScreen({x}, {y})")
        page.mouse.click(q["x"], q["y"])

    page.click("#k-fit")
    n0 = page.evaluate("kirbyTab.summaries()")
    for x, y in [(300, 300), (700, 300), (700, 700), (400, 700), (400, 200), (300, 200)]:
        click(x, y)
    click(300, 300)  # back to the start: the strand ends there
    s = wait_summary(page, n0)
    assert s, page.inner_text("#k-status")
    k = s["stages"][0]["handles"][0]
    assert k["writhe"] in ("1", "-1"), k
    print("drawn by hand: K with writhe", k["writhe"])
    # flip the crossing in edit mode
    page.click("button[data-kmode=edit]")
    n0 = page.evaluate("kirbyTab.summaries()")
    click(400, 300)
    s2 = wait_summary(page, n0)
    assert s2["stages"][0]["handles"][0]["writhe"] == str(-int(k["writhe"])), s2
    # drag the whole strand by one of its segments
    before = page.evaluate("kirbyTab.state().points.map(p => [p.x, p.y])")
    q0 = page.evaluate("kirbyTab.toScreen(550, 700)")
    q1 = page.evaluate("kirbyTab.toScreen(600, 700)")
    page.mouse.move(q0["x"], q0["y"])
    page.mouse.down()
    page.mouse.move(q1["x"], q1["y"], steps=5)
    page.mouse.up()
    after = page.evaluate("kirbyTab.state().points.map(p => [p.x, p.y])")
    shifts = {(b[0] - a[0], b[1] - a[1]) for a, b in zip(before, after)}
    assert len(shifts) == 1 and abs(list(shifts)[0][0] - 50) <= 1, shifts
    print("dragged the strand by", shifts)
    page.screenshot(path=OUT / "kirby_drawn.png")

    # the workbench is untouched and still computes
    page.click("#tab-btn-workbench")
    assert page.is_visible("#canvas") and not page.is_visible("#k-canvas")
    page.select_option("#library", "3_1")
    page.wait_for_function("document.querySelector('#stats .stat .v')?.textContent === '3'", timeout=15000)
    print("workbench: trefoil OK")
    browser.close()
    assert not errors, errors
    print("OK")
