/* Tav page (tav.html): the ground under the page, and the rover that crosses it. No library.
 * The ground: contour lines of the Moon's real elevation (img/moon-elevation.jpg, LOLA, as on the globe). The page is a strip of
 * the near side, north up, centred on 0° longitude: 62° N at its top, 62° S at its end. A line every 500 m, a stronger one every 2 km.
 * The rover (wide screens with a mouse, not with reduced motion): seen from above, as the ground is. It lands at the top of the left
 * margin and drives down it as the page scrolls, leaving its tracks. Its cameras look at the pointer. Point at it and it reads the
 * place and the elevation under it; click it and it draws a box round itself, as Tav does. */
(() => {
  const host = document.querySelector('.terrain');
  if (!host) return;
  const NS = 'http://www.w3.org/2000/svg', RAD = Math.PI / 180;
  const LAT = 62, CELL = 8, STEP = 500, BOLD = 2000, BAND = 720;     // CELL: the grid of heights, in page pixels. BAND: lines are grouped by height on the page
  const KM = 30.33;                                                  // one degree on the Moon
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), turn = a => Math.atan2(Math.sin(a), Math.cos(a)), r1 = v => Math.round(v * 10) / 10;
  const el = (name, attrs, parent) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.append(e); return e; };

  // 1. The ground ---------------------------------------------------------------------
  const lines = el('svg', { class: 'contours' }, host), map = new Image();
  let W = 0, H = 0, S = 1, gw = 0, gh = 0, high = null;              // S: pixels per degree. high: metres at each node of the grid (the rover reads it)

  // A box blur in place, along the rows then along the columns
  function soften(a, r) {
    const b = new Float32Array(a.length), n = 2 * r + 1;
    for (let j = 0; j < gh; j++) { const o = j * gw; let sum = 0;
      for (let i = -r; i <= r; i++) sum += a[o + clamp(i, 0, gw - 1)];
      for (let i = 0; i < gw; i++) { b[o + i] = sum / n; sum += a[o + Math.min(i + r + 1, gw - 1)] - a[o + Math.max(i - r, 0)]; } }
    for (let i = 0; i < gw; i++) { let sum = 0;
      for (let j = -r; j <= r; j++) sum += b[clamp(j, 0, gh - 1) * gw + i];
      for (let j = 0; j < gh; j++) { a[j * gw + i] = sum / n; sum += b[Math.min(j + r + 1, gh - 1) * gw + i] - b[Math.max(j - r, 0) * gw + i]; } }
    return a;
  }

  function build() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h || (w === W && h === H)) return;
    W = w; H = h; S = H / (2 * LAT); gw = Math.ceil(W / CELL) + 1; gh = Math.ceil(H / CELL) + 1;
    // The strip of the map under the page, one pixel per node
    const c = document.createElement('canvas'); c.width = gw; c.height = gh;
    const g = c.getContext('2d', { willReadFrequently: true }), k = map.naturalWidth / 360, d = CELL / S;
    g.imageSmoothingQuality = 'high';
    g.drawImage(map, (180 - W / 2 / S - d / 2) * k, (90 - LAT - d / 2) * k, gw * d * k, gh * d * k, 0, 0, gw, gh);
    const px = g.getImageData(0, 0, gw, gh).data, f = new Float32Array(gw * gh);
    for (let i = 0; i < f.length; i++) f[i] = (px[i * 4] - 77.5) * 129;   // grey to metres: 161 is the highest point (10,786 m), 7 the lowest (−9,100 m)
    high = soften(f, 1).slice(); soften(f, 2); soften(f, 2);              // the lines follow a smoother ground than the one the rover reads

    // Marching squares. A crossing is named by its edge: e < N on the edge from node e to the next in its row, else on the edge from node e − N to the one below.
    // Each crossing has two neighbours at most (nb), so the crossings chain into lines.
    const N = gw * gh, nb = new Int32Array(N * 4).fill(-1), seen = new Uint8Array(N * 2), bands = [];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
    for (let level = Math.ceil(lo / STEP) * STEP; level < hi; level += STEP) {
      const used = [], bold = level % BOLD === 0;
      const link = (a, b) => { if (nb[2 * a] < 0) used.push(a); if (nb[2 * b] < 0) used.push(b);
        nb[nb[2 * a] < 0 ? 2 * a : 2 * a + 1] = b; nb[nb[2 * b] < 0 ? 2 * b : 2 * b + 1] = a; };
      for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
        const o = j * gw + i, n = (f[o] > level) | (f[o + 1] > level) << 1 | (f[o + gw + 1] > level) << 2 | (f[o + gw] > level) << 3;
        if (!n || n === 15) continue;
        const T = o, B = o + gw, L = N + o, R = N + o + 1;
        if (n === 1 || n === 14) link(L, T); else if (n === 2 || n === 13) link(T, R); else if (n === 3 || n === 12) link(L, R);
        else if (n === 4 || n === 11) link(R, B); else if (n === 6 || n === 9) link(T, B); else if (n === 7 || n === 8) link(L, B);
        else if ((n === 5) === ((f[o] + f[o + 1] + f[o + gw] + f[o + gw + 1]) / 4 > level)) { link(T, R); link(L, B); }   // a saddle: the middle decides
        else { link(L, T); link(R, B); }
      }
      const at = e => { const a = e < N ? e : e - N, b = e < N ? a + 1 : a + gw, t = (level - f[a]) / (f[b] - f[a]), x = a % gw, y = (a - x) / gw;
        return e < N ? [(x + t) * CELL, y * CELL] : [x * CELL, (y + t) * CELL]; };
      // Open lines first, from an end; then the closed ones
      for (let pass = 0; pass < 2; pass++) for (const e of used) {
        if (seen[e] || (!pass && nb[2 * e + 1] >= 0)) continue;
        const p = []; let prev = -1, cur = e;
        while (cur >= 0 && !seen[cur]) { seen[cur] = 1; p.push(at(cur)); const next = nb[2 * cur] !== prev ? nb[2 * cur] : nb[2 * cur + 1]; prev = cur; cur = next; }
        const n = p.length, mid = i => r1((p[i][0] + p[(i + 1) % n][0]) / 2) + ' ' + r1((p[i][1] + p[(i + 1) % n][1]) / 2);
        if (n < (pass ? 8 : 4)) continue;                                // a speck
        // A curve through the middle of each step, so the grid does not show
        let s = 'M' + (pass ? mid(n - 1) : r1(p[0][0]) + ' ' + r1(p[0][1]) + 'L' + mid(0));
        for (let i = pass ? 0 : 1; i < n - 1 + pass; i++) s += 'Q' + r1(p[i][0]) + ' ' + r1(p[i][1]) + ' ' + mid(i);
        s += pass ? 'Z' : 'L' + r1(p[n - 1][0]) + ' ' + r1(p[n - 1][1]);
        const band = bands[Math.floor(p[0][1] / BAND)] ||= ['', ''];
        band[+bold] += s;
      }
      for (const e of used) { seen[e] = 0; nb[2 * e] = nb[2 * e + 1] = -1; }
    }
    lines.replaceChildren(); lines.setAttribute('width', W); lines.setAttribute('height', H);
    bands.forEach(b => { if (b[0]) el('path', { d: b[0] }, lines); if (b[1]) el('path', { class: 'bold', d: b[1] }, lines); });
  }
  // Metres under a point of the page
  const height = (x, y) => { const u = clamp(x / CELL, 0, gw - 1.001), v = clamp(y / CELL, 0, gh - 1.001), i = u | 0, j = v | 0, a = u - i, b = v - j, o = j * gw + i;
    return (high[o] * (1 - a) + high[o + 1] * a) * (1 - b) + (high[o + gw] * (1 - a) + high[o + gw + 1] * a) * b; };

  // 2. The rover -----------------------------------------------------------------------
  const fine = matchMedia('(hover: hover) and (pointer: fine)'), still = matchMedia('(prefers-reduced-motion: reduce)');
  // On the ground: where it landed, the tracks it has left (shown down to the farthest point it reached), the boxes it drew
  const tracks = el('svg', { class: 'tracks' }, host);
  tracks.innerHTML = `<clipPath id="driven"><rect/></clipPath>
    <g class="lander"><path d="M-4-4-8.6-8.6M4-4 8.6-8.6M-4 4-8.6 8.6M4 4 8.6 8.6"/><circle r="5.8"/><circle r="2.1"/>
      <circle class="pad" cx="-9.2" cy="-9.2" r="1.7"/><circle class="pad" cx="9.2" cy="-9.2" r="1.7"/><circle class="pad" cx="-9.2" cy="9.2" r="1.7"/><circle class="pad" cx="9.2" cy="9.2" r="1.7"/></g>
    <g class="ruts" clip-path="url(#driven)"><path/><path/></g><g class="boxes"></g>`;
  const clip = tracks.querySelector('rect'), lander = tracks.querySelector('.lander'), ruts = tracks.querySelectorAll('.ruts path'), boxes = tracks.querySelector('.boxes');
  // The rover itself, drawn facing up: six wheels on their axles, the hull, the solar panel, and the mast with its two cameras
  const rover = document.createElement('div');
  rover.className = 'rover'; rover.setAttribute('aria-hidden', 'true');
  rover.innerHTML = `<div class="cast"><svg viewBox="-18 -24 36 48" width="36" height="48">
      <path class="axle" d="M-13-15h26M-13 0h26M-13 15h26"/>
      <path class="wheel" d="M-17-19.5h5.5v9h-5.5zM-17-4.5h5.5v9h-5.5zM-17 10.5h5.5v9h-5.5zM11.5-19.5h5.5v9h-5.5zM11.5-4.5h5.5v9h-5.5zM11.5 10.5h5.5v9h-5.5z"/>
      <rect class="hull" x="-8" y="-17" width="16" height="34" rx="4.5"/>
      <rect class="panel" x="-5" y="-4" width="10" height="17.5" rx="1.5"/><path class="cells" d="M0-4v17.5M-5 1.8h10M-5 7.7h10"/>
      <g class="mast"><rect class="head" x="-4.6" y="-2" width="9.2" height="4" rx="1.9"/><circle class="eye" cx="-2.3" cy="-2.3" r="1.2"/><circle class="eye" cx="2.3" cy="-2.3" r="1.2"/></g>
    </svg></div><div class="hit"></div><div class="tag"><span></span><span></span></div>`;
  document.body.append(rover);
  const body = rover.querySelector('svg'), mast = rover.querySelector('.mast'), tag = rover.querySelector('.tag'), [where, what] = tag.children;

  // Its road: a winding line down the left margin. s is how far down the page it is, far the farthest it has been, dir the way it faces (1: down the page).
  // head is its bearing (0: up the page, clockwise) and look the turn of its mast from it.
  let on = false, placed = false, margin = 0, cx = 0, amp = 0, top = 0, bottom = 0, s = 0, far = 0, dir = 1, head = Math.PI, look = 0;
  let pointer = null, near = false, pinned = 0, note = '', shown = -1, raf = 0, last = 0, nap = 0, timer = 0;
  const roadX = y => cx + amp * (.62 * Math.sin(y / 170 + .6) + .38 * Math.sin(y / 71 + 2.1));
  const lean = y => amp * (.62 / 170 * Math.cos(y / 170 + .6) + .38 / 71 * Math.cos(y / 71 + 2.1));
  const goal = () => clamp(scrollY + innerHeight * .58, top, bottom);

  function place() {
    const hero = document.querySelector('.hero').getBoundingClientRect(), gutter = hero.left + scrollX, lane = Math.min(gutter / 2, 110);
    on = !!high && fine.matches && !still.matches && gutter >= 64;
    rover.classList.toggle('on', on); tracks.style.display = on ? '' : 'none';
    if (!on) return;
    margin = gutter; cx = gutter - lane; amp = clamp(lane - 34, 0, 42);
    const y0 = hero.top + scrollY + 40;                                // the landing site, beside the top of the hero
    top = y0 + 36; bottom = H - 150;
    tracks.setAttribute('width', gutter); tracks.setAttribute('height', H);
    lander.setAttribute('transform', `translate(${r1(roadX(y0))} ${r1(y0)})`);
    let l = '', r = '';
    for (let y = y0 + 11; y <= bottom; y += 6) { const m = lean(y), n = 14.25 / Math.hypot(m, 1), x = roadX(y), c = l ? 'L' : 'M';
      l += c + r1(x - n) + ' ' + r1(y + n * m); r += c + r1(x + n) + ' ' + r1(y - n * m); }
    ruts[0].setAttribute('d', l); ruts[1].setAttribute('d', r);
    clip.setAttribute('y', y0 + 11); clip.setAttribute('width', gutter); shown = -1;
    if (!placed) { placed = true; s = far = scrollY > 80 ? goal() : top; setTimeout(kick, 900); }   // a page opened at its top: it drives off the lander
    else { s = clamp(s, top, bottom); far = clamp(far, s, bottom); kick(); }
    paint();
  }

  function paint() {
    const x = roadX(s), len = Math.max(0, Math.round(far - clip.y.baseVal.value));
    rover.style.transform = `translate3d(${x.toFixed(2)}px,${s.toFixed(2)}px,0)`;
    body.style.transform = `rotate(${head.toFixed(4)}rad)`;
    mast.setAttribute('transform', `translate(0 -10.5) rotate(${(look / RAD).toFixed(1)})`);
    if (len !== shown) clip.setAttribute('height', shown = len);
    if (near || pinned) {
      const lat = LAT - s / S, lon = (x - W / 2) / S, m = Math.round(height(x, s) / 10) * 10;
      const a = `${Math.abs(lat).toFixed(1)}° ${lat < 0 ? 'S' : 'N'}  ${Math.abs(lon).toFixed(1)}° ${lon < 0 ? 'W' : 'E'}`;
      const b = pinned ? note : (m < 0 ? '−' : '') + Math.abs(m).toLocaleString('en-US') + ' m';
      if (where.textContent !== a) where.textContent = a;
      if (what.textContent !== b) what.textContent = b;
      const w = tag.offsetWidth;                                       // under the rover, kept inside the margin
      tag.style.left = r1(clamp(-w / 2, 8 - x, Math.max(8 - x, margin - 6 - w - x))) + 'px';
    }
    rover.classList.toggle('near', near || !!pinned);
  }

  // It is quiet until it moves or is pointed at, and quiet again a moment later
  function wake() {
    rover.classList.add('awake'); clearTimeout(nap);
    nap = setTimeout(function doze() { if (on && (near || pinned)) nap = setTimeout(doze, 600); else rover.classList.remove('awake'); }, 1800);
  }
  function tick(now) {
    raf = 0;
    const dt = last ? Math.min((now - last) / 1000, .05) : .016, d = goal() - s; last = now;
    let busy = false;
    if (pinned && now > pinned) pinned = 0;
    if (Math.abs(d) > .5) {
      if (d * dir < 0 && Math.abs(d) > 40) dir = -dir;                 // far behind it: it turns round. Nearer, it backs up
      const m = lean(s), off = turn(Math.atan2(m * dir, -dir) - head);
      head = turn(head + off * Math.min(1, dt * 10));
      s += d * Math.min(1, dt * 4.5) * Math.max(0, Math.cos(off)) ** 2;   // it turns on the spot before it drives
      if (s > far) far = s;
      busy = true; wake();
    }
    // The mast: towards the pointer, or straight ahead when there is none
    const x = roadX(s) - scrollX, y = s - scrollY;
    let aim = 0;
    if (pointer) { const dx = pointer.x - x, dy = pointer.y - y, dist = Math.hypot(dx, dy);
      aim = dist > 12 ? turn(Math.atan2(dx, -dy) - head) : look;
      if ((dist < 62) !== near) { near = !near; if (near) wake(); } }
    else near = false;
    const dl = turn(aim - look);
    if (Math.abs(dl) > .004) { look = turn(look + dl * Math.min(1, dt * 9)); busy = true; }
    paint();
    if (busy) kick(); else last = 0;
  }
  function kick() { if (on && !raf) raf = requestAnimationFrame(tick); }

  addEventListener('scroll', kick, { passive: true });
  addEventListener('pointermove', e => { pointer = e.pointerType === 'mouse' ? { x: e.clientX, y: e.clientY } : null; kick(); }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer = null; kick(); });

  // Clicked, it sounds the ground and draws a box round itself: the piece of the Moon Tav would download
  rover.querySelector('.hit').addEventListener('click', () => {
    const w = 60, h = 52, lat = LAT - s / S;
    rover.classList.remove('ping'); void rover.offsetWidth; rover.classList.add('ping');
    if (![...boxes.children].some(b => Math.abs(b.dataset.y - s) < h * .6)) {
      const g = el('g', { transform: `translate(${r1(roadX(s))} ${r1(s)})`, 'data-y': r1(s) }, boxes);
      el('rect', { class: 'wash', x: -w / 2, y: -h / 2, width: w, height: h, rx: 2 }, g);
      el('rect', { class: 'edge', x: -w / 2, y: -h / 2, width: w, height: h, rx: 2, pathLength: 100 }, g);
      for (const [i, j] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) el('rect', { class: 'knob', x: i * w / 2 - 3, y: j * h / 2 - 3, width: 6, height: 6, rx: 1.5 }, g);
      if (boxes.children.length > 6) boxes.firstChild.remove();
    }
    note = `${Math.round(w / S * KM * Math.cos(lat * RAD))} × ${Math.round(h / S * KM)} km box`;
    pinned = performance.now() + 2600; setTimeout(kick, 2650); wake(); kick();
  });

  // 3. Start: once the map and the fonts are in (the fonts set the height of the page), and again when the page changes size
  const start = () => {
    build(); place(); host.classList.add('ready');
    new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(() => { build(); place(); }, 200); }).observe(host);
    fine.addEventListener('change', place); still.addEventListener('change', place);
  };
  map.onload = () => (document.fonts ? document.fonts.ready : Promise.resolve()).then(start, start);
  map.src = 'img/moon-elevation.jpg';
})();
