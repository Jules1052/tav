/* Page 02 animations: how each mapping tool works. One <canvas id> per scene, all schematic.
 * Every scene is a pure function of time t (seconds, looping), so reduced motion just draws one finished frame.
 * Colours follow the tokens of the night cards in style.css (.night), the same in both themes: the card is black, so light = lit and black = shadow.
 */
(() => {
  const root = document.documentElement;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const W = 560, TAU = Math.PI * 2;

  let c = {}, ctx;
  const readColors = () => {
    const s = getComputedStyle(document.querySelector('.night') || root), v = n => s.getPropertyValue(n).trim();
    c = { ink: v('--ink'), muted: v('--muted'), line: v('--line'), accent: v('--violet'),
          blue: v('--blue'), pink: v('--pink'), green: v('--green'), mono: v('--mono') };
  };
  readColors();

  /* Helpers ------------------------------------------------------------- */
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const ease = p => p * p * (3 - 2 * p);
  const gauss = (x, m, w) => Math.exp(-(((x - m) / w) ** 2));

  // Mono label. raw = keep case (units such as µm, symbols such as i).
  const label = (t, x, y, color = c.muted, align = 'left', raw = false) => {
    ctx.font = `500 14px ${c.mono}`; ctx.textAlign = align; ctx.fillStyle = color;
    if ('letterSpacing' in ctx) ctx.letterSpacing = raw ? '.4px' : '1.4px';
    ctx.fillText(raw ? t : t.toUpperCase(), x, y);
  };
  const seg = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  const circle = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); };
  const stroke = (color, width = 1.2, dash = []) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); };
  const withAlpha = (a, fn) => { const p = ctx.globalAlpha; ctx.globalAlpha = p * a; fn(); ctx.globalAlpha = p; };
  // Rock: ink tint fading with depth. cut() removes a void from whatever is already drawn.
  const rock = (path, y0, y1) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, c.ink); g.addColorStop(1, 'transparent');
    ctx.save(); ctx.globalAlpha = .13; ctx.fillStyle = g; path(); ctx.fill(); ctx.restore();
  };
  const cut = path => { ctx.save(); ctx.globalCompositeOperation = 'destination-out'; path(); ctx.fill(); ctx.restore(); };
  // A pit seen from above: the up-Sun rim (left) throws a shadow `shift` long onto the floor.
  const pitTop = (x, y, r, shift) => {
    cut(() => circle(x, y, r));
    ctx.save(); circle(x, y, r); ctx.clip();
    ctx.fillStyle = c.ink; ctx.globalAlpha *= .34; circle(x + shift, y, r); ctx.fill();
    ctx.restore();
    stroke(c.ink, 1.2); circle(x, y, r); ctx.stroke();
  };
  const photo = (x, y, w, h) => {                  // a patch of sunlit ground as a camera sees it
    ctx.fillStyle = c.ink; withAlpha(.2, () => ctx.fillRect(x, y, w, h));
    stroke(c.line, 1); ctx.strokeRect(x + .5, y + .5, w, h);
  };
  const sunlit = pts => {                          // the part of a hole that sunlight reaches
    ctx.fillStyle = c.pink;
    withAlpha(.22, () => { ctx.beginPath(); pts.forEach(p => ctx.lineTo(p[0], p[1])); ctx.fill(); });
  };
  const crater = (x, y, r) => {
    ctx.fillStyle = c.ink; withAlpha(.05, () => { circle(x, y, r); ctx.fill(); });
    stroke(c.ink, 1); withAlpha(.45, () => { circle(x, y, r); ctx.stroke(); });
  };
  const sat = (x, y) => {
    ctx.fillStyle = c.ink;
    ctx.fillRect(x - 5, y - 4, 10, 8); ctx.fillRect(x - 17, y - 2, 10, 4); ctx.fillRect(x + 7, y - 2, 10, 4);
  };

  /* Scene runner -------------------------------------------------------- */
  const scenes = [];
  const scene = (id, H, period, endT, draw) => {
    const cv = document.getElementById(id);
    if (cv) scenes.push({ cv, g: cv.getContext('2d'), H, period, endT, draw, on: true });
  };
  const fit = s => {
    const w = s.cv.getBoundingClientRect().width, d = Math.min(devicePixelRatio || 1, 2);
    s.cv.width = Math.round(w * d); s.cv.height = Math.round(w * s.H / W * d);
  };
  const paint = (s, t) => {
    ctx = s.g;
    const k = s.cv.width / W;
    ctx.setTransform(k, 0, 0, k, 0, 0); ctx.clearRect(0, 0, W, s.H);
    ctx.globalAlpha = 1; ctx.lineJoin = ctx.lineCap = 'round'; ctx.setLineDash([]);
    s.draw(t, 1 - prog(t, s.period - .7, s.period));          // second argument: fade-out before the loop restarts
  };

  /* 1. Unmixing: every pixel's spectrum is split into the minerals that make it up ---------- */
  const MINERALS = [
    { name: 'Pyroxene', ink: 'pink', f: l => (.24 + .1 * (l - .5)) * (1 - .55 * gauss(l, .95, .13) - .42 * gauss(l, 2.05, .32)) },
    { name: 'Olivine', ink: 'green', f: l => (.22 + .12 * (l - .5)) * (1 - .55 * gauss(l, 1.05, .25)) },
    { name: 'Plagioclase', ink: 'blue', f: l => (.42 + .08 * (l - .5)) * (1 - .16 * gauss(l, 1.25, .2)) },
  ];
  const N = 6, CELL = 26, STEP = .3;
  const mixOf = i => {
    const col = i % N, row = (i / N) | 0;
    const a = [1 + Math.sin(col * .9 + row * .5), 1 + Math.sin(col * .6 - row * 1.1 + 2), .6 + .9 * Math.cos(col * .5 + row * .8 + 1)]
      .map(v => Math.max(.05, v) ** 2);
    const sum = a[0] + a[1] + a[2];
    return a.map(v => v / sum);
  };
  scene('viz-unmix', 270, 14, 12, (t, fade) => {
    const total = N * N, done = t >= total * STEP, n = Math.min(total - 1, Math.floor(t / STEP));
    const cur = mixOf(n), prev = mixOf(Math.max(0, n - 1)), p = done ? 1 : ease(prog(t - n * STEP, 0, STEP * .6));
    const a = cur.map((v, i) => prev[i] + (v - prev[i]) * p);

    // Image cube: grey until the pixel is processed, then the ink of its dominant mineral
    label('M³ image cube', 24, 56);
    for (let i = 0; i < total; i++) {
      const x = 24 + (i % N) * CELL, y = 70 + ((i / N) | 0) * CELL, m = mixOf(i);
      if (i < n || done) {
        const top = m.indexOf(Math.max(...m));
        ctx.fillStyle = c[MINERALS[top].ink];
        withAlpha((.25 + .65 * m[top]) * fade, () => ctx.fillRect(x, y, CELL, CELL));
      } else {
        ctx.fillStyle = c.ink; withAlpha(.05 + .12 * m[2], () => ctx.fillRect(x, y, CELL, CELL));
      }
      stroke(c.line, 1); ctx.strokeRect(x + .5, y + .5, CELL, CELL);
    }
    if (!done) { stroke(c.accent, 2); ctx.strokeRect(24 + (n % N) * CELL, 70 + ((n / N) | 0) * CELL, CELL, CELL); }
    label('Top mineral', 24, 244);

    // Spectrum of the current pixel (ink) and the three mineral spectra it is the sum of
    const px = l => 215 + (l - .5) / 2.5 * 170, py = r => 226 - r / .62 * 156;
    label('Pixel spectrum', 215, 56);
    stroke(c.line, 1); seg(215, 70, 215, 226); seg(215, 226, 385, 226);
    const curve = f => { ctx.beginPath(); for (let l = .5; l <= 3.001; l += .025) ctx.lineTo(px(l), py(f(l))); ctx.stroke(); };
    MINERALS.forEach((m, i) => { stroke(c[m.ink], 1.2); withAlpha(.9, () => curve(l => a[i] * m.f(l))); });
    stroke(c.ink, 1.8); curve(l => MINERALS.reduce((s, m, i) => s + a[i] * m.f(l), 0));
    label('0.5 µm', 215, 244, c.muted, 'left', true); label('3.0 µm', 385, 244, c.muted, 'right', true);

    // Output: the share of each mineral
    label('Estimated mix', 420, 56);
    MINERALS.forEach((m, i) => {
      const y = 92 + i * 48;
      label(m.name, 420, y, c[m.ink]);
      stroke(c.line, 1); ctx.strokeRect(420.5, y + 7.5, 74, 10);
      ctx.fillStyle = c[m.ink]; ctx.fillRect(421, y + 8, 73 * a[i], 9);
      label(Math.round(a[i] * 100) + '%', 544, y + 17, c.ink, 'right');
    });
    label('→', 193, 152); label('→', 398, 152);
  });

  /* 2. PitScan: with the Sun high, only steep-walled holes and rocks still cast shadows ---------- */
  scene('viz-pitscan', 380, 10.5, 9, (t, fade) => {
    const TAN = Math.tan(25 * Math.PI / 180), SURF = 110, FLOOR = 185;
    const bowl = x => SURF + (Math.abs(x - 150) < 42 ? 14 * (1 - ((x - 150) / 42) ** 2) : 0);
    const profile = () => {                        // surface line with the crater, the rock and the pit
      ctx.moveTo(0, SURF);
      for (let x = 4; x <= 258; x += 4) ctx.lineTo(x, bowl(x));
      ctx.quadraticCurveTo(270, SURF - 32, 282, SURF);
      ctx.lineTo(365, SURF); ctx.lineTo(365, FLOOR); ctx.lineTo(435, FLOOR); ctx.lineTo(435, SURF); ctx.lineTo(W, SURF);
    };
    rock(() => { ctx.beginPath(); profile(); ctx.lineTo(W, 208); ctx.lineTo(0, 208); }, SURF, 208);
    sunlit([[365, SURF], [435, SURF], [435, FLOOR], [365 + (FLOOR - SURF) * TAN, FLOOR]]);   // the rest of the pit stays black
    stroke(c.ink, 1.3); ctx.beginPath(); profile(); ctx.stroke();

    stroke(c.pink, 1, [2, 5]);                     // sunlight, 25° from vertical
    for (const [x, y] of [[60, SURF], [150, SURF + 14], [225, SURF], [330, SURF], [420, FLOOR], [500, SURF]])
      withAlpha(.7, () => seg(x - (y - 34) * TAN, 34, x, y));
    label('Sun high in the sky', 20, 22, c.pink);
    label('Fully lit crater', 150, 150, c.muted, 'center');
    label('Rock', 270, 136, c.muted, 'center');
    label('Pit', 448, 140); label('in shadow', 448, 158);

    // The same scene as the camera sees it
    label('Orbital image of the same ground', 20, 236);
    photo(20, 246, 520, 100);
    crater(150, 296, 42); crater(60, 318, 8); crater(215, 325, 7); crater(330, 270, 9); crater(495, 280, 10);
    cut(() => { ctx.beginPath(); ctx.ellipse(283, 296, 7, 5, 0, 0, TAU); });      // rock: bright face, black shadow behind it
    ctx.fillStyle = c.ink; withAlpha(.7, () => { circle(270, 296, 9); ctx.fill(); });
    pitTop(400, 296, 35, 35);

    const sx = 20 + 520 * prog(t, .5, 7.5);
    if (t < 7.5) { stroke(c.accent, 1.6); seg(sx, 242, sx, 350); }
    withAlpha(fade, () => {
      if (sx > 198) label('No shadow', 150, 366, c.muted, 'center');
      if (sx > 294) { stroke(c.muted, 1.2, [3, 4]); ctx.strokeRect(254.5, 280.5, 42, 31); label('Ignored', 270, 366, c.muted, 'center'); }
      if (sx > 441) { stroke(c.accent, 1.8); ctx.strokeRect(357.5, 253.5, 85, 85); label('Candidate', 400, 366, c.accent, 'center'); }
    });
  });

  /* 3. PITS: depth from the length of the shadow and the height of the Sun ---------- */
  scene('viz-pits', 360, 9, 1.5, t => {
    const RIM = 170, SURF = 80, DEPTH = 130, FLOOR = SURF + DEPTH, PX_PER_M = 1.3;
    const deg = 27.5 + 12.5 * Math.sin(t / 9 * TAU), i = deg * Math.PI / 180, L = DEPTH * Math.tan(i);
    const hole = () => { ctx.beginPath(); ctx.rect(RIM, SURF - 1, DEPTH, DEPTH + 1); };
    rock(() => { ctx.beginPath(); ctx.rect(0, SURF, W, 160); }, SURF, 240);
    cut(hole);
    sunlit([[RIM, SURF], [RIM + DEPTH, SURF], [RIM + DEPTH, FLOOR], [RIM + L, FLOOR]]);
    label('Shadow', RIM + 8, FLOOR - 10);
    stroke(c.ink, 1.3);
    seg(0, SURF, RIM, SURF); seg(RIM + DEPTH, SURF, W, SURF);
    ctx.beginPath(); ctx.moveTo(RIM, SURF); ctx.lineTo(RIM, FLOOR); ctx.lineTo(RIM + DEPTH, FLOOR); ctx.lineTo(RIM + DEPTH, SURF); ctx.stroke();

    // Sunlight: the ray that grazes the rim marks the edge of the shadow
    const sx = Math.sin(i), sy = Math.cos(i);
    stroke(c.pink, 1, [2, 5]);
    for (const x of [90, 420]) withAlpha(.7, () => seg(x - 62 * sx / sy, SURF - 62, x, SURF));
    stroke(c.pink, 1.7); seg(RIM - 74 * sx, SURF - 74 * sy, RIM + L, FLOOR);
    stroke(c.muted, 1, [2, 4]); seg(RIM, SURF, RIM, SURF - 66);
    stroke(c.pink, 1.2); ctx.beginPath(); ctx.arc(RIM, SURF, 36, -Math.PI / 2 - i, -Math.PI / 2); ctx.stroke();
    label('i', RIM - 48 * Math.sin(i / 2) - 2, SURF - 48 * Math.cos(i / 2) + 4, c.pink, 'center', true);
    label('Sun', 20, 24, c.pink);

    // What is measured (L) and what is wanted (h)
    stroke(c.accent, 1.6); seg(RIM, FLOOR + 12, RIM + L, FLOOR + 12); seg(RIM, FLOOR + 8, RIM, FLOOR + 16); seg(RIM + L, FLOOR + 8, RIM + L, FLOOR + 16);
    label('L', RIM + L / 2, FLOOR + 27, c.accent, 'center', true);
    stroke(c.muted, 1.2); seg(RIM + DEPTH + 14, SURF, RIM + DEPTH + 14, FLOOR); seg(RIM + DEPTH + 10, SURF, RIM + DEPTH + 18, SURF); seg(RIM + DEPTH + 10, FLOOR, RIM + DEPTH + 18, FLOOR);
    label('h', RIM + DEPTH + 24, SURF + DEPTH / 2 + 4, c.muted, 'left', true);

    // The image the tool actually gets, and the arithmetic
    const k = 42 / (DEPTH / 2);
    label('Seen from orbit', 20, 309);
    pitTop(235, 305, 42, L * k);
    stroke(c.accent, 1.6); seg(193, 305, 193 + L * k, 305);
    [['Sun angle i', deg.toFixed(0) + '°', c.ink], ['Shadow L', (L / PX_PER_M).toFixed(0) + ' m', c.accent],
     ['Depth = L / tan i', (L / Math.tan(i) / PX_PER_M).toFixed(0) + ' m', c.ink]].forEach(([name, value, color], n) => {
      const y = 284 + n * 26;
      label(name, 330, y, c.muted, 'left', n === 2 ? true : false);
      label(value, 540, y, color, 'right', true);
      stroke(c.line, 1); seg(330, y + 8, 540, y + 8);
    });
  });

  /* 4. ESSA: a network learns what known pits look like, then scores every patch of a new image ---------- */
  scene('viz-essa', 310, 13, 11, (t, fade) => {
    const training = t < 4;
    label('Training set', 20, 40);
    for (let n = 0; n < 9; n++) {
      const x = 20 + (n % 3) * 44, y = 54 + ((n / 3) | 0) * 44, hot = training && Math.floor(t / .44) % 9 === n;
      ctx.fillStyle = c.ink; withAlpha(.2, () => ctx.fillRect(x, y, 38, 38));
      pitTop(x + 17 + (n * 5) % 7, y + 17 + (n * 3) % 6, 7 + n % 4, 5 + n % 3);
      stroke(hot ? c.accent : c.line, hot ? 1.8 : 1); ctx.strokeRect(x + .5, y + .5, 38, 38);
      if (hot) { const p = (t / .44) % 1; ctx.fillStyle = c.accent; circle(x + 38 + (196 - x - 38) * p, y + 19 + (117 - y - 19) * p, 3); ctx.fill(); }
    }
    label('Known pits', 20, 202); label('Moon and Mars', 20, 218);

    // Network
    const layers = [4, 5, 3].map((count, l) => Array.from({ length: count }, (_, n) => [200 + l * 45, 117 + (n - (count - 1) / 2) * 26]));
    stroke(training ? c.accent : c.muted, 1);
    for (let l = 0; l < 2; l++) for (const [x0, y0] of layers[l]) for (const [x1, y1] of layers[l + 1])
      withAlpha(training ? .22 + .2 * Math.sin(t * 6 + x0 + y0 + y1) : .28, () => seg(x0, y0, x1, y1));
    ctx.fillStyle = c.ink; for (const [x, y] of layers.flat()) { circle(x, y, 3.6); ctx.fill(); }
    label('Model', 245, 40, c.muted, 'center');
    label(training ? 'Learning' : 'Searching', 245, 202, training ? c.accent : c.muted, 'center');
    label('→', 312, 121);

    // New image, scanned window by window
    label('New image', 340, 40);
    photo(340, 54, 200, 200);
    crater(385, 100, 22); crater(500, 95, 12); crater(470, 215, 16); crater(372, 222, 9);
    cut(() => { ctx.beginPath(); ctx.ellipse(392, 165, 6, 3.5, 0, 0, TAU); });
    pitTop(455, 150, 15, 13);
    if (t >= 4 && t < 10) {
      const row = Math.floor((t - 4) / 2), p = ((t - 4) / 2) % 1;
      stroke(c.accent, 1.5); ctx.strokeRect(340 + 140 * p, 54 + row * 70, 60, 60);
    }
    withAlpha(fade, () => {
      if (t > 6.4) { stroke(c.muted, 1.2, [3, 4]); ctx.strokeRect(379.5, 154.5, 25, 21); label('0.22', 392, 190, c.muted, 'center'); }
      if (t > 7.2) { stroke(c.accent, 1.8); ctx.strokeRect(433.5, 128.5, 43, 43); label('0.96', 455, 122, c.accent, 'center'); }
      if (t > 10) { label('0.96 → candidate', 340, 276, c.accent); label('a person checks it', 340, 292); }
    });
  });

  /* 5. Radar simulation: compute the radar image for each cave model, keep the one that matches ---------- */
  const along = (pts, d) => {                      // point at distance d along a polyline
    for (let n = 1; n < pts.length; n++) {
      const [x0, y0] = pts[n - 1], [x1, y1] = pts[n], len = Math.hypot(x1 - x0, y1 - y0);
      if (d <= len) return [x0 + (x1 - x0) * d / len, y0 + (y1 - y0) * d / len];
      d -= len;
    }
    return pts[pts.length - 1];
  };
  const pathLen = pts => pts.slice(1).reduce((s, p, n) => s + Math.hypot(p[0] - pts[n][0], p[1] - pts[n][1]), 0);
  const radarStrip = (x, y, wall, tail, tailInk) => {   // one line of a radar image: ground, pit shadow, wall echo, late echoes
    ctx.fillStyle = c.ink;
    withAlpha(.12, () => { ctx.fillRect(x, y, 70, 24); ctx.fillRect(x + 112, y, 138, 24); });
    withAlpha(.85 * wall, () => ctx.fillRect(x + 112, y, 16, 24));
    ctx.fillStyle = tailInk; withAlpha(.85, () => ctx.fillRect(x + 134, y, 70 * tail, 24));
    stroke(c.line, 1); ctx.strokeRect(x + .5, y + .5, 250, 24);
  };
  scene('viz-radar', 350, 10.5, 8.5, (t, fade) => {
    const SURF = 90, FLOOR = 175, ROOF = 130;
    [[20, false, 'A: pit only'], [290, true, 'B: pit and conduit']].forEach(([ox, conduit, name]) => {
      const hollow = () => {
        ctx.beginPath(); ctx.moveTo(ox + 70, SURF - 1); ctx.lineTo(ox + 70, FLOOR);
        if (conduit) { ctx.lineTo(ox + 215, FLOOR); ctx.lineTo(ox + 215, ROOF); ctx.lineTo(ox + 130, ROOF); } else ctx.lineTo(ox + 130, FLOOR);
        ctx.lineTo(ox + 130, SURF - 1);
      };
      rock(() => { ctx.beginPath(); ctx.rect(ox, SURF, 250, 118); }, SURF, 208);
      cut(hollow);
      stroke(c.ink, 1.3); seg(ox, SURF, ox + 70, SURF); seg(ox + 130, SURF, ox + 250, SURF); hollow(); ctx.stroke();
      label(name, ox, 30);
      if (conduit) label('Conduit', ox + 172, 198, c.muted, 'center');

      // Two radar rays arriving at 45°. In A they stop at the wall; in B they run on into the conduit and come back late.
      const rays = conduit
        ? [[[ox + 36, 42], [ox + 84, SURF], [ox + 169, FLOOR], [ox + 214, ROOF + 1]], [[ox + 24, 42], [ox + 72, SURF], [ox + 157, FLOOR], [ox + 202, ROOF], [ox + 215, ROOF + 13]]]
        : [[[ox + 36, 42], [ox + 84, SURF], [ox + 130, 136]], [[ox + 24, 42], [ox + 72, SURF], [ox + 130, 148]]];
      let back = 0;
      rays.forEach((pts, n) => {
        const len = pathLen(pts), d = 110 * (t - .6 - n * .5);
        stroke(c.accent, 1, [2, 4]); withAlpha(.45, () => { ctx.beginPath(); pts.forEach(p => ctx.lineTo(p[0], p[1])); ctx.stroke(); });
        if (d >= 0 && d <= 2 * len) { const [x, y] = along(pts, d <= len ? d : 2 * len - d); ctx.fillStyle = c.accent; circle(x, y, 3.4); ctx.fill(); }
        back += prog(d, 2 * len, 2 * len + 50) / 2;
      });
      label('Simulated image', ox, 232); label('Range →', ox + 250, 232, c.muted, 'right');
      withAlpha(fade, () => {
        radarStrip(ox, 240, conduit ? prog(t, 3, 3.5) : back, conduit ? back : 0, c.accent);
        if (t > 6.9) label(conduit ? 'Bright tail: match' : 'No tail: no match', ox, 282, conduit ? c.accent : c.muted);
      });
    });
    label('Observed by Mini-RF, 2010', 155, 310);
    radarStrip(155, 318, 1, 1, c.ink);
  });

  /* 6. GRAIL: two spacecraft feel the missing mass; the dip is matched against the signal of an empty tube ---------- */
  scene('viz-grail', 364, 13.5, 12, (t, fade) => {
    const SURF = 130, dip = x => -gauss(x, 300, 60);
    const tube = () => { ctx.beginPath(); ctx.ellipse(300, 172, 36, 15, 0, 0, TAU); };
    rock(() => { ctx.beginPath(); ctx.rect(0, SURF, W, 88); }, SURF, 218);
    cut(tube);
    stroke(c.ink, 1.3); seg(0, SURF, W, SURF); tube(); ctx.stroke();
    label('Empty tube, missing mass', 300, 207, c.muted, 'center');

    // Twin spacecraft: the gap between them changes as each one passes over the deficit
    const trail = -90 + 720 * prog(t, 0, 8.5), lead = trail + 64 + 22 * (dip(trail + 64) - dip(trail));
    stroke(c.line, 1, [2, 6]); seg(0, 56, W, 56);
    stroke(c.accent, 1.5); seg(trail, 56, lead, 56);
    sat(trail, 56); sat(lead, 56);
    label('Distance between the two, tracked by radio', 20, 30);

    // Gravity along the track, drawn as they fly
    label('Gravity along the track', 20, 246);
    stroke(c.line, 1, [2, 4]); seg(20, 285, 540, 285);
    const mid = clamp((trail + lead) / 2, 20, 540);
    withAlpha(fade, () => {
      stroke(c.ink, 1.7); ctx.beginPath();
      for (let x = 20; x <= mid; x += 3) ctx.lineTo(x, 285 - 44 * dip(x) + 1.5 * Math.sin(x / 7) + Math.sin(x / 3.1));
      ctx.stroke();
      if (mid > 380) label('Dip', 372, 318);
      if (t > 8.8) {                                // slide the expected signal along until it fits
        const cx = 90 + 210 * ease(prog(t, 8.8, 10.8));
        stroke(c.accent, 1.8, [5, 5]); ctx.beginPath();
        for (let x = cx - 120; x <= cx + 120; x += 4) ctx.lineTo(x, 285 - 44 * dip(x - cx + 300));
        ctx.stroke();
        label(t > 10.8 ? 'Matches an empty tube' : 'Sliding the signal of a tube', 300, 354, t > 10.8 ? c.accent : c.muted, 'center');
      }
    });
  });

  /* Run ----------------------------------------------------------------- */
  scenes.forEach(fit);
  const repaintStill = () => scenes.forEach(s => paint(s, s.endT));
  addEventListener('resize', () => { scenes.forEach(fit); if (still) repaintStill(); });
  if (still) return repaintStill();
  if ('IntersectionObserver' in window) {          // only animate what is on screen
    const io = new IntersectionObserver(es => es.forEach(e => { scenes.find(s => s.cv === e.target).on = e.isIntersecting; }));
    scenes.forEach(s => io.observe(s.cv));
  }
  const tick = now => { for (const s of scenes) if (s.on) paint(s, (now / 1000) % s.period); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})();
