#!/bin/sh
# Builds the Android app into dist/notedid.apk (make apk): the browser-only app, inside Android's
# WebView (Capacitor). Runs in the android container.
set -eu

BROWSER_OUT=dist/app npm run build:browser > /dev/null
npx cap sync android > /dev/null

# The signing key, made once in .apk-signing/ (gitignored). Keep a copy: Android installs an update
# only if it is signed with the same key, so a lost key means uninstalling the app (and its notes).
if [ ! -s .apk-signing/notedid.p12 ]; then
  mkdir -p .apk-signing
  chmod 700 .apk-signing
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n' > .apk-signing/password
  keytool -genkeypair -keystore .apk-signing/notedid.p12 -storetype PKCS12 -alias notedid -keyalg RSA -keysize 3072 \
    -validity 18250 -dname "CN=notedid" -storepass:file .apk-signing/password > /dev/null 2>&1
  chmod 600 .apk-signing/notedid.p12 .apk-signing/password
  echo "Made a signing key in .apk-signing/: keep a copy of that folder."
fi

# Each build gets a higher version (the number of commits), so it installs over the one before.
NOTEDID_VERSION_CODE=$(git rev-list --count HEAD 2> /dev/null || echo 1)
export NOTEDID_VERSION_CODE
export NOTEDID_VERSION_NAME="1.$NOTEDID_VERSION_CODE"
(cd android && ./gradlew --no-daemon -q assembleRelease 2>&1 | grep -v -E 'SDK processing|understands SDK XML|Xlint|unchecked or unsafe' || true)

mkdir -p dist
zipalign -f -p 4 android/app/build/outputs/apk/release/app-release-unsigned.apk dist/notedid-aligned.apk
apksigner sign --ks .apk-signing/notedid.p12 --ks-pass file:.apk-signing/password --ks-key-alias notedid --out dist/notedid.apk dist/notedid-aligned.apk
rm -f dist/notedid-aligned.apk dist/notedid.apk.idsig
apksigner verify dist/notedid.apk
echo "dist/notedid.apk: notedid $NOTEDID_VERSION_NAME, $(du -h dist/notedid.apk | cut -f1)"
