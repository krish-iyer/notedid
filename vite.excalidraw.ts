import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Excalidraw's own build, and its fonts, as the package ships them. */
const PROD = path.resolve('node_modules/@excalidraw/excalidraw/dist/prod');
const FONTS = path.join(PROD, 'fonts');

/** The files of Excalidraw's build that its font worker loads: those subset-worker.chunk.js imports, and theirs. */
function workerFiles(): string[] {
  const found = new Set<string>();
  const visit = (file: string) => {
    for (const [, imported] of readFileSync(path.join(PROD, file), 'utf8').matchAll(/(?:from|import)\s*"\.\/([\w.-]+\.js)"/g)) {
      if (imported && !found.has(imported)) {
        found.add(imported);
        visit(imported);
      }
    }
  };
  visit('subset-worker.chunk.js');
  return [...found];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Excalidraw's fonts, served by the app itself at excalidraw/fonts/ (main.tsx points Excalidraw
 * there): whiteboards draw their text offline, and in the desktop app, which loads nothing from the
 * web. Left alone, Excalidraw would fetch them from a CDN. Not its font for Chinese, Japanese and
 * Korean (Xiaolai, 13 MB, four times the app's own size in the Android app): such text shows in one
 * of the computer's fonts instead.
 */
export function excalidrawFonts(): Plugin {
  let outDir = 'dist';
  let base = '/';
  return {
    name: 'excalidraw-fonts',
    // Fonts in an exported picture (a whiteboard's picture in a note, Export image) are cut down to the
    // letters used, in a worker that loads subset-worker.chunk.js and what it imports. Bundled as they
    // come, two small files it imports would land in the chunk with all of Excalidraw, which a worker
    // can't run, and the work would fall back to the page. Each gets a chunk of its own.
    config() {
      return {
        build: {
          rolldownOptions: {
            output: {
              codeSplitting: {
                groups: workerFiles().map((file) => ({
                  name: `excalidraw-${file.replace(/\.js$/, '')}`,
                  test: new RegExp(`[\\\\/]@excalidraw[\\\\/]excalidraw[\\\\/]dist[\\\\/]prod[\\\\/]${escapeRegExp(file)}(?:\\?|$)`),
                  includeDependenciesRecursively: false,
                })),
              },
            },
          },
        },
      };
    },
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      base = config.base;
    },
    configureServer(server) {
      server.middlewares.use(`${base}excalidraw/fonts`, (req, res, next) => {
        let rel: string;
        try {
          rel = decodeURIComponent((req.url ?? '').split('?')[0] ?? '').replace(/^\/+/, '');
        } catch {
          return next();
        }
        const file = path.resolve(FONTS, rel);
        if (!file.startsWith(FONTS + path.sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('content-type', 'font/woff2');
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        res.end(readFileSync(file));
      });
    },
    writeBundle() {
      cpSync(FONTS, path.join(outDir, 'excalidraw', 'fonts'), { recursive: true, filter: (from) => path.basename(from) !== 'Xiaolai' });
    },
    // Excalidraw gives each font a second address, on a CDN (esm.sh), should the first fail. The app's
    // fonts don't fail, and the app loads nothing from the web: the second address is the app's too.
    // (The desktop app's content security policy refuses the CDN, and says so for every font.)
    transform(code, id) {
      if (!id.includes('/@excalidraw/excalidraw/dist/') || !code.includes('"ASSETS_FALLBACK_URL"')) return null;
      const fallback = /("ASSETS_FALLBACK_URL",\s*)`https:\/\/esm\.sh\/.*?\/dist\/prod\/`/;
      if (!fallback.test(code)) this.error('Excalidraw names its fonts’ fallback address differently now: update the pattern in vite.excalidraw.ts');
      return { code: code.replace(fallback, '$1(typeof window < "u" && window.EXCALIDRAW_ASSET_PATH) || "/"'), map: null };
    },
  };
}
