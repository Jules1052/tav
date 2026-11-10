/* Tav page (tav.html): the Moon as a globe. WebGL2, no library.
 * Colour: the LRO wide-angle camera (img/moon-color.jpg). Relief: LOLA elevation (img/moon-elevation.jpg), exaggerated.
 * Composition: the Lunar Prospector iron and thorium maps (img/moon-iron.jpg, img/moon-thorium.jpg), read back from their rainbow scale
 * (blue = low, red = high), in the --globe-high, --globe-mare and --globe-kreep tokens of style.css.
 * All maps are equirectangular, centred on 0° longitude, as on the home.
 * It turns slowly until touched (not with reduced motion). Drag it or use the arrow keys; a site button turns it to that site. */
(() => {
  const fig = document.querySelector('.globe');
  if (!fig) return;
  const stage = fig.querySelector('.stage'), canvas = stage.querySelector('canvas'), list = fig.querySelector('.sites'), key = fig.querySelector('.key');
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
  if (!gl) { fig.classList.add('nogl'); return; }

  // Three pits that open into lava tubes, and a rille that may be one whose roof fell in
  const SITES = [
    { name: 'Marius Hills pit', lat: 14.09, lon: -56.77, pos: '14.09° N 56.77° W' },
    { name: 'Tranquillitatis pit', lat: 8.34, lon: 33.22, pos: '8.34° N 33.22° E' },
    { name: 'Ingenii pit', lat: -35.95, lon: 166.06, pos: '35.95° S 166.06° E' },
    { name: 'Hadley Rille', lat: 26.13, lon: 3.63, pos: '26.13° N 3.63° E' },
  ];
  const RAD = Math.PI / 180, DIST = 4.3, F = 1 / Math.tan(15 * RAD);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), wrap = a => ((a % 360) + 540) % 360 - 180;
  const css = getComputedStyle(document.documentElement);
  const ink = name => { let h = css.getPropertyValue(name).trim().replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };

  const VS = `#version 300 es
  in vec2 aLL; uniform mat4 uMVP; uniform mat3 uRot; uniform sampler2D uH; uniform float uK, uBase;
  out vec2 vUV; out vec3 vN;
  void main() {
    vec2 uv = vec2(aLL.x / 6.2831853 + .5, .5 - aLL.y / 3.14159265);
    vec3 n = vec3(cos(aLL.y) * sin(aLL.x), sin(aLL.y), cos(aLL.y) * cos(aLL.x));
    vUV = uv; vN = uRot * n;
    gl_Position = uMVP * vec4(n * (1. + (textureLod(uH, uv, 2.).r - uBase) * uK), 1.);
  }`;
  // uMode 0: the camera's colour; 1: composition (highlands, iron-rich maria, thorium). Both with the relief light and a darker limb.
  const FS = `#version 300 es
  precision highp float;
  in vec2 vUV; in vec3 vN;
  uniform sampler2D uH, uC, uFe, uTh;
  uniform vec3 uHigh, uMare, uKreep; uniform float uMode;
  out vec4 o;
  // The Lunar Prospector maps are rainbow-coded: recover 0 (blue) .. 1 (red) from the hue
  float val(sampler2D t) {
    vec3 c = texture(t, vUV, 1.6).rgb;
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
    if (d < .03) return 0.;
    float hue = mx == c.r ? mod((c.g - c.b) / d, 6.) : mx == c.g ? (c.b - c.r) / d + 2. : (c.r - c.g) / d + 4.;
    return clamp(1. - hue / 6. / .68, 0., 1.) * smoothstep(.03, .2, d);
  }
  void main() {
    float h = texture(uH, vUV).r, lat = (.5 - vUV.y) * 3.14159265;
    vec2 e = vec2(1. / 1920., 1. / 960.) * 1.5;
    float hx = (texture(uH, vUV + vec2(e.x, 0.)).r - texture(uH, vUV - vec2(e.x, 0.)).r) / max(cos(lat), .2);
    float hy = texture(uH, vUV + vec2(0., e.y)).r - texture(uH, vUV - vec2(0., e.y)).r;
    float shade = clamp(1. + 7. * (hx + hy), .5, 1.4);              // relief light from the north-west
    float limb = mix(.6, 1., pow(max(vN.z, 0.), .55));
    vec3 colour = texture(uC, vUV).rgb * mix(1., shade, .8) * 1.1;
    float polar = 1. - smoothstep(1.25, 1.42, abs(lat));            // the element maps are noise near the poles
    vec3 comp = mix(uHigh, uMare, smoothstep(.3, .56, val(uFe)) * polar);
    comp = mix(comp, uKreep, smoothstep(.4, .85, val(uTh)) * polar);
    comp *= mix(.8, 1.12, smoothstep(.1, .7, h)) * shade;         // higher ground is lighter
    o = vec4(mix(colour, comp, uMode) * limb, 1.);
  }`;

  let U;
  try {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'aLL'); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    U = n => gl.getUniformLocation(prog, n);
  } catch (err) { console.error(err); fig.classList.add('nogl'); return; }

  // Sphere grid in (longitude, latitude)
  const NX = 360, NY = 180, ll = new Float32Array((NX + 1) * (NY + 1) * 2), idx = new Uint32Array(NX * NY * 6);
  for (let j = 0, k = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) { ll[k++] = (i / NX - .5) * 2 * Math.PI; ll[k++] = (.5 - j / NY) * Math.PI; }
  for (let j = 0, k = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + NX + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = a + 1; idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1; }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, ll, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.enable(gl.DEPTH_TEST);
  gl.uniform1f(U('uK'), .11); gl.uniform1f(U('uBase'), .45);
  gl.uniform3fv(U('uHigh'), ink('--globe-high')); gl.uniform3fv(U('uMare'), ink('--globe-mare')); gl.uniform3fv(U('uKreep'), ink('--globe-kreep'));
  const uMVP = U('uMVP'), uRot = U('uRot'), uMode = U('uMode');

  const MAPS = [['img/moon-elevation.jpg', 'uH'], ['img/moon-color.jpg', 'uC'], ['img/moon-iron.jpg', 'uFe'], ['img/moon-thorium.jpg', 'uTh']];
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  let loaded = 0;
  MAPS.forEach(([file, name], unit) => {
    gl.uniform1i(U(name), unit);
    const img = new Image();
    img.onload = () => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);   // the height and element maps hold numbers, not colours
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
      if (++loaded === MAPS.length) { fig.classList.add('ready'); loop(); }
    };
    img.onerror = () => fig.classList.add('nogl');
    img.src = file;
  });

  // View: the point (lon0, lat0) faces the viewer
  let lon0 = -12, lat0 = 12, spin = !still, goal = null, mode = 0, modeGoal = 0, size = 0, drag = null;
  function draw() {
    if (loaded < MAPS.length) return;
    const w = Math.round(stage.clientWidth * Math.min(devicePixelRatio || 1, 2));
    if (w !== size) { size = canvas.width = canvas.height = w; gl.viewport(0, 0, w, w); }
    const c = Math.cos(-lon0 * RAD), s = Math.sin(-lon0 * RAD), ca = Math.cos(lat0 * RAD), sa = Math.sin(lat0 * RAD);
    const R = [[c, 0, s], [sa * s, ca, -sa * c], [-ca * s, sa, ca * c]];
    const near = 1, far = 10, A = (far + near) / (near - far), B = 2 * far * near / (near - far);
    gl.uniformMatrix4fv(uMVP, false, [
      F * R[0][0], F * R[1][0], A * R[2][0], -R[2][0],  F * R[0][1], F * R[1][1], A * R[2][1], -R[2][1],
      F * R[0][2], F * R[1][2], A * R[2][2], -R[2][2],  0, 0, -A * DIST + B, DIST]);
    gl.uniformMatrix3fv(uRot, false, [R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]);
    gl.uniform1f(uMode, mode);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);
    SITES.forEach(p => {                                             // the pins follow their site, and hide behind the limb
      const la = p.lat * RAD, lo = p.lon * RAD, n = [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
      const [x, y, z] = R.map(r => r[0] * n[0] + r[1] * n[1] + r[2] * n[2]);
      p.pin.style.left = (50 + 50 * F * x / (DIST - z)) + '%'; p.pin.style.top = (50 - 50 * F * y / (DIST - z)) + '%';
      p.pin.classList.toggle('far', z < .3);
    });
  }

  // Motion: the slow turn, the turn to a chosen site, the cross-fade between colour and composition
  let raf = 0, last = 0, visible = true;
  function tick(now) {
    raf = 0;
    const dt = last ? Math.min((now - last) / 1000, .05) : 0; last = now;
    let moving = false;
    if (goal) {
      const dl = wrap(goal.lon - lon0), dp = goal.lat - lat0, k = Math.min(1, dt * 5);
      lon0 += dl * k; lat0 += dp * k; moving = true;
      if (Math.abs(dl) < .05 && Math.abs(dp) < .05) { lon0 = goal.lon; lat0 = goal.lat; goal = null; }
    } else if (spin && !drag) { lon0 -= dt * 5; moving = true; }
    if (mode !== modeGoal) { const d = modeGoal - mode; mode = Math.abs(d) < .01 ? modeGoal : mode + d * Math.min(1, dt * 6); moving = true; }
    draw();
    if (moving) loop(); else last = 0;
  }
  const loop = () => { if (!raf && visible) raf = requestAnimationFrame(tick); };
  new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) { last = 0; loop(); } }).observe(stage);
  new ResizeObserver(() => draw()).observe(stage);

  // Drag to turn (on a touch screen, a vertical drag scrolls the page); the arrow keys turn it by 10°
  stage.addEventListener('pointerdown', e => {
    if (e.button > 0 || e.target.closest('.pin')) return;
    drag = { x: e.clientX, y: e.clientY }; spin = false; goal = null;
    stage.setPointerCapture(e.pointerId); stage.classList.add('dragging'); fig.classList.add('turned');
  });
  stage.addEventListener('pointermove', e => {
    if (!drag) return;
    const k = 150 / stage.clientWidth;
    lon0 -= (e.clientX - drag.x) * k; lat0 = clamp(lat0 + (e.clientY - drag.y) * k, -85, 85);
    drag.x = e.clientX; drag.y = e.clientY; draw();
  });
  const end = () => { drag = null; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  stage.addEventListener('keydown', e => {
    const d = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] }[e.key];
    if (!d || e.target !== stage) return;
    e.preventDefault(); spin = false; goal = null; lon0 += d[0]; lat0 = clamp(lat0 + d[1], -85, 85); draw();
  });

  // Sites: a pin on the globe (for the pointer) and a button under it (for everyone)
  function select(p) {
    SITES.forEach(q => { q.pin.classList.toggle('on', q === p); q.pill.setAttribute('aria-pressed', String(q === p)); });
    spin = false; goal = { lon: p.lon, lat: clamp(p.lat, -60, 60) };
    if (still) { lon0 = goal.lon; lat0 = goal.lat; goal = null; draw(); } else loop();
  }
  SITES.forEach(p => {
    p.pin = document.createElement('button');
    p.pin.type = 'button'; p.pin.className = 'pin'; p.pin.title = p.name + ' · ' + p.pos; p.pin.tabIndex = -1; p.pin.setAttribute('aria-hidden', 'true');
    p.pin.addEventListener('click', () => select(p));
    stage.append(p.pin);
    p.pill = document.createElement('button');
    p.pill.type = 'button'; p.pill.className = 'pill'; p.pill.textContent = p.name; p.pill.title = p.pos; p.pill.setAttribute('aria-pressed', 'false');
    p.pill.addEventListener('click', () => select(p));
    list.append(p.pill);
  });

  // Colour or composition
  const modes = [...fig.querySelectorAll('.modes button')];
  modes.forEach(b => b.addEventListener('click', () => {
    modeGoal = +b.dataset.mode; if (still) mode = modeGoal;
    modes.forEach(o => o.setAttribute('aria-pressed', String(o === b)));
    key.classList.toggle('on', modeGoal === 1);
    loop();
  }));
})();
