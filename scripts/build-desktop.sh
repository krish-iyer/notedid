#!/bin/sh
# Builds the desktop app (make desktop) into dist/desktop/: the web client and the server's code in
# Electron. Runs in the desktop container.
#   sh scripts/build-desktop.sh            all of them: Linux (AppImage, .deb), Windows (installer), macOS (zips)
#   sh scripts/build-desktop.sh --linux    some of them (electron-builder's options)
#   sh scripts/build-desktop.sh app        only the app's folder, dist/desktop-app, to run with Electron as it is
set -eu

APP=dist/desktop-app
rm -rf "$APP"
# The web client, served to the window by the app itself.
npx vite build --outDir "$APP/web" --emptyOutDir > /dev/null
# The main process: the server's code and its packages in one file.
DESKTOP_OUT="$APP" npx vite build --config vite.desktop.config.ts > /dev/null
cp node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm "$APP/sqlite3.wasm"
cp public/icon-512.png "$APP/icon.png"
# Each build gets a higher version (the number of commits), as the Android app does.
VERSION="1.$(git rev-list --count HEAD 2> /dev/null || echo 0).0"
cat > "$APP/package.json" << JSON
{
  "name": "notedid",
  "productName": "notedid",
  "version": "$VERSION",
  "description": "Personal notes as plain markdown files",
  "author": "notedid",
  "license": "UNLICENSED",
  "desktopName": "notedid.desktop",
  "type": "module",
  "main": "main.js"
}
JSON
echo "$APP: notedid $VERSION"
[ "${1:-}" = app ] && exit 0

[ $# -gt 0 ] || set -- --linux --win --mac
# The Windows installer's build runs a Windows program in Wine, which needs a settings folder of its own.
[ -z "${WINEPREFIX:-}" ] || mkdir -p "$WINEPREFIX"
npx electron-builder --config desktop/electron-builder.yml --publish never "$@"
ls -la dist/desktop | grep -E '\.(AppImage|deb|exe|zip)$' || true
