/* Contour reveal: the background lines near the cursor take the four inks (.contour-glow in style.css).
 * Text blocks sit on black, so the lines never run under words. Mouse and pen only.
 */
(() => {
  const R = 300, TILE = 1200;                    // disc radius; width of the contour stencil, centred on the page
  const glow = document.createElement('div');
  glow.className = 'contour-glow'; glow.setAttribute('aria-hidden', 'true');
  glow.innerHTML = '<i></i><i></i><b><i></i></b>';
  document.body.append(glow);
  let x = 0, y = 0, queued = false;
  const place = () => {
    queued = false;
    const set = (name, value) => glow.style.setProperty(name, value + 'px');
    set('--mx', x); set('--my', y);
    set('--ox', document.documentElement.clientWidth / 2 - TILE / 2 - (x - R)); set('--oy', -(y - R));
    glow.style.opacity = 1;
  };
  addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    x = e.clientX; y = e.clientY;
    if (!queued) { queued = true; requestAnimationFrame(place); }
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { glow.style.opacity = 0; });
})();
