import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The browser-only app: the same web app, plus a service worker (vite.sw.config.ts, built right
 * after this) that stands in for the server. The result in dist/browser is plain static files: it
 * can be served from anywhere, and keeps the notes in the browser. `npm run build:browser`.
 */
export default defineConfig({
  plugins: [react()],
  define: { __BROWSER_APP__: 'true' },
  build: {
    outDir: 'dist/browser',
    emptyOutDir: true,
  },
  preview: {
    // In the dev container this is 0.0.0.0; Docker then publishes the port on the host's localhost only.
    host: process.env.WEB_HOST || 'localhost',
    port: Number(process.env.BROWSER_PORT) || 4323,
    strictPort: true,
  },
});
