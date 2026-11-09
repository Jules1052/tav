// Tav in the browser: the captures of tav/server.py, made in the page and kept in this browser (IndexedDB).
// Same files and the same manifest as the local version; tests/web_reference.mjs checks them with tests/reference.py.
// Rasters from PDS Geosciences and NAC frames come through /proxy (worker/index.js): those archives send no CORS header.
// Only in the local version: Kaguya TC at 7 m (302 MB tiles), full archive downloads, radar and Xenarch pictures, the agent API.
// The arithmetic follows Python and numpy step by step (rounding, modulo, float32 sums), so both give the same numbers.
(function () {
  'use strict';
  const KM_DEG = 30.3234;
  const GEO = 'https://pds-geosciences.wustl.edu', ODE = 'https://oderest.rsl.wustl.edu/live2/';
  const TREK = 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg';
  const LOCAL = 'only in the local version of Tav (github.com/Jules1052/tav)';
  const ALL_LAYERS = ['imagery', 'elevation', 'thermal_night', 'gravity', 'radar_cpr', 'vectors', 'catalogue', 'points_nac', 'points_radar', 'points_xenarch'];

  // ------------------------------------------------------ Python arithmetic
  const pyMod = (a, b) => { let m = a % b; if (m && ((b < 0) !== (m < 0))) m += b; return m; };   // float %, sign of b
  const w180 = lon => pyMod(+lon + 180, 360) - 180;
  function pyFloorDiv(a, b) {   // float //, as CPython computes it
    let mod = a % b, div = (a - mod) / b;
    if (mod && ((b < 0) !== (mod < 0))) div -= 1;
    if (!div) return 0 * (a / b);
    const f = Math.floor(div); return div - f > 0.5 ? f + 1 : f;
  }
  const F64 = new DataView(new ArrayBuffer(8));
  function pyRound(x, d) {   // round(x, d): the exact binary value rounded half to even, like CPython
    if (!isFinite(x) || x === 0) return x;
    F64.setFloat64(0, x); const hi = F64.getUint32(0), lo = F64.getUint32(4), ex = (hi >>> 20) & 0x7ff;
    let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo); if (ex) mant |= 1n << 52n;
    const e = (ex || 1) - 1075, p = 10n ** BigInt(d), num = mant * p; let q;
    if (e >= 0) q = num << BigInt(e);
    else { const den = 1n << BigInt(-e); q = num / den; const r2 = 2n * (num - q * den); if (r2 > den || (r2 === den && (q & 1n))) q += 1n; }
    return (hi >>> 31 ? -1 : 1) * Number(q) / Number(p);
  }
  const ceilDiv = (a, b) => Math.ceil(a / b);   // len(range(0, a, b)) for a ≥ 0
  function sum32(a, lo, n) {   // numpy's pairwise sum of a float32 array, in float32
    const f = Math.fround;
    if (n < 8) { let r = 0; for (let i = 0; i < n; i++) r = f(r + a[lo + i]); return r; }
    if (n <= 128) {
      const r = [a[lo], a[lo + 1], a[lo + 2], a[lo + 3], a[lo + 4], a[lo + 5], a[lo + 6], a[lo + 7]]; let i = 8;
      for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] = f(r[j] + a[lo + i + j]);
      let s = f(f(f(r[0] + r[1]) + f(r[2] + r[3])) + f(f(r[4] + r[5]) + f(r[6] + r[7])));
      for (; i < n; i++) s = f(s + a[lo + i]); return s;
    }
    let n2 = Math.floor(n / 2); n2 -= n2 % 8;
    return f(sum32(a, lo, n2) + sum32(a, lo + n2, n - n2));
  }
  function stats(a) {   // np.nanmin, np.nanmax, np.nanmean of a float32 array, and the count of values
    let mn = Infinity, mx = -Infinity, cnt = 0; const z = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === v) { cnt++; z[i] = v; if (v < mn) mn = v; if (v > mx) mx = v; } }
    return { min: mn, max: mx, mean: cnt ? Math.fround(sum32(z, 0, z.length) / cnt) : NaN, count: cnt };
  }
  function percentiles(values, qs) {   // np.percentile, linear interpolation
    const s = Float64Array.from(values).sort(), n = s.length;
    return qs.map(q => {
      const vi = q / 100 * (n - 1), lo = Math.floor(vi), hi = Math.min(lo + 1, n - 1), t = vi - lo, d = s[hi] - s[lo];
      return t >= 0.5 ? s[hi] - d * (1 - t) : s[lo] + d * t;
    });
  }
  function inRing(lat, lon, ring) {   // server.in_ring for one point: even-odd rule
    let c = false;
    for (let i = 0; i < ring.length; i++) {
      const [y1, x1] = ring[i], [y2, x2] = ring[(i + 1) % ring.length];
      if (y1 === y2) continue;
      if (((y1 > lat) !== (y2 > lat)) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) c = !c;
    }
    return c;
  }
  function trackCrossing(t, s, n, w, e) {   // server.track_crossing: [lat, lon] where a radar sounder track crosses the box, or null
    const a = Math.min(t.lat0, t.lat1), b = Math.max(t.lat0, t.lat1);
    if (b < s || a > n || t.lat1 === t.lat0) return null;
    const lat = Math.min(Math.max((s + n) / 2, a), b), dl = pyMod(t.lon1 - t.lon0 + 180, 360) - 180;
    const lon = w180(t.lon0 + dl * (lat - t.lat0) / (t.lat1 - t.lat0));
    return w <= lon && lon <= e ? [lat, lon] : null;
  }
  const pad = (v, n) => String(v).padStart(n, '0');
  const stamp = (d, sep) => d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + sep + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
  const pyStr = v => Number.isInteger(v) ? v.toFixed(1) : String(v);   // str() of a Python float
  const short = e => String((e && e.message) || e);

  // ---------------------------------------------------------------- network
  async function pool(items, n, fn) {   // fn over items, n at a time, results in order
    const out = new Array(items.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
    return out;
  }
  async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(u.split('?')[0] + ': ' + r.status); return r.json(); }
  const IDX = {};
  function index(name, bin) {   // files in site/index/, null if missing
    if (!(name in IDX)) IDX[name] = fetch('index/' + name).then(r => !r.ok ? null : bin ? r.arrayBuffer().then(b => new Float32Array(b)) : r.json()).catch(() => null);
    return IDX[name];
  }
  class RangesIgnored extends Error {}
  function indexOfBytes(buf, pat, from) {
    outer: for (let i = from; i <= buf.length - pat.length; i++) { for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer; return i; }
    return -1;
  }
  const latin1 = b => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  async function proxyRanges(url, spans) {   // byte ranges [a, b) of one archive file in one request; one Uint8Array per range
    const r = await fetch('proxy?url=' + encodeURIComponent(url), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: spans.map(s => s[0] + '-' + (s[1] - 1)).join(',') });
    if (r.status === 416) throw new RangesIgnored(url);
    if (r.status !== 206) { let e = r.status; try { e = (await r.json()).error || e; } catch (x) { /* not JSON */ } throw new Error(url.split('/').pop() + ': ' + e); }
    const buf = new Uint8Array(await r.arrayBuffer()), parts = [];
    const ct = /multipart\/byteranges.*?boundary="?([^";\s]+)/i.exec(r.headers.get('content-type') || '');
    if (ct) {   // walk the parts by their Content-Range length, so the boundary may appear inside the data
      const delim = new TextEncoder().encode('--' + ct[1]), crlf2 = new Uint8Array([13, 10, 13, 10]); let pos = 0;
      for (;;) {
        const i = indexOfBytes(buf, delim, pos);
        if (i < 0 || (buf[i + delim.length] === 45 && buf[i + delim.length + 1] === 45)) break;
        const j = indexOfBytes(buf, crlf2, i), cr = j > 0 && /content-range:\s*bytes\s+(\d+)-(\d+)\//i.exec(latin1(buf.subarray(i, j)));
        if (!cr) throw new Error(url.split('/').pop() + ': unreadable multipart reply');
        const a = +cr[1], n = +cr[2] + 1 - a; parts.push([a, buf.subarray(j + 4, j + 4 + n)]); pos = j + 4 + n;
      }
    } else {
      const cr = /bytes\s+(\d+)-/i.exec(r.headers.get('content-range') || '');
      if (!cr) throw new Error(url.split('/').pop() + ': reply without Content-Range');
      parts.push([+cr[1], buf]);
    }
    parts.sort((x, y) => x[0] - y[0]);
    return spans.map(([a, b]) => {   // the archive may merge or reorder ranges
      let lo = 0, hi = parts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (parts[mid][0] <= a) lo = mid; else hi = mid - 1; }
      const [s, d] = parts[lo];
      if (s > a || b - s > d.length) throw new Error(url.split('/').pop() + ': bytes ' + a + '-' + (b - 1) + ' missing from the reply');
      return d.subarray(a - s, b - s);
    });
  }
  async function readSpans(url, spans) {   // server.curl_spans: adjacent ranges merged, at most 400 ranges or 32 MB a request, 4 at a time
    const merged = [];
    for (const [a, b] of spans) { const l = merged[merged.length - 1]; if (l && l[1] === a) l[1] = b; else merged.push([a, b]); }
    const batches = []; let size = 0;
    for (const s of merged) {
      if (!batches.length || batches[batches.length - 1].length >= 400 || size + s[1] - s[0] > 32 * 2 ** 20) { batches.push([]); size = 0; }
      batches[batches.length - 1].push(s); size += s[1] - s[0];
    }
    const got = await pool(batches, 4, async batch => {
      try { return await proxyRanges(url, batch); } catch (e) {
        if (!(e instanceof RangesIgnored)) throw e;
        const out = []; for (const s of batch) out.push((await proxyRanges(url, [s]))[0]); return out;   // no multi-range support
      }
    });
    const flat = got.flat(), out = new Uint8Array(flat.reduce((t, d) => t + d.length, 0)); let o = 0;
    for (const d of flat) { out.set(d, o); o += d.length; }
    return out;
  }

  // ---------------------------------------------------------------- rasters
  const sldem = (ti, tj) => GEO + '/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/tiles/float_img/sldem2015_512_' +
    ['30n_60n', '00n_30n', '30s_00s', '60s_30s'][ti] + '_' + pad(tj * 45, 3) + '_' + pad(tj * 45 + 45, 3) + '_float.img';
  const RASTERS = [
    { key: 'elevation', title: 'Elevation (SLDEM)', unit: 'm', ppd: 512, top: 60, bot: -60, west: 0, dtype: 'f4', scale: 1000, tiles: [15360, 23040, sldem],
      valid: a => Math.abs(a) < 50, source: 'SLDEM2015, LOLA + Kaguya, 59 m per pixel' },
    { key: 'elevation_lola', title: 'Elevation (LOLA)', unit: 'm', ppd: 64, top: 90, bot: -90, west: 0, dtype: 'i2', scale: 0.5,
      url: GEO + '/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img', source: 'LOLA LDEM 64 px/deg, 474 m per pixel' },
    { key: 'thermal_night', title: 'Night temperature (Diviner)', unit: 'K', ppd: 128, top: 70, bot: -70, west: 0, dtype: 'f4', scale: 1,
      url: GEO + '/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_ghrm/img/dghrm_tbol_m_70s70n_img.img',
      valid: a => a > 20 && a < 500, source: 'Diviner global mosaic, bolometric temperature at midnight, 237 m per pixel' },
    { key: 'gravity', title: 'Gravity (GRAIL)', unit: 'mGal', ppd: 16, top: 90, bot: -90, west: 0, dtype: 'f4', scale: 1,
      url: GEO + '/grail/grail-l-lgrs-5-rdr-v1/grail_1001/rsdmap/gggrx_1200a_anom_l660.img', source: 'GRAIL GRGM1200A free-air anomaly to degree 660, 1.9 km per pixel' },
    { key: 'radar_cpr', title: 'Radar polarisation (Mini-RF)', unit: 'ratio', ppd: 128, top: 90, bot: -90, west: -180, dtype: 'f4', scale: 1,
      url: GEO + '/lro/lro-l-mrflro-5-global-mosaic-v1/lromrf_1001/data/128ppd/global_cpr_128ppd_simp_0c.img',
      valid: a => a > 0 && a < 50, source: 'Mini-RF global mosaic, circular polarisation ratio, 237 m per pixel' },
  ];
  const elevationRaster = (s, n) => n <= 60 && s >= -60 ? RASTERS[0] : RASTERS[1];   // server.elevation_raster: SLDEM2015, LOLA beyond 60°
  function rasterFiles(r, r0, r1, c0, c1) {   // Raster._files
    const cols = Math.round(360 * r.ppd);
    if (!r.tiles) return [{ url: r.url, fr: r0, fc: c0, nr: r1 - r0, nc: c1 - c0, width: cols, orr: 0, occ: 0 }];
    const [th, tw, name] = r.tiles, out = [];
    for (let ti = Math.floor(r0 / th); ti <= Math.floor((r1 - 1) / th); ti++)
      for (let tj = Math.floor(c0 / tw); tj <= Math.floor((c1 - 1) / tw); tj++) {
        const a = Math.max(r0, ti * th), b = Math.min(r1, (ti + 1) * th), c = Math.max(c0, tj * tw), d = Math.min(c1, (tj + 1) * tw);
        out.push({ url: name(ti, tj), fr: a - ti * th, fc: c - tj * tw, nr: b - a, nc: d - c, width: tw, orr: a - r0, occ: c - c0 });
      }
    return out;
  }
  async function readBlock(r, url, fr, fc, nr, nc, width, k) {   // Raster._read: the part of each row inside the box
    const bpp = r.dtype === 'f4' ? 4 : 2, rows = [];
    for (let row = fr; row < fr + nr; row += k) rows.push(row);
    const raw = await readSpans(url, rows.map(row => [(row * width + fc) * bpp, (row * width + fc + nc) * bpp]));
    const src = r.dtype === 'f4' ? new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4) : new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
    const w = ceilDiv(nc, k), out = new Float32Array(rows.length * w);
    for (let i = 0; i < rows.length; i++) for (let j = 0; j < w; j++) out[i * w + j] = src[i * nc + j * k];
    return { data: out, h: rows.length, w };
  }
  async function readRaster(r, s, n, w, e, maxPx) {   // Raster.read
    n = Math.min(n, r.top); s = Math.max(s, r.bot);
    if (n <= s) return null;
    const ppd = r.ppd, rows = Math.round((r.top - r.bot) * ppd), cols = Math.round(360 * ppd);
    const r0 = Math.trunc((r.top - n) * ppd); let r1 = Math.max(Math.trunc(Math.ceil((r.top - s) * ppd)), 0);
    r1 = Math.min(Math.max(r1, r0 + 1), rows);
    const c0 = Math.trunc(pyMod(w - r.west, 360) * ppd), c1 = c0 + Math.max(Math.trunc(Math.ceil((e - w) * ppd)), 1);
    const k = Math.max(1, Math.ceil(Math.max(r1 - r0, c1 - c0) / maxPx)), H = ceilDiv(r1 - r0, k);
    const spans = [[c0, Math.min(c1, cols)]].concat(c1 > cols ? [[0, c1 - cols]] : []), parts = [];
    for (const [a, b] of spans) {
      const W = ceilDiv(b - a, k), out = new Float32Array(H * W).fill(NaN);
      await Promise.all(rasterFiles(r, r0, r1, a, b).map(async f => {
        const dr = pyMod(-f.orr, k), dc = pyMod(-f.occ, k);   // keep the decimation grid aligned across tiles
        if (dr >= f.nr || dc >= f.nc) return;
        const blk = await readBlock(r, f.url, f.fr + dr, f.fc + dc, f.nr - dr, f.nc - dc, f.width, k);
        const i = (f.orr + dr) / k, j = (f.occ + dc) / k;
        for (let y = 0; y < Math.min(blk.h, H - i); y++) for (let x = 0; x < Math.min(blk.w, W - j); x++) out[(i + y) * W + j + x] = blk.data[y * blk.w + x];
      }));
      parts.push({ data: out, w: W });
    }
    const Wt = parts.reduce((t, p) => t + p.w, 0), arr = new Float32Array(H * Wt);
    for (let y = 0; y < H; y++) { let o = 0; for (const p of parts) { arr.set(p.data.subarray(y * p.w, (y + 1) * p.w), y * Wt + o); o += p.w; } }
    for (let i = 0; i < arr.length; i++) { const v = arr[i]; arr[i] = (v === v && (!r.valid || r.valid(v))) ? Math.fround(v * r.scale) : NaN; }
    const top = r.top - r0 / ppd, west = w180(r.west + c0 / ppd);
    return { arr, H, W: Wt, n: top, s: top - H * k / ppd, w: west, e: west + Wt * k / ppd, deg_px: k / ppd,
             m_px: pyRound(KM_DEG * 1000 * k / ppd, 1), native_m_px: pyRound(KM_DEG * 1000 / ppd, 1) };
  }

  // ---------------------------------------------------------------- writers
  const GEOKEYS = [1, 1, 0, 6, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 32767, 2054, 0, 1, 9102, 2057, 34736, 1, 0, 2058, 34736, 1, 1];
  function geotiff(arr, W, H, n, w, deg) {   // float32 GeoTIFF, one strip, the tags of server.write_geotiff
    const tags = [[256, 4, [W]], [257, 4, [H]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]], [273, 4, [0]], [277, 3, [1]], [278, 4, [H]],
      [279, 4, [W * H * 4]], [284, 3, [1]], [339, 3, [3]], [33550, 12, [deg, deg, 0]], [33922, 12, [0, 0, 0, w, n, 0]], [34735, 3, GEOKEYS], [34736, 12, [1737400, 1737400]]];
    const size = { 3: 2, 4: 4, 12: 8 }, ifd = 8, extra0 = ifd + 2 + tags.length * 12 + 4; let extra = extra0;
    const place = tags.map(([, t, v]) => { const b = size[t] * v.length; if (b <= 4) return null; extra = Math.ceil(extra / 8) * 8; const at = extra; extra += b; return at; });
    const data = Math.ceil(extra / 8) * 8, buf = new ArrayBuffer(data + W * H * 4), dv = new DataView(buf);
    dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifd, true); dv.setUint16(ifd, tags.length, true);
    const put = (at, t, v) => v.forEach((x, i) => t === 3 ? dv.setUint16(at + 2 * i, x, true) : t === 4 ? dv.setUint32(at + 4 * i, x, true) : dv.setFloat64(at + 8 * i, x, true));
    tags.forEach(([tag, t, v], i) => {
      const e = ifd + 2 + i * 12; if (tag === 273) v = [data];
      dv.setUint16(e, tag, true); dv.setUint16(e + 2, t, true); dv.setUint32(e + 4, v.length, true);
      if (place[i] === null) put(e + 8, t, v); else { dv.setUint32(e + 8, place[i], true); put(place[i], t, v); }
    });
    dv.setUint32(ifd + 2 + tags.length * 12, 0, true);
    new Float32Array(buf, data, W * H).set(arr);
    return new Blob([buf], { type: 'image/tiff' });
  }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  const toBlob = (c, type, q) => new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error('could not encode ' + type)), type, q));
  function scaled(src, sx, sy, sw, sh, dw, dh) {
    const c = canvas(dw, dh), x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh); return c;
  }
  async function preview(arr, W, H, box) {   // server.write_preview: stretched grey picture, transparent where there is no data
    const fin = arr.filter(v => v === v);
    if (!fin.length) return null;
    let [a, b] = percentiles(fin, [1, 99]); b = b > a ? b : a + 1;
    const src = canvas(W, H), x = src.getContext('2d'), img = x.createImageData(W, H), d = img.data;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i], ok = v === v, g = Math.trunc(Math.min(Math.max(((ok ? v : a) - a) / (b - a), 0), 1) * 255);
      d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = g; d[4 * i + 3] = ok ? 255 : 0;
    }
    x.putImageData(img, 0, 0); let out = src;
    if (box) {
      const bw = box[2] - box[0], bh = box[3] - box[1], sc = Math.max(1, 512 / Math.max(bw, bh));
      out = scaled(src, box[0], box[1], bw, bh, Math.max(1, pyRound(bw * sc, 0)), Math.max(1, pyRound(bh * sc, 0)));
    } else if (Math.max(W, H) < 512) out = scaled(src, 0, 0, W, H, Math.floor(W * 512 / Math.max(W, H)), Math.floor(H * 512 / Math.max(W, H)));
    return toBlob(out, 'image/png');
  }
  function linspace(a, b, n) { const out = new Float64Array(n), step = (b - a) / (n - 1); for (let i = 0; i < n; i++) out[i] = i * step + a; if (n > 1) out[n - 1] = b; return out; }
  function glb(h, ny, nx, tex, wM, hM) {   // server.write_glb: x east, y up, z south, metres, texture draped on top
    let mn = Infinity; for (const v of h) if (v === v && v < mn) mn = v;
    const xs = linspace(-wM / 2, wM / 2, nx), zs = linspace(-hM / 2, hM / 2, ny), us = linspace(0, 1, nx), vs = linspace(0, 1, ny);
    const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      const i = r * nx + c, v = h[i]; pos[3 * i] = xs[c]; pos[3 * i + 1] = Math.fround((v === v ? v : mn) - mn); pos[3 * i + 2] = zs[r]; uv[2 * i] = us[c]; uv[2 * i + 1] = vs[r];
    }
    const tri = [];
    for (const second of [false, true]) for (let r = 0; r < ny - 1; r++) for (let c = 0; c < nx - 1; c++) {
      const i = r * nx + c, t = second ? [i + 1, i + nx, i + nx + 1] : [i, i + nx, i + 1];
      if (t.every(j => h[j] === h[j])) tri.push(...t);   // a polygon capture is cut to its outline
    }
    const idx = Uint32Array.from(tri), mm = [0, 1, 2].map(k => { let a = Infinity, b = -Infinity; for (let i = k; i < pos.length; i += 3) { a = Math.min(a, pos[i]); b = Math.max(b, pos[i]); } return [a, b]; });
    const chunks = [pos, uv, idx, tex].map(c => new Uint8Array(c.buffer, c.byteOffset, c.byteLength)), padded = chunks.map(c => Math.ceil(c.length / 4) * 4);
    const offs = padded.reduce((o, l) => (o.push(o[o.length - 1] + l), o), [0]);
    const g = { asset: { version: '2.0', generator: 'tav' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
      textures: [{ source: 0 }], images: [{ bufferView: 3, mimeType: 'image/jpeg' }], buffers: [{ byteLength: offs[4] }],
      bufferViews: [{ buffer: 0, byteOffset: offs[0], byteLength: pos.byteLength, target: 34962 }, { buffer: 0, byteOffset: offs[1], byteLength: uv.byteLength, target: 34962 },
        { buffer: 0, byteOffset: offs[2], byteLength: idx.byteLength, target: 34963 }, { buffer: 0, byteOffset: offs[3], byteLength: tex.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: nx * ny, type: 'VEC3', min: mm.map(x => x[0]), max: mm.map(x => x[1]) },
        { bufferView: 1, componentType: 5126, count: nx * ny, type: 'VEC2' }, { bufferView: 2, componentType: 5125, count: idx.length, type: 'SCALAR' }] };
    let js = new TextEncoder().encode(JSON.stringify(g)); const jl = Math.ceil(js.length / 4) * 4;
    const out = new Uint8Array(12 + 8 + jl + 8 + offs[4]), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
    dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true); out.fill(32, 20, 20 + jl); out.set(js, 20);
    const b0 = 20 + jl; dv.setUint32(b0, offs[4], true); dv.setUint32(b0 + 4, 0x004e4942, true);
    chunks.forEach((c, i) => out.set(c, b0 + 8 + offs[i]));
    return new Blob([out], { type: 'model/gltf-binary' });
  }
  function polygonMask(ring, d, W, H) {   // server.polygon_mask: cells whose centre is inside the ring, same arithmetic
    const m = new Uint8Array(W * H), pts = ring.map(([la, lo]) => [(lo - d.w) / (d.e - d.w) * W, (d.n - la) / (d.n - d.s) * H]);
    for (let y = 0; y < H; y++) {
      const yc = y + 0.5, xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        if ((y1 > yc) !== (y2 > yc)) xs.push(x1 + (yc - y1) * (x2 - x1) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x < Math.min(W, Math.ceil(xs[i + 1] - 0.5)); x++) m[y * W + x] = 1;
    }
    return m;
  }

  // ---------------------------------------------------------------- storage
  const DB = new Promise((ok, no) => {
    const q = indexedDB.open('tav', 1);
    q.onupgradeneeded = () => { q.result.createObjectStore('files'); q.result.createObjectStore('manifests'); };
    q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error);
  });
  async function idb(store, mode, fn) {
    const db = await DB;
    return new Promise((ok, no) => { const t = db.transaction(store, mode), r = fn(t.objectStore(store)); t.oncomplete = () => ok(r && r.result); t.onerror = () => no(t.error); t.onabort = () => no(t.error); });
  }
  const CAPS = new Map();   // id → { m, files: Map name → Blob, urls: Map name → [blob, object URL], run: Promise | null }

  // ---------------------------------------------------------------- capture
  class Capture {
    constructor(ring, shape, opts) {
      const o = opts || {};
      this.want = new Set((o.layers && o.layers.length ? o.layers : ALL_LAYERS).concat(['elevation']));
      this.maxPx = Math.trunc(Math.min(2048, Math.max(256, o.max_px || 1024)));
      this.ring = ring.map(([a, b]) => [+a, w180(b)]);
      const la = this.ring.map(p => p[0]), lo = this.ring.map(p => p[1]);
      [this.s, this.n, this.w, this.e] = [Math.min(...la), Math.max(...la), Math.min(...lo), Math.max(...lo)];
      const mid = (this.s + this.n) / 2, now = new Date();
      const base = 'tav-' + stamp(now, 'T').replace(/[-:]/g, '') + ('-' + Math.abs(mid).toFixed(1).padStart(4, '0') + (mid >= 0 ? 'n' : 's') + pyMod((this.w + this.e) / 2, 360).toFixed(1).padStart(5, '0') + 'e').replace(/\./g, '_');
      let id = base; for (let k = 2; CAPS.has(id); k++) id = base + '-' + k;
      this.id = id;
      const wk = (this.e - this.w) * KM_DEG * Math.cos(mid * (Math.PI / 180)), hk = (this.n - this.s) * KM_DEG;
      this.m = { id, created: stamp(now, 'T'), shape, ring: this.ring, bbox: { south: this.s, north: this.n, west: this.w, east: this.e }, size_km: [pyRound(wk, 2), pyRound(hk, 2)],
        options: { layers: [...this.want].sort(), max_px: this.maxPx, tc_download: false }, status: 'running', step: 'starting', steps: [], layers: [], vectors: [], catalogue: [],
        points: [], notes: [], files: [], dir: 'In this browser' };
      this.c = { m: this.m, files: new Map(), urls: new Map(), run: null }; CAPS.set(id, this.c);
    }
    static async load(id) {   // a capture kept in this browser
      if (CAPS.has(id)) return CAPS.get(id);
      const m = await idb('manifests', 'readonly', s => s.get(id));
      if (!m) throw new Error('capture not found');
      const files = new Map(), range = IDBKeyRange.bound(id + '/', id + '/\uffff');
      const keys = await idb('files', 'readonly', s => s.getAllKeys(range)), blobs = await idb('files', 'readonly', s => s.getAll(range));
      keys.forEach((k, i) => files.set(k.slice(id.length + 1), blobs[i]));
      const c = { m, files, urls: new Map(), run: null };
      if (m.status === 'running') { m.status = 'stopped'; m.step = 'stopped'; m.notes.push('The page was closed before this capture finished.'); await idb('manifests', 'readwrite', s => s.put(m, id)); }
      CAPS.set(id, c); return c;
    }
    async put(name, blob) { this.c.files.set(name, blob); await idb('files', 'readwrite', s => s.put(blob, this.id + '/' + name)); }
    async save() {
      this.m.files = [...this.c.files].filter(([n]) => !n.split('/').pop().startsWith('_')).map(([name, b]) => ({ name, bytes: b.size })).sort((a, b) => a.name < b.name ? -1 : 1);
      this.c.files.set('manifest.json', new Blob([JSON.stringify(this.m, null, 1)], { type: 'application/json' }));
      await idb('manifests', 'readwrite', s => s.put(this.m, this.id));
      await idb('files', 'readwrite', s => s.put(this.c.files.get('manifest.json'), this.id + '/manifest.json'));
    }
    async step(name, fn) {
      this.m.step = name; await this.save(); const t = performance.now();
      try { await fn(); this.m.steps.push({ name, ok: true, seconds: pyRound((performance.now() - t) / 1000, 1) }); }
      catch (ex) { console.error(ex); this.m.steps.push({ name, ok: false, error: short(ex).slice(0, 300) }); this.m.notes.push(name + ': ' + short(ex).slice(0, 200)); }
      await this.save();
    }
    mask(d) {
      this.inside = d.arr.length;
      if (this.m.shape !== 'polygon') return d.arr;
      const m = polygonMask(this.ring, d, d.W, d.H), a = d.arr.slice(); let k = 0;
      for (let i = 0; i < a.length; i++) if (m[i]) k++; else a[i] = NaN;
      this.inside = Math.max(1, k); return a;
    }

    async imagery() {
      const span = Math.max(this.e - this.w, this.n - this.s);
      const z = Math.trunc(Math.min(8, Math.max(0, Math.floor(Math.log2(2 * this.maxPx * 180 / (256 * span))))));
      const t = 180 / 2 ** z, x0 = Math.trunc(pyFloorDiv(this.w + 180, t)), x1 = Math.trunc(pyFloorDiv(this.e + 180, t));
      const y0 = Math.trunc(pyFloorDiv(90 - this.n, t)), y1 = Math.min(Math.trunc(pyFloorDiv(90 - this.s, t)), 2 ** z - 1), tiles = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push([x, y]);
      const mos = canvas((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256), mx = mos.getContext('2d');
      await pool(tiles, 8, async ([x, y]) => {
        const u = TREK.replace('{z}', z).replace('{x}', pyMod(x, 2 ** (z + 1))).replace('{y}', y), r = await fetch(u);
        if (!r.ok) throw new Error('imagery tile ' + z + '/' + y + '/' + x + ': ' + r.status);
        mx.drawImage(await createImageBitmap(await r.blob()), (x - x0) * 256, (y - y0) * 256);
      });
      const ppd = 256 / t, bx = [Math.trunc((this.w + 180 - x0 * t) * ppd), Math.trunc((90 - this.n - y0 * t) * ppd), Math.trunc(Math.ceil((this.e + 180 - x0 * t) * ppd)), Math.trunc(Math.ceil((90 - this.s - y0 * t) * ppd))];
      let W = bx[2] - bx[0], H = bx[3] - bx[1];
      if (Math.max(W, H) < 1024) { const m = Math.max(W, H); [W, H] = [Math.max(1, Math.floor(W * 1024 / m)), Math.max(1, Math.floor(H * 1024 / m))]; }
      const im = scaled(mos, bx[0], bx[1], bx[2] - bx[0], bx[3] - bx[1], W, H), x = im.getContext('2d'), px = x.getImageData(0, 0, W, H), d = px.data;
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = (d[i] * 19595 + d[i + 1] * 38470 + d[i + 2] * 7471 + 0x8000) >> 16;   // PIL's RGB → L
      x.putImageData(px, 0, 0); await this.put('wac.jpg', await toBlob(im, 'image/jpeg', 0.9));
      this.m.layers.push({ key: 'imagery', title: 'Imagery (LROC WAC)', file: 'wac.jpg', preview: 'wac.jpg', bounds: [[this.s, this.w], [this.n, this.e]],
        m_px: pyRound(KM_DEG * 1000 / ppd, 0), source: 'LROC WAC global mosaic via NASA Moon Trek, zoom ' + z, px: [W, H] });
    }

    async raster(r) {
      const d = await readRaster(r, this.s, this.n, this.w, this.e, this.maxPx);
      if (!d) { this.m.notes.push(r.title + ': no coverage at this latitude'); return null; }
      const a = this.mask(d), st = stats(a);
      if (!st.count) { this.m.notes.push(r.title + ': no data inside the box'); return null; }
      const key = r.key.replace('_lola', ''), dp = d.deg_px;
      await this.put(key + '.tif', geotiff(a, d.W, d.H, d.n, d.w, dp));
      const bn = Math.min(this.n, d.n), bs = Math.max(this.s, d.s), bw = Math.max(this.w, d.w), be = Math.min(this.e, d.e);
      await this.put(key + '.png', await preview(a, d.W, d.H, [(bw - d.w) / dp, (d.n - bn) / dp, (be - d.w) / dp, (d.n - bs) / dp]));
      this.m.layers.push({ key, title: r.title, unit: r.unit, file: key + '.tif', preview: key + '.png', bounds: [[bs, bw], [bn, be]], data_bounds: [[d.s, d.w], [d.n, d.e]],
        m_px: d.m_px, native_m_px: d.native_m_px, px: [d.W, d.H], source: r.source, coverage_pct: pyRound(Math.min(100, st.count / this.inside * 100), 1),
        min: pyRound(st.min, 3), max: pyRound(st.max, 3), mean: pyRound(st.mean, 3) });
      return [d, a];
    }

    async elevation() {
      const r = elevationRaster(this.s, this.n); let got;
      try { got = await this.raster(r); } catch (ex) {
        if (r === RASTERS[1]) throw ex;
        this.m.notes.push('SLDEM failed (' + short(ex).slice(0, 80) + '), used LOLA instead'); got = await this.raster(RASTERS[1]);
      }
      if (!got) return;
      const [d, a] = got, [wk, hk] = this.m.size_km, k = Math.max(1, Math.ceil(Math.max(d.H, d.W) / 220));
      const ny = ceilDiv(d.H, k), nx = ceilDiv(d.W, k), h = new Float32Array(ny * nx);
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) h[y * nx + x] = a[y * k * d.W + x * k];
      let tex;
      const wac = this.c.files.get('wac.jpg');
      if (wac) {
        const bm = await createImageBitmap(wac), f = Math.min(1, 1024 / Math.max(bm.width, bm.height));
        tex = await toBlob(scaled(bm, 0, 0, bm.width, bm.height, Math.max(1, Math.round(bm.width * f)), Math.max(1, Math.round(bm.height * f))), 'image/jpeg', 0.85);
      } else { const c = canvas(8, 8), x = c.getContext('2d'); x.fillStyle = 'rgb(128,128,128)'; x.fillRect(0, 0, 8, 8); tex = await toBlob(c, 'image/jpeg', 0.85); }
      if (Math.min(ny, nx) >= 2) {
        await this.put('mesh.glb', glb(h, ny, nx, new Uint8Array(await tex.arrayBuffer()), wk * 1000, hk * 1000));
        const st = stats(h);
        this.m.mesh = { file: 'mesh.glb', vertices: ny * nx, relief_m: pyRound(Math.fround(st.max - st.min), 1), width_m: wk * 1000, height_m: hk * 1000 };
      }
    }

    async vectors() {
      const fc = feats => new Blob([JSON.stringify({ type: 'FeatureCollection', features: feats })], { type: 'application/geo+json' });
      const dump = async (name, feats, title) => { await this.put(name, fc(feats)); this.m.vectors.push({ key: name.split('.')[0], title, file: name, count: feats.length }); };
      const pt = (la, lo, p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [pyRound(lo, 5), pyRound(la, 5)] }, properties: p });
      const c = await cratersIn(this.s, this.n, this.w, this.e);
      if (c) {
        let s = c.filter(x => inRing(x[0], x[1], this.ring)); const total = s.length;
        s = s.sort((a, b) => b[2] - a[2] || a[0] - b[0] || a[1] - b[1]).slice(0, 5000);   // largest first, ties by lat then lon
        await dump('craters.geojson', s.map(([a, b, d]) => pt(a, b, { diameter_km: pyRound(d, 3) })), 'Craters of 1 km or more');
        if (total > 5000) this.m.notes.push('Craters: kept the 5,000 largest of ' + total.toLocaleString('en') + '');
      }
      const nm = await index('names.json');
      if (nm) await dump('names.geojson', nm.filter(x => inRing(x[2], x[3], this.ring)).map(x => pt(x[2], x[3], { name: x[0], type: x[1], diameter_km: x[4] })), 'IAU names');
      const pits = await index('pits.json');
      if (pits) await dump('pits.geojson', pits.filter(p => inRing(p.lat, p.lon, this.ring)).map(p => { const q = Object.assign({}, p); delete q.lat; delete q.lon; return pt(p.lat, p.lon, q); }), 'Known pits');
      const leg = await index('geology.json'), units = leg && await geologyUnits(this.s, this.n, this.w, this.e, leg);
      if (units) {
        await this.put('geology.json', new Blob([JSON.stringify(units, null, 1)], { type: 'application/json' }));
        this.m.vectors.push({ key: 'geology', title: 'Geologic units', file: 'geology.json', count: units.length, units: units.slice(0, 6) });
      }
    }

    async catalogue() {
      const q = async ([ih, ii, pt, title]) => {
        const p = new URLSearchParams({ query: 'product', results: 'fmpc', target: 'moon', ihid: ih, iid: ii, pt, output: 'JSON', limit: '400',
          westernlon: pyMod(this.w, 360).toFixed(4), easternlon: pyMod(this.e, 360).toFixed(4), minlat: this.s.toFixed(4), maxlat: this.n.toFixed(4) });
        const d = (await getJSON(ODE + '?' + p))['ODEResults'];
        let ps = d.Products; ps = ps && typeof ps === 'object' && !Array.isArray(ps) ? (ps.Product || []) : []; ps = Array.isArray(ps) ? ps : [ps];
        const items = [], num = (x, k) => x[k] === undefined || x[k] === null || x[k] === '' ? null : parseFloat(x[k]);
        for (const x of ps) {
          let fs = (x.Product_files || {}).Product_file || []; fs = (Array.isArray(fs) ? fs : [fs]).filter(f => (f.URL || '').indexOf('ode.rsl.wustl.edu') < 0);
          if (!fs.length) continue;
          const big = fs.reduce((a, f) => parseFloat(f.KBytes || 0) > parseFloat(a.KBytes || 0) ? f : a);
          items.push({ id: x.pdsid, url: big.URL, bytes: Math.trunc(parseFloat(big.KBytes || 0) * 1024), files: fs.map(f => f.URL), footprint: x.Footprint_C0_geometry || x.Footprint_geometry,
            lat: num(x, 'Center_latitude'), lon: num(x, 'Center_longitude'), incidence: num(x, 'Incidence_angle'), emission: num(x, 'Emission_angle'), m_px: num(x, 'Map_resolution'),
            time: x.UTC_start_time || x.Observation_time });
        }
        return { type: pt, title, count: parseInt(d.Count, 10) || items.length, listed: items.length, bytes: items.reduce((t, i) => t + i.bytes, 0), items };
      };
      const full = [];
      (await pool(ODE_TYPES, 4, t => q(t).catch(e => e))).forEach((r, i) => {
        if (r instanceof Error) this.m.notes.push(ODE_TYPES[i][3] + ': catalogue query failed (' + short(r).slice(0, 80) + ')'); else full.push(r);
      });
      await this.put('catalogue.json', new Blob([JSON.stringify(full, null, 1)], { type: 'application/json' }));
      this.m.catalogue = full.map(c => { const s = Object.assign({}, c); delete s.items; s.file = 'catalogue.json'; return s; });
    }

    async kaguya() {   // the 7 m layers need whole 302 MB tiles: the local version builds them
      const cat = await products(this.id), n = (cat.find(c => c.type === 'TCORT') || { items: [] }).items.length;
      if (n) this.m.notes.push('Kaguya TC at 7 m: ' + n + (n === 1 ? ' tile covers' : ' tiles cover') + ' this box, 302 MB each, so this layer is ' + LOCAL + '.');
    }

    async points() {
      const pts = [], clamp = (v, a, b) => Math.min(Math.max(v, a), b);
      const nac = this.want.has('points_nac') ? ((await products(this.id)).find(c => c.type === 'CDRNAC4') || { items: [] }).items : [];
      for (const it of nac) {
        if (it.lat === null) continue;
        const sun = it.incidence !== null ? ', sun ' + it.incidence.toFixed(0) + '° from vertical' + (it.incidence > 90 ? ' (night)' : '') : '';
        let la = it.lat, lo = w180(it.lon); const centred = this.s <= la && la <= this.n && this.w <= lo && lo <= this.e;
        const fp = centred ? [] : [...(it.footprint || '').matchAll(/(-?[\d.]+) (-?[\d.]+)/g)];
        if (fp.length) {   // dot at the middle of the part of the strip that lies inside the box
          const xs = fp.map(m => w180(parseFloat(m[1]))), ys = fp.map(m => parseFloat(m[2]));
          const a = Math.max(Math.min(...xs), this.w), b = Math.min(Math.max(...xs), this.e), c = Math.max(Math.min(...ys), this.s), d = Math.min(Math.max(...ys), this.n);
          if (a <= b && c <= d) { la = (c + d) / 2; lo = (a + b) / 2; }
        }
        la = clamp(la, this.s, this.n); lo = clamp(lo, this.w, this.e);
        pts.push({ kind: 'nac', lat: la, lon: lo, title: 'NAC frame ' + it.id.split('.').pop().toUpperCase(),
          text: (it.time || '').slice(0, 10) + ', ' + (it.m_px === null ? 'None' : pyStr(it.m_px)) + ' m per pixel' + sun + '. Raw strip, ' + (it.bytes / 1e6).toFixed(0) + ' MB.', ref: it.id, incidence: it.incidence });
      }
      for (const t of this.want.has('points_radar') ? (await index('lrs_tracks.json')) || [] : []) {
        const x = trackCrossing(t, this.s, this.n, this.w, this.e);
        if (x)
          pts.push({ kind: 'radar', lat: x[0], lon: x[1], title: 'Radar sounder track ' + t.id.slice(-14),
            text: 'Kaguya LRS, ' + t.day.slice(0, 4) + '-' + t.day.slice(4, 6) + '-' + t.day.slice(6) + '. A vertical cut through the ground along the orbit, 25 m per pixel in depth.', ref: t.id, day: t.day, track: t });
      }
      for (const p of this.want.has('points_xenarch') ? (await index('xenarch.json')) || [] : [])
        if (this.s <= p.lat && p.lat <= this.n && this.w <= p.lon && p.lon <= this.e && inRing(p.lat, p.lon, this.ring)) pts.push(Object.assign({}, p));
      pts.forEach((p, i) => { p.i = i; });
      this.m.points = pts;
      this.m.point_counts = Object.fromEntries(['nac', 'radar', 'ohrc', 'hardware', 'terrain'].map(k => [k, pts.filter(p => p.kind === k).length]));
    }

    async run() {
      const w = this.want;
      if (w.has('imagery')) await this.step('Imagery', () => this.imagery());
      await this.step('Elevation and 3D mesh', () => this.elevation());   // always: the 3D view needs it
      for (const r of RASTERS.slice(2)) if (w.has(r.key)) await this.step(r.title, () => this.raster(r));
      if (w.has('vectors')) await this.step('Craters, names, pits, geology', () => this.vectors());
      if (w.has('catalogue') || w.has('points_nac')) {
        await this.step('Catalogue of products', () => this.catalogue());
        await this.step('Kaguya TC, 7 m', () => this.kaguya());
      }
      await this.step('Points', () => this.points());
      this.m.status = 'complete'; this.m.step = 'done'; await this.save();
    }
  }
  const ODE_TYPES = [['LRO', 'LROC', 'CDRNAC4', 'LROC NAC frames'], ['LRO', 'LROC', 'SDNDTM', 'NAC stereo DTMs'], ['SLN', 'TC', 'TCORT', 'Kaguya TC ortho tiles'],
    ['SLN', 'TC', 'TCDTMM', 'Kaguya TC elevation tiles'], ['SLN', 'MI', 'MIMAP', 'Kaguya MI mineral tiles'], ['CH1-ORB', 'M3', 'REFIMG', 'M³ reflectance cubes'],
    ['LRO', 'MRFLRO', 'MAPCDR', 'Mini-RF radar strips']];
  async function products(id) {   // catalogue.json of a capture ([] if not catalogued)
    const b = CAPS.get(id).files.get('catalogue.json'); return b ? JSON.parse(await b.text()) : [];
  }
  async function cratersIn(s, n, w, e) {   // server.craters_in: craters [lat, lon, diameter_km] inside a box, from the 10° tiles
    const meta = await index('craters/index.json');
    if (!meta) return null;
    const d = meta.deg, names = [];
    for (let a = Math.max(-90, Math.floor(s / d) * d); a <= Math.min(90 - d, Math.floor(n / d) * d); a += d)
      for (let b = Math.max(-180, Math.floor(w / d) * d); b <= Math.min(180 - d, Math.floor(e / d) * d); b += d) if ((a + '_' + b) in meta.tiles) names.push(a + '_' + b);
    const out = [];
    for (const t of await Promise.all(names.map(t => index('craters/' + t + '.bin', true)))) {
      if (!t) throw new Error('a crater tile is missing');
      for (let i = 0; i < t.length; i += 3) { const la = t[i], lo = t[i + 1]; if (la >= s && la <= n && lo >= w && lo <= e) out.push([la, lo, t[i + 2]]); }
    }
    return out;
  }
  let GEOLOGY = null;
  async function geologyUnits(s, n, w, e, leg) {   // unit codes of geology.png (16 px per degree) under the box, largest share first
    if (!GEOLOGY) GEOLOGY = fetch('index/geology.png').then(r => r.ok ? r.blob() : null).then(b => b && createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }));
    const img = await GEOLOGY;
    if (!img) return null;
    const r0 = Math.trunc((90 - n) * 16), c0 = Math.trunc((w + 180) * 16), r1 = Math.max(Math.trunc(Math.ceil((90 - s) * 16)), r0 + 1), c1 = Math.max(Math.trunc(Math.ceil((e + 180) * 16)), c0 + 1);
    const y0 = Math.min(r0, img.height), y1 = Math.min(r1, img.height), x0 = Math.min(c0, img.width), x1 = Math.min(c1, img.width), cnt = new Map();
    let total = 0;
    if (y1 > y0 && x1 > x0) {
      const c = canvas(x1 - x0, y1 - y0), x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
      const d = x.getImageData(0, 0, x1 - x0, y1 - y0).data;
      for (let i = 0; i < d.length; i += 4) { cnt.set(d[i], (cnt.get(d[i]) || 0) + 1); total++; }
    }
    return [...cnt].sort((a, b) => a[0] - b[0]).sort((a, b) => b[1] - a[1]).filter(([u]) => String(u) in leg)
      .map(([u, k]) => Object.assign({ pct: pyRound(k / total * 100, 1) }, leg[String(u)]));
  }

  // ------------------------------------------------------------------- plan
  async function plan(ringIn) {
    const ring = ringIn.map(([a, b]) => [+a, w180(b)]), la = ring.map(p => p[0]), lo = ring.map(p => p[1]);
    const s = Math.min(...la), n = Math.max(...la), w = Math.min(...lo), e = Math.max(...lo), mid = (s + n) / 2;
    const inside = pts => pts.filter(p => s <= p.lat && p.lat <= n && w <= p.lon && p.lon <= e && inRing(p.lat, p.lon, ring)).length;
    const out = { size_km: [pyRound((e - w) * KM_DEG * Math.cos(mid * (Math.PI / 180)), 2), pyRound((n - s) * KM_DEG, 2)], layers: {} };
    [['elevation', elevationRaster(s, n)], ['thermal_night', RASTERS[2]], ['gravity', RASTERS[3]], ['radar_cpr', RASTERS[4]]].forEach(([key, r]) => {
      out.layers[key] = { title: r.title, m_px: pyRound(KM_DEG * 1000 / r.ppd, 1), px: [Math.trunc((e - w) * r.ppd) + 1, Math.trunc((n - s) * r.ppd) + 1], available: Math.min(n, r.top) > Math.max(s, r.bot), source: r.source };
    });
    out.layers.imagery = { title: 'Imagery (LROC WAC)', m_px: 83, px: [Math.trunc((e - w) * 364) + 1, Math.trunc((n - s) * 364) + 1], available: true, source: 'LROC WAC global mosaic, NASA Moon Trek' };
    let tiles = 0;
    for (let top = Math.floor(s / 3) * 3 + 3; top < Math.ceil(n / 3) * 3 + 1; top += 3) for (let west = Math.floor(pyMod(w, 360) / 3) * 3; west < Math.ceil((pyMod(w, 360) + (e - w)) / 3) * 3; west += 3) tiles++;
    out.kaguya = { tiles, on_disk: 0, download_mb: tiles * 604 };
    const [c, nm, pits, xen, lrs] = await Promise.all([cratersIn(s, n, w, e), index('names.json'), index('pits.json'), index('xenarch.json'), index('lrs_tracks.json')]);
    const radar = (lrs || []).filter(t => trackCrossing(t, s, n, w, e)).length;
    out.counts = { craters: c ? c.length : null, names: (nm || []).filter(x => s <= x[2] && x[2] <= n && w <= x[3] && x[3] <= e).length, pits: inside(pits || []), radar,
      ohrc: inside((xen || []).filter(p => p.kind === 'ohrc')), hardware: inside((xen || []).filter(p => p.kind === 'hardware')), terrain: inside((xen || []).filter(p => p.kind === 'terrain')) };
    return out;
  }

  // ------------------------------------------------------- point previews
  async function nacPreview(id, p) {   // server.nac_preview: a full-resolution cut of the raw frame around the box
    const c = CAPS.get(id), name = p.ref.split('.').pop(), fc = 'nac/' + name + '_centre.jpg', fw = 'nac/' + name + '_wide.jpg', fj = 'nac/' + name + '.json';
    const it = ((await products(id)).find(x => x.type === 'CDRNAC4') || { items: [] }).items.find(i => i.id === p.ref);
    if (!it) throw new Error('frame not in the catalogue');
    if (!c.files.has(fj)) {
      const url = it.files.find(u => u.toUpperCase().endsWith('.IMG')), cap = attach(c);
      const lab = latin1((await proxyRanges(url, [[0, 6000]]))[0]), g = k => parseInt(new RegExp(k + '\\s*=\\s*(\\d+)').exec(lab)[1], 10);
      const rb = g('RECORD_BYTES'), lr = g('LABEL_RECORDS'), lines = g('\\bLINES'), samples = g('LINE_SAMPLES');
      const v = /\(\((.*?)\)\)/.exec(it.footprint)[1].split(',').slice(0, 4).map(x => x.trim().split(/\s+/).map(Number));
      const [ur, lr_, ll, ul] = v.map(([x, y]) => [w180(x), y]), xs = [ul[0], ur[0], ll[0], lr_[0]], b = c.m.bbox;
      const tgt = [Math.min(Math.max((b.west + b.east) / 2, Math.min(...xs)), Math.max(...xs)), (b.south + b.north) / 2];
      const a1 = [ur[0] - ul[0], ur[1] - ul[1]], a2 = [ll[0] - ul[0], ll[1] - ul[1]], rhs = [tgt[0] - ul[0], tgt[1] - ul[1]], det = a1[0] * a2[1] - a2[0] * a1[1];
      const s = Math.min(Math.max((rhs[0] * a2[1] - a2[0] * rhs[1]) / det, 0), 1), t = Math.min(Math.max((a1[0] * rhs[1] - rhs[0] * a1[1]) / det, 0), 1);
      const n = Math.min(lines, 1600), l0 = Math.trunc(Math.min(Math.max(t * lines - n / 2, 0), lines - n)), a0 = rb * lr + l0 * samples * 2;
      const raw = (await proxyRanges(url, [[a0, a0 + n * samples * 2]]))[0], a = new Int16Array(raw.slice().buffer);
      const ok = a.filter(x => x > 0), [lo, hi] = ok.length ? percentiles(ok, [0.5, 99.7]) : [0, 1];
      const im = canvas(samples, n), x = im.getContext('2d'), px = x.createImageData(samples, n), d = px.data;
      for (let i = 0; i < a.length; i++) { const gv = Math.trunc(Math.min(Math.max((a[i] - lo) / Math.max(hi - lo, 1), 0), 1) * 255); d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = gv; d[4 * i + 3] = 255; }
      x.putImageData(px, 0, 0);
      await cap.put(fw, await toBlob(scaled(im, 0, 0, samples, n, 1200, Math.max(1, Math.trunc(1200 * n / samples))), 'image/jpeg', 0.85));
      const h = Math.min(400, Math.floor(samples / 2), Math.floor(n / 2));
      const cx = Math.min(Math.max(Math.trunc(s * samples), h), samples - h), cy = Math.min(Math.max(Math.trunc(t * lines) - l0, h), n - h);
      await cap.put(fc, await toBlob(scaled(im, cx - h, cy - h, 2 * h, 2 * h, 2 * h, 2 * h), 'image/jpeg', 0.88));
      await cap.put(fj, new Blob([JSON.stringify({ lines, samples, first_line: l0, lines_read: n, centre_sample: cx, centre_line: cy + l0 })], { type: 'application/json' }));
      await cap.save();
    }
    const j = JSON.parse(await c.files.get(fj).text());
    return { img: fc, more: fw, extra: 'Cut at full resolution, ' + (j.samples && Math.min(800, j.samples)) + ' px wide, around line ' + j.centre_line.toLocaleString('en') + ' of ' + j.lines.toLocaleString('en') +
      '. The position inside the frame comes from its four corners, so it is good to a few hundred metres. Raw frames can be mirrored. The full frame (' + (it.bytes / 1e6).toFixed(0) + ' MB) is ' + LOCAL + '.' };
  }
  function attach(c) {   // a stored capture as a Capture again, to add files or rebuild the mesh (server.Capture.load)
    const m = c.m, o = m.options || {};
    return Object.assign(Object.create(Capture.prototype), { id: m.id, c, m, ring: m.ring, maxPx: o.max_px || 1024, want: new Set(o.layers || ALL_LAYERS),
      s: m.bbox.south, n: m.bbox.north, w: m.bbox.west, e: m.bbox.east });
  }

  // --------------------------------------------------------------------- zip
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  async function zip(id) {   // the capture folder as a .zip (stored, not compressed: the layers are already compressed or binary)
    const c = await Capture.load(id), now = new Date(), parts = [], dir = [];
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let off = 0;
    for (const [name, blob] of [...c.files].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
      const data = new Uint8Array(await blob.arrayBuffer()), fn = new TextEncoder().encode(id + '/' + name), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, fn.length, 2], [28, 0, 2]]
        .forEach(([o, v, n]) => n === 4 ? h.setUint32(o, v, true) : h.setUint16(o, v, true));
      const d = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, fn.length, 2],
        [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, off, 4]].forEach(([o, v, n]) => n === 4 ? d.setUint32(o, v, true) : d.setUint16(o, v, true));
      parts.push(h, fn, data); dir.push(d, fn); off += 30 + fn.length + data.length;
    }
    const size = dir.reduce((t, x) => t + x.byteLength, 0), end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [8, dir.length / 2, 2], [10, dir.length / 2, 2], [12, size, 4], [16, off, 4]].forEach(([o, v, n]) => n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true));
    return new Blob(parts.concat(dir, [end]), { type: 'application/zip' });
  }

  // ------------------------------------------------------------- the API
  // The same calls as the local server (tav/server.py), answered in the page.
  async function api(path, body) {
    const u = new URL(path, location.href), parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (u.pathname === '/api/status') return { ok: true, web: true };
    if (u.pathname === '/api/plan') return plan(body.ring);
    if (u.pathname === '/api/captures' && body) {
      const ring = body.ring;
      if (ring.length < 3 || ring.length > 200) throw new Error('a box needs 3 to 200 corners');
      const lo = ring.map(p => w180(p[1]));
      if (Math.max(...lo) - Math.min(...lo) > 180) throw new Error('boxes across the 180° meridian are not supported yet');
      const cap = new Capture(ring, body.shape === 'polygon' ? 'polygon' : 'rectangle', body.options);
      await cap.save(); cap.c.run = cap.run().catch(e => console.error(e)); return { id: cap.id };
    }
    if (u.pathname === '/api/captures') {
      const all = await idb('manifests', 'readonly', s => s.getAll());
      return all.map(m => CAPS.has(m.id) ? CAPS.get(m.id).m : m).sort((a, b) => a.id < b.id ? 1 : -1)
        .map(m => ({ id: m.id, created: m.created, status: m.status === 'running' && !CAPS.has(m.id) ? 'stopped' : m.status, size_km: m.size_km, bbox: m.bbox, ring: m.ring, shape: m.shape }));
    }
    if (parts[0] === 'api' && parts[1] === 'captures' && parts[2]) {
      const c = await Capture.load(parts[2]);
      if (parts.length === 3) return Object.assign(JSON.parse(JSON.stringify(c.m)), { jobs: {} });
      if (parts[3] === 'mesh') {
        const cap = attach(c);
        c.run = (async () => {
          c.m.status = 'running'; await cap.save();
          if (!c.files.has('wac.jpg')) await cap.step('Imagery', () => cap.imagery());
          c.m.layers = c.m.layers.filter(l => l.key !== 'elevation');
          await cap.step('Elevation and 3D mesh', () => cap.elevation());
          c.m.status = 'complete'; c.m.step = 'done'; await cap.save();
        })();
        return { ok: true };
      }
      if (parts[3] === 'point') {
        const p = c.m.points[+parts[4]];
        if (!p) throw new Error('no such point');
        if (p.kind !== 'nac') throw new Error('Pictures of ' + (p.kind === 'radar' ? 'radar tracks (from JAXA)' : 'Xenarch points (Hugging Face login)') + ' are ' + LOCAL + '.');
        return Object.assign(await nacPreview(c.m.id, p), { title: p.title, text: p.text, kind: p.kind });
      }
      if (parts[3] === 'fetch') throw new Error('Downloading full archive products is ' + LOCAL + '.');
    }
    throw new Error('not found');
  }
  function url(id, name) {   // a URL for one file of a capture kept in this browser ('' until it exists)
    const c = CAPS.get(id), b = c && c.files.get(name);
    if (!b) return '';
    const u = c.urls.get(name);
    if (u && u[0] === b) return u[1];
    if (u) URL.revokeObjectURL(u[1]);
    const nu = URL.createObjectURL(b); c.urls.set(name, [b, nu]); return nu;
  }
  async function done(id) { const c = await Capture.load(id); while (c.run) { const r = c.run; await r; if (c.run === r) break; } return c.m; }

  window.TavWeb = { api, url, zip, done, LOCAL };
})();
