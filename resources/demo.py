#!/usr/bin/env python3
"""Record the README demo: drive the Tav app in a headless browser and save
frames, then build resources/demo.webp. Needs the server running on :8060
and the project .venv with playwright (`.venv/bin/python -m playwright install chromium`).

  .venv/bin/python resources/demo.py
"""
import io, os, time
from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'resources', 'demo.webp')
URL = os.environ.get('TAV', 'http://127.0.0.1:8060') + '/tav-app.html'
W, H, SCALE = 1440, 900, 1200 / 1440
SPEED = 2   # playback speed of the finished video
frames = []   # (PIL image, milliseconds)

CURSOR = """
(() => { const c = document.createElement('div'); c.id = 'democursor';
c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:99999;pointer-events:none;transform:translate(-2px,-2px)';
c.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>';
document.body.appendChild(c); window.__cur = (x, y, down) => { c.style.left = x + 'px'; c.style.top = y + 'px'; c.style.transform = down ? 'translate(-2px,-2px) scale(.8)' : 'translate(-2px,-2px)'; }; })()
"""


def main():
    with sync_playwright() as p:
        br = p.chromium.launch()
        pg = br.new_page(viewport={'width': W, 'height': H}, device_scale_factor=1)
        pg.goto(URL); pg.wait_for_selector('#home:not([hidden])'); pg.wait_for_timeout(2500)
        pg.evaluate(CURSOR)
        cx, cy = W // 2, H // 2
        down = {'v': False}

        def shot(ms=120, n=1):
            for _ in range(n):
                frames.append((Image.open(io.BytesIO(pg.screenshot())).convert('RGB'), ms))

        def move(x, y, steps=12, ms=40):
            nonlocal cx, cy
            for i in range(1, steps + 1):
                px, py = cx + (x - cx) * i / steps, cy + (y - cy) * i / steps
                pg.mouse.move(px, py); pg.evaluate('([x,y,d])=>__cur(x,y,d)', [px, py, down['v']]); shot(ms)
            cx, cy = x, y

        def click(sel=None, xy=None, hold=700):
            if sel:
                b = pg.locator(sel).first.bounding_box(); xy = (b['x'] + b['width'] / 2, b['y'] + b['height'] / 2)
            move(*xy); down['v'] = True; pg.evaluate('([x,y,d])=>__cur(x,y,d)', [cx, cy, True]); shot(90)
            pg.mouse.click(cx, cy); down['v'] = False; pg.evaluate('([x,y,d])=>__cur(x,y,d)', [cx, cy, False]); shot(hold)

        def hold(ms, every=250):
            t0 = time.time()
            while time.time() - t0 < ms / 1000: shot(every); pg.wait_for_timeout(every)

        # 1 · the map, then search a place
        shot(1800)
        click('#q', hold=300)
        for ch in 'Marius': pg.keyboard.type(ch); shot(110)
        pg.wait_for_selector('#results li'); shot(900)
        exact = pg.locator('#results li').filter(has_text='Crater').first
        click('#results li:has(small:text-is("Crater · 40.1 km"))' if exact.count() else '#results li', hold=400); pg.wait_for_timeout(2600); shot(1200)
        click('#zin', hold=700); pg.wait_for_timeout(700); shot(900)

        # 2 · draw a rectangle
        m = pg.locator('#map').bounding_box(); mx, my = m['x'] + m['width'] / 2, m['y'] + m['height'] / 2
        click('#draw-rect', hold=600)
        x0, y0, x1, y1 = mx - 150, my - 105, mx + 150, my + 105
        move(x0, y0); down['v'] = True; pg.mouse.down(); pg.evaluate('([x,y,d])=>__cur(x,y,d)', [cx, cy, True]); shot(200)
        move(x1, y1, steps=22, ms=45); pg.mouse.up(); down['v'] = False; pg.evaluate('([x,y,d])=>__cur(x,y,d)', [cx, cy, False])
        pg.wait_for_selector('#choose:not([hidden])'); pg.wait_for_selector('#c-layers li'); pg.wait_for_timeout(800); shot(1600)

        # 3 · choose and download
        click('#c-detail button[data-px="2048"]', hold=700)
        click('#capture', hold=400)
        pg.wait_for_selector('#detail:not([hidden])')
        t0 = time.time()
        while time.time() - t0 < 240:   # the real wait, shown as a time-lapse
            shot(140); pg.wait_for_timeout(700)
            if pg.evaluate("document.getElementById('d-prog').hidden") and pg.locator('#d-layers li').count() > 0: break
        pg.wait_for_timeout(800); shot(1500)

        # 4 · toggle layers on the map
        def toggle(text, hold=1300):
            cb = pg.locator('#d-layers li', has_text=text).first.locator('input')
            b = cb.bounding_box() if cb.count() else None
            if b: click(xy=(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2), hold=hold)
        toggle('Elevation'); toggle('Elevation', 400); toggle('Night temperature'); toggle('Night temperature', 400); toggle('Gravity'); toggle('Gravity', 400)

        # 5 · the 3D mesh
        if pg.locator('#d-3d-btn').is_visible():
            click('#d-3d-btn', hold=300)
            try:
                pg.wait_for_selector('#three:not([hidden])', timeout=120000); pg.wait_for_timeout(2500); shot(1200)
                c = pg.locator('#t-canvas').bounding_box(); tx, ty = c['x'] + c['width'] / 2, c['y'] + c['height'] / 2
                move(tx, ty, steps=6); down['v'] = True; pg.mouse.down(); move(tx + 260, ty + 40, steps=26, ms=50); pg.mouse.up(); down['v'] = False
                shot(900); click('#t-close', hold=800)
            except Exception as e: print('3D skipped:', e)

        # 6 · a point on the map
        pts = pg.locator('#map .pt')
        if pts.count():
            best = None
            for i in range(min(pts.count(), 150)):
                b = pts.nth(i).bounding_box()
                if b and m['x'] + 60 < b['x'] < m['x'] + m['width'] - 60 and m['y'] + 80 < b['y'] < m['y'] + m['height'] - 80: best = b; break
            if best:
                click(xy=(best['x'] + 9, best['y'] + 9), hold=300)
                try: pg.wait_for_function("document.getElementById('v-img').complete && document.getElementById('v-img').naturalWidth > 0", timeout=90000)
                except Exception as e: print('viewer:', e)
                pg.wait_for_timeout(600); shot(2600)
                click('#v-close', hold=1000)
        shot(1800)
        br.close()

    imgs = [f.resize((int(W * SCALE), int(H * SCALE)), Image.LANCZOS) for f, _ in frames]
    imgs[0].save(OUT, save_all=True, append_images=imgs[1:], duration=[max(20, d // SPEED) for _, d in frames], loop=0, quality=72, method=4)
    print(f'{OUT}: {len(frames)} frames, {sum(d for _, d in frames) / 1000:.1f} s, {os.path.getsize(OUT) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
