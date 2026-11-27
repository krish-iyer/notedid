// electron-builder's afterPack hook: signs the macOS app ad hoc, without an Apple certificate, before
// it is zipped. An Apple Silicon Mac runs nothing unsigned, and making Electron's app into notedid
// voids the signature it came with. rcodesign does it here on Linux (the desktop container has it).
// A Mac still asks once before opening it: Privacy & Security → Open Anyway (README.md).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function signMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const name = context.packager.appInfo.productFilename;
  const app = path.join(context.appOutDir, `${name}.app`);
  execFileSync('rcodesign', ['sign', app], { stdio: ['ignore', 'ignore', 'inherit'] });
  // Each program now carries an ad hoc signature: the app's, Electron's, and its helpers'. (rcodesign's
  // own verify command is known to be unreliable, so this reads the signatures instead.)
  const programs = [
    `Contents/MacOS/${name}`,
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
    ...['', ' (GPU)', ' (Plugin)', ' (Renderer)'].map((kind) => `Contents/Frameworks/${name} Helper${kind}.app/Contents/MacOS/${name} Helper${kind}`),
  ];
  for (const program of programs) {
    const info = execFileSync('rcodesign', ['print-signature-info', path.join(app, program)], { encoding: 'utf8' });
    if (!info.includes('CodeSignatureFlags(ADHOC)') || !info.includes('digest_type: sha256')) throw new Error(`${program} is not signed ad hoc`);
  }
  console.log(`  • signed ad hoc  app=${path.relative(process.cwd(), app)} programs=${programs.length}`);
};
