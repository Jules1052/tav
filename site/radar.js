/* Home animation: an orbiter sounds the ground with radar. Solid ground returns one echo;
 * a lava tube returns two more, from its roof and floor. The radargram below builds as it flies.
 * Schematic of the Kaguya Lunar Radar Sounder result at Marius Hills (2017). Colours follow the theme tokens.
 */
(() => {
  const cv = document.getElementById('radar');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = 500, H = 600;                       // logical drawing space, scaled to the canvas
  const ORBIT_Y = 72, X0 = 20, X1 = 480;        // orbiter track
  const TUBE0 = 110, TUBE1 = 420, PIT0 = 300, PIT1 = 332;
  const SPEED = 38, PULSE_V = 430, EMIT_EVERY = 5;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const S = x => 200 + 3 * Math.sin(x / 37) + 2 * Math.sin(x / 13 + 1);                       // surface
  const R = x => 286 + 4 * Math.sin(x / 50);                                                   // tube roof
  const F = x => 328 + 3 * Math.sin(x / 40 + 1) - 12 * Math.exp(-(((x - 316) / 16) ** 2));     // tube floor + rubble under the pit
  const gy = depth => 446 + (depth - 200) * 0.72;                                              // radargram row for a reflector depth
  const inPit = x => x > PIT0 && x < PIT1, inTube = x => x >= TUBE0 && x <= TUBE1;

  // What a pulse sent straight down at x reflects from, top to bottom.
  const reflectors = x => inPit(x) ? [[F(x), 'floor']]
    : inTube(x) ? [[S(x), 'surface'], [R(x), 'roof'], [F(x), 'floor']]
    : [[S(x), 'surface']];

  let c = {};
  const readColors = () => {
    const s = getComputedStyle(document.documentElement), v = n => s.getPropertyValue(n).trim();
    c = { ink: v('--ink'), muted: v('--muted'), accent: v('--accent'), line: v('--line'), mono: v('--mono') };
  };
  readColors();
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const fit = () => {
    const r = cv.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(r.width * d); cv.height = Math.round(r.width * H / W * d);
  };
  fit(); addEventListener('resize', fit);

  let ox, pulses, echoes, gram, lastEmit, hold, fade;
  const reset = () => { ox = X0; pulses = []; echoes = []; gram = []; lastEmit = X0 - EMIT_EVERY; hold = 0; fade = 1; };
  reset();

  const voidPath = () => {
    ctx.beginPath();
    ctx.moveTo(PIT0, S(PIT0));
    for (let x = PIT0 - 3; x >= TUBE0; x -= 6) ctx.lineTo(x, R(x));
    ctx.quadraticCurveTo(TUBE0 - 24, (R(TUBE0) + F(TUBE0)) / 2, TUBE0, F(TUBE0));
    for (let x = TUBE0; x <= TUBE1; x += 4) ctx.lineTo(x, F(x));
    ctx.quadraticCurveTo(TUBE1 + 24, (R(TUBE1) + F(TUBE1)) / 2, TUBE1, R(TUBE1));
    for (let x = TUBE1; x >= PIT1 + 3; x -= 6) ctx.lineTo(x, R(x));
    ctx.lineTo(PIT1, S(PIT1));
  };

  const label = (t, x, y, color, align = 'left') => {
    ctx.font = `500 11px ${c.mono}`; ctx.textAlign = align; ctx.fillStyle = color;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.4px';
    ctx.fillText(t.toUpperCase(), x, y);
  };

  const step = dt => {
    if (ox < X1) {
      ox = Math.min(X1, ox + SPEED * dt);
      while (ox - lastEmit >= EMIT_EVERY) { lastEmit += EMIT_EVERY; pulses.push({ x: lastEmit, y: ORBIT_Y + 10, hit: 0, r: reflectors(lastEmit) }); }
    } else if (!pulses.length && !echoes.length) {
      hold += dt;
      if (hold > 2.2) { fade -= dt / 0.7; if (fade <= 0) reset(); }
    }
    for (const p of pulses) {
      p.y += PULSE_V * dt;
      while (p.hit < p.r.length && p.y >= p.r[p.hit][0]) { echoes.push({ x: p.x, y: p.r[p.hit][0], d: p.r[p.hit][0], kind: p.r[p.hit][1] }); p.hit++; }
    }
    pulses = pulses.filter(p => p.hit < p.r.length || (p.r.length === 1 && p.r[0][1] === 'surface' && p.y < p.r[0][0] + 70));
    for (const e of echoes) e.y -= PULSE_V * dt;
    echoes = echoes.filter(e => e.y > ORBIT_Y + 10 || (gram.push(e), false));
  };

  const draw = () => {
    const k = cv.width / W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = ctx.lineCap = 'round';

    // Ground: rock tint fading with depth, the tube and pit cut out of it
    const g = ctx.createLinearGradient(0, 195, 0, 392);
    g.addColorStop(0, c.ink); g.addColorStop(1, 'transparent');
    ctx.globalAlpha = .13; ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(0, S(0));
    for (let x = 4; x <= W; x += 4) ctx.lineTo(x, S(x));
    ctx.lineTo(W, 392); ctx.lineTo(0, 392); ctx.fill();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'destination-out';
    voidPath(); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    ctx.strokeStyle = c.ink; ctx.lineWidth = 1.3;
    for (const [a, b] of [[0, PIT0], [PIT1, W]]) {
      ctx.beginPath(); ctx.moveTo(a, S(a));
      for (let x = a + 4; x < b; x += 4) ctx.lineTo(x, S(x));
      ctx.lineTo(b, S(b)); ctx.stroke();
    }
    voidPath(); ctx.stroke();

    label('Pit', (PIT0 + PIT1) / 2, S(PIT0) - 12, c.muted, 'center');
    label('Lava tube', 190, 312, c.muted, 'center');

    // Orbit and orbiter
    ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.setLineDash([2, 6]);
    ctx.beginPath(); ctx.moveTo(0, ORBIT_Y); ctx.lineTo(W, ORBIT_Y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = c.ink;
    ctx.fillRect(ox - 6, ORBIT_Y - 4, 12, 8);
    ctx.fillRect(ox - 21, ORBIT_Y - 2, 12, 4); ctx.fillRect(ox + 9, ORBIT_Y - 2, 12, 4);
    ctx.fillRect(ox - .75, ORBIT_Y + 4, 1.5, 6);
    label('Orbiter · radar sounder', 20, 40, c.muted);

    // Pulses down (accent), echoes up (ink for the surface, accent for roof and floor)
    ctx.lineWidth = 1.6;
    for (const p of pulses) {
      const below = p.r[0][1] === 'surface' && p.y > p.r[0][0];
      ctx.globalAlpha = below ? (p.r.length > 1 ? .55 : Math.max(0, .55 * (1 - (p.y - p.r[0][0]) / 70))) : .95;
      ctx.strokeStyle = c.accent;
      ctx.beginPath(); ctx.moveTo(p.x - 5, p.y); ctx.lineTo(p.x + 5, p.y); ctx.stroke();
    }
    ctx.lineWidth = 1.2;
    for (const e of echoes) {
      ctx.globalAlpha = .7; ctx.strokeStyle = e.kind === 'surface' ? c.ink : c.accent;
      ctx.beginPath(); ctx.moveTo(e.x - 3.5, e.y); ctx.lineTo(e.x + 3.5, e.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Radargram
    ctx.strokeStyle = c.line; ctx.lineWidth = 1;
    ctx.strokeRect(X0 - 8.5, 422.5, X1 - X0 + 17, 150);
    label('Radargram', X0, 412, c.muted);
    label('Echo delay ↓', X1, 412, c.muted, 'right');
    ctx.globalAlpha = fade;
    for (const e of gram) {
      ctx.fillStyle = e.kind === 'surface' ? c.ink : c.accent;
      ctx.fillRect(e.x - EMIT_EVERY / 2, gy(e.d) - 1, EMIT_EVERY, 2);
    }
    const seen = x => gram.length && gram[gram.length - 1].x >= x;
    if (seen(60)) label('Surface', X0, gy(200) - 10, c.muted);
    if (seen(TUBE0 + 50)) { label('Roof', TUBE0 + 4, gy(286) - 10, c.accent); label('Floor', TUBE0 + 4, gy(328) + 18, c.accent); }
    ctx.globalAlpha = 1;
  };

  if (still) {                                  // reduced motion: the finished pass, no movement
    for (let x = X0; x <= X1; x += EMIT_EVERY) for (const [d, kind] of reflectors(x)) gram.push({ x, d, kind });
    ox = X1; draw(); addEventListener('resize', draw);
    new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return;
  }
  let last = performance.now();
  const frame = now => { step(Math.min(.05, (now - last) / 1000)); last = now; draw(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})();
