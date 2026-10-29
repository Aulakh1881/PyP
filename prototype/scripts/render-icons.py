"""Renders the extension icons (and the website favicon) from shared/pyp-figure.js.

    pip install playwright && python scripts/render-icons.py

Uses headless Chromium so the icons match the exact Pyp drawing used in the UI.
"""
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIGURE = (ROOT / "shared" / "pyp-figure.js").read_text()

PAGE = """<!doctype html><html><body style="margin:0;background:transparent">
<div id="i" style="display:flex;align-items:center;justify-content:center"></div>
<script>%s</script>
<script>
function draw(px){
  var el=document.getElementById('i'); el.style.width=px+'px'; el.style.height=px+'px';
  var w=Math.round(px*0.80);
  el.innerHTML=PypFigure.svg({size:w,mode:'idle',label:''});
}
</script></body></html>""" % FIGURE

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(device_scale_factor=1)
    pg.set_content(PAGE)
    outs = [(16, ROOT / "extension/icons/icon-16.png"), (32, ROOT / "extension/icons/icon-32.png"),
            (48, ROOT / "extension/icons/icon-48.png"), (128, ROOT / "extension/icons/icon-128.png"),
            (64, ROOT / "website/assets/favicon.png")]
    for px, path in outs:
        path.parent.mkdir(parents=True, exist_ok=True)
        pg.evaluate("px => draw(px)", px)
        pg.locator("#i").screenshot(path=str(path), omit_background=True)
        print("wrote", path.relative_to(ROOT))
    b.close()
