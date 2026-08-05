import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Unmount between tests. Without this a component that subscribes to the cache
// or the socket keeps running into the next test and reports as a flake there.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
