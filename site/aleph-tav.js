/* Aleph + Tav (index.html). WebGL2, no library.
 * Background (.field): the sheet and the Earth–Moon gravity lines
 * (equipotentials of the two bodies, the Moon's pull exaggerated) drifting slowly outward. Near the pointer they turn red.
 * Globes: the Earth (up left) and the Moon (down right) start as paper maps. Point at one, touch it or drag it,
 * and real colour soaks out from that spot, in day or night colour.
 * Theme: the page follows the system, light (cream paper) or dark (night paper). The Day and Night buttons set it, and turn both globes real.
 * Pointing at a globe opens its card: Aleph for the Earth, Tav for the Moon. Each card is a link, and clicking a globe follows it.
 * Earth: NASA Blue Marble, city lights, land height and a water mask (img/earth-data.png: R height, G sea and lakes, B rivers).
 * Moon: LRO wide-angle camera colour (NASA SVS) and LOLA elevation. All maps are equirectangular, centred on 0° longitude. */
(() => {
  const RAD = Math.PI / 180, DIST = 4.3, F = 1 / Math.tan(15 * RAD);
  const DISC = F / Math.sqrt(DIST * DIST - 1);                       // disc radius as a share of the canvas half-width (≈ .89)
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover)').matches;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const css = getComputedStyle(document.documentElement);
  const ink = name => { let h = css.getPropertyValue(name).trim().replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
  const frame = document.querySelector('.frame');
  const repaint = [];                                                // the canvases, redrawn in the theme's inks when it changes
  const compile = (gl, vs, fs) => {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(prog, 0, 'aP'); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    return n => gl.getUniformLocation(prog, n);
  };

  /* ---------------------------------------------------------------- Globes */
  const VS = `#version 300 es
  in vec2 aP; uniform mat4 uMVP; uniform mat3 uRot; uniform sampler2D uH; uniform float uK, uBase;
  out vec2 vUV; out vec3 vN, vM;
  void main() {
    vec2 uv = vec2(aP.x / 6.2831853 + .5, .5 - aP.y / 3.14159265);
    vec3 n = vec3(cos(aP.y) * sin(aP.x), sin(aP.y), cos(aP.y) * cos(aP.x));
    vUV = uv; vN = uRot * n; vM = n;
    gl_Position = uMVP * vec4(n * (1. + (textureLod(uH, uv, 2.).r - uBase) * uK), 1.);
  }`;
  // iso(c): a thin line at every half-integer of c, faded where the lines would crowd.
  // soak: a front spreading from the touched point uT (model space) out to the angle uR, ragged and inky.
  // uDir 1: real colour spreads over the paper; 0: the paper spreads back over the real colour.
  const LIB = `
  float iso(float c) { float w = fwidth(c); return (1. - smoothstep(0., 1.3 * w, abs(fract(c) - .5))) * (1. - smoothstep(.25, .6, w)); }
  float hash(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1., 0., 0.)), f.x), mix(hash(i + vec3(0., 1., 0.)), hash(i + vec3(1., 1., 0.)), f.x), f.y),
               mix(mix(hash(i + vec3(0., 0., 1.)), hash(i + vec3(1., 0., 1.)), f.x), mix(hash(i + vec3(0., 1., 1.)), hash(i + vec3(1., 1., 1.)), f.x), f.y), f.z); }
  vec3 soak(vec3 paper, vec3 real, vec3 ink) {
    float a = acos(clamp(dot(normalize(vM), uT), -1., 1.)) + (noise(vM * 5.) + .5 * noise(vM * 13.) - .75) * .55;
    float r = 1. - smoothstep(uR - .16, uR, a);
    float front = 1. - smoothstep(0., .06, abs(a - uR + .07));
    return mix(mix(mix(real, paper, uDir), mix(paper, real, uDir), r), ink, front * .4);
  }`;

  const EARTH_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; in vec3 vN, vM;
  uniform sampler2D uH, uC, uL;
  uniform vec2 uW;                                                  // looks: day, night
  uniform vec3 uT, uPaper, uSea, uInk, uRed; uniform float uR, uDir;
  out vec4 o;
  ${LIB}
  void main() {
    vec4 D = texture(uH, vUV);
    float lat = (.5 - vUV.y) * 3.14159265, mu = max(vN.z, 0.), limb = pow(mu, .5), rim = pow(1. - mu, 3.);
    float sea = smoothstep(.3, .7, D.g), land = 1. - sea, hs = texture(uH, vUV, 1.).r;
    vec2 e = vec2(1. / 2048., 1. / 1024.);
    float hx = (texture(uH, vUV + vec2(e.x, 0.)).r - texture(uH, vUV - vec2(e.x, 0.)).r) / max(cos(lat), .15);
    float hy = texture(uH, vUV + vec2(0., e.y)).r - texture(uH, vUV - vec2(0., e.y)).r;
    float shade = clamp(1. + 10. * (hx + hy), .55, 1.45);           // relief light from the north-west
    vec3 C = texture(uC, vUV).rgb;

    // Day: Blue Marble, lightened (the dark oceans lifted more than the bright land and clouds), a little relief light on land, blue air at the rim
    vec3 day = mix(pow(C, vec3(.8)) * mix(1., shade, .5 * land) * mix(.84, 1.04, limb), vec3(.45, .66, 1.), rim * .65);
    // Night: city lights (orange on a blue base), made to glow
    vec3 L = texture(uL, vUV).rgb;
    vec3 night = mix((L * 1.1 + vec3(1., .78, .45) * smoothstep(.06, .3, L.r) * 1.5) * mix(.6, 1., limb), vec3(.12, .2, .45), rim * .6);

    // Paper: Aleph's map. Cream land, darker sea, ink coasts and contours, red lakes and rivers, a 15° graticule, an engraved edge
    vec3 paper = mix(uPaper, uSea, sea);
    float grid = max(iso((vUV.x - .5) * 24. + .5), iso(lat / 3.14159265 * 12. + .5));
    float coast = 1. - smoothstep(0., 1.6 * fwidth(D.g), abs(D.g - .5));
    paper = mix(paper, uInk, grid * .14);
    paper = mix(paper, uInk, iso(hs * 8.) * land * .38);
    paper = mix(paper, uRed, smoothstep(.1, .4, D.b) * land * .9);
    paper = mix(paper, uInk, coast * .85);
    paper = mix(paper, uInk, (1. - smoothstep(0., .22, mu)) * .4);

    o = vec4(soak(paper, uW.x * day + uW.y * night, uInk), 1.);
  }`;

  const MOON_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; in vec3 vN, vM;
  uniform sampler2D uH, uC;
  uniform vec2 uW;                                                  // looks: day, night
  uniform vec3 uT, uPaper, uSea, uInk; uniform float uR, uDir;
  out vec4 o;
  ${LIB}
  void main() {
    float hc = texture(uH, vUV, 1.).r, lat = (.5 - vUV.y) * 3.14159265, mu = max(vN.z, 0.);
    vec2 e = vec2(1. / 1920., 1. / 960.) * 1.5;
    float hx = (texture(uH, vUV + vec2(e.x, 0.)).r - texture(uH, vUV - vec2(e.x, 0.)).r) / max(cos(lat), .2);
    float hy = texture(uH, vUV + vec2(0., e.y)).r - texture(uH, vUV - vec2(0., e.y)).r;
    float shade = clamp(1. + 7. * (hx + hy), .5, 1.4), limb = mix(.74, 1., pow(mu, .55)), rim = pow(1. - mu, 3.);
    vec3 C = texture(uC, vUV).rgb;

    // Day: LRO wide-angle camera colour, with the relief light
    vec3 day = C * mix(1., shade, .8) * limb * 1.1;
    // Night: the night side, lit only by earthshine (dim and blue)
    vec3 night = C * vec3(.55, .68, 1.) * .66 * mix(1., shade, .8) * limb + vec3(.16, .24, .55) * rim * .6;

    // Paper: the Moon on Aleph's paper, a shade darker than the Earth's. Maria darker still, ink contours, an engraved edge
    float alb = dot(texture(uC, vUV, 1.).rgb, vec3(.333));
    vec3 paper = mix(uSea * .82, uPaper * .92, smoothstep(.36, .62, alb)) * mix(1., shade, .35);
    paper = mix(paper, uInk, iso(hc * 11.) * .36);
    paper = mix(paper, uInk, (1. - smoothstep(0., .22, mu)) * .45);

    vec3 real = uW.x * day + uW.y * night;
    real = 1. - (1. - real) * .84;                                   // lift the darks: the Moon is small and must read at a glance
    o = vec4(soak(paper, real, uInk), 1.);
  }`;

  /* One globe. o: { fs, tex: [[file, sampler]] (the first is the height map), k, base, grid, lon, lat, spin, colours } */
  function globe(fig, o) {
    const stage = fig.querySelector('.stage'), canvas = stage.querySelector('canvas');
    const g = { fig, stage, onHot() {}, onTap() {} };
    let lon0 = o.lon, lat0 = o.lat, omega = 0, hot = false, drag = null;
    let want = false, dir = 1, reach = -1, speed = 0;                 // the soak front: dir as in the shader, reach its angle, speed +1 grows / -1 turns back
    const W = [1, 0], G = [1, 0], touch = [0, 0, 1];
    let draw = () => {}, loop = () => {};
    const rot = () => { const c = Math.cos(-lon0 * RAD), s = Math.sin(-lon0 * RAD), ca = Math.cos(lat0 * RAD), sa = Math.sin(lat0 * RAD);
      return [[c, 0, s], [sa * s, ca, -sa * c], [-ca * s, sa, ca * c]]; };

    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
    if (!gl) fig.classList.add('nogl');
    else {
      const U = compile(gl, VS, o.fs), uMVP = U('uMVP'), uRot = U('uRot'), uW = U('uW'), uT = U('uT'), uR = U('uR'), uDir = U('uDir');
      // Sphere grid in (longitude, latitude)
      const NX = o.grid, NY = o.grid / 2, ll = new Float32Array((NX + 1) * (NY + 1) * 2), idx = new Uint32Array(NX * NY * 6);
      for (let j = 0, k = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) { ll[k++] = (i / NX - .5) * 2 * Math.PI; ll[k++] = (.5 - j / NY) * Math.PI; }
      for (let j = 0, k = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + NX + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = a + 1; idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1; }
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, ll, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.enable(gl.DEPTH_TEST);
      gl.uniform1f(U('uK'), o.k); gl.uniform1f(U('uBase'), o.base);
      const paint = () => o.colours((n, v) => gl.uniform3fv(U(n), v));
      paint(); repaint.push(() => { paint(); draw(); });

      let loaded = 0, size = 0;
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      o.tex.forEach(([file, name], unit) => {
        gl.uniform1i(U(name), unit);
        const img = new Image();
        img.onload = () => {
          gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
          gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);   // the data map holds numbers, not colours
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
          if (++loaded === o.tex.length) { fig.classList.add('ready'); loop(); }
        };
        img.onerror = () => fig.classList.add('nogl');
        img.src = file;
      });

      // View: the point (lon0, lat0) faces the viewer
      draw = () => {
        if (loaded < o.tex.length) return;
        const w = Math.round(stage.clientWidth * Math.min(devicePixelRatio || 1, 2));
        if (w !== size) { size = canvas.width = canvas.height = w; gl.viewport(0, 0, w, w); }
        const R = rot(), near = 1, far = 10, A = (far + near) / (near - far), B = 2 * far * near / (near - far);
        gl.uniformMatrix4fv(uMVP, false, [
          F * R[0][0], F * R[1][0], A * R[2][0], -R[2][0],  F * R[0][1], F * R[1][1], A * R[2][1], -R[2][1],
          F * R[0][2], F * R[1][2], A * R[2][2], -R[2][2],  0, 0, -A * DIST + B, DIST]);
        gl.uniformMatrix3fv(uRot, false, [R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]);
        gl.uniform2fv(uW, W); gl.uniform3fv(uT, touch); gl.uniform1f(uR, reach); gl.uniform1f(uDir, dir);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);
      };

      // Motion: omega (°/s) eases towards a slow spin (none while pointed at, or with reduced motion); looks cross-fade; colour soaks in
      let raf = 0, last = 0, visible = true;
      const tick = now => {
        raf = 0;
        const dt = Math.min((now - last) / 1000 || 0, .05); last = now;
        const base = still || hot ? 0 : -o.spin;
        let moving = false;
        if (!drag) { omega += (base - omega) * (1 - Math.exp(-dt * (hot ? 3.5 : 1.1))); lon0 += omega * dt; moving = Math.abs(omega) > .02 || base !== 0; }
        for (let i = 0; i < 2; i++) { const d = G[i] - W[i]; if (Math.abs(d) < .003) W[i] = G[i]; else { W[i] += d * Math.min(1, dt * 7); moving = true; } }
        if (speed) { reach += speed * dt * (1.1 + Math.max(reach, 0) * 1.1); if (reach >= 4) { reach = 4; speed = 0; } else if (reach <= -1) { reach = -1; speed = 0; } moving = true; }
        draw();
        if (moving) loop(); else last = 0;
      };
      loop = () => { if (!raf && visible) raf = requestAnimationFrame(tick); };
      new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) { last = 0; loop(); } }).observe(stage);
      new ResizeObserver(() => draw()).observe(stage);
    }

    // Where on the disc is the pointer? [x, y] in disc radii (y up), or null when off the disc
    const at = e => { const r = stage.getBoundingClientRect(), R = r.width / 2 * DISC;
      const x = (e.clientX - r.left - r.width / 2) / R, y = -(e.clientY - r.top - r.height / 2) / R;
      return x * x + y * y <= 1.06 ? [x, y] : null; };
    // Turn real (or back to paper), soaking out from a point of the disc (default: its centre). Mid-soak, the front turns back.
    g.go = (real, p = [0, 0]) => {
      if (real === want) return;
      want = real; fig.classList.toggle('real', real);
      if (speed) speed = -speed;
      else {
        const [x, y] = p, z = Math.sqrt(Math.max(0, 1 - x * x - y * y)), R = rot();
        for (let j = 0; j < 3; j++) touch[j] = R[0][j] * x + R[1][j] * y + R[2][j] * z;   // view → model: Rᵀ v
        dir = real ? 1 : 0; reach = still ? 4 : 0; speed = still ? 0 : 1;
      }
      loop();
    };
    const touched = p => { if (p) g.go(true, p); };                  // paper until touched
    g.setLook = i => { G.fill(0); G[i] = 1; loop(); };
    g.disc = () => { const r = stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width / 2 * DISC]; };
    const setHot = v => { if (v === hot) return; hot = v; fig.classList.toggle('hot', v); g.onHot(v); loop(); };

    // Drag to turn; let go while moving and it keeps turning
    stage.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      const now = performance.now(), p = at(e);
      touched(p);
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: now, t: now, v: 0, moved: false };
      stage.setPointerCapture(e.pointerId); stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', e => {
      if (!drag) { if (e.pointerType !== 'touch') { const p = at(e); touched(p); setHot(!!p); } return; }
      const k = 150 / stage.clientWidth, now = performance.now(), dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) drag.moved = true;
      lon0 -= dx * k; lat0 = clamp(lat0 + dy * k, -80, 80);
      drag.v = drag.v * .5 + (-dx * k / Math.max(now - drag.t, 4) * 1000) * .5;
      drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
      draw();
    });
    const end = e => {
      if (!drag) return;
      const now = performance.now(), tap = !drag.moved && now - drag.t0 < 500;
      omega = still || now - drag.t > 90 ? 0 : clamp(drag.v, -360, 360);
      drag = null; stage.classList.remove('dragging'); loop();
      if (e.type === 'pointerup' && e.pointerType !== 'touch') setHot(!!at(e));
      if (tap && e.type === 'pointerup' && at(e)) g.onTap(e.pointerType, e);
    };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    stage.addEventListener('pointerleave', e => { if (!drag && e.pointerType !== 'touch') setHot(false); });
    stage.addEventListener('keydown', e => {
      if (e.target !== stage) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); touched([0, 0]); g.onTap('key', e); return; }
      const d = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] }[e.key];
      if (!d) return;
      e.preventDefault(); touched([0, 0]); omega = 0; lon0 += d[0]; lat0 = clamp(lat0 + d[1], -80, 80); draw();
    });
    return g;
  }

  const earth = globe(document.querySelector('.world.earth'), {
    fs: EARTH_FS, grid: 320, k: .04, base: 0, lon: 12, lat: 24, spin: 5,
    tex: [['img/earth-data.png', 'uH'], ['img/earth-color.jpg', 'uC'], ['img/earth-night.jpg', 'uL']],
    colours: set => { set('uPaper', ink('--globe-land')); set('uSea', ink('--globe-sea')); set('uInk', ink('--line-a')); set('uRed', ink('--red')); },
  });
  const moon = globe(document.querySelector('.world.moon'), {
    fs: MOON_FS, grid: 200, k: .11, base: .45, lon: 0, lat: 8, spin: 6,
    tex: [['img/moon-elevation.jpg', 'uH'], ['img/moon-color.jpg', 'uC']],
    colours: set => { set('uPaper', ink('--globe-land')); set('uSea', ink('--globe-sea')); set('uInk', ink('--line-a')); },
  });

  /* ---------------------------------------------------------------- Theme
   * The CSS follows the system on its own. data-theme on <html> overrides it ("light" or "dark"); none: the system's.
   * A change of theme redraws the canvases in the new inks, cross-fading the page where the browser can. */
  const root = document.documentElement, system = matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : system.matches;
  const theme = want => {                                            // 'light', 'dark', or '' for the system's
    const flips = (want ? want === 'dark' : system.matches) !== isDark();
    const apply = () => { if (want) root.dataset.theme = want; else delete root.dataset.theme; repaint.forEach(f => f()); };
    if (flips && !still && document.startViewTransition) document.startViewTransition(apply); else apply();
  };

  /* ---------------------------------------------------------------- Day and night
   * One button for each theme, the theme's own pressed. Choosing one sets the theme and turns both globes real in that look.
   * Before any choice the globes are paper maps, and a globe pointed at turns real in the look of the theme.
   * When the system changes theme, the page and the look turn with it. */
  const looks = [...document.querySelectorAll('.looks button')];
  const setLook = i => { earth.setLook(i); moon.setLook(i); looks.forEach(b => b.setAttribute('aria-pressed', +b.dataset.look === i)); };
  looks.forEach(b => b.addEventListener('click', () => {
    const want = +b.dataset.look ? 'dark' : 'light';
    setLook(+b.dataset.look); theme(want === (system.matches ? 'dark' : 'light') ? '' : want);
    earth.go(true); moon.go(true);
  }));
  system.addEventListener('change', () => { theme(''); setLook(system.matches ? 1 : 0); });
  setLook(isDark() ? 1 : 0);

  /* ---------------------------------------------------------------- Cards
   * Pointing at a globe opens its card; it stays while the pointer is on the globe or the card. Keyboard focus opens it too.
   * Each card is a link (Aleph on GitHub, the Tav site), and clicking its globe (or Enter on it) follows it.
   * On a touch screen, where nothing points, the first tap opens and pins the card; a second tap, on the globe or the card, follows the link
   * (tap elsewhere or press Escape to close). */
  const card = { aleph: frame.querySelector('.card.aleph'), tav: frame.querySelector('.card.tav') };   // the links
  let open = '', pin = '', hover = '', focus = '', timer = 0;
  const show = key => { if (key === open) return; open = key; frame.classList.toggle('pair-aleph', key === 'aleph'); frame.classList.toggle('pair-tav', key === 'tav'); };
  const sync = () => { clearTimeout(timer); const now = hover || focus; if (now) show(now); else timer = setTimeout(() => show(hover || focus || pin), 450); };
  [['aleph', earth], ['tav', moon]].forEach(([key, g]) => {
    const c = card[key], mine = el => g.fig.contains(el) || c.contains(el);
    g.onHot = on => { if (on) hover = key; else if (hover === key) hover = ''; sync(); };
    g.onTap = (how, e) => {
      if (how === 'touch' && open !== key) { pin = key; clearTimeout(timer); show(key); return; }
      // the link's own click, so a modifier key (new tab, new window) works as on the link
      const { ctrlKey, metaKey, shiftKey, altKey } = e;
      c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, ctrlKey, metaKey, shiftKey, altKey }));
    };
    c.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') { hover = key; sync(); } });
    c.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && hover === key) { hover = ''; sync(); } });
    // Only keyboard focus opens a card
    [g.fig, c].forEach(el => {
      el.addEventListener('focusin', e => { if (e.target.matches(':focus-visible')) { focus = key; sync(); } });
      el.addEventListener('focusout', e => { if (focus === key && !mine(e.relatedTarget)) { focus = ''; sync(); } });
    });
  });
  document.addEventListener('pointerdown', e => { if (pin && !e.target.closest('.world, .card')) { pin = ''; clearTimeout(timer); show(hover || focus); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) { pin = hover = focus = ''; clearTimeout(timer); show(''); } });

  /* ---------------------------------------------------------------- Field: paper and gravity lines */
  const FIELD_VS = `#version 300 es
  in vec2 aP; void main() { gl_Position = vec4(aP, 0., 1.); }`;
  const FIELD_FS = `#version 300 es
  precision highp float;
  uniform vec2 uRes, uMouse; uniform float uDpr, uU, uTime, uHot;
  uniform vec3 uE, uM, uSheet, uInk, uRed;                          // uE, uM: centre (css px, y down) and radius of each disc
  uniform vec4 uClear[3];                                           // boxes kept free of lines (text)
  out vec4 o;
  float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float noise(vec2 x) { vec2 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
    return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y); }
  void main() {
    vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
    // Gravity lines: equipotentials of the Earth and the Moon (its pull exaggerated so its well shows), drawn by a slightly shaky hand
    vec2 w = p + (vec2(noise(p * .016), noise(p * .016 + 17.)) - .5) * 7. * uU;
    vec2 dE = w - uE.xy, dM = w - uM.xy;
    float re = max(length(dE), uE.z * .85), rm = max(length(dM), uM.z * .85);
    float phi = uE.z / re + .26 * uE.z / rm;
    float c = log(phi) * 7. + uTime * .1;                           // + time: the lines drift outward, like waves
    float fc = fwidth(c) * uDpr;                                    // change of c per css pixel
    float line = (1. - smoothstep(.4, 1., abs(fract(c) - .5) / fc)) * (1. - smoothstep(.3, .7, fc));
    vec3 bg = uSheet * (1. - .05 * hash(floor(gl_FragCoord.xy)));   // paper grain
    float clr = 0.;
    for (int i = 0; i < 3; i++) { vec4 r = uClear[i]; vec2 q = max(r.xy - p, p - r.zw); clr = max(clr, 1. - smoothstep(-6., 26., max(q.x, q.y))); }
    line *= 1. - .92 * clr;
    // Near the pointer the lines turn red
    float m = uHot * (1. - smoothstep(0., 280., length(p - uMouse)));
    vec3 lc = mix(uInk, uRed, m);
    float a = mix(line * .2, line * .95, m);
    o = vec4(mix(bg, lc, a) + (hash(gl_FragCoord.xy + 7.) - .5) / 255., 1.);   // dither
  }`;
  (() => {
    const canvas = document.querySelector('.field'), gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) return;                                                 // the body keeps its CSS gradient
    const U = compile(gl, FIELD_VS, FIELD_FS);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const paint = () => { gl.uniform3fv(U('uSheet'), ink('--sheet')); gl.uniform3fv(U('uInk'), ink('--line-a')); gl.uniform3fv(U('uRed'), ink('--red')); };
    const uRes = U('uRes'), uDpr = U('uDpr'), uU = U('uU'), uTime = U('uTime'), uE = U('uE'), uM = U('uM'), uMouse = U('uMouse'), uHot = U('uHot'), uClear = U('uClear');
    const boxes = ['.claim', '.settings', '.hint'].map(q => frame.querySelector(q));
    let dpr = 1, hot = 0, hotGoal = 0, mx = -1e4, my = -1e4, raf = 0, lastDraw = 0;
    const measure = () => {
      dpr = Math.min(devicePixelRatio || 1, 1.5);
      const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      gl.uniform2f(uRes, w, h); gl.uniform1f(uDpr, dpr);
      const W = parseFloat(getComputedStyle(frame).getPropertyValue('--W'));
      gl.uniform1f(uU, parseFloat(getComputedStyle(frame).width) / W);
      gl.uniform3fv(uE, earth.disc()); gl.uniform3fv(uM, moon.disc());
      gl.uniform4fv(uClear, boxes.flatMap(b => { const r = b.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
    };
    const frameDraw = now => {
      raf = 0;
      hot += (hotGoal - hot) * .15; if (Math.abs(hotGoal - hot) < .01) hot = hotGoal;
      gl.uniform1f(uTime, still ? 0 : now / 1000); gl.uniform1f(uHot, hot); gl.uniform2f(uMouse, mx, my);
      gl.drawArrays(gl.TRIANGLES, 0, 3); lastDraw = now;
      if (!still || hot !== hotGoal) queue();
    };
    // About 30 frames a second is plenty for lines this slow
    const queue = () => { if (!raf) raf = requestAnimationFrame(now => { if (!still && now - lastDraw < 30 && hot === hotGoal) { raf = 0; queue(); } else frameDraw(now); }); };
    addEventListener('resize', () => { measure(); queue(); });
    if (fine) {
      addEventListener('pointermove', e => { if (e.pointerType === 'touch') return; mx = e.clientX; my = e.clientY; hotGoal = 1; queue(); }, { passive: true });
      document.documentElement.addEventListener('pointerleave', () => { hotGoal = 0; queue(); });
    }
    document.fonts.ready.then(() => { measure(); queue(); });
    repaint.push(() => { paint(); queue(); });
    paint(); measure(); queue();
  })();
})();
