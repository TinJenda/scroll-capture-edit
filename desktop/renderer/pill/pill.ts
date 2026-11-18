import type { PillUpdate, SnapflowDesktopApi } from '../../shared/ipc';

declare global {
  interface Window {
    snapflowDesktop: SnapflowDesktopApi;
  }
}

const main = document.getElementById('main') as HTMLSpanElement;
const note = document.getElementById('note') as HTMLElement;

window.snapflowDesktop.on('pill:update', (raw) => {
  const u = raw as PillUpdate;
  main.textContent = `Scrolling… ${u.frames} frame${u.frames === 1 ? '' : 's'} · ${u.height.toLocaleString()} px`;
  note.textContent = u.note;
});
document.getElementById('stop')?.addEventListener('click', () => window.snapflowDesktop.send('pill:stop'));
document.getElementById('discard')?.addEventListener('click', () => window.snapflowDesktop.send('pill:discard'));
