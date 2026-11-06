/* Rover: a tiny rover drives over the empty parts of the page, following the background contour lines, and leaves wheel tracks that fade.
 * Drawn in three-quarter view (body and mast lifted above the wheels). Point at it and it stops and looks at you; click it and it pings.
 * It knows the terrain: WAVES is the same height function img/contours.svg was drawn from (a 1200x900 tile, centred, fixed to the window).
 * It steers around the text blocks (BLOCKS) and passes under them if they scroll over it.
 * Decoration only: the canvas takes no pointer events (it listens on the window), off when reduced motion is asked for.
 */
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const WAVES = [[-3,1,0.09661,2.1729],[-3,2,0.08541,1.8133],[-3,3,0.04578,2.1602],[-2,1,0.1462,6.1189],[-2,2,0.0597,2.7942],[-2,3,0.04192,2.1964],[-1,1,0.4193,2.069],[-1,2,0.12905,2.6365],[-1,3,0.07542,2.8099],[0,1,0.30799,2.7264],[0,2,0.1217,4.9808],[0,3,0.06987,1.234],[1,0,0.80431,1.8747],[1,1,0.29673,1.3814],[1,2,0.1091,4.9393],[1,3,0.06383,4.727],[2,0,0.26286,3.6888],[2,1,0.17723,2.4962],[2,2,0.09955,4.8835],[2,3,0.03601,5.8913],[3,0,0.09584,0.8741],[3,1,0.06495,2.1405],[3,2,0.04158,2.4998],[3,3,0.04208,4.1177]];
  const TW = 1200, TH = 900, SPEED = 30, LIFE = 14, TURN = 1.9, M = 40, SIZE = 2.1, LIFT = 3.6, REACH = 38;   // SIZE scales the drawing, LIFT = body height, REACH = how close the pointer must be
  const BLOCKS = '.intro, .globe, .hero .wrap, main > section, .tile, footer';   // what it drives around
  const canvas = document.createElement('canvas'); canvas.className = 'rover'; canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d'), rand = (a, b) => a + Math.random() * (b - a);
  let cw = 0, ch = 0, zone = null, col = {}, rects = [];

  // Height and slope of the terrain at a window position
  function terrain(x, y) {
    const u = (x - (cw / 2 - TW / 2)) / TW, v = y / TH; let h = 0, gx = 0, gy = 0;
    for (const [m, n, a, p] of WAVES) { const q = 2 * Math.PI * (m * u + n * v) + p, c = a * Math.cos(q) * 2 * Math.PI;
      h += a * Math.sin(q); gx += c * m / TW; gy += c * n / TH; }
    return { h, gx, gy, g: Math.max(Math.hypot(gx, gy), 1e-5) };
  }

  // Its ground is the window below the nav; the text blocks are obstacles (re-read as the page scrolls)
  function layout() {
    const dpr = Math.min(devicePixelRatio || 1, 2), first = !zone;
    cw = document.documentElement.clientWidth; ch = innerHeight;
    canvas.width = cw * dpr; canvas.height = ch * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const nav = document.querySelector('nav');
    zone = { x0: 10, x1: cw - 10, y0: (nav ? nav.offsetHeight : 0) + 10, y1: ch - 10 };
    const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue(n).trim();
    col = { ink: v('--ink') || '#fff', wheel: v('--muted') || '#999', panel: v('--violet') || '#a98bff', eye: v('--green') || '#3dffc0', bg: v('--bg') || '#000' };
    obstacles(); if (first) place();
  }
  function obstacles() {
    rects = [...document.querySelectorAll(BLOCKS)].map(el => el.getBoundingClientRect())
      .filter(r => r.bottom > -60 && r.top < ch + 60).map(r => ({ x0: r.left - 26, x1: r.right + 26, y0: r.top - 26, y1: r.bottom + 26 }));
  }
  // How hard, and which way, the obstacles and the window edges push at a point
  function pushAt(x, y) {
    let px = 0, py = 0;
    if (x < zone.x0 + M) px += (zone.x0 + M - x) / M; if (x > zone.x1 - M) px -= (x - zone.x1 + M) / M;
    if (y < zone.y0 + M) py += (zone.y0 + M - y) / M; if (y > zone.y1 - M) py -= (y - zone.y1 + M) / M;
    for (const r of rects) {
      const ox = Math.max(r.x0 - x, 0, x - r.x1), oy = Math.max(r.y0 - y, 0, y - r.y1), d = Math.hypot(ox, oy);
      if (d >= M) continue;
      if (d > 0) { const k = (M - d) / M / d; px += (x < r.x0 ? -ox : x > r.x1 ? ox : 0) * k; py += (y < r.y0 ? -oy : y > r.y1 ? oy : 0) * k; }
      else {                                                       // under a block: head for its nearest edge
        const e = [[x - r.x0, -1, 0], [r.x1 - x, 1, 0], [y - r.y0, 0, -1], [r.y1 - y, 0, 1]].sort((p, q) => p[0] - q[0])[0];
        px += e[1] * 1.6; py += e[2] * 1.6;
      }
    }
    return [px, py];
  }

  // State
  let x = 0, y = 0, th = 0, dir = 1, level = 0, pause = 0, nextWhim = 0, flipWait = 0, nextLook = 0, cross = 0, crossSign = 1, clock = 0, tracks = [], lastTrack = null;
  let ptr = null, held = false, ping = -9;                         // pointer position, is it on the rover, time of the last click on it
  function place() {
    for (let i = 0; i < 60; i++) {                                 // somewhere in the open
      x = rand(zone.x0 + M, zone.x1 - M); y = rand(zone.y0 + M, zone.y1 - M);
      const [px, py] = pushAt(x, y); if (!px && !py) break;
    }
    const t = terrain(x, y); level = t.h; dir = Math.random() < .5 ? 1 : -1;
    th = Math.atan2(t.gx * dir, -t.gy * dir); tracks = []; lastTrack = null; nextWhim = clock + rand(6, 12);
  }

  function step(dt) {
    clock += dt;
    while (tracks.length && clock - tracks[0].t > LIFE) tracks.shift();
    if (!zone) return;
    held = !!ptr && Math.hypot(ptr.x - x, ptr.y - y) < REACH;
    if (held) { pause = Math.max(pause, .7); return; }             // touched: stay put, and a moment longer after the pointer leaves
    if (pause > 0) { pause -= dt; return; }
    if (clock > nextWhim) {                                        // now and then: stop to look, or leave its line and cut across the slope
      nextWhim = clock + rand(6, 11); const r = Math.random();
      if (r < .3) pause = rand(1, 2.2);
      else if (r < .85) { cross = rand(2.5, 5.5); crossSign = Math.random() < .5 ? 1 : -1; if (Math.random() < .4) dir = -dir; }
    }
    const t = terrain(x, y);
    let dx = -t.gy / t.g * dir, dy = t.gx / t.g * dir;             // along the contour
    if (cross > 0) {                                               // cross-country: mostly up or down the slope, then settle on the line it reaches
      cross -= dt; level = t.h;
      dx = dx * .45 + t.gx / t.g * crossSign; dy = dy * .45 + t.gy / t.g * crossSign;
    } else {
      const off = Math.max(-1.2, Math.min(1.2, (level - t.h) / t.g / 14));   // steer back onto its line
      dx += t.gx / t.g * off; dy += t.gy / t.g * off;
    }
    if (clock > nextLook) { nextLook = clock + .4; obstacles(); }
    const [px, py] = pushAt(x, y);                                 // away from text blocks and window edges
    const push = Math.hypot(px, py);
    if (push > 0) {
      level = t.h; flipWait -= dt;                                 // crossing lines: adopt whichever one it is on
      if (push > .5 && dx * px + dy * py < -.3 * push && flipWait <= 0) { dir = -dir; flipWait = 2.5; }
      dx += px * 2.2; dy += py * 2.2;
    }
    let d = Math.atan2(dy, dx) - th; d = Math.atan2(Math.sin(d), Math.cos(d));
    th += Math.max(-TURN * dt, Math.min(TURN * dt, d));
    const v = SPEED * (1 - Math.min(Math.abs(d), 1.4) * .45);      // slows down in turns
    x += Math.cos(th) * v * dt; y += Math.sin(th) * v * dt;
    x = Math.max(zone.x0, Math.min(zone.x1, x)); y = Math.max(zone.y0, Math.min(zone.y1, y));
    if (!lastTrack || Math.hypot(x - lastTrack.x, y - lastTrack.y) > 5) { lastTrack = { x, y, th, t: clock }; tracks.push(lastTrack); }
  }

  function draw() {
    ctx.clearRect(0, 0, cw, ch);
    if (!zone) return;
    const W = 5.6 * SIZE;                                          // half the wheel track
    ctx.strokeStyle = col.ink; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    for (const p of tracks) {                                      // wheel tracks: two rows of tread marks
      const a = 1 - (clock - p.t) / LIFE; if (a <= 0) continue;
      ctx.globalAlpha = .75 * Math.min(1, a * 1.6); const s = Math.sin(p.th), c = Math.cos(p.th);
      for (const side of [-W, W]) { const mx = p.x - s * side, my = p.y + c * side;
        ctx.beginPath(); ctx.moveTo(mx - s * 2.6, my + c * 2.6); ctx.lineTo(mx + s * 2.6, my - c * 2.6); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    const since = clock - ping;                                    // click: a ring spreads from it
    if (since < 1.1) { ctx.globalAlpha = 1 - since / 1.1; ctx.strokeStyle = col.eye; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 14 + since * 60, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }

    // Three-quarter view: wheels on the ground, then the body drawn LIFT higher on screen with its side wall, then mast and antenna standing up
    const c = Math.cos(th), s = Math.sin(th), at = (px, py, up) => [px * c - py * s, px * s + py * c - up];   // body point -> screen offset
    const turned = (up, fn) => { ctx.save(); ctx.translate(0, -up); ctx.rotate(th); fn(); ctx.restore(); };
    const box = (bx, by, w, h, r) => { ctx.beginPath(); ctx.roundRect(bx, by, w, h, r); ctx.fill(); };
    ctx.save(); ctx.translate(x, y); ctx.scale(SIZE, SIZE);
    ctx.fillStyle = col.wheel;
    turned(0, () => { for (const wx of [-5.6, 0, 5.6]) for (const wy of [-5.6, 5.6]) box(wx - 2.3, wy - 1.6, 4.6, 3.2, 1.3); });
    for (let up = .6; up < LIFT; up += .6) turned(up, () => box(-6.6, -3.9, 13.2, 7.8, 2.6));                // side wall
    ctx.fillStyle = col.ink; turned(LIFT, () => box(-6.6, -3.9, 13.2, 7.8, 2.6));                            // deck
    ctx.fillStyle = col.panel; turned(LIFT, () => box(-5.2, -2.6, 5.6, 5.2, 1));                             // solar panel
    ctx.strokeStyle = col.ink; ctx.lineCap = 'round';
    const [ax, ay] = at(-5.2, -3, LIFT), wag = held ? Math.sin(clock * 16) * 1.2 : 0;                        // antenna: wags when touched
    ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + wag, ay - 7); ctx.stroke();
    ctx.fillStyle = col.ink; ctx.beginPath(); ctx.arc(ax + wag, ay - 7, 1, 0, 7); ctx.fill();
    const [mx, my] = at(3.4, 0, LIFT), hy = my - 6.5;                                                         // mast and camera head
    ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx, hy); ctx.stroke();
    ctx.beginPath(); ctx.arc(mx, hy, 3.3, 0, 7); ctx.fill();
    ctx.fillStyle = col.bg; ctx.beginPath(); ctx.arc(mx, hy, 2.5, 0, 7); ctx.fill();
    // Eye: looks where it is going, around when stopped, at the pointer when touched; blinks
    const gaze = held ? Math.atan2(ptr.y - y, ptr.x - x) : th + (pause > 0 ? Math.sin(clock * 3.2) * 1.1 : 0), blink = !held && (clock % 4.3) < .13;
    if (!blink) { ctx.fillStyle = col.eye; ctx.shadowColor = col.eye; ctx.shadowBlur = held ? 12 : 6;
      ctx.beginPath(); ctx.arc(mx + Math.cos(gaze) * 1.1, hy + Math.sin(gaze) * .9, held ? 1.5 : 1.25, 0, 7); ctx.fill(); }
    ctx.restore();
  }

  let last = 0, raf = 0;
  function frame(now) {
    raf = 0; const dt = Math.min((now - last) / 1000 || 0, .05); last = now;
    step(dt); draw();
    if (!document.hidden) raf = requestAnimationFrame(frame);
  }
  const start = () => { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } };
  // Touching it: mouse or pen hovering on it holds it still; a click or tap on it also makes it ping and wait
  addEventListener('pointermove', e => { ptr = e.pointerType === 'touch' ? null : { x: e.clientX, y: e.clientY }; }, { passive: true });
  addEventListener('pointerdown', e => { if (Math.hypot(e.clientX - x, e.clientY - y) < REACH + 8) { ping = clock; pause = Math.max(pause, 2.5); } }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { ptr = null; });
  addEventListener('resize', layout); addEventListener('scroll', obstacles, { passive: true }); document.addEventListener('visibilitychange', start);
  layout(); start();
})();
