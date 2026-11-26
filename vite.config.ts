import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { DEFAULT_PORT, DEFAULT_WEB_PORT, parsePort } from './src/server/config.ts';

const apiPort = parsePort('PORT', process.env.PORT, DEFAULT_PORT);
const webPort = parsePort('WEB_PORT', process.env.WEB_PORT, DEFAULT_WEB_PORT);

export default defineConfig({
  plugins: [react()],
  // This is the app with its server; vite.browser.config.ts builds the one that runs in a browser alone.
  define: { __BROWSER_APP__: 'false' },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  server: {
    // In the dev container this is 0.0.0.0; Docker then publishes the port on the host's localhost only.
    host: process.env.WEB_HOST || 'localhost',
    port: webPort,
    strictPort: true,
    proxy: {
      // changeOrigin makes the Host header match the API server, which only answers to localhost names.
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
    watch: {
      ignored: ['**/dev-notes/**'],
    },
  },
});
