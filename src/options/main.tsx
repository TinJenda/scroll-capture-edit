import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/ui/theme.css';
import './options.css';
import { ToastProvider } from '@/ui/hooks';
import { Options } from './Options';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ToastProvider>
      <Options />
    </ToastProvider>
  </StrictMode>,
);
