import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/ui/theme.css';
import './history.css';
import { ToastProvider } from '@/ui/hooks';
import { History } from './History';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ToastProvider>
      <History />
    </ToastProvider>
  </StrictMode>,
);
