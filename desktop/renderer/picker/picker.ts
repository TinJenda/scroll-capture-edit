import '@/ui/theme.css';
import './picker.css';
import type { PickerWindow, SnapflowDesktopApi } from '../../shared/ipc';

declare global {
  interface Window {
    snapflowDesktop: SnapflowDesktopApi;
  }
}

const grid = document.getElementById('grid') as HTMLDivElement;
const status = document.getElementById('status') as HTMLParagraphElement;

window.snapflowDesktop.invoke<PickerWindow[]>('picker:list').then((list) => {
  status.textContent = list.length ? 'Click a window. Esc cancels.' : 'No windows found.';
  for (const w of list) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset.name = w.name;
    card.innerHTML = '<div class="thumb"><img alt="" /></div><div class="name"></div>';
    (card.querySelector('img') as HTMLImageElement).src = w.thumbnail;
    (card.querySelector('.name') as HTMLElement).textContent = w.name;
    card.addEventListener('click', () => window.snapflowDesktop.send('picker:choose', { id: w.id, name: w.name }));
    grid.appendChild(card);
  }
  (grid.firstElementChild as HTMLElement | null)?.focus();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.snapflowDesktop.send('picker:cancel');
});
