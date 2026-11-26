import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

/**
 * The browser-only app's service worker: one classic script, /sw.js, built after the app
 * (vite.browser.config.ts) into the same folder. It gets the list of the app's files to keep for
 * offline use, and a build name for its cache.
 */
const OUT = 'dist/browser';

function appFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(`/${path.relative(OUT, full).split(path.sep).join('/')}`);
    }
  };
  walk(OUT);
  return found.filter((file) => file !== '/sw.js').sort();
}

export default defineConfig(() => {
  const files = appFiles();
  const build = createHash('sha256');
  for (const file of files) build.update(file).update(readFileSync(path.join(OUT, file)));
  return {
    define: {
      // A classic script has no import.meta; the worker's own address does its job (SQLite finds its files with it).
      'import.meta.url': 'self.location.href',
      __APP_FILES__: JSON.stringify(files),
      __BUILD__: JSON.stringify(build.digest('hex').slice(0, 12)),
    },
    build: {
      outDir: OUT,
      emptyOutDir: false,
      copyPublicDir: false,
      rolldownOptions: {
        input: 'src/browser/sw.ts',
        output: { format: 'iife' as const, entryFileNames: 'sw.js', assetFileNames: 'assets/[name]-[hash][extname]' },
      },
    },
  };
});
