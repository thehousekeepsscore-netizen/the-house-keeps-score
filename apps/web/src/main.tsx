import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { AuthProvider } from './lib/auth-context';
import { ResourceCacheProvider } from './lib/resource-cache';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
      ResourceCacheProvider sits inside AuthProvider (it wipes the cache when the
      authenticated identity changes) and outside App (whose viewState switch
      destroys screens on navigation — the whole point is to outlive that).
    */}
    <AuthProvider>
      <ResourceCacheProvider>
        <App />
      </ResourceCacheProvider>
    </AuthProvider>
  </StrictMode>,
);
