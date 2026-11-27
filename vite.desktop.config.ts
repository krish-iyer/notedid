import { defineConfig } from 'vite';

/**
 * The desktop app's main process (src/desktop/main.ts) as one file for Electron, with the server's
 * code and the packages it uses inside, so the packaged app needs no node_modules. Built by
 * scripts/build-desktop.sh, next to the web client it serves.
 */
export default defineConfig({
  build: {
    ssr: 'src/desktop/main.ts',
    outDir: process.env.DESKTOP_OUT || 'dist/desktop-app',
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'node22',
    rolldownOptions: {
      external: ['electron'],
      output: { format: 'es' as const, entryFileNames: 'main.js' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});
