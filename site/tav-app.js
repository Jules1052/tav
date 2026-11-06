// Tav app · 1 draw a box, 2 choose what to download, 3 look at the result.
// Every step has its own address (#…), so Back and Forward work.
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
  var res = function (m) { return (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m') + ' per pixel'; };
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
  var store = { get: function (k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }, set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

  // ---------------------------------------------------------------- map
  var map = L.map('map', { crs: L.CRS.EPSG4326, center: [14.09, -56.77], zoom: 3, minZoom: 1, maxZoom: 13, zoomControl: false,
    maxBounds: [[-95, -200], [95, 200]], zoomSnap: 0.5 });
  map.attributionControl.setPrefix('');
  map.createPane('base').style.zIndex = 150;   // under the tiles: only seen while they load or if NASA is unreachable
  L.imageOverlay('img/tav/moon_map.jpg', [[-90, -180], [90, 180]], { pane: 'base' }).addTo(map);
  L.tileLayer('https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    { maxNativeZoom: 8, maxZoom: 13, noWrap: true, bounds: [[-90, -180], [90, 180]], attribution: 'LROC WAC mosaic · NASA Moon Trek' }).addTo(map);
  $('zin').onclick = function () { map.zoomIn(); }; $('zout').onclick = function () { map.zoomOut(); };

  // ------------------------------------------------- addresses and history
  // ''                       step 1, draw
  // new=rectangle;lat,lon;…  step 2, choose
  // tav-…[&3d|&p12]          step 3, result (optionally the 3D view or one point)
  function nav(hash, replace) {
    var url = location.pathname + (hash ? '#' + hash : '');
    if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
    route();
  }
  $('h-back').onclick = function () { history.back(); };
  $('h-fwd').onclick = function () { history.forward(); };
  window.addEventListener('popstate', route);
  function show(step) {
    ['home', 'choose', 'detail'].forEach(function (s) { $(s).hidden = s !== step; });
    var order = ['home', 'choose', 'detail'], at = order.indexOf(step);
    Array.prototype.forEach.call($('crumbs').children, function (li, i) { li.className = i === at ? 'on' : i < at ? 'done' : ''; });
    $('side').scrollTop = 0;
  }
  function route() {
    var h = decodeURIComponent(location.hash.slice(1)), parts = h.split('&');
    setMode(null);
    if (h.indexOf('new=') === 0) {
      var seg = h.slice(4).split(';'), pts = seg.slice(1).map(function (s) { return s.split(',').map(Number); });
      if (pts.length >= 3 && pts.every(function (p) { return p.length === 2 && isFinite(p[0]) && isFinite(p[1]); })) { leaveCapture(); choose(seg[0] === 'polygon' ? 'polygon' : 'rectangle', pts); return; }
    }
    if (/^tav-[\w-]+$/.test(parts[0])) {
      clearShape(); want = parts[1] || null;
      if (!cur || cur.id !== parts[0]) openCapture(parts[0]); else applyWant();
      show('detail'); return;
    }
    leaveCapture(); clearShape(); show('home'); loadList();
  }

  // ---------------------------------------------------------------- draw
  var mode = null, shape = null, ring = null, start = null, verts = [], ghost = null;
  function setMode(m) {
    mode = m; $('draw-rect').classList.toggle('on', m === 'rect'); $('draw-poly').classList.toggle('on', m === 'poly');
    map.getContainer().classList.toggle('drawing', !!m);
    if (m) { map.dragging.disable(); map.doubleClickZoom.disable(); } else { map.dragging.enable(); map.doubleClickZoom.enable(); }
    $('hint').textContent = m === 'rect' ? 'Now press, drag and release on the map.' : m === 'poly' ? 'Click each corner on the map. Double-click to close the shape.' : 'Press the button, then press, drag and release on the map.';
    verts = []; start = null; if (ghost) { map.removeLayer(ghost); ghost = null; }
  }
  function clearShape() { if (shape) map.removeLayer(shape); shape = null; ring = null; }
  function finish(kind, pts) {
    nav('new=' + kind + ';' + pts.map(function (p) { return p.lat.toFixed(5) + ',' + p.lng.toFixed(5); }).join(';'));
  }
  $('draw-rect').onclick = function () { setMode(mode === 'rect' ? null : 'rect'); };
  $('draw-poly').onclick = function () { setMode(mode === 'poly' ? null : 'poly'); };
  $('redraw').onclick = function () { nav(''); setMode('rect'); };
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
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && mode) setMode(null); });

  // ----------------------------------------------- step 2 · choose
  var opts = { off: {}, max_px: 1024, tc: false };   // fresh every time: nothing stays switched off by surprise
  function check(key, title, sub, disabled) {
    var cb = el('input', { type: 'checkbox' }); cb.checked = !disabled && !opts.off[key]; cb.disabled = !!disabled; cb.dataset.key = key;
    cb.onchange = function () { opts.off[key] = !cb.checked; store.set('tav-options', opts); };
    return el('li', disabled ? { class: 'off' } : {}, [el('label', {}, [cb, el('span', {}, [title, el('small', { text: sub })])])]);
  }
  function choose(kind, pts) {
    clearShape(); ring = pts; ring.kind = kind; show('choose');
    shape = L.polygon(pts, { color: RED, weight: 2, fillColor: RED, fillOpacity: 0.08, interactive: false }).addTo(map);
    var b = shape.getBounds(), mid = (b.getNorth() + b.getSouth()) / 2;
    if (!map.getBounds().pad(0.3).contains(b) || map.getBoundsZoom(b) - map.getZoom() > 3) map.fitBounds(b, { padding: [120, 120], maxZoom: 11 });
    $('c-size').textContent = fmtKm((b.getEast() - b.getWest()) * KM * Math.cos(mid * Math.PI / 180)) + ' km × ' + fmtKm((b.getNorth() - b.getSouth()) * KM) + ' km · ' + kind;
    ['c-layers', 'c-points', 'c-kaguya'].forEach(function (id) { $(id).innerHTML = ''; });
    $('c-layers').appendChild(el('li', { class: 'muted', text: 'Looking at what is inside…' }));
    Array.prototype.forEach.call($('c-detail').children, function (bt) {
      bt.classList.toggle('on', +bt.dataset.px === opts.max_px);
      bt.onclick = function () { opts.max_px = +bt.dataset.px; store.set('tav-options', opts); Array.prototype.forEach.call($('c-detail').children, function (x) { x.classList.toggle('on', x === bt); }); };
    });
    $('capture').disabled = true;
    api('/api/plan', { ring: pts }).then(function (p) {
      if (ring !== pts) return;
      var L1 = $('c-layers'), c = p.counts, k = p.kaguya; L1.innerHTML = ''; $('capture').disabled = false;
      ['imagery', 'elevation', 'thermal_night', 'gravity', 'radar_cpr'].forEach(function (key) {
        var l = p.layers[key];
        if (key === 'elevation') { L1.appendChild(el('li', {}, [el('label', {}, [el('input', { type: 'checkbox', checked: '', disabled: '' }), el('span', {}, [l.title + ' + 3D mesh', el('small', { text: 'Always included · ' + res(l.m_px) + ' · ' + l.px[0].toLocaleString() + ' × ' + l.px[1].toLocaleString() + ' px in the box' })])])])); return; }
        L1.appendChild(check(key, l.title, l.available ? res(l.m_px) + ' · ' + l.px[0].toLocaleString() + ' × ' + l.px[1].toLocaleString() + ' px in the box' : 'Not available at this latitude', !l.available));
      });
      L1.appendChild(check('vectors', 'Craters, names, pits, geology', (c.craters === null ? '' : c.craters.toLocaleString() + ' craters · ') + c.names + ' names · ' + c.pits + (c.pits === 1 ? ' pit' : ' pits')));
      L1.appendChild(check('catalogue', 'List of full products in the archives', 'NAC frames, Kaguya tiles, M³ cubes, radar strips: names, sizes and links'));
      var P = $('c-points');
      P.appendChild(check('points_nac', 'NAC raw frames', 'Counted by asking the archive, a few seconds'));
      P.appendChild(check('points_radar', 'Radar sounder tracks', c.radar + (c.radar === 1 ? ' track crosses' : ' tracks cross') + ' the box', !c.radar));
      P.appendChild(check('points_xenarch', 'Xenarch images', c.ohrc + ' OHRC tiles · ' + c.hardware + ' hardware sites · ' + c.terrain + ' terrain tiles', !(c.ohrc + c.hardware + c.terrain)));
      var K = $('c-kaguya'), need = k.tiles - k.on_disk;
      if (!need) K.appendChild(el('li', {}, ['Kaguya Terrain Camera, 7 m per pixel', el('small', { text: (k.tiles === 1 ? 'The tile is' : 'All ' + k.tiles + ' tiles are') + ' already on disk: included' })]));
      else {
        var cb = el('input', { type: 'checkbox' }); cb.checked = !!opts.tc && need <= 4; cb.id = 'c-tc';
        cb.onchange = function () { opts.tc = cb.checked; store.set('tav-options', opts); };
        K.appendChild(el('li', {}, [el('label', {}, [cb, el('span', {}, ['Kaguya Terrain Camera, 7 m per pixel', el('small', { text: 'Download ' + need + (need === 1 ? ' tile pair' : ' tile pairs') + ' · ' + fmtB(k.download_mb * 1e6) + '. Without it: image at 83 m, elevation at 59 m' })])])]));
      }
    }).catch(function (e) {
      $('c-layers').innerHTML = ''; $('c-layers').appendChild(el('li', { class: 'muted', text: online ? 'Could not plan this box: ' + e.message : 'Start the Tav server to see what is inside.' }));
    });
  }
  $('capture').onclick = function () {
    if (!ring) return;
    var layers = Array.prototype.filter.call(document.querySelectorAll('#choose input[data-key]'), function (c) { return c.checked; }).map(function (c) { return c.dataset.key; });
    $('capture').disabled = true;
    api('/api/captures', { ring: ring, shape: ring.kind, options: { layers: layers.length ? layers : ['none'], max_px: opts.max_px, tc_download: !!($('c-tc') && $('c-tc').checked) } })
      .then(function (r) { $('capture').disabled = false; nav(r.id); })
      .catch(function (e) { $('capture').disabled = false; alert('Download failed: ' + e.message); });
  };

  // ------------------------------------------------------------ captures
  var openTick = null;
  var cur = null, timer = null, vis = {}, overlays = {}, markers = [], builtFor = null, online = false, want = null, fitNext = false;
  function loadList() {
    return api('/api/captures').then(function (list) {
      online = true; $('offline').hidden = true;
      var ul = $('caplist'); ul.innerHTML = '';
      if (!list.length) ul.appendChild(el('li', { class: 'muted', text: 'None yet.' }));
      list.forEach(function (c) {
        ul.appendChild(el('li', { class: 'cap', tabindex: '0', on: function () { nav(c.id); } },
          [c.created.replace('T', ' · ').slice(0, 18), el('small', { text: fmtKm(c.size_km[0]) + ' km × ' + fmtKm(c.size_km[1]) + ' km · ' + ((c.bbox.north + c.bbox.south) / 2).toFixed(2) + '°, ' + ((c.bbox.east + c.bbox.west) / 2).toFixed(2) + '° · ' + c.status })]));
      });
    }).catch(function () { online = false; $('offline').hidden = false; });
  }
  $('to-home').onclick = function () { nav(''); };
  function leaveCapture() {
    clearInterval(timer); timer = null; cur = null; builtFor = null; want = null; hideViewer(); hide3d();
    Object.keys(overlays).forEach(function (k) { map.removeLayer(overlays[k]); }); overlays = {};
    markers.forEach(function (m) { map.removeLayer(m); }); markers = [];
  }
  function openCapture(id) {
    var keep = want; leaveCapture(); want = keep; vis = { outline: true }; fitNext = true;
    $('d-title').textContent = 'Loading…'; $('d-sub').textContent = '';
    ['d-steps', 'd-layers', 'd-points', 'd-cat', 'd-files', 'd-notes'].forEach(function (k) { $(k).innerHTML = ''; });
    var tick = function () {
      api('/api/captures/' + id).then(function (m) {
        if (location.hash.slice(1).split('&')[0] !== id) return;
        cur = m; render();
        var busy = m.status !== 'complete' || Object.keys(m.jobs || {}).some(function (k) { return m.jobs[k].state === 'running'; });
        clearInterval(timer); timer = setInterval(tick, busy ? 1200 : 6000);
      }).catch(function (e) { if (!cur) { $('d-title').textContent = 'Capture not found'; $('d-sub').textContent = e.message; } });
    };
    openTick = tick; tick();
  }
  function applyWant() {
    if (!cur || cur.status !== 'complete') return;
    if (want === '3d') { hideViewer(); if (cur.mesh) { if (location.hash.indexOf('&3d') < 0) { nav(cur.id + '&3d'); return; } show3d(); } }
    else if (/^p\d+$/.test(want || '') && cur.points[+want.slice(1)]) { hide3d(); showPoint(+want.slice(1), 0); }
    else { hide3d(); hideViewer(); }
  }

  function layerRow(key, title, sub, color) {
    var cb = el('input', { type: 'checkbox' }); cb.checked = !!vis[key];
    cb.onchange = function () { vis[key] = cb.checked; sync(); };
    return el('li', {}, [el('label', {}, [cb, el('span', {}, [color ? el('i', { class: 'dotkey', style: '--c:' + color }) : '', title, el('small', { text: sub })])])]);
  }
  function render() {
    var m = cur, b = m.bbox;
    $('d-title').textContent = m.created.replace('T', ' · ').slice(0, 18);
    $('d-sub').textContent = (m.status === 'complete' ? 'Complete' : 'Downloading…') + ' · ' + fmtKm(m.size_km[0]) + ' km × ' + fmtKm(m.size_km[1]) + ' km · ' + ((b.north + b.south) / 2).toFixed(3) + '°, ' + ((b.east + b.west) / 2).toFixed(3) + '°';
    var st = $('d-steps'); st.innerHTML = '';
    m.steps.forEach(function (s) { st.appendChild(el('li', { class: s.ok ? 'ok' : 'bad', text: s.name + (s.ok ? ' · ' + s.seconds + ' s' : ' · failed') })); });
    if (m.status !== 'complete') st.appendChild(el('li', { class: 'run', text: m.step }));
    st.hidden = m.status === 'complete' && m.steps.every(function (s) { return s.ok; });

    var keys = m.layers.map(function (l) { return l.key; });
    var tc = m.layers.filter(function (l) { return l.key === 'imagery_tc'; })[0];
    var best = tc && tc.coverage_pct >= 90 ? 'imagery_tc' : 'imagery';
    keys.forEach(function (k) { if (!(k in vis)) vis[k] = false; });
    if (keys.indexOf(best) >= 0 && !vis._picked) { vis[best] = true; vis._picked = best; }
    if (best === 'imagery_tc' && vis._picked === 'imagery') { vis.imagery = false; vis.imagery_tc = true; vis._picked = best; }

    var b3 = $('d-3d-btn'), done = m.status === 'complete';
    b3.disabled = !done; b3.textContent = !done ? '◆ 3D view · preparing…' : m.mesh ? '◆ Show in 3D' : '◆ Build the 3D view';
    b3.onclick = function () {
      if (m.mesh) { nav(m.id + '&3d'); return; }
      b3.disabled = true; want = '3d'; api('/api/captures/' + m.id + '/mesh', {}).then(function () { clearInterval(timer); timer = setInterval(function () { openTick && openTick(); }, 1200); }).catch(function (e) { alert('Could not build the 3D view: ' + e.message); });
    };
    var ul = $('d-layers'); ul.innerHTML = '';
    if (m.mesh) ul.appendChild(el('li', {}, ['3D mesh', el('small', { text: m.mesh.vertices.toLocaleString() + ' points · ' + num(m.mesh.relief_m) + ' m of relief · mesh.glb' })]));
    ul.appendChild(layerRow('outline', 'Capture outline', m.shape));
    m.layers.forEach(function (l) {
      var sub = res(l.m_px);
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
    if (m.status === 'complete' && !m.points.length) up.appendChild(el('li', { class: 'muted', text: 'No frames, tracks or tiles inside this box (or none were asked for).' }));
    if (m.status !== 'complete') up.appendChild(el('li', { class: 'muted', text: 'Dots appear when the download is complete.' }));

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
    if (!m.catalogue.length && m.status === 'complete') uc.appendChild(el('li', { class: 'muted', text: 'Not asked for in this capture.' }));

    var uf = $('d-files'); uf.innerHTML = '';
    m.files.slice(0, 60).forEach(function (f) { uf.appendChild(el('li', {}, [el('a', { href: '/captures/' + m.id + '/' + f.name, target: '_blank', rel: 'noopener', text: f.name }), el('span', { text: fmtB(f.bytes) })])); });
    if (m.files.length > 60) uf.appendChild(el('li', { class: 'muted', text: '… and ' + (m.files.length - 60) + ' more' }));
    $('d-path').textContent = m.dir;
    var un = $('d-notes'); un.innerHTML = ''; m.notes.forEach(function (n) { un.appendChild(el('li', { text: n })); });

    sync(); applyWant();
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
  function sync() {
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
        mk.p = p; mk.on('click', function () { nav(m.id + '&p' + p.i); }); return mk;
      });
    }
    markers.forEach(function (mk) { var on = !!vis['p_' + mk.p.kind]; if (on && !map.hasLayer(mk)) mk.addTo(map); if (!on && map.hasLayer(mk)) map.removeLayer(mk); });
    spread();
    if (fitNext) { fitNext = false; map.fitBounds([[m.bbox.south, m.bbox.west], [m.bbox.north, m.bbox.east]], { padding: [120, 120] }); }
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
  function hideViewer() { $('viewer').hidden = true; vp = null; markers.forEach(function (mk) { if (mk._icon) mk._icon.firstChild.classList.remove('on'); }); }
  $('v-close').onclick = function () { if (cur) nav(cur.id); };
  function showPoint(i, tile) {
    var m = cur, p = m.points[i], same = m.points.filter(function (x) { return x.kind === p.kind; }), pos = same.indexOf(p);
    if (vp === i && !tile) return;
    vp = i; $('viewer').hidden = false; $('v-img').hidden = true; $('v-wait').hidden = false; $('v-wait').textContent = p.kind === 'nac' ? 'Reading the frame from the LROC archive…' : p.kind === 'radar' ? 'Downloading the track from JAXA (45 MB the first time)…' : 'Loading…';
    $('v-kind').textContent = KIND[p.kind].name + ' · ' + (pos + 1) + ' of ' + same.length;
    $('v-title').textContent = p.title; $('v-text').textContent = p.text; $('v-extra').textContent = '';
    markers.forEach(function (mk) { if (mk._icon) mk._icon.firstChild.classList.toggle('on', mk.p.i === i); });
    var tools = $('v-tools'); tools.innerHTML = '';
    if (same.length > 1) {   // stepping through points replaces the address, so Back leaves the viewer in one press
      tools.appendChild(el('button', { type: 'button', text: '← Previous', on: function () { nav(m.id + '&p' + same[(pos - 1 + same.length) % same.length].i, true); } }));
      tools.appendChild(el('button', { type: 'button', text: 'Next →', on: function () { nav(m.id + '&p' + same[(pos + 1) % same.length].i, true); } }));
    }
    api('/api/captures/' + m.id + '/point/' + i + '?i=' + tile).then(function (r) {
      if (vp !== i) return;
      var base = '/captures/' + m.id + '/', img = $('v-img'), put = function (src) { img.onload = function () { img.hidden = false; $('v-wait').hidden = true; }; img.src = base + src; img.alt = p.title; };
      put(r.img); $('v-extra').textContent = r.extra || '';
      if (r.n > 1) tools.appendChild(el('button', { type: 'button', text: 'Tile ' + (r.i + 1) + ' of ' + r.n + ' →', on: function () { showPoint(i, r.i + 1); } }));
      if (r.more) { var wide = false, b = el('button', { type: 'button', text: 'Wide view', on: function () { wide = !wide; b.textContent = wide ? 'Close-up' : 'Wide view'; put(wide ? r.more : r.img); } }); tools.appendChild(b); }
      if (r.download) {
        var d = el('button', { type: 'button', text: 'Download full frame · ' + fmtB(r.download.bytes), on: function () { d.disabled = true; d.textContent = 'Downloading into the capture folder…'; api('/api/captures/' + m.id + '/fetch', { type: r.download.type, id: r.download.id }); } });
        tools.appendChild(d);
      }
    }).catch(function (e) { if (vp === i) $('v-wait').textContent = 'Could not load: ' + e.message; });
  }

  // ------------------------------------------------------------------ 3D
  var three = null;
  function hide3d() { $('three').hidden = true; if (three) { cancelAnimationFrame(three.raf); window.removeEventListener('resize', three.fit); three.renderer.dispose(); $('t-canvas').innerHTML = ''; three = null; } }
  $('t-close').onclick = function () { if (cur) nav(cur.id); };
  function show3d() {
    if (three && three.id === cur.id) return;
    if (!window.THREE || !THREE.GLTFLoader) { alert('The 3D viewer could not be loaded (no network?). The mesh file is mesh.glb in the capture folder.'); nav(cur.id, true); return; }
    hide3d(); $('three').hidden = false;
    var box = $('t-canvas'), m = cur;
    var renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.outputEncoding = THREE.sRGBEncoding; box.appendChild(renderer.domElement);
    var scene = new THREE.Scene(); scene.background = new THREE.Color(0x05060b);
    var size = Math.max(m.mesh.width_m, m.mesh.height_m), cam = new THREE.PerspectiveCamera(38, 1, size / 1000, size * 30);
    var ctl = new THREE.OrbitControls(cam, renderer.domElement); ctl.maxPolarAngle = Math.PI / 2; ctl.enableDamping = true;
    var home = function () { cam.position.set(0, size * 1.05, size * 1.7); ctl.target.set(0, 0, 0); ctl.update(); };   // the mesh sits at the origin: always start centred
    var fit = function () { var w = box.clientWidth, h = box.clientHeight; if (!w || !h) return; renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); };
    fit(); home(); window.addEventListener('resize', fit);
    three = { renderer: renderer, raf: 0, obj: null, id: m.id, fit: fit };
    $('t-reset').onclick = home;
    var stamp = (m.files.filter(function (f) { return f.name === 'mesh.glb'; })[0] || {}).bytes || 0;
    new THREE.GLTFLoader().load('/captures/' + m.id + '/mesh.glb?v=' + stamp, function (g) {
      if (!three || three.id !== m.id) return;
      g.scene.traverse(function (o) { if (o.isMesh) { o.material = new THREE.MeshBasicMaterial({ map: o.material.map, side: THREE.DoubleSide }); } });
      three.obj = g.scene; scene.add(g.scene); exag();
    });
    function exag() { var v = parseFloat($('t-exag').value); $('t-exag-v').textContent = v; if (three && three.obj) { three.obj.scale.y = v; three.obj.position.y = -m.mesh.relief_m * v / 2; } }
    $('t-exag').oninput = exag;
    (function loop() { if (!three || three.id !== m.id) return; three.raf = requestAnimationFrame(loop); ctl.update(); renderer.render(scene, cam); })();
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

  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var li = $('results').querySelector('li'); if (li && !$('results').hidden) li.click(); } });
  $('caplist').addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.classList.contains('cap')) e.target.click(); });
  loadList().then(route);
})();
