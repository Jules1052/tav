#!/usr/bin/env python3
"""Build the small lookup tables Tav needs (run once; needs numpy, pillow, pyshp).

  python tav/build_index.py [names|pits|xenarch|craters|geology|--lrs …]   (no argument: all but --lrs)

Reads the catalogues in data/tav/ and writes site/index/ (served with the site, so a static host has it too):
  names.json      IAU names (lat, lon, diameter, type)
  pits.json       Lunar Pit Atlas
  xenarch.json    Xenarch points: hardware sites, OHRC tiles, NAC terrain tiles
  craters/        Robbins craters in 10° tiles of float32 [lat, lon, diameter_km] (+ index.json)
  geology.png     geologic unit code per pixel, 16 px/deg  (+ geology.json legend)
  lrs_tracks.json Kaguya radar sounder tracks (only with --lrs: fetches 2,579 labels from JAXA)
"""
import csv, glob, json, os, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D, OUT = os.path.join(ROOT, 'data', 'tav'), os.path.join(ROOT, 'site', 'index')
os.makedirs(OUT, exist_ok=True)
w180 = lambda lon: ((float(lon) + 180) % 360) - 180


def names():
    import shapefile
    r = shapefile.Reader(glob.glob(D + '/gazetteer/extracted/*.shp')[0])
    out = [[x['name'], x['type'].split(',')[0], round(x['center_lat'], 4), round(w180(x['center_lon']), 4), round(x['diameter'], 1)]
           for x in (rec.as_dict() for rec in r.records())]
    json.dump(out, open(OUT + '/names.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    print('names', len(out))


def pits():
    rows = list(csv.DictReader(open(D + '/pit-atlas/pits.csv')))
    out = [dict(name=p['Name'], host=p['Host Feat.'], lat=float(p['Lat.']), lon=w180(p['Long.']),
                depth_m=p['Depth (m)'], inner_m=p['Inner Max Diam. (m)'], funnel_m=p['Funnel Max Diam. (m)']) for p in rows]
    json.dump(out, open(OUT + '/pits.json', 'w'), separators=(',', ':'))
    print('pits', len(out))


CRATER_DEG = 10


def craters():
    """Robbins craters of 1 km or more, cut into 10° tiles so the browser loads only the ones a box touches.
    Source: the USGS release (a zip holding one CSV), saved as data/tav/crater-database/*.zip, from
    https://astrogeology.usgs.gov/search/map/Moon/Research/Craters/lunar_crater_database_robbins_2018
    Each tile craters/<south>_<west>.bin is float32 little-endian [lat, lon (−180…180), diameter_km] per crater,
    largest first (ties by lat, then lon); craters/index.json lists the tiles and their counts."""
    import io, zipfile
    with zipfile.ZipFile(glob.glob(D + '/crater-database/*.zip')[0]) as z:
        name = next(n for n in z.namelist() if os.path.basename(n).startswith('lunar_crater_database') and n.endswith('.csv'))
        with io.TextIOWrapper(z.open(name), 'utf-8') as f:
            r = csv.reader(f); h = next(r); i, j, k = h.index('LAT_CIRC_IMG'), h.index('LON_CIRC_IMG'), h.index('DIAM_CIRC_IMG')
            a = np.array([(float(x[i]), float(x[j]), float(x[k])) for x in r], np.float64)
    a[:, 1] = (a[:, 1] + 180) % 360 - 180; a = a.astype(np.float32)
    d = CRATER_DEG; south = np.clip(np.floor(a[:, 0] / d) * d, -90, 90 - d).astype(int); west = np.clip(np.floor(a[:, 1] / d) * d, -180, 180 - d).astype(int)
    out = os.path.join(OUT, 'craters'); os.makedirs(out, exist_ok=True)
    for f in glob.glob(out + '/*.bin'): os.remove(f)
    tiles = {}
    for s, w in sorted(set(zip(south.tolist(), west.tolist()))):
        t = a[(south == s) & (west == w)]; t = t[np.lexsort((t[:, 1], t[:, 0], -t[:, 2]))]
        t.astype('<f4').tofile(os.path.join(out, f'{s}_{w}.bin')); tiles[f'{s}_{w}'] = len(t)
    json.dump(dict(deg=d, record=['lat', 'lon', 'diameter_km'], dtype='float32 little-endian', order='largest first',
                   count=len(a), tiles=tiles, source='Robbins (2019) lunar crater database, craters of 1 km or more, USGS release 2018'),
              open(os.path.join(out, 'index.json'), 'w'), separators=(',', ':'))
    print('craters', len(a), 'in', len(tiles), 'tiles')


def geology():
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    t = glob.glob(D + '/geologic-map/extracted/*RASTER/numerical_versions/*.tif')[0]
    im = Image.open(t); print('geology raster', im.size, im.mode)
    im.resize((5760, 2880), Image.NEAREST).save(OUT + '/geology.png', optimize=True)
    leg = {r['DN']: dict(unit=r['Unit'], name=r['Unit_Name'], age=r['Unit_Age'], color=r['GeologyUnit_color_hex'])
           for r in csv.DictReader(open(glob.glob(D + '/geologic-map/extracted/*RASTER/*.csv')[0]))}
    json.dump(leg, open(OUT + '/geology.json', 'w'), indent=0); print('geology units', len(leg))


def xenarch():
    X = D + '/xenarch'; pts = []
    sites = list(csv.DictReader(open(X + '/human-hardware_ground-truth/derived/sites_moon-mars.csv')))
    crops = {}
    for r in csv.DictReader(open(X + '/human-hardware_ground-truth/crops_lroc-nac_hirise/metadata.csv')):
        crops.setdefault(r['site_id'], []).append(r)
    for s in sites:
        if s['body'] != 'Moon' or s['site_id'] not in crops: continue
        c = crops[s['site_id']]
        pts.append(dict(kind='hardware', lat=float(s['lat']), lon=w180(s['lon_east']), title=s['object'],
                        text=f"{s['mission']}, arrived {s['arrival_utc_date']}. {len(c)} NAC crops in Xenarch, best {s['best_resolution_m_px']} m per pixel.",
                        files=['human-hardware_ground-truth/crops_lroc-nac_hirise/' + x['file_name'] for x in c]))
    for sub, kind, label in (('moon_chandrayaan2-ohrc', 'ohrc', 'Chandrayaan-2 OHRC tile'), ('moon_lroc-nac', 'terrain', 'NAC terrain tile')):
        p = f'{X}/natural-terrain_training/{sub}/metadata.csv'
        if not os.path.exists(p): continue
        groups = {}
        for r in csv.DictReader(open(p)):
            key = (r['frame_id'], r['lat'], r['lon_east']) if kind == 'terrain' else (r['file_name'],)
            groups.setdefault(key, []).append(r)
        for rs in groups.values():
            r = rs[0]
            pts.append(dict(kind=kind, lat=float(r['lat']), lon=w180(r['lon_east']),
                            title=f"{label}, {r['target'] if kind == 'terrain' else r['frame_id'][:27]}",
                            text=f"{r['instrument']}, {r['utc_start'][:10]}, {r['resolution_m_px']} m per pixel, {r['landform'].replace('_', ' ')}. {len(rs)} tile{'s' if len(rs) > 1 else ''} of 1,024 px.",
                            files=[f'natural-terrain_training/{sub}/' + x['file_name'] for x in rs]))
    json.dump(pts, open(OUT + '/xenarch.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    import collections; print('xenarch', collections.Counter(p['kind'] for p in pts))


def lrs():
    B = 'https://data.darts.isas.jaxa.jp/pub/pds3/sln-l-lrs-5-sndr-ss-sar05-power-v1.0/'
    get = lambda u: urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'tav'}), timeout=60).read().decode('latin-1')
    days = re.findall(r'href="(\d{8})/"', get(B)); print('lrs days', len(days))
    def day(d):
        try: return [f'{d}/data/{x}' for x in set(re.findall(r'href="(LRS_SAR05KM_\d+\.lbl)"', get(f'{B}{d}/data/')))]
        except Exception: return []
    def lab(p):
        for _ in range(3):
            try:
                t = get(B + p); g = lambda k: float(re.search(k + r'\s*=\s*([-\d.]+)', t).group(1))
                return dict(id=os.path.basename(p)[:-4], day=p[:8], lat0=g('START_SUB_SPACECRAFT_LATITUDE'), lat1=g('STOP_SUB_SPACECRAFT_LATITUDE'),
                            lon0=round(w180(g('START_SUB_SPACECRAFT_LONGITUDE')), 3), lon1=round(w180(g('STOP_SUB_SPACECRAFT_LONGITUDE')), 3),
                            n=int(re.search(r'LINE_SAMPLES\s*=\s*(\d+)', t).group(1)))
            except Exception: pass
    with ThreadPoolExecutor(16) as ex:
        labels = [x for l in ex.map(day, days) for x in l]; print('lrs labels', len(labels))
        tr = [t for t in ex.map(lab, labels) if t]
    json.dump(tr, open(OUT + '/lrs_tracks.json', 'w'), separators=(',', ':')); print('lrs tracks', len(tr))


if __name__ == '__main__':
    steps = dict(names=names, pits=pits, xenarch=xenarch, craters=craters, geology=geology, lrs=lrs)
    for a in [a.lstrip('-') for a in sys.argv[1:]] or ['names', 'pits', 'xenarch', 'craters', 'geology']: steps[a]()
