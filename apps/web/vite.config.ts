import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    // jsdom rather than a browser: these tests assert cache state and DOM
    // output, not layout or paint. Nothing here needs a real engine, and a
    // headless browser would make the suite too slow to run on every change.
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
      exclude: ['node_modules/**', 'dist/**'],
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: {
        '/api': {
          target: 'http://localhost:4001',
          changeOrigin: true,
        },
        '/socket.io': {
          target: 'http://localhost:4001',
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
