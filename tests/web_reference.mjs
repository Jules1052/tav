// The reference cases of tests/reference.py, captured by the web version in a real browser and checked with it.
//
//   npm run test:web [CASE…]
//
// Starts `wrangler dev` (the site and the proxy, as on Cloudflare), drives Chromium headless, saves each capture
// as a .zip and runs `tests/reference.py check` on it. Environment: PYTHON (a Python with numpy and Pillow,
// default python3), CHROMIUM (the browser, default /Applications/Chromium.app), PORT (default 8788).
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))), REF = path.join(ROOT, 'tests', 'reference');
const PY = process.env.PYTHON || 'python3', PORT = +(process.env.PORT || 8788);
const BROWSER = process.env.CHROMIUM || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const cases = process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync(REF).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();

const dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; dev.stdout.on('data', d => { log += d; }); dev.stderr.on('data', d => { log += d; });
const base = `http://localhost:${PORT}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(base + '/tav-app.html')).ok) break; } catch { /* not up yet */ }
  if (i > 90) { console.error('wrangler dev did not start:\n' + log); dev.kill(); process.exit(2); }
  await new Promise(r => setTimeout(r, 1000));
}

const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.error('   page error:', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('   console:', m.text()); });
await page.goto(base + '/tav-app.html');
await page.waitForFunction(() => window.TavWeb);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tav-web-')); let failed = 0;
for (const c of cases) {
  const req = JSON.parse(fs.readFileSync(path.join(REF, c + '.json'), 'utf8')).request, t = Date.now();
  const got = await page.evaluate(async r => {
    const { id } = await TavWeb.api('/api/captures', r), m = await TavWeb.done(id), z = new Uint8Array(await (await TavWeb.zip(id)).arrayBuffer());
    let s = ''; for (let i = 0; i < z.length; i += 32768) s += String.fromCharCode.apply(null, z.subarray(i, i + 32768));
    return { id, zip: btoa(s), bad: m.steps.filter(x => !x.ok).map(x => x.name + ': ' + x.error) };
  }, req);
  const zipPath = path.join(tmp, got.id + '.zip'); fs.writeFileSync(zipPath, Buffer.from(got.zip, 'base64'));
  spawnSync(PY, ['-I', '-m', 'zipfile', '-e', zipPath, tmp]);
  const r = spawnSync(PY, [path.join(ROOT, 'tests', 'reference.py'), 'check', c, path.join(tmp, got.id)], { encoding: 'utf8' });
  process.stdout.write(r.stdout + r.stderr + `   (${((Date.now() - t) / 1000).toFixed(1)} s in the browser${got.bad.length ? '; failed steps: ' + got.bad.join(' | ') : ''})\n`);
  if (r.status !== 0) failed++;
}
await browser.close(); dev.kill();
console.log(failed ? `${failed} of ${cases.length} cases failed` : `all ${cases.length} cases pass`);
process.exit(failed ? 1 : 0);
