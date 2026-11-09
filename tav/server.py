#!/usr/bin/env python3
"""Tav · Aleph for the Moon.

Serves the site and the Tav API on http://127.0.0.1:8060 (PORT=… to change).
Draw a box on the map and Tav collects every lunar layer inside it into
captures/<id>/, with manifest.json as the file to read first.

Needs: python3, numpy, pillow, curl. No AI inside: it only collects data.
"""
import bisect, csv, io, json, math, os, re, struct, subprocess, sys, threading, time, traceback, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image, ImageDraw, TiffImagePlugin

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE, IDX = os.path.join(ROOT, 'site'), os.path.join(ROOT, 'site', 'index')
DATA, CAPS = os.path.join(ROOT, 'data', 'tav'), os.path.join(ROOT, 'captures')
CACHE = os.path.join(DATA, 'cache')
R_MOON, KM_DEG = 1737.4, 30.3234
GEO = 'https://pds-geosciences.wustl.edu'
ODE = 'https://oderest.rsl.wustl.edu/live2/'
TREK = 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg'
HF = 'https://huggingface.co/datasets/jules1235813/xenarch/resolve/main/'
w180 = lambda lon: ((float(lon) + 180) % 360) - 180


# ---------------------------------------------------------------- http (curl)
def curl(url, rng=None, timeout=180, headers=()):
    cmd = ['curl', '-fsSL', '--retry', '2', '-m', str(timeout), '-A', 'tav/0.1']
    for h in headers: cmd += ['-H', h]
    if rng: cmd += ['-r', f'{rng[0]}-{rng[1] - 1}']
    r = subprocess.run(cmd + [url], capture_output=True)
    if r.returncode != 0: raise IOError(f'{url}: {r.stderr.decode(errors="replace").strip()[:160]}')
    if rng and len(r.stdout) != rng[1] - rng[0]: raise IOError(f'{url}: server ignored the byte range')
    return r.stdout


class RangesIgnored(IOError): pass


def curl_ranges(url, spans, timeout=600):
    """Fetch byte ranges [a, b) of one file in a single request (multipart/byteranges); one bytes object per range."""
    if len(spans) == 1: return [curl(url, spans[0], timeout)]
    want = sum(b - a for a, b in spans)   # a server that ignores the ranges would send the whole file: stop it early
    cmd = ['curl', '-fsSL', '--retry', '2', '-m', str(timeout), '-A', 'tav/0.1', '-D', '-', '--max-filesize', str(want + 300 * len(spans) + 65536),
           '-H', 'Range: bytes=' + ','.join(f'{a}-{b - 1}' for a, b in spans), url]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode == 63 or b'Maximum file size exceeded' in r.stderr: raise RangesIgnored(f'{url}: server ignored the byte ranges')   # 56 over HTTP/2
    if r.returncode != 0: raise IOError(f'{url}: {r.stderr.decode(errors="replace").strip()[:160]}')
    out, head = r.stdout, ''
    while out.startswith(b'HTTP/'):   # one header block per redirect or retry, then the body
        i = out.find(b'\r\n\r\n')
        if i < 0: raise IOError(f'{url}: truncated reply')
        head, out = out[:i].decode('latin-1'), out[i + 4:]
    if head.split(None, 2)[1:2] != ['206']: raise RangesIgnored(f'{url}: server ignored the byte ranges')
    ct = re.search(r'(?im)^content-type:\s*multipart/byteranges.*?boundary="?([^";\s]+)', head); parts = []
    if ct:   # walk the parts by their Content-Range length, so the boundary may appear inside the data
        delim, pos = b'--' + ct.group(1).encode(), 0
        while True:
            i = out.find(delim, pos)
            if i < 0 or out[i + len(delim):i + len(delim) + 2] == b'--': break
            j = out.find(b'\r\n\r\n', i); cr = re.search(rb'(?i)content-range:\s*bytes\s+(\d+)-(\d+)/', out[i:j]) if j > 0 else None
            if not cr: raise IOError(f'{url}: unreadable multipart reply')
            a, n = int(cr.group(1)), int(cr.group(2)) + 1 - int(cr.group(1))
            parts.append((a, out[j + 4:j + 4 + n])); pos = j + 4 + n
    else:   # the server merged every range into one
        cr = re.search(r'(?im)^content-range:\s*bytes\s+(\d+)-', head)
        if not cr: raise IOError(f'{url}: reply without Content-Range')
        parts.append((int(cr.group(1)), out))
    parts.sort(key=lambda p: p[0]); starts, res = [p[0] for p in parts], []
    for a, b in spans:   # the server may merge or reorder ranges
        s, d = parts[max(bisect.bisect_right(starts, a) - 1, 0)]
        if not s <= a or b - s > len(d): raise IOError(f'{url}: bytes {a}-{b - 1} missing from the reply')
        res.append(d[a - s:b - s])
    return res


def curl_spans(url, spans, max_ranges=400, max_bytes=32 << 20):
    """The bytes of all ranges [a, b) of one file, back to back, in as few requests as possible.
    PDS Geosciences rejects a Range header over ~16 KB (about 700 ranges), so a request carries at most 400."""
    merged = []
    for a, b in spans:   # adjacent ranges travel as one
        if merged and merged[-1][1] == a: merged[-1][1] = b
        else: merged.append([a, b])
    batches = []
    for a, b in merged:
        if not batches or len(batches[-1]) >= max_ranges or sum(y - x for x, y in batches[-1]) + b - a > max_bytes: batches.append([])
        batches[-1].append((a, b))
    def one(batch):
        try: return curl_ranges(url, batch)
        except RangesIgnored: return [curl(url, s, timeout=120) for s in batch]   # no multi-range support: one request per range
    with ThreadPoolExecutor(4) as ex: return b''.join(d for got in ex.map(one, batches) for d in got)


def curl_to(url, path, headers=(), timeout=3600):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cmd = ['curl', '-fsSL', '--retry', '3', '-m', str(timeout), '-A', 'tav/0.1', '-o', path + '.part']
    for h in headers: cmd += ['-H', h]
    r = subprocess.run(cmd + [url], capture_output=True)
    if r.returncode != 0: raise IOError(f'{url}: {r.stderr.decode(errors="replace").strip()[:160]}')
    os.replace(path + '.part', path); return path


def hf_headers():
    tok = os.environ.get('HF_TOKEN')
    p = os.path.expanduser('~/.cache/huggingface/token')
    if not tok and os.path.exists(p): tok = open(p).read().strip()
    return (f'Authorization: Bearer {tok}',) if tok else ()


# ------------------------------------------------- global rasters, read by box
class Raster:
    """A simple-cylindrical raster (one file or a grid of tiles), read by byte ranges."""

    def __init__(self, key, title, unit, ppd, lat_top, lat_bot, lon_west, dtype, scale=1.0, url=None, local=None,
                 tiles=None, offset=0, valid=None, source=''):
        self.key, self.title, self.unit, self.ppd, self.lat_top, self.lat_bot = key, title, unit, ppd, lat_top, lat_bot
        self.lon_west, self.dtype, self.scale, self.url, self.local = lon_west, np.dtype(dtype), scale, url, local
        self.tiles, self.offset, self.valid, self.source = tiles, offset, valid, source
        self.rows, self.cols = int(round((lat_top - lat_bot) * ppd)), int(round(360 * ppd))

    def _files(self, r0, r1, c0, c1):
        """Yield (url, local, file_r0, file_c0, nrows, ncols, file_width, out_r, out_c)."""
        if not self.tiles:
            yield self.url, self.local, r0, c0, r1 - r0, c1 - c0, self.cols, 0, 0; return
        th, tw, name = self.tiles
        for ti in range(r0 // th, (r1 - 1) // th + 1):
            for tj in range(c0 // tw, (c1 - 1) // tw + 1):
                a, b = max(r0, ti * th), min(r1, (ti + 1) * th); c, d = max(c0, tj * tw), min(c1, (tj + 1) * tw)
                u, loc = name(ti, tj)
                yield u, loc, a - ti * th, c - tj * tw, b - a, d - c, tw, a - r0, c - c0

    def _read(self, url, local, fr, fc, nr, nc, width, k):
        bpp = self.dtype.itemsize
        if local and os.path.exists(local):
            m = np.memmap(local, self.dtype, 'r', offset=self.offset, shape=(os.path.getsize(local) - self.offset) // bpp // width * width).reshape(-1, width)
            return np.array(m[fr:fr + nr:k, fc:fc + nc:k])
        rows = range(fr, fr + nr, k)   # only the part of each row inside the box, hundreds of rows per request
        raw = curl_spans(url, [(self.offset + (r * width + fc) * bpp, self.offset + (r * width + fc + nc) * bpp) for r in rows])
        return np.frombuffer(raw, self.dtype).reshape(len(rows), nc)[:, ::k].copy()

    def read(self, s, n, w, e, max_px=1024):
        n, s = min(n, self.lat_top), max(s, self.lat_bot)
        if n <= s: return None
        r0, r1 = int((self.lat_top - n) * self.ppd), max(int(math.ceil((self.lat_top - s) * self.ppd)), 0)
        r1 = min(max(r1, r0 + 1), self.rows)
        c0 = int(((w - self.lon_west) % 360) * self.ppd); c1 = c0 + max(int(math.ceil((e - w) * self.ppd)), 1)
        k = max(1, int(math.ceil(max(r1 - r0, c1 - c0) / max_px)))
        spans = [(c0, min(c1, self.cols))] + ([(0, c1 - self.cols)] if c1 > self.cols else [])
        parts = []
        for a, b in spans:
            out = np.full((len(range(0, r1 - r0, k)), len(range(0, b - a, k))), np.nan, np.float32)
            for url, loc, fr, fc, nr, nc, width, orr, occ in self._files(r0, r1, a, b):
                # keep the decimation grid aligned across tiles
                dr, dc = (-orr) % k, (-occ) % k
                if dr >= nr or dc >= nc: continue
                blk = self._read(url, loc, fr + dr, fc + dc, nr - dr, nc - dc, width, k).astype(np.float32)
                i, j = (orr + dr) // k, (occ + dc) // k
                out[i:i + blk.shape[0], j:j + blk.shape[1]] = blk[:out.shape[0] - i, :out.shape[1] - j]
            parts.append(out)
        arr = np.hstack(parts)
        bad = ~np.isfinite(arr) if self.valid is None else ~self.valid(arr)
        arr = arr * self.scale; arr[bad] = np.nan
        top, west = self.lat_top - r0 / self.ppd, w180(self.lon_west + c0 / self.ppd)
        return dict(arr=arr, n=top, s=top - arr.shape[0] * k / self.ppd, w=west, e=west + arr.shape[1] * k / self.ppd,
                    deg_px=k / self.ppd, m_px=round(KM_DEG * 1000 * k / self.ppd, 1), native_m_px=round(KM_DEG * 1000 / self.ppd, 1))


def _sldem(ti, tj):
    band = ('30n_60n', '00n_30n', '30s_00s', '60s_30s')[ti]
    f = f'sldem2015_512_{band}_{tj * 45:03d}_{tj * 45 + 45:03d}_float.img'
    return f'{GEO}/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/tiles/float_img/{f}', os.path.join(DATA, 'sldem', f)


RASTERS = [
    Raster('elevation', 'Elevation · SLDEM', 'm', 512, 60, -60, 0, '<f4', 1000.0, tiles=(15360, 23040, _sldem),
           valid=lambda a: np.abs(a) < 50, source='SLDEM2015, LOLA + Kaguya, 59 m per pixel'),
    Raster('elevation_lola', 'Elevation · LOLA', 'm', 64, 90, -90, 0, '<i2', 0.5,
           url=f'{GEO}/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img',
           local=os.path.join(DATA, 'lola', 'ldem_64.img'), source='LOLA LDEM 64 px/deg, 474 m per pixel'),
    Raster('thermal_night', 'Night temperature · Diviner', 'K', 128, 70, -70, 0, '<f4',
           url=f'{GEO}/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_ghrm/img/dghrm_tbol_m_70s70n_img.img',
           valid=lambda a: (a > 20) & (a < 500), source='Diviner global mosaic, bolometric temperature at midnight, 237 m per pixel'),
    Raster('gravity', 'Gravity · GRAIL', 'mGal', 16, 90, -90, 0, '<f4',
           url=f'{GEO}/grail/grail-l-lgrs-5-rdr-v1/grail_1001/rsdmap/gggrx_1200a_anom_l660.img',
           local=os.path.join(DATA, 'grail', 'gggrx_1200a_anom_l660.img'), source='GRAIL GRGM1200A free-air anomaly to degree 660, 1.9 km per pixel'),
    Raster('radar_cpr', 'Radar polarisation · Mini-RF', 'ratio', 128, 90, -90, -180, '<f4',
           url=f'{GEO}/lro/lro-l-mrflro-5-global-mosaic-v1/lromrf_1001/data/128ppd/global_cpr_128ppd_simp_0c.img',
           valid=lambda a: (a > 0) & (a < 50), source='Mini-RF global mosaic, circular polarisation ratio, 237 m per pixel'),
]

ODE_TYPES = [  # (ihid, iid, pt, title)
    ('LRO', 'LROC', 'CDRNAC4', 'LROC NAC frames'), ('LRO', 'LROC', 'SDNDTM', 'NAC stereo DTMs'),
    ('SLN', 'TC', 'TCORT', 'Kaguya TC ortho tiles'), ('SLN', 'TC', 'TCDTMM', 'Kaguya TC elevation tiles'),
    ('SLN', 'MI', 'MIMAP', 'Kaguya MI mineral tiles'), ('CH1-ORB', 'M3', 'REFIMG', 'M³ reflectance cubes'),
    ('LRO', 'MRFLRO', 'MAPCDR', 'Mini-RF radar strips'),
]


# ------------------------------------------------------------------- writers
def write_geotiff(path, arr, n, w, deg_px):
    ifd = TiffImagePlugin.ImageFileDirectory_v2()
    ifd.tagtype[33550] = 12; ifd[33550] = (deg_px, deg_px, 0.0)
    ifd.tagtype[33922] = 12; ifd[33922] = (0.0, 0.0, 0.0, float(w), float(n), 0.0)
    ifd.tagtype[34736] = 12; ifd[34736] = (1737400.0, 1737400.0)
    ifd.tagtype[34735] = 3
    ifd[34735] = (1, 1, 0, 6, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 32767, 2054, 0, 1, 9102, 2057, 34736, 1, 0, 2058, 34736, 1, 1)
    Image.fromarray(arr.astype(np.float32), 'F').save(path, tiffinfo=ifd)


def write_preview(path, arr, lo=1, hi=99, box=None):
    """Stretched picture of a layer. `box` (left, top, right, bottom in array pixels, fractions allowed) cuts it exactly to the capture box."""
    ok = np.isfinite(arr)
    if not ok.any(): return None
    a, b = np.percentile(arr[ok], [lo, hi]); b = b if b > a else a + 1
    g = (np.clip((np.nan_to_num(arr, nan=a) - a) / (b - a), 0, 1) * 255).astype(np.uint8)
    im = Image.merge('LA', (Image.fromarray(g), Image.fromarray((ok * 255).astype(np.uint8))))
    if box:
        bw, bh = box[2] - box[0], box[3] - box[1]; sc = max(1.0, 512 / max(bw, bh))
        im = im.resize((max(1, int(round(bw * sc))), max(1, int(round(bh * sc)))), Image.BICUBIC, box=box)
    elif max(im.size) < 512: im = im.resize((im.size[0] * 512 // max(im.size), im.size[1] * 512 // max(im.size)), Image.BICUBIC)
    im.save(path); return [float(a), float(b)]


def write_glb(path, height, tex_jpg, w_m, h_m):
    """Terrain mesh as binary glTF: x east, y up, z south, metres, texture draped on top."""
    ny, nx = height.shape; hh = np.nan_to_num(height, nan=float(np.nanmin(height))); hh = hh - float(hh.min())
    xs, zs = np.meshgrid(np.linspace(-w_m / 2, w_m / 2, nx), np.linspace(-h_m / 2, h_m / 2, ny))
    pos = np.stack([xs, hh, zs], -1).reshape(-1, 3).astype('<f4')
    us, vs = np.meshgrid(np.linspace(0, 1, nx), np.linspace(0, 1, ny)); uv = np.stack([us, vs], -1).reshape(-1, 2).astype('<f4')
    i = np.arange((ny - 1) * nx).reshape(ny - 1, nx)[:, :-1].ravel()
    tri = np.concatenate([np.stack([i, i + nx, i + 1], 1), np.stack([i + 1, i + nx, i + nx + 1], 1)])
    tri = tri[np.isfinite(height).ravel()[tri].all(1)]          # a polygon capture is cut to its outline
    idx = tri.ravel().astype('<u4')
    pad = lambda b: b + b'\0' * (-len(b) % 4)
    chunks = [pad(pos.tobytes()), pad(uv.tobytes()), pad(idx.tobytes()), pad(tex_jpg)]; offs = np.cumsum([0] + [len(c) for c in chunks])
    g = dict(asset=dict(version='2.0', generator='tav'), scene=0, scenes=[dict(nodes=[0])], nodes=[dict(mesh=0)],
             meshes=[dict(primitives=[dict(attributes=dict(POSITION=0, TEXCOORD_0=1), indices=2, material=0)])],
             materials=[dict(pbrMetallicRoughness=dict(baseColorTexture=dict(index=0), metallicFactor=0, roughnessFactor=1), doubleSided=True)],
             textures=[dict(source=0)], images=[dict(bufferView=3, mimeType='image/jpeg')],
             buffers=[dict(byteLength=int(offs[-1]))],
             bufferViews=[dict(buffer=0, byteOffset=int(offs[0]), byteLength=pos.nbytes, target=34962), dict(buffer=0, byteOffset=int(offs[1]), byteLength=uv.nbytes, target=34962),
                          dict(buffer=0, byteOffset=int(offs[2]), byteLength=idx.nbytes, target=34963), dict(buffer=0, byteOffset=int(offs[3]), byteLength=len(tex_jpg))],
             accessors=[dict(bufferView=0, componentType=5126, count=len(pos), type='VEC3', min=pos.min(0).tolist(), max=pos.max(0).tolist()),
                        dict(bufferView=1, componentType=5126, count=len(uv), type='VEC2'), dict(bufferView=2, componentType=5125, count=len(idx), type='SCALAR')])
    js = json.dumps(g, separators=(',', ':')).encode(); js += b' ' * (-len(js) % 4); body = b''.join(chunks)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(body)))
        f.write(struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(body), b'BIN\0') + body)


def in_ring(lat, lon, ring):
    lat, lon = np.asarray(lat, float), np.asarray(lon, float); c = np.zeros(lat.shape, bool)
    for (y1, x1), (y2, x2) in zip(ring, ring[1:] + ring[:1]):
        if y1 == y2: continue
        m = (y1 > lat) != (y2 > lat)
        c ^= m & (lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1)
    return c


# ------------------------------------------------------------------ captures
INDEX, JOBS, OPS, LOCK = {}, {}, {}, threading.Lock()   # JOBS: capture id → {'type:id': download progress}


def capture_lock(cid):
    """One change to a capture at a time. A capture run, a 3D rebuild and the Kaguya update after a download each
    load the manifest, change it and save it whole: two at once would lose the changes of one."""
    with LOCK: return OPS.setdefault(cid, threading.Lock())


def index(name):
    if name not in INDEX:
        p = os.path.join(IDX, name)
        if not os.path.exists(p): INDEX[name] = None
        elif name.endswith('.bin'): INDEX[name] = np.fromfile(p, '<f4').reshape(-1, 3)
        elif name.endswith('.png'): INDEX[name] = np.array(Image.open(p))
        else: INDEX[name] = json.load(open(p))
    return INDEX[name]


def craters_in(s, n, w, e):
    """Craters [lat, lon, diameter_km] inside a box, edges included, from the 10° tiles in site/index/craters/ (None if not built)."""
    meta = index('craters/index.json')
    if not meta: return None
    d = meta['deg']; tiles = [f'{a}_{b}' for a in range(max(-90, math.floor(s / d) * d), min(90 - d, math.floor(n / d) * d) + 1, d)
                              for b in range(max(-180, math.floor(w / d) * d), min(180 - d, math.floor(e / d) * d) + 1, d)]
    c = [index(f'craters/{t}.bin') for t in tiles if t in meta['tiles']]
    c = np.concatenate(c) if c else np.zeros((0, 3), np.float32)
    return c[(c[:, 0] >= s) & (c[:, 0] <= n) & (c[:, 1] >= w) & (c[:, 1] <= e)]


def products(cdir, typ):
    """The archive products of one type that cross a capture's box, from its catalogue.json (None if not catalogued)."""
    p = os.path.join(cdir, 'catalogue.json')
    return next((c['items'] for c in json.load(open(p)) if c['type'] == typ), None) if os.path.exists(p) else None


ALL_LAYERS = ['imagery', 'elevation', 'thermal_night', 'gravity', 'radar_cpr', 'vectors', 'catalogue', 'points_nac', 'points_radar', 'points_xenarch']


class Capture:
    def __init__(self, ring, shape, opts=None):
        o = opts or {}; self.want = set(o.get('layers') or ALL_LAYERS) | {'elevation'}; self.max_px = int(min(2048, max(256, o.get('max_px') or 1024))); self.tc_download = bool(o.get('tc_download'))
        self.ring = [[float(a), w180(b)] for a, b in ring]
        la, lo = [p[0] for p in self.ring], [p[1] for p in self.ring]
        self.s, self.n, self.w, self.e = min(la), max(la), min(lo), max(lo)
        mid = (self.s + self.n) / 2
        base = time.strftime('tav-%Y%m%dT%H%M%S') + f"-{abs(mid):04.1f}{'n' if mid >= 0 else 's'}{(self.w + self.e) / 2 % 360:05.1f}e".replace('.', '_')
        self.id, k = base, 1
        while True:   # the same place in the same second: -2, -3… (creating the folder is the atomic claim)
            try: os.makedirs(os.path.join(CAPS, self.id)); break
            except FileExistsError: k += 1; self.id = f'{base}-{k}'
        self.dir = os.path.join(CAPS, self.id)
        wk, hk = (self.e - self.w) * KM_DEG * math.cos(math.radians(mid)), (self.n - self.s) * KM_DEG
        self.m = dict(id=self.id, created=time.strftime('%Y-%m-%dT%H:%M:%S'), shape=shape, ring=self.ring,
                      bbox=dict(south=self.s, north=self.n, west=self.w, east=self.e), size_km=[round(wk, 2), round(hk, 2)],
                      options=dict(layers=sorted(self.want), max_px=self.max_px, tc_download=self.tc_download), status='running', step='starting', steps=[], layers=[], vectors=[], catalogue=[], points=[], notes=[], files=[], dir=self.dir)
        self.save()

    @classmethod
    def load(cls, cid):
        c = cls.__new__(cls); c.id, c.dir = cid, os.path.join(CAPS, cid)
        with LOCK: c.m = json.load(open(os.path.join(c.dir, 'manifest.json')))
        b = c.m['bbox']; c.ring = c.m['ring']; c.s, c.n, c.w, c.e = b['south'], b['north'], b['west'], b['east']
        o = c.m.get('options') or {}; c.want = set(o.get('layers') or ALL_LAYERS); c.max_px = int(o.get('max_px') or 1024); c.tc_download = False
        return c

    def add_mesh(self):
        self.m['status'] = 'running'; self.save()
        if not os.path.exists(os.path.join(self.dir, 'wac.jpg')): self.step('Imagery', self.imagery)
        self.m['layers'] = [l for l in self.m['layers'] if l['key'] != 'elevation']
        self.step('Elevation and 3D mesh', self.elevation)
        if self.m['catalogue']: self.step('Kaguya TC, 7 m', self.kaguya)
        self.m['status'] = 'complete'; self.m['step'] = 'done'; self.save()

    def save(self):
        fs = []
        for r, _, names in os.walk(self.dir):
            for f in sorted(names):
                if f.endswith('.part') or f.startswith('_'): continue
                p = os.path.join(r, f); fs.append(dict(name=os.path.relpath(p, self.dir), bytes=os.path.getsize(p)))
        self.m['files'] = sorted(fs, key=lambda x: x['name'])
        with LOCK: json.dump(self.m, open(os.path.join(self.dir, 'manifest.json'), 'w'), indent=1)

    def step(self, name, fn):
        self.m['step'] = name; self.save(); t = time.time()
        try: fn(); self.m['steps'].append(dict(name=name, ok=True, seconds=round(time.time() - t, 1)))
        except Exception as ex:
            traceback.print_exc()
            self.m['steps'].append(dict(name=name, ok=False, error=str(ex)[:300])); self.m['notes'].append(f'{name}: {str(ex)[:200]}')
        self.save()

    def mask(self, d):
        self._inside = d['arr'].size
        if self.m['shape'] != 'polygon': return d['arr']
        h, w = d['arr'].shape; im = Image.new('L', (w, h), 0)
        ImageDraw.Draw(im).polygon([((lo - d['w']) / (d['e'] - d['w']) * w, (d['n'] - la) / (d['n'] - d['s']) * h) for la, lo in self.ring], fill=1)
        a = d['arr'].copy(); a[np.array(im) == 0] = np.nan; self._inside = max(1, int(np.array(im).sum())); return a

    # -- steps
    def imagery(self):
        span = max(self.e - self.w, self.n - self.s)
        z = int(min(8, max(0, math.floor(math.log2(2 * self.max_px * 180 / (256 * span))))))
        t = 180 / 2 ** z; x0, x1 = int((self.w + 180) // t), int((self.e + 180) // t); y0, y1 = int((90 - self.n) // t), int((90 - self.s) // t)
        y1 = min(y1, 2 ** z - 1); tiles = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
        def get(xy): return xy, Image.open(io.BytesIO(curl(TREK.format(z=z, x=xy[0] % 2 ** (z + 1), y=xy[1]), timeout=60)))
        mos = Image.new('L', ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256))
        with ThreadPoolExecutor(8) as ex:
            for (x, y), im in ex.map(get, tiles): mos.paste(im.convert('L'), ((x - x0) * 256, (y - y0) * 256))
        ppd = 256 / t; box = (int((self.w + 180 - x0 * t) * ppd), int((90 - self.n - y0 * t) * ppd), int(math.ceil((self.e + 180 - x0 * t) * ppd)), int(math.ceil((90 - self.s - y0 * t) * ppd)))
        im = mos.crop(box)
        if max(im.size) < 1024: im = im.resize((max(1, im.size[0] * 1024 // max(im.size)), max(1, im.size[1] * 1024 // max(im.size))), Image.LANCZOS)
        im.save(os.path.join(self.dir, 'wac.jpg'), quality=90)
        self.m['layers'].append(dict(key='imagery', title='Imagery · LROC WAC', file='wac.jpg', preview='wac.jpg', bounds=[[self.s, self.w], [self.n, self.e]],
                                     m_px=round(KM_DEG * 1000 / ppd), source=f'LROC WAC global mosaic via NASA Moon Trek, zoom {z}', px=list(im.size)))

    def raster(self, r):
        d = r.read(self.s, self.n, self.w, self.e, self.max_px)
        if d is None: self.m['notes'].append(f'{r.title}: no coverage at this latitude'); return None
        a = self.mask(d); ok = np.isfinite(a)
        if not ok.any(): self.m['notes'].append(f'{r.title}: no data inside the box'); return None
        key = r.key.replace('_lola', '')
        write_geotiff(os.path.join(self.dir, key + '.tif'), a, d['n'], d['w'], d['deg_px'])
        bn, bs, bw, be = min(self.n, d['n']), max(self.s, d['s']), max(self.w, d['w']), min(self.e, d['e']); dp = d['deg_px']
        write_preview(os.path.join(self.dir, key + '.png'), a, box=((bw - d['w']) / dp, (d['n'] - bn) / dp, (be - d['w']) / dp, (d['n'] - bs) / dp))
        self.m['layers'].append(dict(key=key, title=r.title, unit=r.unit, file=key + '.tif', preview=key + '.png', bounds=[[bs, bw], [bn, be]], data_bounds=[[d['s'], d['w']], [d['n'], d['e']]],
                                     m_px=d['m_px'], native_m_px=d['native_m_px'], px=[a.shape[1], a.shape[0]], source=r.source, coverage_pct=round(min(100.0, float(ok.sum() / self._inside * 100)), 1),
                                     min=round(float(np.nanmin(a)), 3), max=round(float(np.nanmax(a)), 3), mean=round(float(np.nanmean(a)), 3)))
        return d, a

    def elevation(self):
        r = RASTERS[0] if (self.n <= 60 and self.s >= -60) else RASTERS[1]
        try: got = self.raster(r)
        except Exception as ex:
            if r is RASTERS[1]: raise
            self.m['notes'].append(f'SLDEM failed ({str(ex)[:80]}), used LOLA instead'); got = self.raster(RASTERS[1])
        if not got: return
        d, a = got; wk, hk = self.m['size_km']
        k = max(1, int(math.ceil(max(a.shape) / 220))); h = a[::k, ::k]
        tex = Image.open(os.path.join(self.dir, 'wac.jpg')).convert('RGB') if os.path.exists(os.path.join(self.dir, 'wac.jpg')) else Image.fromarray(np.full((8, 8, 3), 128, np.uint8))
        tex.thumbnail((1024, 1024)); b = io.BytesIO(); tex.save(b, 'JPEG', quality=85)
        if min(h.shape) >= 2:
            write_glb(os.path.join(self.dir, 'mesh.glb'), h, b.getvalue(), wk * 1000, hk * 1000)
            self.m['mesh'] = dict(file='mesh.glb', vertices=int(h.size), relief_m=round(float(np.nanmax(h) - np.nanmin(h)), 1), width_m=wk * 1000, height_m=hk * 1000)

    def vectors(self):
        def dump(name, feats, title):
            json.dump(dict(type='FeatureCollection', features=feats), open(os.path.join(self.dir, name), 'w'))
            self.m['vectors'].append(dict(key=name.split('.')[0], title=title, file=name, count=len(feats)))
        pt = lambda la, lo, **p: dict(type='Feature', geometry=dict(type='Point', coordinates=[round(float(lo), 5), round(float(la), 5)]), properties=p)
        c = craters_in(self.s, self.n, self.w, self.e)
        if c is not None:
            s = c[in_ring(c[:, 0], c[:, 1], self.ring)]
            total = len(s); s = s[np.lexsort((s[:, 1], s[:, 0], -s[:, 2]))][:5000]   # largest first, ties by lat then lon
            dump('craters.geojson', [pt(a, b, diameter_km=round(float(d), 3)) for a, b, d in s], 'Craters of 1 km or more')
            if total > 5000: self.m['notes'].append(f'Craters: kept the 5,000 largest of {total:,}')
        nm = index('names.json')
        if nm: dump('names.geojson', [pt(x[2], x[3], name=x[0], type=x[1], diameter_km=x[4]) for x in nm if in_ring([x[2]], [x[3]], self.ring)[0]], 'IAU names')
        pits = index('pits.json')
        if pits: dump('pits.geojson', [pt(p['lat'], p['lon'], **{k: v for k, v in p.items() if k not in ('lat', 'lon')}) for p in pits if in_ring([p['lat']], [p['lon']], self.ring)[0]], 'Known pits')
        g, leg = index('geology.png'), index('geology.json')
        if g is not None:
            r0, r1 = int((90 - self.n) * 16), int(math.ceil((90 - self.s) * 16)); c0, c1 = int((self.w + 180) * 16), int(math.ceil((self.e + 180) * 16))
            v, n = np.unique(g[r0:max(r1, r0 + 1), c0:max(c1, c0 + 1)], return_counts=True)
            units = [dict(pct=round(float(k / n.sum() * 100), 1), **leg.get(str(int(u)), dict(unit=str(int(u))))) for u, k in sorted(zip(v, n), key=lambda t: -t[1]) if str(int(u)) in leg]
            json.dump(units, open(os.path.join(self.dir, 'geology.json'), 'w'), indent=1)
            self.m['vectors'].append(dict(key='geology', title='Geologic units', file='geology.json', count=len(units), units=units[:6]))

    def catalogue(self):
        def q(t):
            ih, ii, pt, title = t
            p = dict(query='product', results='fmpc', target='moon', ihid=ih, iid=ii, pt=pt, output='JSON', limit='400',
                     westernlon=f'{self.w % 360:.4f}', easternlon=f'{self.e % 360:.4f}', minlat=f'{self.s:.4f}', maxlat=f'{self.n:.4f}')
            d = json.loads(curl(ODE + '?' + urllib.parse.urlencode(p), timeout=120))['ODEResults']
            ps = d.get('Products', {}); ps = ps.get('Product', []) if isinstance(ps, dict) else []
            ps = [ps] if isinstance(ps, dict) else ps; items = []
            for x in ps:
                fs = x.get('Product_files', {}).get('Product_file', []); fs = [fs] if isinstance(fs, dict) else fs
                fs = [f for f in fs if 'ode.rsl.wustl.edu' not in f.get('URL', '')]
                if not fs: continue
                big = max(fs, key=lambda f: float(f.get('KBytes') or 0)); num = lambda k: (float(x[k]) if x.get(k) not in (None, '') else None)
                items.append(dict(id=x.get('pdsid'), url=big['URL'], bytes=int(float(big.get('KBytes') or 0) * 1024), files=[f['URL'] for f in fs],
                                  footprint=x.get('Footprint_C0_geometry') or x.get('Footprint_geometry'), lat=num('Center_latitude'), lon=num('Center_longitude'),
                                  incidence=num('Incidence_angle'), emission=num('Emission_angle'), m_px=num('Map_resolution'), time=x.get('UTC_start_time') or x.get('Observation_time')))
            return dict(type=pt, title=title, count=int(d.get('Count') or len(items)), listed=len(items), bytes=sum(i['bytes'] for i in items), items=items)
        full = []
        with ThreadPoolExecutor(4) as ex:
            for t, r in zip(ODE_TYPES, ex.map(lambda t: _try(q, t), ODE_TYPES)):
                if isinstance(r, Exception): self.m['notes'].append(f'{t[3]}: catalogue query failed ({str(r)[:80]})')
                else: full.append(r)
        json.dump(full, open(os.path.join(self.dir, 'catalogue.json'), 'w'), indent=1)
        # the manifest keeps the counts; the product lists (up to 400 per type, ~1 MB for a big box) live in catalogue.json
        self.m['catalogue'] = [dict({k: v for k, v in c.items() if k != 'items'}, file='catalogue.json') for c in full]

    def kaguya(self):
        """Kaguya Terrain Camera at 7.4 m, from tiles already on disk (JAXA serves whole 302 MB tiles only)."""
        made = {}
        for typ, key, title, dt, nod, unit in (('TCORT', 'imagery_tc', 'Imagery · Kaguya TC', '>u2', 0, 'DN'), ('TCDTMM', 'elevation_tc', 'Elevation · Kaguya TC', '>i2', -9999, 'm')):
            items = products(self.dir, typ)
            if not items: continue
            ppd = 4096; rows, cols = int(math.ceil((self.n - self.s) * ppd)), int(math.ceil((self.e - self.w) * ppd)); k = max(1, int(math.ceil(max(rows, cols) / (1.5 * self.max_px))))
            out = np.full((len(range(0, rows, k)), len(range(0, cols, k))), np.nan, np.float32); missing = []
            for it in items:
                url = next((u for u in it['files'] if u.lower().endswith('.img')), None); mm = re.search(r'_([NS])(\d+)E(\d+)[NS]\d+E\d+', url or '')
                if not mm: continue
                top, west = (1 if mm.group(1) == 'N' else -1) * int(mm.group(2)), w180(int(mm.group(3))); f = os.path.basename(url)
                loc = next((x for x in (os.path.join(DATA, 'kaguya-tc', f), os.path.join(CACHE, 'tc', f), os.path.join(self.dir, typ.lower(), f)) if os.path.exists(x)), None)
                if not loc and self.tc_download:
                    self.m['step'] = f'Downloading Kaguya tile {f} (302 MB)'; self.save()
                    try: loc = curl_to(url, os.path.join(CACHE, 'tc', f), timeout=3600)
                    except Exception as ex: self.m['notes'].append(f'{f}: download failed ({str(ex)[:80]})')
                if not loc: missing.append(f); continue
                a = np.memmap(loc, dt, 'r', shape=(12288, 12288))
                r0, c0 = int(round((top - self.n) * ppd)), int(round((self.w - west) * ppd))   # box origin inside the tile
                ys = np.arange(0, rows, k) + r0; xs = np.arange(0, cols, k) + c0; my, mx = (ys >= 0) & (ys < 12288), (xs >= 0) & (xs < 12288)
                if my.any() and mx.any():
                    blk = np.array(a[ys[my][0]:ys[my][-1] + 1:k, xs[mx][0]:xs[mx][-1] + 1:k]).astype(np.float32); blk[blk == nod] = np.nan
                    i, j = int(np.argmax(my)), int(np.argmax(mx)); out[i:i + blk.shape[0], j:j + blk.shape[1]] = blk
            if missing: self.m['notes'].append(f"{title}: {len(missing)} tile(s) not on disk yet ({', '.join(missing[:2])}). Download them from the catalogue to add this layer.")
            if not np.isfinite(out).any(): continue
            d = dict(arr=out, n=self.n, s=self.n - out.shape[0] * k / ppd, w=self.w, e=self.w + out.shape[1] * k / ppd); a = self.mask(d)
            self.m['layers'] = [l for l in self.m['layers'] if l['key'] != key]
            write_geotiff(os.path.join(self.dir, key + '.tif'), a, d['n'], d['w'], k / ppd)
            if key == 'imagery_tc':
                ok = np.isfinite(a); lo, hi = np.percentile(a[ok], [0.5, 99.5]); g = (np.clip((np.nan_to_num(a, nan=lo) - lo) / max(hi - lo, 1), 0, 1) * 255).astype(np.uint8)
                Image.fromarray(g).save(os.path.join(self.dir, 'tc.jpg'), quality=90); prev = 'tc.jpg'
                if not ok.all(): Image.merge('LA', (Image.fromarray(g), Image.fromarray((ok * 255).astype(np.uint8)))).save(os.path.join(self.dir, 'tc.png')); prev = 'tc.png'
            else: write_preview(os.path.join(self.dir, key + '.png'), a); prev = key + '.png'
            self.m['layers'].append(dict(key=key, title=title, unit=unit, file=key + '.tif', preview=prev, bounds=[[d['s'], d['w']], [d['n'], d['e']]], m_px=round(7.4 * k, 1), native_m_px=7.4,
                                         px=[a.shape[1], a.shape[0]], source='Kaguya Terrain Camera map tiles, JAXA DARTS, 7.4 m per pixel', coverage_pct=round(min(100.0, float(np.isfinite(a).sum() / self._inside * 100)), 1),
                                         min=round(float(np.nanmin(a)), 1), max=round(float(np.nanmax(a)), 1), mean=round(float(np.nanmean(a)), 1)))
            made[key] = self.m['layers'][-1]['coverage_pct']; made[key + '_a'] = a
        if made.get('elevation_tc', 0) >= 90:   # sharper mesh, only if the tiles cover the box
            a = made['elevation_tc_a']; wk, hk = self.m['size_km']; k = max(1, int(math.ceil(max(a.shape) / 300))); h = a[::k, ::k]
            tp = os.path.join(self.dir, 'tc.jpg' if made.get('imagery_tc', 0) >= 90 else 'wac.jpg')
            tex = Image.open(tp).convert('RGB'); tex.thumbnail((2048, 2048)); b = io.BytesIO(); tex.save(b, 'JPEG', quality=88)
            write_glb(os.path.join(self.dir, 'mesh.glb'), h, b.getvalue(), wk * 1000, hk * 1000)
            self.m['mesh'] = dict(file='mesh.glb', vertices=int(h.size), relief_m=round(float(np.nanmax(h) - np.nanmin(h)), 1), width_m=wk * 1000, height_m=hk * 1000, source='Kaguya TC elevation and image')

    def points(self):
        pts = []; mid = (self.s + self.n) / 2; clamp = lambda v, a, b: min(max(v, a), b)
        for it in (products(self.dir, 'CDRNAC4') or []) if 'points_nac' in self.want else []:
            if it['lat'] is None: continue
            sun = f", sun {it['incidence']:.0f}° from vertical" + (' (night)' if it['incidence'] > 90 else '') if it['incidence'] is not None else ''
            la, lo = it['lat'], w180(it['lon']); centred = self.s <= la <= self.n and self.w <= lo <= self.e
            fp = [] if centred else re.findall(r'(-?[\d.]+) (-?[\d.]+)', it['footprint'] or '')
            if fp:   # dot at the middle of the part of the strip that lies inside the box
                xs, ys = [w180(x) for x, _ in fp], [float(y) for _, y in fp]
                a, b, c, d = max(min(xs), self.w), min(max(xs), self.e), max(min(ys), self.s), min(max(ys), self.n)
                if a <= b and c <= d: la, lo = (c + d) / 2, (a + b) / 2
            la, lo = clamp(la, self.s, self.n), clamp(lo, self.w, self.e)
            pts.append(dict(kind='nac', lat=la, lon=lo, title=f"NAC frame {it['id'].split('.')[-1].upper()}",
                            text=f"{(it['time'] or '')[:10]}, {it['m_px']} m per pixel{sun}. Raw strip, {it['bytes'] / 1e6:.0f} MB.", ref=it['id'], incidence=it['incidence']))
        for t in (index('lrs_tracks.json') or []) if 'points_radar' in self.want else []:
            a, b = min(t['lat0'], t['lat1']), max(t['lat0'], t['lat1'])
            if b < self.s or a > self.n or t['lat1'] == t['lat0']: continue
            dl = ((t['lon1'] - t['lon0'] + 180) % 360) - 180; lon = w180(t['lon0'] + dl * (clamp(mid, a, b) - t['lat0']) / (t['lat1'] - t['lat0']))
            if self.w <= lon <= self.e:
                pts.append(dict(kind='radar', lat=clamp(mid, a, b), lon=lon, title=f"Radar sounder track {t['id'][-14:]}",
                                text=f"Kaguya LRS, {t['day'][:4]}-{t['day'][4:6]}-{t['day'][6:]}. A vertical cut through the ground along the orbit, 25 m per pixel in depth.", ref=t['id'], day=t['day'], track=t))
        for p in (index('xenarch.json') or []) if 'points_xenarch' in self.want else []:
            if self.s <= p['lat'] <= self.n and self.w <= p['lon'] <= self.e and in_ring([p['lat']], [p['lon']], self.ring)[0]: pts.append(dict(p))
        for i, p in enumerate(pts): p['i'] = i
        self.m['points'] = pts
        self.m['point_counts'] = {k: sum(1 for p in pts if p['kind'] == k) for k in ('nac', 'radar', 'ohrc', 'hardware', 'terrain')}

    def run(self):
        with capture_lock(self.id):
            w = self.want
            if 'imagery' in w: self.step('Imagery', self.imagery)
            self.step('Elevation and 3D mesh', self.elevation)   # always: the 3D view needs it
            for r in RASTERS[2:]:
                if r.key in w: self.step(r.title, lambda r=r: self.raster(r))
            if 'vectors' in w: self.step('Craters, names, pits, geology', self.vectors)
            if 'catalogue' in w or 'points_nac' in w or self.tc_download:
                self.step('Catalogue of products', self.catalogue)
                self.step('Kaguya TC, 7 m', self.kaguya)
            self.step('Points', self.points)
            self.m['status'] = 'complete'; self.m['step'] = 'done'; self.save()


def add_mesh(cid):
    with capture_lock(cid): Capture.load(cid).add_mesh()   # loaded inside the lock, so it starts from the latest manifest


def plan(ring):
    ring = [[float(a), w180(b)] for a, b in ring]; la, lo = [p[0] for p in ring], [p[1] for p in ring]
    s, n, w, e = min(la), max(la), min(lo), max(lo); mid = (s + n) / 2
    inside = lambda pts: sum(1 for p in pts if s <= p['lat'] <= n and w <= p['lon'] <= e and in_ring([p['lat']], [p['lon']], ring)[0])
    out = dict(size_km=[round((e - w) * KM_DEG * math.cos(math.radians(mid)), 2), round((n - s) * KM_DEG, 2)], layers={})
    for key, r in (('elevation', RASTERS[0] if (n <= 60 and s >= -60) else RASTERS[1]), ('thermal_night', RASTERS[2]), ('gravity', RASTERS[3]), ('radar_cpr', RASTERS[4])):
        ok = min(n, r.lat_top) > max(s, r.lat_bot)
        out['layers'][key] = dict(title=r.title, m_px=round(KM_DEG * 1000 / r.ppd, 1), px=[int((e - w) * r.ppd) + 1, int((n - s) * r.ppd) + 1], available=ok, source=r.source)
    out['layers']['imagery'] = dict(title='Imagery · LROC WAC', m_px=83, px=[int((e - w) * 364) + 1, int((n - s) * 364) + 1], available=True, source='LROC WAC global mosaic, NASA Moon Trek')
    tiles = [(top, west) for top in range(int(math.floor(s / 3)) * 3 + 3, int(math.ceil(n / 3)) * 3 + 1, 3) for west in range(int(math.floor((w % 360) / 3)) * 3, int(math.ceil((w % 360 + (e - w)) / 3)) * 3, 3)]
    have = 0
    for top, west in tiles:
        ns = lambda v: ('N' if v >= 0 else 'S') + f'{abs(v):02d}'
        f = f'_MAP_02_{ns(top)}E{west % 360:03d}{ns(top - 3)}E{(west + 3) % 360 if (west + 3) % 360 else 360:03d}SC.img'
        have += all(any(os.path.exists(os.path.join(d, pre + f)) for d in (os.path.join(DATA, 'kaguya-tc'), os.path.join(CACHE, 'tc'))) for pre in ('TCO', 'DTM'))
    out['kaguya'] = dict(tiles=len(tiles), on_disk=have, download_mb=(len(tiles) - have) * 604)
    c = craters_in(s, n, w, e)
    xen =[p for p in (index('xenarch.json') or [])]; radar = 0
    for t in index('lrs_tracks.json') or []:
        a, b = min(t['lat0'], t['lat1']), max(t['lat0'], t['lat1'])
        if b < s or a > n or t['lat1'] == t['lat0']: continue
        dl = ((t['lon1'] - t['lon0'] + 180) % 360) - 180; lon = w180(t['lon0'] + dl * (min(max(mid, a), b) - t['lat0']) / (t['lat1'] - t['lat0']))
        radar += w <= lon <= e
    out['counts'] = dict(craters=len(c) if c is not None else None, names=sum(1 for x in (index('names.json') or []) if s <= x[2] <= n and w <= x[3] <= e),
                         pits=inside(index('pits.json') or []), radar=int(radar), ohrc=inside([p for p in xen if p['kind'] == 'ohrc']),
                         hardware=inside([p for p in xen if p['kind'] == 'hardware']), terrain=inside([p for p in xen if p['kind'] == 'terrain']))
    return out


def _try(f, *a):
    try: return f(*a)
    except Exception as ex: return ex


# ------------------------------------------------- point previews (on click)
def nac_preview(m, p, cdir):
    it = next(i for i in products(cdir, 'CDRNAC4') or [] if i['id'] == p['ref'])
    name = p['ref'].split('.')[-1]; out = os.path.join(cdir, 'nac'); os.makedirs(out, exist_ok=True)
    f_c, f_w = os.path.join(out, name + '_centre.jpg'), os.path.join(out, name + '_wide.jpg')
    if not os.path.exists(f_c):
        url = next(u for u in it['files'] if u.upper().endswith('.IMG'))
        lab = curl(url, (0, 6000)).decode('latin-1'); g = lambda k: int(re.search(k + r'\s*=\s*(\d+)', lab).group(1))
        rb, lr, lines, samples = g('RECORD_BYTES'), g('LABEL_RECORDS'), g(r'\bLINES'), g('LINE_SAMPLES')
        v = [tuple(map(float, x.split())) for x in re.search(r'\(\((.*?)\)\)', it['footprint']).group(1).split(',')][:4]
        ur, lr_, ll, ul = [np.array([w180(x), y]) for x, y in v]   # ODE order: upper right, lower right, lower left, upper left
        tgt = np.array([min(max((m['bbox']['west'] + m['bbox']['east']) / 2, min(ul[0], ur[0], ll[0], lr_[0])), max(ul[0], ur[0], ll[0], lr_[0])), (m['bbox']['south'] + m['bbox']['north']) / 2])
        A = np.stack([ur - ul, ll - ul], 1); s, t = np.linalg.solve(A, tgt - ul); s, t = float(np.clip(s, 0, 1)), float(np.clip(t, 0, 1))
        n = min(lines, 1600); l0 = int(min(max(t * lines - n / 2, 0), lines - n)); a0 = rb * lr + l0 * samples * 2
        a = np.frombuffer(curl(url, (a0, a0 + n * samples * 2), timeout=600), '<i2').reshape(n, samples).astype(np.float32)
        ok = a > 0; lo, hi = np.percentile(a[ok], [0.5, 99.7]) if ok.any() else (0, 1); g8 = (np.clip((a - lo) / max(hi - lo, 1), 0, 1) * 255).astype(np.uint8)
        im = Image.fromarray(g8); im.resize((1200, max(1, int(1200 * n / samples))), Image.LANCZOS).save(f_w, quality=85)
        cx, cy = int(s * samples), int(t * lines) - l0; h = min(400, samples // 2, n // 2); cx, cy = min(max(cx, h), samples - h), min(max(cy, h), n - h)
        im.crop((cx - h, cy - h, cx + h, cy + h)).save(f_c, quality=88)
        json.dump(dict(lines=lines, samples=samples, first_line=l0, lines_read=n, centre_sample=cx, centre_line=cy + l0), open(os.path.join(out, name + '.json'), 'w'))
    j = json.load(open(os.path.join(out, name + '.json')))
    return dict(img=f'nac/{name}_centre.jpg', more=f'nac/{name}_wide.jpg', download=dict(type='CDRNAC4', id=p['ref'], bytes=it['bytes']),
                extra=f"Cut at full resolution, {j['samples'] and min(800, j['samples'])} px wide, around line {j['centre_line']:,} of {j['lines']:,}. The position inside the frame comes from its four corners, so it is good to a few hundred metres. Raw frames can be mirrored.")


def radar_preview(m, p, cdir):
    out = os.path.join(cdir, 'radar'); os.makedirs(out, exist_ok=True); f = os.path.join(out, p['ref'] + '.jpg')
    if not os.path.exists(f):
        src = os.path.join(CACHE, 'lrs', p['ref'] + '.img')
        for alt in (os.path.join(DATA, 'kaguya-lrs', p['ref'] + '.img'),):
            if os.path.exists(alt): src = alt
        if not os.path.exists(src): curl_to(f"https://data.darts.isas.jaxa.jp/pub/pds3/sln-l-lrs-5-sndr-ss-sar05-power-v1.0/{p['day']}/data/{p['ref']}.img", src)
        n = p['track']['n']; raw = np.fromfile(src, np.uint8); hdr = raw[:55 * n].reshape(n, 55); img = raw[55 * n:55 * n + 1000 * n].reshape(1000, n)
        lat = hdr[:, 29:33].copy().view('<f4')[:, 0]; b = m['bbox']; pad = max(b['north'] - b['south'], 1.5)
        cols = np.where((lat >= b['south'] - pad) & (lat <= b['north'] + pad))[0]
        if len(cols) < 2: raise IOError('track does not cross the box')
        c0, c1 = cols.min(), cols.max() + 1; seg = 255.0 - img[:, c0:c1]; lo, hi = np.percentile(seg, [2, 99.8])
        im = Image.fromarray((np.clip((seg - lo) / max(hi - lo, 1), 0, 1) * 255).astype(np.uint8)).resize((1200, 700), Image.LANCZOS).convert('RGB')
        d = ImageDraw.Draw(im); inside = np.where((lat[c0:c1] >= b['south']) & (lat[c0:c1] <= b['north']))[0]
        if len(inside):
            for x in (inside.min(), inside.max()): d.line([x / (c1 - c0) * 1200, 0, x / (c1 - c0) * 1200, 700], fill=(255, 60, 60), width=2)
        im.save(f, quality=85); os.makedirs(os.path.join(cdir, 'radar'), exist_ok=True)
    return dict(img=f"radar/{p['ref']}.jpg", extra='Across: distance along the orbit. Down: echo delay. The bright line is the surface; the red lines mark where the track enters and leaves the box.')


def xen_preview(m, p, cdir, i):
    rel = p['files'][i % len(p['files'])]; out = os.path.join(cdir, 'xenarch', os.path.basename(rel)); src = os.path.join(DATA, 'xenarch', rel)
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if os.path.exists(src): Image.open(src).save(out)
        else:
            h = hf_headers()
            if not h: raise IOError('Xenarch needs a Hugging Face login (huggingface-cli login) or HF_TOKEN')
            curl_to(HF + urllib.parse.quote(rel), out, headers=h, timeout=300)
    return dict(img='xenarch/' + os.path.basename(rel), n=len(p['files']), i=i % len(p['files']))


def fetch_products(cid, typ, pid):
    """Download the full files of one product (or a whole product type) into the capture folder."""
    cap_dir = os.path.join(CAPS, cid); items = [i for i in products(cap_dir, typ) or [] if pid in (None, i['id'])]
    st = dict(done=0, total=len(items), bytes=0, state='running', errors=[])
    with LOCK: JOBS.setdefault(cid, {})[f'{typ}:{pid or "all"}'] = st
    def one(it):
        for u in it['files']:
            try: p = os.path.join(cap_dir, typ.lower(), os.path.basename(u)); os.path.exists(p) or curl_to(u, p, timeout=7200); st['bytes'] += os.path.getsize(p)
            except Exception as ex: st['errors'].append(str(ex)[:120])
        st['done'] += 1
    with ThreadPoolExecutor(3) as ex: list(ex.map(one, items))
    if typ in ('TCORT', 'TCDTMM'):   # the download can take hours: start from the manifest as it is now, not as it was
        with capture_lock(cid):
            c = Capture.load(cid); c.m['notes'] = [n for n in c.m['notes'] if 'not on disk yet' not in n]; c.kaguya(); c.save()
    st['state'] = 'done'


# ---------------------------------------------------------------------- http
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=SITE, **k)
    def log_message(self, *a): pass

    def end_headers(self):   # always revalidate: a stale script or style sheet looks like a broken page
        self.send_header('Cache-Control', 'no-cache'); super().end_headers()

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def manifest(self, cid):
        if not re.fullmatch(r'tav-[\w-]+', cid): raise KeyError(cid)
        with LOCK: return json.load(open(os.path.join(CAPS, cid, 'manifest.json')))

    def translate_path(self, path):
        p = urllib.parse.unquote(path.split('?')[0])
        for prefix, base in (('/captures/', CAPS),):
            if p.startswith(prefix):
                full = os.path.realpath(os.path.join(base, p[len(prefix):]))
                return full if full.startswith(os.path.realpath(base) + os.sep) else os.path.join(SITE, '__none__')
        return super().translate_path(path)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query); parts = u.path.strip('/').split('/')
        try:
            if u.path == '/api/status': return self.send_json(dict(ok=True, root=ROOT, captures=CAPS, hf=bool(hf_headers()), index={n: os.path.exists(os.path.join(IDX, n)) for n in ('names.json', 'craters/index.json', 'lrs_tracks.json', 'xenarch.json')}))
            if u.path == '/api/captures':
                out = []
                for d in sorted(os.listdir(CAPS), reverse=True) if os.path.isdir(CAPS) else []:
                    try: m = self.manifest(d); out.append({k: m[k] for k in ('id', 'created', 'status', 'size_km', 'bbox', 'ring', 'shape')})
                    except Exception: pass
                return self.send_json(out)
            if len(parts) == 3 and parts[:2] == ['api', 'captures']: return self.send_json(dict(self.manifest(parts[2]), jobs=dict(JOBS.get(parts[2], {}))))
            if len(parts) == 5 and parts[:2] == ['api', 'captures'] and parts[3] == 'point':
                m = self.manifest(parts[2]); p = m['points'][int(parts[4])]; cdir = os.path.join(CAPS, parts[2])
                r = nac_preview(m, p, cdir) if p['kind'] == 'nac' else radar_preview(m, p, cdir) if p['kind'] == 'radar' else xen_preview(m, p, cdir, int(q.get('i', ['0'])[0]))
                return self.send_json(dict(r, title=p['title'], text=p['text'], kind=p['kind']))
        except Exception as ex:
            traceback.print_exc(); return self.send_json(dict(error=str(ex)[:300]), 500)
        if u.path.startswith('/api/'): return self.send_json(dict(error='not found'), 404)
        if u.path == '/favicon.ico': self.send_response(204); return self.end_headers()
        return super().do_GET()

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}'); parts = self.path.strip('/').split('/')
            if self.path == '/api/captures':
                ring = body['ring']
                if len(ring) < 3 or len(ring) > 200: raise ValueError('a box needs 3 to 200 corners')
                c = Capture(ring, 'polygon' if body.get('shape') == 'polygon' else 'rectangle', body.get('options'))
                if c.e - c.w > 180: raise ValueError('boxes across the 180° meridian are not supported yet')
                threading.Thread(target=c.run, daemon=True).start(); return self.send_json(dict(id=c.id))
            if self.path == '/api/plan': return self.send_json(plan(body['ring']))
            if len(parts) == 4 and parts[:2] == ['api', 'captures'] and parts[3] == 'mesh':
                self.manifest(parts[2]); threading.Thread(target=add_mesh, args=(parts[2],), daemon=True).start(); return self.send_json(dict(ok=True))
            if len(parts) == 4 and parts[:2] == ['api', 'captures'] and parts[3] == 'fetch':
                self.manifest(parts[2]); threading.Thread(target=fetch_products, args=(parts[2], body['type'], body.get('id')), daemon=True).start()
                return self.send_json(dict(ok=True, job=f"{body['type']}:{body.get('id') or 'all'}"))
            self.send_json(dict(error='not found'), 404)
        except Exception as ex:
            traceback.print_exc(); self.send_json(dict(error=str(ex)[:300]), 400)


if __name__ == '__main__':
    os.makedirs(CAPS, exist_ok=True); port = int(os.environ.get('PORT', '8060'))
    print(f'Tav · http://127.0.0.1:{port}/tav-app.html  (captures in {CAPS})', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
