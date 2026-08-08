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
      /*
       * TWO paths go to the API, and production must forward both.
       *
       * This block is only half the story: it covers `npm run dev`, and
       * apps/web/vercel.json has to say the same thing for the deployed site.
       * For the whole life of the deployment it did not — it forwarded /api and
       * not /socket.io, so in production the handshake fell through to the SPA
       * catch-all and engine.io was handed index.html:
       *
       *     GET /socket.io/?EIO=4&transport=polling
       *     200  text/html   <!doctype html>...
       *
       * The socket therefore never connected for anybody, and no live update
       * ever arrived; the only way to see another player's action was to
       * refresh. Nothing was wrong with the client listeners or the server
       * emits, which is why auditing them kept coming back clean — the
       * transport underneath them was never up.
       *
       * It is invisible locally precisely because of the `ws: true` line below.
       * Dev and prod disagreed about something no test exercises, so if you
       * ever add a path here, add it there too.
       */
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
