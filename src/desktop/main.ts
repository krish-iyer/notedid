// The desktop app (Electron): the web client in a window, and the server's code behind it in this
// process, over a notes folder on this computer. No network port is opened: the window asks for
// notedid://app/…, and this process answers, the /api requests with the backend and everything
// else with the web client's files.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, Menu, type MenuItemConstructorOptions, nativeTheme, protocol, screen, session, shell } from 'electron';
import { type DesktopBackend, startDesktopBackend } from './backend.ts';

const SCHEME = 'notedid';
const HOST = 'app';
const ORIGIN = `${SCHEME}://${HOST}`;

// A secure origin of its own, so the web client runs as it does over HTTPS (the vault's WebCrypto, workers, fetch).
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);

app.setName('notedid');
if (process.env.NOTEDID_USER_DATA) app.setPath('userData', path.resolve(process.env.NOTEDID_USER_DATA));
if (process.platform === 'win32') app.setAppUserModelId('app.notedid.notes');

// ---- Settings of the app itself (not of the notes): which folder, and where the window was ----

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

interface DesktopSettings {
  notesDir?: string;
  window?: WindowState;
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings(): DesktopSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as DesktopSettings) : {};
  } catch {
    return {};
  }
}

/** Small, and written at once: the window's place is saved as the app quits. */
function saveSettings(change: Partial<DesktopSettings>): void {
  const next = { ...loadSettings(), ...change };
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(settingsFile(), `${JSON.stringify(next, null, 2)}\n`);
}

// ---- The notes folder ----

/** Asks for a folder; null if the dialog was cancelled. */
async function pickFolder(title: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({ title, defaultPath: app.getPath('documents'), buttonLabel: 'Use this folder', properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** The notes folder: the one used last, or one asked for the first time. Null to quit. */
async function notesFolder(): Promise<string | null> {
  // For tests, and for trying the app on another folder: NOTEDID_NOTES_DIR=/some/folder
  if (process.env.NOTEDID_NOTES_DIR) return path.resolve(process.env.NOTEDID_NOTES_DIR);
  const saved = loadSettings().notesDir;
  if (saved && existsSync(saved)) return saved;
  if (saved) {
    // Not there: say so, rather than start an empty folder in its place (it may be on a drive that isn't connected).
    for (;;) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: 'Your notes folder isn’t there',
        detail: `${saved}\n\nIt may be on a drive that isn’t connected, or it was moved or renamed.`,
        buttons: ['Choose the folder…', 'Make it again, empty', 'Quit'],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 2) return null;
      if (response === 1) return saved;
      const picked = await pickFolder('Your notes folder');
      if (picked) return picked;
    }
  }
  const suggested = path.join(app.getPath('documents'), 'notedid');
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: 'Where should notedid keep your notes?',
      detail: `Your notes are plain markdown files in a folder of your choice, which other apps can open, sync and back up too. A folder you already keep markdown notes in works as well.\n\nSuggested: ${suggested}`,
      buttons: ['Use the suggested folder', 'Choose a folder…', 'Quit'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return null;
    if (response === 0) return suggested;
    const picked = await pickFolder('Where to keep your notes');
    if (picked) return picked;
  }
}

// ---- Serving the window: the web client's files, and /api from the backend ----

let backend: DesktopBackend | null = null;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const webRoot = () => path.join(app.getAppPath(), 'web');

/** The page's rules: only its own scripts (and the inline theme script, by its hash), no plugins or frames. */
function contentSecurityPolicy(html: string): string {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1] ?? '').digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${inline.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

let indexPage: { html: string; csp: string } | null = null;

async function appPage(): Promise<Response> {
  if (!indexPage) {
    const html = await readFile(path.join(webRoot(), 'index.html'), 'utf8');
    indexPage = { html, csp: contentSecurityPolicy(html) };
  }
  return new Response(indexPage.html, { headers: { 'content-type': TYPES['.html'] ?? '', 'content-security-policy': indexPage.csp, 'cache-control': 'no-cache' } });
}

async function staticFile(pathname: string): Promise<Response> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (rel === '/' || rel === '/index.html') return appPage();
  const root = webRoot();
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
  const ext = path.extname(file).toLowerCase();
  const bytes = await readFile(file).catch(() => null);
  if (bytes) {
    // Vite names built files by their content (assets/index-1a2b3c.js), so those never change.
    const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': cache } });
  }
  // Any other address is one of the app's own pages (/note/…, /tasks): the app shows it.
  return ext ? new Response('Not found', { status: 404 }) : appPage();
}

async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response('Not found', { status: 404 });
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    if (!backend) return Response.json({ error: 'The notes are still opening' }, { status: 503 });
    return backend.app.fetch(request);
  }
  return staticFile(url.pathname);
}

// ---- Links: the web's open in the browser, files in the notes folder with their app ----

/** Files a click may open with the computer's own app: documents and pictures, never programs or scripts. */
const OPEN_WITH_SYSTEM = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.txt', '.csv', '.bib']);

/** A file of the notes folder (/api/file?path=…), opened with the app the computer has for it. */
function openNotesFile(url: URL): boolean {
  if (url.origin !== ORIGIN || url.pathname !== '/api/file' || !backend) return false;
  const rel = url.searchParams.get('path');
  if (!rel) return false;
  const file = path.resolve(backend.notesDir, rel);
  if (!file.startsWith(backend.notesDir + path.sep) || !OPEN_WITH_SYSTEM.has(path.extname(file).toLowerCase())) return false;
  void shell.openPath(file);
  return true;
}

function openOutside(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

// ---- The window ----

let mainWindow: BrowserWindow | null = null;

/** The window where it was last, if that is still on a screen. */
function restoredBounds(state: WindowState | undefined): Partial<WindowState> {
  if (!state) return { width: 1280, height: 860 };
  const { x, y, width, height } = state;
  const visible = x !== undefined && y !== undefined && screen.getAllDisplays().some(({ workArea: a }) => x + 80 > a.x && x + 80 < a.x + a.width && y + 40 > a.y && y + 40 < a.y + a.height);
  return visible ? { x, y, width, height } : { width, height };
}

function contextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    for (const word of params.dictionarySuggestions.slice(0, 5)) items.push({ label: word, click: () => window.webContents.replaceMisspelling(word) });
    if (params.misspelledWord) {
      items.push({ label: 'Add to dictionary', click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (params.linkURL && /^(https?|mailto):/i.test(params.linkURL)) {
      items.push({ label: 'Open link in the browser', click: () => openOutside(params.linkURL) }, { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
    }
    if (params.isEditable) items.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window });
  });
}

function guardNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (openNotesFile(target)) return { action: 'deny' };
    // A page of the app's own (a note opened in a new window): another window of the app.
    if (target.origin === ORIGIN) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: process.platform !== 'darwin' } };
    openOutside(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${ORIGIN}/`)) return;
    event.preventDefault();
    openOutside(url);
  });
  window.webContents.on('did-create-window', (child) => {
    contextMenu(child);
    guardNavigation(child);
  });
}

function createWindow(): void {
  const state = loadSettings().window;
  const window = new BrowserWindow({
    ...restoredBounds(state),
    minWidth: 360,
    minHeight: 420,
    title: 'notedid',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171614' : '#fbfaf7',
    autoHideMenuBar: process.platform !== 'darwin',
    icon: process.platform === 'linux' ? path.join(app.getAppPath(), 'icon.png') : undefined,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  mainWindow = window;
  if (state?.maximized) window.maximize();
  window.once('ready-to-show', () => window.show());
  contextMenu(window);
  guardNavigation(window);
  // Where the window is, kept as it moves (however the app ends, it opens there next time).
  const keepPlace = () => saveSettings({ window: { ...window.getNormalBounds(), maximized: window.isMaximized() } });
  let placing: ReturnType<typeof setTimeout> | undefined;
  const moved = () => {
    clearTimeout(placing);
    placing = setTimeout(keepPlace, 500);
  };
  window.on('resize', moved);
  window.on('move', moved);
  window.on('maximize', moved);
  window.on('unmaximize', moved);
  window.on('close', () => {
    clearTimeout(placing);
    keepPlace();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(`${ORIGIN}/`);
}

// ---- Menus ----

function folderLabel(): string {
  if (process.platform === 'darwin') return 'Show Notes Folder in Finder';
  if (process.platform === 'win32') return 'Show Notes Folder in Explorer';
  return 'Show Notes Folder';
}

async function switchFolder(): Promise<void> {
  const picked = await pickFolder('Open another notes folder');
  if (!picked || picked === backend?.notesDir) return;
  saveSettings({ notesDir: picked });
  // Starting again opens the other folder; quitting first keeps the versions not kept yet.
  app.relaunch();
  app.quit();
}

function buildMenu(): void {
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Notes Folder…', click: () => void switchFolder() },
        { label: folderLabel(), click: () => backend && void shell.openPath(backend.notesDir) },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Starting and quitting ----

let stopped = false;

async function start(): Promise<void> {
  const folder = await notesFolder();
  if (!folder) {
    app.quit();
    return;
  }
  try {
    await mkdir(folder, { recursive: true });
    const sqliteWasm = await readFile(path.join(app.getAppPath(), 'sqlite3.wasm'));
    backend = await startDesktopBackend(folder, { host: HOST, origin: ORIGIN, sqliteWasm });
  } catch (err) {
    dialog.showErrorBox('notedid could not open your notes', `${folder}\n\n${err instanceof Error ? err.message : String(err)}`);
    app.quit();
    return;
  }
  if (!process.env.NOTEDID_NOTES_DIR) saveSettings({ notesDir: backend.notesDir });
  console.log(`notes folder: ${backend.notesDir} (${backend.notes} notes, git backup ${backend.git ? 'on' : 'off'})`);
  protocol.handle(SCHEME, answer);
  session.defaultSession.on('will-download', (_event, item) => {
    // Exports and BibTeX files: a save dialog, starting in Downloads.
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
  buildMenu();
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  // One app per computer user: two would both write the same notes folder.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start, (err: unknown) => {
    console.error(err);
    app.quit();
  });
  app.on('activate', () => {
    if (backend && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (stopped || !backend) return;
    // Keep the versions of the notes changed in the last minute, and commit the git backup, before quitting.
    event.preventDefault();
    stopped = true;
    const quit = () => app.quit();
    const timer = setTimeout(quit, 5000);
    void backend.stop().finally(() => {
      clearTimeout(timer);
      quit();
    });
  });
}
