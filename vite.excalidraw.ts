import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Excalidraw's fonts, as the package ships them. */
const FONTS = path.resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts');

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
