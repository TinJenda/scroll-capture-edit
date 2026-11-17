// Tiny static server for the E2E fixture pages. `/img/:n.svg?delay=ms` serves solid-colour SVGs
// with an artificial delay so lazy-loading behaviour can be tested.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const PORT = 4173;

export const bandColor = (i) => [(i * 6) % 256, (((255 - i * 6) % 256) + 256) % 256, (i * 37) % 256];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  const img = /^\/img\/(\d+)\.svg$/.exec(url.pathname);
  if (img) {
    const [r, g, b] = bandColor(Number(img[1]));
    const delay = Number(url.searchParams.get('delay') ?? 120);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="rgb(${r},${g},${b})"/></svg>`);
    }, delay);
    return;
  }
  const file = path.join(root, path.normalize(url.pathname === '/' ? '/long.html' : url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/plain', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`fixtures on http://127.0.0.1:${PORT}`));
