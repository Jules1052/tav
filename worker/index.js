// Tav on Cloudflare: the site in site/ is served as static assets (free, unlimited); this script only runs for /proxy.
//
// The archives below send no CORS header, so a page cannot read them directly. The web version (site/tav-web.js)
// asks this proxy instead:   POST /proxy?url=<file URL>   body: byte ranges, inclusive, e.g. "0-99,4000-4999"
// The answer is the archive's own 206 (multipart/byteranges when several ranges). A server that ignores the ranges
// would send the whole file, so that is refused with 416 and the page falls back to one range per request.
const HOSTS = new Set(['pds-geosciences.wustl.edu', 'pds.lroc.im-ldi.com', 'pds.mcp.nasa.gov']);
const RANGES = /^\d+-\d+(,\d+-\d+)*$/;

const fail = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== '/proxy') return fail(404, 'not found');
    if (req.method !== 'POST') return fail(405, 'use POST');
    // browsers say where a request comes from: only this site's own pages may use the proxy
    const site = req.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin') return fail(403, 'only pages of this site may use the proxy');
    let target;
    try { target = new URL(u.searchParams.get('url') || ''); } catch { return fail(400, 'bad url'); }
    if (target.protocol !== 'https:' || !HOSTS.has(target.hostname)) return fail(403, 'archive not allowed: ' + target.hostname);
    const ranges = (await req.text()).trim();
    if (ranges.length > 16000 || !RANGES.test(ranges)) return fail(400, 'bad byte ranges');

    const up = await fetch(target, { headers: { range: 'bytes=' + ranges, 'user-agent': 'tav-web/1' }, redirect: 'follow' });
    if (up.status !== 206) {
      if (up.body) up.body.cancel();
      return up.status === 200 ? fail(416, 'ranges ignored') : fail(502, 'the archive answered ' + up.status);
    }
    const h = new Headers({ 'cache-control': 'no-store' });
    for (const k of ['content-type', 'content-range', 'content-length']) { const v = up.headers.get(k); if (v) h.set(k, v); }
    return new Response(up.body, { status: 206, headers: h });
  },
};
