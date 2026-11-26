import { copyFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The browser-only app: the same web app, plus a service worker (vite.sw.config.ts, built right
 * after this) that stands in for the server. The result in dist/browser is plain static files: it
 * can be served from anywhere, and keeps the notes in the browser. `npm run build:browser`.
 *
 * Served from a folder (GitHub Pages: https://you.github.io/notedid/), build it with that folder:
 * `BASE_PATH=/notedid/ npm run build:browser`.
 */
const BASE = process.env.BASE_PATH || '/';
if (!/^\/([\w.-]+\/)*$/.test(BASE)) throw new Error(`BASE_PATH must start and end with a slash, like /notedid/ (got ${BASE})`);

/** A copy of index.html as 404.html: hosts like GitHub Pages answer an address they don't know (a note's) with it, and the app shows the note. */
const notFoundPage: Plugin = {
  name: 'not-found-page',
  apply: 'build',
  closeBundle() {
    copyFileSync('dist/browser/index.html', 'dist/browser/404.html');
  },
};

export default defineConfig({
  base: BASE,
  plugins: [react(), notFoundPage],
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
