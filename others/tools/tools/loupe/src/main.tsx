import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { makeQueryClient } from './data/queryClient.ts';
import { router } from './router.tsx';
import { AuthGate } from './auth/AuthGate.tsx';
import { isUrlError } from './screens/ErrorScreens.tsx';
import './index.css';
import './settings/appearance.ts';
import './design/index.ts';

const queryClient = makeQueryClient();
createRoot(document.getElementById('root') as HTMLElement, {
  onCaughtError: (e) => { if (!isUrlError(e)) console.error(e); },
}).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <RouterProvider router={router} />
      </AuthGate>
    </QueryClientProvider>
  </StrictMode>,
);
