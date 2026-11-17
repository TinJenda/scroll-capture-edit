// Shared by the fixture pages: deterministic, unique colour per band so tests can verify order & alignment.
window.bandColor = (i) => [(i * 6) % 256, (255 - i * 6 + 256) % 256, (i * 37) % 256];
window.bandCss = (i) => `rgb(${window.bandColor(i).join(',')})`;
window.makeBands = (parent, n, h, label = true) => {
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'b';
    d.id = 'b' + i;
    d.style.cssText = `height:${h}px;background:${window.bandCss(i)};display:flex;align-items:center;justify-content:center;font:700 28px system-ui;color:#fff;`;
    if (label) d.textContent = 'Band ' + i;
    parent.appendChild(d);
  }
};
window.param = (k, d) => +(new URLSearchParams(location.search).get(k) ?? d);
