// Tav app · draw a box on the Moon, capture every layer inside it, click the dots.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var KM = 30.3234, RED = '#ff4b4b';
  var KIND = {
    nac: { c: '#3dffc0', name: 'NAC raw frames' }, radar: { c: '#a98bff', name: 'Radar sounder tracks' },
    ohrc: { c: '#ff5fb8', name: 'Chandrayaan-2 OHRC tiles · Xenarch' }, hardware: { c: '#5b8cff', name: 'Hardware sites · Xenarch' },
    terrain: { c: '#ffb347', name: 'NAC terrain tiles · Xenarch' }
  };
  var fmtB = function (b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' kB'; };
  var num = function (v) { return v.toLocaleString('en', { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2 }); };
  var fmtKm = function (k) { return k >= 100 ? Math.round(k) : k >= 10 ? k.toFixed(1) : k.toFixed(2); };
  var el = function (tag, attrs, kids) {
    var e = document.createElement(tag), k;
    for (k in attrs || {}) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'on') e.addEventListener('click', attrs[k]); else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  };
  var api = function (path, body) {
    return fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  };

  // ---------------------------------------------------------------- map
  var map = L.map('map', { crs: L.CRS.EPSG4326, center: [14.09, -56.77], zoom: 3, minZoom: 1, maxZoom: 13, zoomControl: false,
    maxBounds: [[-95, -200], [95, 200]], zoomSnap: 0.5, doubleClickZoom: true });
  L.imageOverlay('img/tav/moon_map.jpg', [[-90, -180], [90, 180]]).addTo(map);
  L.tileLayer('https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    { maxNativeZoom: 8, maxZoom: 13, noWrap: true, bounds: [[-90, -180], [90, 180]], attribution: 'LROC WAC mosaic · NASA Moon Trek' }).addTo(map);
  map.attributionControl.setPrefix('');
  $('zin').onclick = function () { map.zoomIn(); }; $('zout').onclick = function () { map.zoomOut(); };

  // ---------------------------------------------------------------- draw
  var mode = null, shape = null, ring = null, start = null, verts = [], ghost = null;
  function setMode(m) {
    mode = m; $('draw-rect').classList.toggle('on', m === 'rect'); $('draw-poly').classList.toggle('on', m === 'poly');
    map.getContainer().classList.toggle('drawing', !!m);
    if (m) { map.dragging.disable(); map.doubleClickZoom.disable(); } else { map.dragging.enable(); map.doubleClickZoom.enable(); }
    $('hint').textContent = m === 'rect' ? 'Press, drag and release on the map.' : m === 'poly' ? 'Click each corner. Double-click to close the shape.' : 'Pick a shape, then draw on the map.';
    verts = []; start = null; if (ghost) { map.removeLayer(ghost); ghost = null; }
  }
  function clearShape() { if (shape) map.removeLayer(shape); shape = null; ring = null; $('pending').hidden = true; }
  function finish(kind, pts) {
    setMode(null); clearShape(); ring = pts.map(function (p) { return [p.lat, p.lng]; }); ring.kind = kind;
    shape = L.polygon(pts, { color: RED, weight: 2, fillColor: RED, fillOpacity: 0.08, interactive: false }).addTo(map);
    var b = shape.getBounds(), mid = (b.getNorth() + b.getSouth()) / 2;
    $('pending-size').textContent = fmtKm((b.getEast() - b.getWest()) * KM * Math.cos(mid * Math.PI / 180)) + ' km × ' + fmtKm((b.getNorth() - b.getSouth()) * KM) + ' km';
    $('pending').hidden = false; $('hint').textContent = 'Box drawn. Capture it, or draw again.';
  }
  $('draw-rect').onclick = function () { showHome(); setMode(mode === 'rect' ? null : 'rect'); };
  $('draw-poly').onclick = function () { showHome(); setMode(mode === 'poly' ? null : 'poly'); };
  $('cancel').onclick = function () { clearShape(); setMode(null); };
  map.on('mousedown', function (e) { if (mode === 'rect') { start = e.latlng; } });
  map.on('mousemove', function (e) {
    if (mode === 'rect' && start) {
      if (ghost) map.removeLayer(ghost);
      ghost = L.rectangle([start, e.latlng], { color: RED, weight: 2, fillOpacity: 0.08, interactive: false }).addTo(map);
    } else if (mode === 'poly' && verts.length) {
      if (ghost) map.removeLayer(ghost);
      ghost = L.polyline(verts.concat([e.latlng]), { color: RED, weight: 2, interactive: false }).addTo(map);
    }
  });
  map.on('mouseup', function (e) {
    if (mode !== 'rect' || !start) return;
    var a = start, b = e.latlng; start = null;
    if (Math.abs(a.lat - b.lat) < 1e-4 || Math.abs(a.lng - b.lng) < 1e-4) return;
    var n = Math.max(a.lat, b.lat), s = Math.min(a.lat, b.lat), w = Math.min(a.lng, b.lng), ea = Math.max(a.lng, b.lng);
    finish('rectangle', [L.latLng(n, w), L.latLng(n, ea), L.latLng(s, ea), L.latLng(s, w)]);
  });
  map.on('click', function (e) { if (mode === 'poly') verts.push(e.latlng); });
  map.on('dblclick', function () {
    if (mode !== 'poly') return;
    var v = verts.filter(function (p, i) { return i === 0 || !p.equals(verts[i - 1]); });
    if (v.length >= 3) finish('polygon', v);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (mode) setMode(null); else if (!$('three').hidden) close3d(); else closeViewer(); } });

  // ------------------------------------------------------------ captures
  var deep = null;
  var cur = null, timer = null, vis = {}, overlays = {}, markers = [], builtFor = null, online = false;
  function showHome() { $('home').hidden = false; $('detail').hidden = true; }
  function loadList() {
    return api('/api/captures').then(function (list) {
      online = true; $('offline').hidden = true;
      var ul = $('caplist'); ul.innerHTML = '';
      if (!list.length) ul.appendChild(el('li', { class: 'muted', text: 'None yet.' }));
      list.forEach(function (c) {
        ul.appendChild(el('li', { class: 'cap', tabindex: '0', on: function () { openCapture(c.id, true); } },
          [c.created.replace('T', ' · ').slice(0, 18), el('small', { text: fmtKm(c.size_km[0]) + ' km × ' + fmtKm(c.size_km[1]) + ' km · ' + ((c.bbox.north + c.bbox.south) / 2).toFixed(2) + '°, ' + ((c.bbox.east + c.bbox.west) / 2).toFixed(2) + '° · ' + c.status })]));
      });
    }).catch(function () { online = false; $('offline').hidden = false; $('capture').disabled = true; });
  }
  $('capture').onclick = function () {
    if (!ring) return; $('capture').disabled = true;
    api('/api/captures', { ring: ring, shape: ring.kind }).then(function (r) { $('capture').disabled = false; $('pending').hidden = true; openCapture(r.id, false); })
      .catch(function (e) { $('capture').disabled = false; alert('Capture failed: ' + e.message); });
  };
  $('to-home').onclick = function () { closeCapture(); history.replaceState(null, '', location.pathname); loadList(); };
  function closeCapture() {
    clearInterval(timer); timer = null; cur = null; builtFor = null; closeViewer(); close3d();
    Object.keys(overlays).forEach(function (k) { map.removeLayer(overlays[k]); }); overlays = {};
    markers.forEach(function (m) { map.removeLayer(m); }); markers = []; clearShape(); showHome();
  }
  function openCapture(id, fit) {
    closeCapture(); $('home').hidden = true; $('detail').hidden = false; vis = { outline: true };
    history.replaceState(null, '', '#' + id);
    var tick = function () {
      api('/api/captures/' + id).then(function (m) {
        var first = !cur; cur = m; render(first && fit);
        var busy = m.status !== 'complete' || Object.keys(m.jobs || {}).some(function (k) { return m.jobs[k].state === 'running'; });
        clearInterval(timer); timer = setInterval(tick, busy ? 1200 : 6000);
      }).catch(function () {});
    };
    tick();
  }

  function layerRow(key, title, sub, color) {
    var cb = el('input', { type: 'checkbox' }); cb.checked = !!vis[key];
    cb.onchange = function () { vis[key] = cb.checked; sync(); };
    return el('li', {}, [el('label', {}, [cb, el('span', {}, [color ? el('i', { class: 'dotkey', style: '--c:' + color }) : '', title, el('small', { text: sub })])])]);
  }
  function render(fit) {
    var m = cur, b = m.bbox;
    $('d-title').textContent = m.created.replace('T', ' · ').slice(0, 18);
    $('d-sub').textContent = (m.status === 'complete' ? 'Complete' : 'Capturing…') + ' · ' + fmtKm(m.size_km[0]) + ' km × ' + fmtKm(m.size_km[1]) + ' km · ' + ((b.north + b.south) / 2).toFixed(3) + '°, ' + ((b.east + b.west) / 2).toFixed(3) + '°';
    var st = $('d-steps'); st.innerHTML = '';
    m.steps.forEach(function (s) { st.appendChild(el('li', { class: s.ok ? 'ok' : 'bad', text: s.name + (s.ok ? ' · ' + s.seconds + ' s' : ' · failed') })); });
    if (m.status !== 'complete') st.appendChild(el('li', { class: 'run', text: m.step }));
    st.hidden = m.status === 'complete' && m.steps.every(function (s) { return s.ok; });

    // default: sharpest imagery on, the rest off
    var keys = m.layers.map(function (l) { return l.key; });
    var best = keys.indexOf('imagery_tc') >= 0 ? 'imagery_tc' : 'imagery';
    keys.forEach(function (k) { if (!(k in vis)) vis[k] = false; });
    if (keys.indexOf(best) >= 0 && !vis._picked) { vis[best] = true; vis._picked = best; }
    if (best === 'imagery_tc' && vis._picked === 'imagery') { vis.imagery = false; vis.imagery_tc = true; vis._picked = best; }

    var ul = $('d-layers'); ul.innerHTML = '';
    if (m.mesh) ul.appendChild(el('li', {}, [el('div', { class: 'row' }, [el('span', {}, ['3D mesh', el('small', { text: m.mesh.vertices.toLocaleString() + ' points · ' + m.mesh.relief_m + ' m of relief' })]), el('button', { type: 'button', text: 'Show in 3D', on: open3d })])]));
    ul.appendChild(layerRow('outline', 'Capture outline', m.shape));
    m.layers.forEach(function (l) {
      var sub = (l.m_px >= 1000 ? (l.m_px / 1000).toFixed(1) + ' km' : l.m_px + ' m') + ' per pixel';
      if (l.min !== undefined && l.key.indexOf('imagery') < 0) sub += ' · ' + num(l.min) + ' to ' + num(l.max) + ' ' + l.unit;
      if (l.coverage_pct !== undefined && l.coverage_pct < 99) sub += ' · covers ' + l.coverage_pct + '%';
      ul.appendChild(layerRow(l.key, l.title, sub));
    });
    m.vectors.forEach(function (v) {
      if (v.key === 'geology') { ul.appendChild(el('li', {}, ['Geologic units', el('small', { text: (v.units || []).slice(0, 3).map(function (u) { return u.unit + ' ' + u.name + ' ' + u.pct + '%'; }).join(' · ') })])); return; }
      if (!(v.key in vis)) vis[v.key] = v.key === 'pits';
      ul.appendChild(layerRow(v.key, v.title, v.count.toLocaleString() + ' inside the box'));
    });

    var pc = m.point_counts || {}, up = $('d-points'); up.innerHTML = '';
    Object.keys(KIND).forEach(function (k) {
      if (!(('p_' + k) in vis)) vis['p_' + k] = true;
      if (pc[k]) up.appendChild(layerRow('p_' + k, KIND[k].name, pc[k] + (pc[k] === 1 ? ' point' : ' points'), KIND[k].c));
    });
    if (m.status === 'complete' && !m.points.length) up.appendChild(el('li', { class: 'muted', text: 'No frames, tracks or tiles inside this box.' }));
    if (m.status !== 'complete') up.appendChild(el('li', { class: 'muted', text: 'Dots appear when the capture is complete.' }));

    var uc = $('d-cat'); uc.innerHTML = '';
    m.catalogue.forEach(function (c) {
      if (!c.count) return;
      var job = (m.jobs || {})[c.type + ':all'], sub = c.count.toLocaleString() + (c.count === 1 ? ' product · ' : ' products · ') + fmtB(c.bytes) + (c.listed < c.count ? ' (first ' + c.listed + ')' : '');
      if (job) sub = (job.state === 'done' ? 'Downloaded ' : 'Downloading ') + job.done + ' of ' + job.total + ' · ' + fmtB(job.bytes) + (job.errors.length ? ' · ' + job.errors.length + ' failed' : '');
      var btn = el('button', { type: 'button', text: 'Download', on: function () {
        if (c.bytes > 1e9 && !confirm('Download ' + c.listed + ' products, ' + fmtB(c.bytes) + ', into the capture folder?')) return;
        btn.disabled = true; api('/api/captures/' + m.id + '/fetch', { type: c.type }).catch(function (e) { alert(e.message); });
      } });
      if (job) btn.disabled = true;
      uc.appendChild(el('li', {}, [el('div', { class: 'row' }, [el('span', {}, [c.title, el('small', { text: sub })]), btn])]));
    });

    var uf = $('d-files'); uf.innerHTML = '';
    m.files.slice(0, 60).forEach(function (f) { uf.appendChild(el('li', {}, [el('a', { href: '/captures/' + m.id + '/' + f.name, target: '_blank', rel: 'noopener', text: f.name }), el('span', { text: fmtB(f.bytes) })])); });
    if (m.files.length > 60) uf.appendChild(el('li', { class: 'muted', text: '… and ' + (m.files.length - 60) + ' more' }));
    $('d-path').textContent = m.dir;
    var un = $('d-notes'); un.innerHTML = ''; m.notes.forEach(function (n) { un.appendChild(el('li', { text: n })); });

    sync(fit);
  }
  $('copy-path').onclick = function () {
    var t = $('d-path').textContent, b = $('copy-path');
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy path'; }, 1500); }, function () { prompt('Capture folder', t); });
  };

  // ---------------------------------------------------- overlays and dots
  function setLayer(key, on, make) {
    if (on && !overlays[key]) { overlays[key] = make().addTo(map); }
    if (!on && overlays[key]) { map.removeLayer(overlays[key]); delete overlays[key]; }
  }
  function sync(fit) {
    var m = cur, base = '/captures/' + m.id + '/';
    setLayer('outline', vis.outline, function () { return L.polygon(m.ring, { color: RED, weight: 2, fill: false, interactive: false }); });
    m.layers.forEach(function (l) {
      var stamp = (m.files.filter(function (f) { return f.name === l.preview; })[0] || {}).bytes || 0, key = l.key + '@' + stamp;
      Object.keys(overlays).forEach(function (k) { if (k.indexOf(l.key + '@') === 0 && k !== key) { map.removeLayer(overlays[k]); delete overlays[k]; } });
      setLayer(key, vis[l.key], function () { return L.imageOverlay(base + l.preview + '?v=' + stamp, l.bounds, { opacity: l.key.indexOf('imagery') === 0 ? 1 : 0.8, interactive: false }); });
    });
    m.vectors.forEach(function (v) {
      if (v.key === 'geology') return;
      setLayer(v.key, vis[v.key], function () {
        var g = L.layerGroup();
        fetch(base + v.file).then(function (r) { return r.json(); }).then(function (fc) {
          fc.features.forEach(function (f) {
            var ll = [f.geometry.coordinates[1], f.geometry.coordinates[0]], p = f.properties;
            if (v.key === 'craters') L.circle(ll, { radius: p.diameter_km * 500 * 6378137 / 1737400, color: '#7aa2ff', weight: 1.5, fill: false, interactive: false }).addTo(g);
            else if (v.key === 'names') L.circleMarker(ll, { radius: 3, color: '#fff', weight: 1, fillOpacity: 1 }).bindTooltip(p.name, { permanent: true, direction: 'right', className: 'nm' }).addTo(g);
            else L.circleMarker(ll, { radius: 7, color: '#ff5fb8', weight: 3, fill: false }).bindTooltip(p.name + ' · ' + p.depth_m + ' m deep', { direction: 'top' }).addTo(g);
          });
        });
        return g;
      });
    });
    if (m.status === 'complete' && builtFor !== m.id) {
      builtFor = m.id;
      markers = m.points.map(function (p) {
        var mk = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: '<div class="pt" style="--c:' + KIND[p.kind].c + '"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), title: p.title, keyboard: true });
        mk.p = p; mk.on('click', function () { openPoint(p.i, 0); }); return mk;
      });
    }
    markers.forEach(function (mk) { var on = !!vis['p_' + mk.p.kind]; if (on && !map.hasLayer(mk)) mk.addTo(map); if (!on && map.hasLayer(mk)) map.removeLayer(mk); });
    spread();
    if (deep && m.status === 'complete') { var d = deep; deep = null; if (d === '3d') open3d(); else if (/^p\d+$/.test(d) && m.points[+d.slice(1)]) openPoint(+d.slice(1), 0); }
    if (fit) map.fitBounds([[m.bbox.south, m.bbox.west], [m.bbox.north, m.bbox.east]], { padding: [60, 60] });
  }
  // dots that fall on the same spot are fanned out so each one can be clicked
  function spread() {
    var cells = {};
    markers.forEach(function (mk) {
      if (!map.hasLayer(mk) || !mk._icon) return;
      var pt = map.latLngToContainerPoint(mk.getLatLng()), k = Math.round(pt.x / 16) + ',' + Math.round(pt.y / 16);
      (cells[k] = cells[k] || []).push(mk);
    });
    Object.keys(cells).forEach(function (k) {
      cells[k].forEach(function (mk, j) {
        var r = 13 * Math.sqrt(j), a = j * 2.39996;
        mk._icon.style.marginLeft = (-9 + r * Math.cos(a)) + 'px'; mk._icon.style.marginTop = (-9 + r * Math.sin(a)) + 'px';
      });
    });
  }
  map.on('zoomend moveend', spread);

  // -------------------------------------------------------------- viewer
  var vp = null;
  function closeViewer() { $('viewer').hidden = true; vp = null; markers.forEach(function (mk) { if (mk._icon) mk._icon.firstChild.classList.remove('on'); }); }
  $('v-close').onclick = closeViewer;
  function openPoint(i, tile) {
    var m = cur, p = m.points[i], same = m.points.filter(function (x) { return x.kind === p.kind; }), pos = same.indexOf(p);
    vp = i; $('viewer').hidden = false; $('v-img').hidden = true; $('v-wait').hidden = false; $('v-wait').textContent = p.kind === 'nac' ? 'Reading the frame from the LROC archive…' : p.kind === 'radar' ? 'Downloading the track from JAXA (45 MB the first time)…' : 'Loading…';
    $('v-kind').textContent = KIND[p.kind].name + ' · ' + (pos + 1) + ' of ' + same.length;
    $('v-title').textContent = p.title; $('v-text').textContent = p.text; $('v-extra').textContent = '';
    markers.forEach(function (mk) { if (mk._icon) mk._icon.firstChild.classList.toggle('on', mk.p.i === i); });
    var tools = $('v-tools'); tools.innerHTML = '';
    if (same.length > 1) {
      tools.appendChild(el('button', { type: 'button', text: '← Previous', on: function () { openPoint(same[(pos - 1 + same.length) % same.length].i, 0); } }));
      tools.appendChild(el('button', { type: 'button', text: 'Next →', on: function () { openPoint(same[(pos + 1) % same.length].i, 0); } }));
    }
    api('/api/captures/' + m.id + '/point/' + i + '?i=' + tile).then(function (r) {
      if (vp !== i) return;
      var base = '/captures/' + m.id + '/', img = $('v-img'), show = function (src) { img.onload = function () { img.hidden = false; $('v-wait').hidden = true; }; img.src = base + src; img.alt = p.title; };
      show(r.img); $('v-extra').textContent = r.extra || '';
      if (r.n > 1) tools.appendChild(el('button', { type: 'button', text: 'Tile ' + (r.i + 1) + ' of ' + r.n + ' →', on: function () { openPoint(i, r.i + 1); } }));
      if (r.more) { var wide = false, b = el('button', { type: 'button', text: 'Wide view', on: function () { wide = !wide; b.textContent = wide ? 'Close-up' : 'Wide view'; show(wide ? r.more : r.img); } }); tools.appendChild(b); }
      if (r.download) {
        var d = el('button', { type: 'button', text: 'Download full frame · ' + fmtB(r.download.bytes), on: function () { d.disabled = true; d.textContent = 'Downloading into the capture folder…'; api('/api/captures/' + m.id + '/fetch', { type: r.download.type, id: r.download.id }); } });
        tools.appendChild(d);
      }
    }).catch(function (e) { if (vp === i) $('v-wait').textContent = 'Could not load: ' + e.message; });
  }

  // ------------------------------------------------------------------ 3D
  var three = null;
  function close3d() { $('three').hidden = true; if (three) { cancelAnimationFrame(three.raf); three.renderer.dispose(); $('t-canvas').innerHTML = ''; three = null; } }
  $('t-close').onclick = close3d;
  function open3d() {
    if (!window.THREE || !THREE.GLTFLoader) { alert('The 3D viewer could not be loaded (no network?). The mesh file is mesh.glb in the capture folder.'); return; }
    close3d(); $('three').hidden = false;
    var box = $('t-canvas'), w = box.clientWidth, h = box.clientHeight, m = cur;
    var renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setSize(w, h); renderer.outputEncoding = THREE.sRGBEncoding; box.appendChild(renderer.domElement);
    var scene = new THREE.Scene(); scene.background = new THREE.Color(0x05060b);
    var size = Math.max(m.mesh.width_m, m.mesh.height_m), cam = new THREE.PerspectiveCamera(40, w / h, size / 1000, size * 20);
    cam.position.set(0, size * 0.75, size * 1.1);
    var ctl = new THREE.OrbitControls(cam, renderer.domElement); ctl.maxPolarAngle = Math.PI / 2;
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    three = { renderer: renderer, raf: 0, obj: null };
    var stamp = (m.files.filter(function (f) { return f.name === 'mesh.glb'; })[0] || {}).bytes || 0;
    new THREE.GLTFLoader().load('/captures/' + m.id + '/mesh.glb?v=' + stamp, function (g) {
      if (!three) return;
      g.scene.traverse(function (o) { if (o.isMesh) { o.material = new THREE.MeshBasicMaterial({ map: o.material.map, side: THREE.DoubleSide }); } });
      three.obj = g.scene; scene.add(g.scene); exag();
    });
    function exag() { var v = parseFloat($('t-exag').value); $('t-exag-v').textContent = v; if (three && three.obj) { three.obj.scale.y = v; three.obj.position.y = -m.mesh.relief_m * v / 2; } }
    $('t-exag').oninput = exag;
    (function loop() { if (!three) return; three.raf = requestAnimationFrame(loop); ctl.update(); renderer.render(scene, cam); })();
  }

  // -------------------------------------------------------------- search
  var names = null;
  $('q').addEventListener('input', function () {
    var q = this.value.trim().toLowerCase(), ul = $('results');
    if (q.length < 2) { ul.hidden = true; return; }
    (names ? Promise.resolve(names) : fetch('/index/names.json').then(function (r) { return r.json(); }).then(function (n) { names = n; return n; })).then(function (n) {
      var hit = n.filter(function (x) { return x[0].toLowerCase().indexOf(q) === 0; }).concat(n.filter(function (x) { return x[0].toLowerCase().indexOf(q) > 0; })).slice(0, 8);
      ul.innerHTML = ''; ul.hidden = !hit.length;
      hit.forEach(function (x) {
        ul.appendChild(el('li', { tabindex: '0', on: function () {
          ul.hidden = true; $('q').value = x[0];
          var z = x[4] > 300 ? 4 : x[4] > 60 ? 6 : x[4] > 10 ? 8 : 10; map.setView([x[2], x[3]], z);
        } }, [x[0], el('small', { text: x[1] + (x[4] ? ' · ' + x[4] + ' km' : '') })]));
      });
    }).catch(function () { ul.hidden = true; });
  });

  loadList().then(function () { var h = location.hash.slice(1).split('&'); if (online && /^tav-[\w-]+$/.test(h[0])) { openCapture(h[0], true); if (h[1]) deep = h[1]; } });
})();
