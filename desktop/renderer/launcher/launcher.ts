import '@/ui/theme.css';
import './launcher.css';
import type { DesktopMode, LauncherState, SnapflowDesktopApi } from '../../shared/ipc';

declare global {
  interface Window {
    snapflowDesktop: SnapflowDesktopApi;
  }
}

const TILES: Array<{ mode: DesktopMode; title: string; sub: string }> = [
  { mode: 'region', title: 'Region', sub: 'Drag a rectangle anywhere on screen' },
  { mode: 'scrolling', title: 'Scrolling region', sub: 'Scrolls the window under the area and stitches it' },
  { mode: 'screen', title: 'Full screen', sub: 'The display your mouse is on' },
  { mode: 'window', title: 'Window', sub: 'Pick an open window' },
];

const grid = document.getElementById('grid') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLParagraphElement;
const buttons = new Map<DesktopMode, HTMLButtonElement>();

for (const t of TILES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile';
  b.dataset.mode = t.mode;
  b.innerHTML = '<strong></strong><span></span><kbd hidden></kbd>';
  (b.querySelector('strong') as HTMLElement).textContent = t.title;
  (b.querySelector('span') as HTMLElement).textContent = t.sub;
  b.addEventListener('click', () => void window.snapflowDesktop.invoke('capture:start', t.mode));
  grid.appendChild(b);
  buttons.set(t.mode, b);
}

const pretty = (accel: string): string => accel.replace('CommandOrControl', 'Ctrl');

function render(state: LauncherState): void {
  const failed: string[] = [];
  for (const h of state.hotkeys) {
    const kbd = buttons.get(h.mode)?.querySelector('kbd') as HTMLElement | null;
    if (!kbd) continue;
    kbd.hidden = !h.registered;
    kbd.textContent = pretty(h.accelerator);
    if (!h.registered) failed.push(pretty(h.accelerator));
  }
  for (const b of buttons.values()) b.disabled = state.busy;
  hint.textContent = failed.length
    ? `Shortcut already used by another app: ${failed.join(', ')}.`
    : 'SnapFlow keeps running in the system tray. Close this window any time.';
}

window.snapflowDesktop.on('launcher:update', (s) => render(s as LauncherState));
void window.snapflowDesktop.invoke<LauncherState>('app:info').then(render);
document.getElementById('history')?.addEventListener('click', () => void window.snapflowDesktop.invoke('history:open'));
document.getElementById('settings')?.addEventListener('click', () => void window.snapflowDesktop.invoke('settings:open'));
