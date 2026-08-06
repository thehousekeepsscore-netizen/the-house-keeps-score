import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import { AuthProvider } from './lib/auth-context';
import { ResourceCacheProvider } from './lib/resource-cache';
import { applyFlagOverridesFromUrl } from './lib/feature-flags';
import './index.css';

// Before the first render, so ?next-session=1 takes effect on the same load
// rather than the next one.
applyFlagOverridesFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
      Provider order matters.

      BrowserRouter is outermost so that everything below it — including the
      auth bootstrap, which inspects the URL for the OAuth callback — can use
      router hooks as the migration proceeds. It is mounted here without any
      <Routes>, so this step changes no behaviour: App still renders its own
      viewState switch exactly as before. Routing is introduced in the next
      step, deliberately as a separate deployment.

      ResourceCacheProvider sits inside AuthProvider (it wipes the cache when
      the authenticated identity changes) and outside App (whose viewState
      switch destroys screens on navigation — the whole point is to outlive
      that). It stays outside the future <Routes> for the same reason: cached
      data must survive route changes.

      This requires the SPA fallback shipped in v1.0.0-rc5 — without it, any
      URL other than '/' would 404 before React ever loaded.
    */}
    <BrowserRouter>
      <AuthProvider>
        <ResourceCacheProvider>
          <App />
        </ResourceCacheProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
