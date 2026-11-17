import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/ui/theme.css';
import './preview.css';
import { ToastProvider } from '@/ui/hooks';
import { Preview } from './Preview';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ToastProvider>
      <Preview />
    </ToastProvider>
  </StrictMode>,
);
