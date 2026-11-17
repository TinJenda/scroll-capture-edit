import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/ui/theme.css';
import './editor.css';
import { ToastProvider } from '@/ui/hooks';
import { Editor } from './Editor';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ToastProvider>
      <Editor />
    </ToastProvider>
  </StrictMode>,
);
