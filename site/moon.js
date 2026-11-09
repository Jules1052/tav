/* Interactive Moon globe (home page). WebGL2, no library.
 * Relief: LRO LOLA elevation (img/moon-elevation.jpg). Minerals: Lunar Prospector iron and thorium maps,
 * read back from their rainbow scale (blue = low, red = high). All maps are centred on 0° longitude.
 * Colours come from the --globe-* tokens in style.css. */
(() => {
  const fig = document.querySelector('.globe');
  if (!fig) return;
  const stage = fig.querySelector('.stage'), canvas = fig.querySelector('canvas');
  const info = fig.querySelector('.info'), chips = fig.querySelector('.chips'), legend = fig.querySelector('.legend');
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
  if (!gl) { fig.classList.add('nogl'); return; }

  const SITES = [
    { name: 'Mare Tranquillitatis pit', short: 'Tranquillitatis', lat: 8.34, lon: 33.22, pos: '8.34° N 33.22° E',
      text: 'Opening about 98 × 84 m, about 105 m deep. Radar shows a cave leaving its floor.' },
    { name: 'Marius Hills pit', short: 'Marius Hills', lat: 14.09, lon: -56.77, pos: '14.09° N 303.23° E',
      text: 'Opening about 58 × 49 m, about 40 m deep. A radar double echo and a gravity deficit point to a tube below.' },
    { name: 'Mare Ingenii pit', short: 'Ingenii', lat: -35.95, lon: 166.06, pos: '35.95° S 166.06° E',
      text: 'Farside. Opening about 118 × 68 m, 45–65 m deep. An overhang is visible in oblique images.' },
    { name: 'Hadley Rille', short: 'Hadley Rille', lat: 26.13, lon: 3.63, pos: '26.13° N 3.63° E',
      text: 'A lava channel about 1.5 km wide and 300 m deep, thought to be a collapsed tube. Apollo 15 reached its edge in 1971.' },
  ];
  const RAD = Math.PI / 180, K = 0.11, DIST = 4.3, F = 1 / Math.tan(15 * RAD);

  const VS = `#version 300 es
  in vec2 aLL; uniform mat4 uMVP; uniform mat3 uRot; uniform sampler2D uH; uniform float uK;
  out vec2 vUV; out vec3 vN;
  void main() {
    vec2 uv = vec2(aLL.x / 6.2831853 + .5, .5 - aLL.y / 3.14159265);
    vec3 n = vec3(cos(aLL.y) * sin(aLL.x), sin(aLL.y), cos(aLL.y) * cos(aLL.x));
    float h = textureLod(uH, uv, 2.).r;
    vUV = uv; vN = uRot * n;
    gl_Position = uMVP * vec4(n * (1. + (h - .45) * uK), 1.);
  }`;
  const FS = `#version 300 es
  precision highp float;
  in vec2 vUV; in vec3 vN;
  uniform sampler2D uH, uFe, uTh;
  uniform vec3 uA, uB, uC, uR0, uR1, uR2, uR3; uniform float uMode;
  out vec4 o;
  // Lunar Prospector maps are rainbow-coded: recover 0 (blue) .. 1 (red) from the hue.
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
    float polar = 1. - smoothstep(1.25, 1.42, abs(lat));          // element maps are noise near the poles
    vec3 mineral = mix(uA, uB, smoothstep(.3, .56, val(uFe)) * polar);
    mineral = mix(mineral, uC, smoothstep(.4, .85, val(uTh)) * polar);
    float t = smoothstep(.12, .62, h) * 3.;
    vec3 ramp = t < 1. ? mix(uR0, uR1, t) : t < 2. ? mix(uR1, uR2, t - 1.) : mix(uR2, uR3, t - 2.);
    vec3 col = mix(mineral, ramp, uMode);
    col *= mix(.8, 1.12, smoothstep(.1, .7, h));                   // higher ground is lighter
    col *= clamp(1. + 7. * (hx + hy), .5, 1.4);                    // relief shading, light from the north-west
    col *= mix(.55, 1., pow(max(vN.z, 0.), .55));                  // limb darkening
    o = vec4(col, 1.);
  }`;

  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  gl.useProgram(prog);
  const U = n => gl.getUniformLocation(prog, n);

  // Sphere grid in (longitude, latitude)
  const NX = 360, NY = 180, ll = new Float32Array((NX + 1) * (NY + 1) * 2), idx = new Uint32Array(NX * NY * 6);
  for (let j = 0, k = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) { ll[k++] = (i / NX - .5) * 2 * Math.PI; ll[k++] = (.5 - j / NY) * Math.PI; }
  for (let j = 0, k = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + NX + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = a + 1; idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1; }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, ll, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.bindAttribLocation(prog, 0, 'aLL'); gl.linkProgram(prog); gl.useProgram(prog);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.enable(gl.DEPTH_TEST);

  let loaded = 0;
  ['moon-elevation.jpg', 'moon-iron.jpg', 'moon-thorium.jpg'].forEach((file, unit) => {
    const img = new Image();
    img.onload = () => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (++loaded === 3) { fig.classList.add('ready'); draw(); }
    };
    img.onerror = () => fig.classList.add('nogl');
    img.src = 'img/' + file;
  });
  gl.uniform1i(U('uH'), 0); gl.uniform1i(U('uFe'), 1); gl.uniform1i(U('uTh'), 2); gl.uniform1f(U('uK'), K);

  // Colours from the --globe-* tokens: highlands, maria, KREEP, then the four stops of the altitude ramp
  const probe = document.createElement('i'); probe.hidden = true; fig.append(probe);
  const ink = name => { probe.style.color = `var(--globe-${name})`; return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(v => v / 255); };
  function colours() {
    gl.uniform3fv(U('uA'), ink('high')); gl.uniform3fv(U('uB'), ink('mare')); gl.uniform3fv(U('uC'), ink('kreep'));
    [0, 1, 2, 3].forEach(i => gl.uniform3fv(U('uR' + i), ink('r' + i)));
  }

  // View: the point (lon0, lat0) faces the viewer
  let lon0 = 15, lat0 = 10, R = [], spin = !matchMedia('(prefers-reduced-motion: reduce)').matches, goal = null, raf = 0, last = 0, mode = 0, size = 0;
  function draw() {
    if (loaded < 3) return;
    const w = Math.round(stage.clientWidth * Math.min(devicePixelRatio || 1, 2));
    if (w !== size) { size = canvas.width = canvas.height = w; gl.viewport(0, 0, w, w); }
    const c = Math.cos(-lon0 * RAD), s = Math.sin(-lon0 * RAD), ca = Math.cos(lat0 * RAD), sa = Math.sin(lat0 * RAD);
    R = [[c, 0, s], [sa * s, ca, -sa * c], [-ca * s, sa, ca * c]];
    const near = 1, far = 10, A = (far + near) / (near - far), B = 2 * far * near / (near - far);
    gl.uniformMatrix4fv(U('uMVP'), false, [
      F * R[0][0], F * R[1][0], A * R[2][0], -R[2][0],  F * R[0][1], F * R[1][1], A * R[2][1], -R[2][1],
      F * R[0][2], F * R[1][2], A * R[2][2], -R[2][2],  0, 0, -A * DIST + B, DIST]);
    gl.uniformMatrix3fv(U('uRot'), false, [R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]);
    gl.uniform1f(U('uMode'), mode);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);
    SITES.forEach(p => {                                           // place the markers
      const la = p.lat * RAD, lo = p.lon * RAD, n = [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
      const [x, y, z] = R.map(r => r[0] * n[0] + r[1] * n[1] + r[2] * n[2]);
      p.el.style.left = (50 + 50 * F * x / (DIST - z)) + '%'; p.el.style.top = (50 - 50 * F * y / (DIST - z)) + '%';
      p.el.classList.toggle('far', z < .42);
    });
  }
  function tick(now) {
    raf = 0;
    const dt = Math.min((now - last) / 1000 || 0, .05); last = now;
    if (goal) {
      const dl = ((goal.lon - lon0 + 540) % 360) - 180, dp = goal.lat - lat0, k = Math.min(1, dt * 5);
      lon0 += dl * k; lat0 += dp * k;
      if (Math.abs(dl) < .05 && Math.abs(dp) < .05) goal = null;
    } else if (spin) lon0 += dt * 5;
    draw();
    if (goal || spin) loop();
  }
  const loop = () => { if (!raf && visible) raf = requestAnimationFrame(t => { tick(t); }); };
  let visible = true;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) { last = 0; loop(); } }).observe(stage);
  new ResizeObserver(() => draw()).observe(stage);

  // Drag to turn
  let drag = null;
  stage.addEventListener('pointerdown', e => { if (e.target.closest('button')) return;
    drag = { x: e.clientX, y: e.clientY }; spin = false; goal = null; stage.setPointerCapture(e.pointerId); stage.classList.add('dragging'); });
  stage.addEventListener('pointermove', e => { if (!drag) return;
    const k = 150 / stage.clientWidth;
    lon0 -= (e.clientX - drag.x) * k; lat0 = Math.max(-85, Math.min(85, lat0 + (e.clientY - drag.y) * k));
    drag = { x: e.clientX, y: e.clientY }; draw(); });
  const end = () => { drag = null; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  stage.addEventListener('keydown', e => { const d = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] }[e.key];
    if (!d || e.target !== stage) return; e.preventDefault(); spin = false; goal = null; lon0 += d[0]; lat0 = Math.max(-85, Math.min(85, lat0 + d[1])); draw(); });

  // Markers, site buttons, legend
  function select(p, turn) {
    SITES.forEach(q => { q.el.setAttribute('aria-pressed', q === p); q.chip.setAttribute('aria-pressed', q === p); });
    info.innerHTML = ''; const b = document.createElement('b'), s = document.createElement('span'), t = document.createElement('p');
    b.textContent = p.name; s.className = 'label'; s.textContent = p.pos; t.textContent = p.text; info.append(b, s, t);
    if (turn) { spin = false; goal = { lon: p.lon, lat: Math.max(-60, Math.min(60, p.lat)) }; loop(); }
  }
  SITES.forEach(p => {
    p.el = document.createElement('button'); p.el.type = 'button'; p.el.className = 'pin'; p.el.title = p.name; p.el.setAttribute('aria-label', p.name);
    p.el.addEventListener('click', () => select(p, true)); stage.append(p.el);
    p.chip = document.createElement('button'); p.chip.type = 'button'; p.chip.textContent = p.short;
    p.chip.addEventListener('click', () => select(p, true)); chips.append(p.chip);
  });
  const LEGEND = [
    '<span><i class="a"></i>Highlands</span><span><i class="b"></i>Maria, iron-rich</span><span><i class="c"></i>Thorium-rich</span><span><i class="pit"></i>Pit or rille</span>',
    '<span>Low</span><i class="ramp"></i><span>High</span><span><i class="pit"></i>Pit or rille</span>'];
  fig.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => {
    mode = +b.dataset.mode; legend.innerHTML = LEGEND[mode];
    fig.querySelectorAll('.modes button').forEach(o => o.setAttribute('aria-pressed', o === b)); draw();
  }));
  legend.innerHTML = LEGEND[0];
  colours(); select(SITES[0], false); loop();
})();
