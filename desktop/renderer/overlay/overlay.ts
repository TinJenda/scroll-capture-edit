import type { OverlayDone, SnapflowDesktopApi } from '../../shared/ipc';

declare global {
  interface Window {
    snapflowDesktop: SnapflowDesktopApi;
  }
}

const params = new URLSearchParams(location.search);
type Mode = 'region' | 'scrolling';
let mode: Mode = params.get('mode') === 'scrolling' ? 'scrolling' : 'region';

const shot = document.getElementById('shot') as HTMLImageElement;
const sel = document.getElementById('sel') as HTMLDivElement;
const dims = document.getElementById('dims') as HTMLSpanElement;
const modeLabel = document.getElementById('modeLabel') as HTMLSpanElement;

shot.src = params.get('shot') ?? '';

function renderMode(): void {
  modeLabel.textContent =
    mode === 'region' ? 'Drag to capture a region' : 'Drag over the area to scroll-capture (it must stay visible)';
  sel.classList.toggle('scrolling', mode === 'scrolling');
}
renderMode();

let start: { x: number; y: number } | null = null;
let rect = { x: 0, y: 0, width: 0, height: 0 };

function paint(): void {
  sel.hidden = rect.width < 1 && rect.height < 1;
  sel.style.left = `${rect.x}px`;
  sel.style.top = `${rect.y}px`;
  sel.style.width = `${rect.width}px`;
  sel.style.height = `${rect.height}px`;
  sel.classList.toggle('near-top', rect.y < 34);
  dims.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  document.body.classList.toggle('has-selection', !sel.hidden);
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) {
    cancel();
    return;
  }
  start = { x: e.clientX, y: e.clientY };
  rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 };
  document.body.classList.add('dragging');
  paint();
});

window.addEventListener('mousemove', (e) => {
  if (!start) return;
  const x = Math.max(0, Math.min(e.clientX, innerWidth));
  const y = Math.max(0, Math.min(e.clientY, innerHeight));
  rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
  paint();
});

window.addEventListener('mouseup', (e) => {
  if (!start || e.button !== 0) return;
  start = null;
  document.body.classList.remove('dragging');
  if (rect.width < 8 || rect.height < 8) {
    rect = { x: 0, y: 0, width: 0, height: 0 };
    paint();
    return;
  }
  const done: OverlayDone = { mode, rect };
  window.snapflowDesktop.send('overlay:done', done);
});

function cancel(): void {
  window.snapflowDesktop.send('overlay:cancel');
}

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'escape') cancel();
  else if (k === 'r') {
    mode = 'region';
    renderMode();
  } else if (k === 's') {
    mode = 'scrolling';
    renderMode();
  }
});
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  cancel();
});
