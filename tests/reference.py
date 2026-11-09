#!/usr/bin/env python3
"""Reference captures: fixed boxes whose output every Tav implementation must reproduce.

  python tests/reference.py record [CASE…]     capture each case with the Python server code and store the result
  python tests/reference.py run [CASE…]        capture again and compare with what is stored
  python tests/reference.py check CASE DIR     compare a capture folder made by any implementation (the browser version, say)

What must match: the size and bounds of every layer and its data, read back from the GeoTIFF, exactly (a polygon
keeps the cells whose centre is inside it, in both versions); the vector features; the geologic units; the mesh;
the radar and Xenarch points. The imagery is compared on a
32×32 thumbnail (correlation ≥ 0.9), so re-encoding passes and a shift of 3% of the picture does not.
What may change: the archive listings (catalogue counts, NAC points) grow as new products are published, so a
difference there is only a warning. Kaguya TC layers depend on tiles already on disk and are left out.
Needs numpy and Pillow.
"""
import json, os, sys, tempfile
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); REF = os.path.join(HERE, 'reference')

CASES = {
    'marius-pit': dict(ring=[[14.0, -56.9], [14.2, -56.9], [14.2, -56.7], [14.0, -56.7]], shape='rectangle', options=dict(max_px=512)),   # the README box
    'marius-polygon': dict(ring=[[13.9, -57.0], [14.3, -56.95], [14.25, -56.6], [14.05, -56.55], [13.95, -56.75]], shape='polygon', options=dict(max_px=512)),
    'apollo-11': dict(ring=[[0.5, 23.3], [0.9, 23.3], [0.9, 23.7], [0.5, 23.7]], shape='rectangle', options=dict(max_px=512)),          # east longitudes, hardware points
    'four-tiles': dict(ring=[[27.5, -47.5], [32.5, -47.5], [32.5, -42.5], [27.5, -42.5]], shape='rectangle', options=dict(max_px=256)),  # SLDEM tile corner, decimated reads
    'north-polar': dict(ring=[[75.0, 10.0], [77.0, 10.0], [77.0, 16.0], [75.0, 16.0]], shape='rectangle', options=dict(max_px=256)),    # LOLA elevation, no Diviner
}
KAGUYA = {'imagery_tc', 'elevation_tc'}


def summarize(d):
    """What a capture folder holds, in a form two implementations can be compared on, plus its data grids."""
    m = json.load(open(os.path.join(d, 'manifest.json'))); grids = {}
    s = dict(shape=m['shape'], bbox=m['bbox'], size_km=m['size_km'], layers={}, features={}, geology=None, mesh=None, points=[],
             nac_points=(m.get('point_counts') or {}).get('nac', 0), catalogue={c['type']: c['count'] for c in m['catalogue']})
    for l in m['layers']:
        if l['key'] in KAGUYA: continue
        s['layers'][l['key']] = e = {k: l.get(k) for k in ('file', 'unit', 'px', 'bounds', 'data_bounds', 'm_px', 'native_m_px', 'coverage_pct', 'min', 'max', 'mean')}
        p = os.path.join(d, l['file'])
        if p.endswith('.tif'): grids[l['key']] = np.array(Image.open(p), np.float32)
        else: e['thumb'] = np.asarray(Image.open(p).convert('L').resize((32, 32), Image.BOX), float).round(1).tolist()
    for v in m['vectors']:
        f = json.load(open(os.path.join(d, v['file'])))
        if v['key'] == 'geology': s['geology'] = f
        else: s['features'][v['key']] = sorted(json.dumps([x['geometry']['coordinates'], x['properties']], sort_keys=True) for x in f['features'])
    if m.get('mesh'): s['mesh'] = {k: m['mesh'].get(k) for k in ('vertices', 'relief_m', 'width_m', 'height_m', 'source')}
    s['points'] = sorted(json.dumps([p['kind'], round(p['lat'], 5), round(p['lon'], 5), p['title']]) for p in m['points'] if p['kind'] != 'nac')
    return s, grids


def canon(s):
    """A feature or point as JSON text with every number a float: JavaScript writes 0 where Python writes 0.0."""
    f = lambda x: {k: f(v) for k, v in x.items()} if isinstance(x, dict) else [f(v) for v in x] if isinstance(x, list) \
        else float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else x
    return json.dumps(f(json.loads(s)), sort_keys=True)


def compare(exp, eg, got, gg):
    fails, warns = [], []
    close = lambda a, b, tol: a is not None and b is not None and abs(a - b) <= tol
    for k in ('shape', 'bbox', 'size_km'):
        if exp[k] != got[k]: fails.append(f'{k}: expected {exp[k]}, got {got[k]}')
    for key in sorted(set(exp['layers']) | set(got['layers'])):
        e, g = exp['layers'].get(key), got['layers'].get(key)
        if not (e and g): fails.append(f'layer {key}: ' + ('missing' if e else 'not expected')); continue
        for k in ('file', 'unit', 'px', 'm_px', 'native_m_px'):
            if e[k] != g[k]: fails.append(f'layer {key}: {k} is {g[k]}, expected {e[k]}')
        for k in ('bounds', 'data_bounds'):
            if (e[k] is None) != (g[k] is None) or e[k] is not None and not np.allclose(e[k], g[k], rtol=0, atol=1e-9): fails.append(f'layer {key}: {k} is {g[k]}, expected {e[k]}')
        if 'thumb' in e:   # mare is flat, so the mean barely moves when the picture is shifted: the correlation catches that
            a, b = np.array(e['thumb']).ravel(), np.array(g.get('thumb', np.zeros((32, 32)))).ravel()
            d, r = float(np.abs(a - b).mean()), float(np.corrcoef(a, b)[0, 1]) if a.std() and b.std() else 0.0
            if not (d <= 3 and r >= 0.9): fails.append(f'layer {key}: the picture differs (32×32 thumbnail: mean difference {d:.1f} grey levels, correlation {r:.3f})')
        if key in eg:
            a, b = eg[key], gg.get(key)
            if b is None or a.shape != b.shape: fails.append(f'layer {key}: grid {None if b is None else b.shape}, expected {a.shape}'); continue
            fa, fb = np.isfinite(a), np.isfinite(b); odd = fa != fb
            if odd.any(): fails.append(f'layer {key}: {int(odd.sum())} cells differ in having data')
            both = fa & fb
            if both.any():
                err = float((np.abs(a[both] - b[both]) / np.maximum(1, np.abs(a[both]))).max())
                if err > 1e-6: fails.append(f'layer {key}: values differ (worst relative difference {err:.2e})')
            for k in ('min', 'max', 'mean'):   # rounded to 3 decimals
                if not close(e[k], g[k], 1e-3 + 1e-6 * abs(e[k])): fails.append(f'layer {key}: {k} is {g[k]}, expected {e[k]}')
            if not close(e['coverage_pct'], g['coverage_pct'], 0.1): fails.append(f"layer {key}: coverage {g['coverage_pct']}%, expected {e['coverage_pct']}%")
    for key in sorted(set(exp['features']) | set(got['features'])):
        a, b = set(map(canon, exp['features'].get(key, []))), set(map(canon, got['features'].get(key, [])))
        if a != b: fails.append(f'{key}: {len(a - b)} features missing, {len(b - a)} not expected' + (f', e.g. {sorted(a ^ b)[0][:120]}' if a ^ b else ''))
    ge, gg_ = exp['geology'] or [], got['geology'] or []
    if [{k: v for k, v in u.items() if k != 'pct'} for u in ge] != [{k: v for k, v in u.items() if k != 'pct'} for u in gg_] \
            or any(abs(x['pct'] - y['pct']) > 0.15 for x, y in zip(ge, gg_)): fails.append('geology: the units differ')
    me, mg = exp['mesh'], got['mesh']
    if any('Kaguya' in ((x or {}).get('source') or '') for x in (me, mg)): warns.append('mesh: built from Kaguya tiles on disk, not compared')
    elif bool(me) != bool(mg): fails.append('mesh: ' + ('missing' if me else 'not expected'))
    elif me:
        if me['vertices'] != mg['vertices']: fails.append(f"mesh: {mg['vertices']} vertices, expected {me['vertices']}")
        if not close(me['relief_m'], mg['relief_m'], 0.1): fails.append(f"mesh: relief {mg['relief_m']} m, expected {me['relief_m']} m")
        if not (close(me['width_m'], mg['width_m'], 0.01) and close(me['height_m'], mg['height_m'], 0.01)): fails.append('mesh: size differs')
    a, b = set(map(canon, exp['points'])), set(map(canon, got['points']))
    if a != b: fails.append(f'points: {len(a - b)} missing, {len(b - a)} not expected' + (f', e.g. {sorted(a ^ b)[0]}' if a ^ b else ''))
    if exp['nac_points'] != got['nac_points']: warns.append(f"NAC points: {got['nac_points']}, {exp['nac_points']} when recorded (the archive changes)")
    for t in sorted(set(exp['catalogue']) | set(got['catalogue'])):
        if exp['catalogue'].get(t) != got['catalogue'].get(t): warns.append(f"catalogue {t}: {got['catalogue'].get(t)}, {exp['catalogue'].get(t)} when recorded")
    return fails, warns


def load(case):
    with open(os.path.join(REF, case + '.json')) as f: exp = json.load(f)['expected']
    with np.load(os.path.join(REF, case + '.npz')) as z: return exp, {k: z[k] for k in z.files}


def report(case, fails, warns):
    print(f"{case:16s} {'FAIL' if fails else 'pass'}" + (f'  ({len(warns)} warning{"s" * (len(warns) != 1)})' if warns else ''))
    for x in fails: print('   ✗', x)
    for x in warns: print('   -', x)
    return not fails


def capture(case, root):
    sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'tav')); import server
    server.CAPS = root; c = CASES[case]; cap = server.Capture(c['ring'], c['shape'], c['options']); cap.run()
    bad = [s for s in cap.m['steps'] if not s['ok']]
    if bad: raise RuntimeError(f"{case}: step '{bad[0]['name']}' failed: {bad[0]['error']}")
    return cap.dir


def main(argv):
    cmd, args = (argv[0] if argv else ''), argv[1:]
    if cmd == 'check' and len(args) == 2:
        exp, eg = load(args[0]); got, gg = summarize(args[1]); return 0 if report(args[0], *compare(exp, eg, got, gg)) else 1
    if cmd not in ('record', 'run') or any(a not in CASES for a in args): print(__doc__); return 2
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        for case in args or CASES:
            d = capture(case, tmp); got, grids = summarize(d)
            if cmd == 'record':
                os.makedirs(REF, exist_ok=True)
                json.dump(dict(request=CASES[case], expected=got), open(os.path.join(REF, case + '.json'), 'w'), indent=1, ensure_ascii=False)
                np.savez_compressed(os.path.join(REF, case + '.npz'), **grids); print(f'{case:16s} recorded: {", ".join(got["layers"])}')
            else:
                exp, eg = load(case); ok &= report(case, *compare(exp, eg, got, grids))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
