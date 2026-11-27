import '@excalidraw/excalidraw/index.css';
import { CaptureUpdateAction, Excalidraw, getSceneVersion, MainMenu, reconcileElements, restoreAppState, restoreElements, serializeAsJSON, WelcomeScreen } from '@excalidraw/excalidraw';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NoteDoc } from '../../shared/api.ts';
import { parseWikiTarget } from '../../shared/markdown.ts';
import { whiteboardName } from '../../shared/whiteboards.ts';
import { deleteNote, renameNote } from '../actions.ts';
import { api, SaveConflict } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { openLink } from '../editor/links.ts';
import { useMediaQuery } from '../hooks.ts';
import { onServerEvent } from '../live.ts';
import { useNote } from '../stores.ts';
import { useTheme } from '../theme.ts';
import { showToast } from '../toast.ts';
import { messageOf } from '../util.ts';

type Elements = ReturnType<ExcalidrawImperativeAPI['getSceneElementsIncludingDeleted']>;
/** The drawing as Excalidraw last reported it. */
interface Scene {
  elements: Elements;
  appState: AppState;
  files: BinaryFiles;
}
type SaveState = 'loading' | 'saved' | 'unsaved' | 'saving' | 'error' | 'gone';

const STATE_TEXT: Record<SaveState, string> = { loading: 'Opening…', saved: 'Saved', unsaved: 'Drawing', saving: 'Saving…', error: 'Not saved', gone: 'Moved or deleted' };

function useDark(): boolean {
  const choice = useTheme();
  const system = useMediaQuery('(prefers-color-scheme: dark)');
  return choice === 'dark' || (choice === 'auto' && system);
}

/** The drawing as Excalidraw writes its own files. */
function fileText(scene: Scene): string {
  return `${serializeAsJSON(scene.elements, scene.appState, scene.files, 'local')}\n`;
}

/**
 * A file as Excalidraw would write it, having opened it: a drawing made elsewhere (excalidraw.com, an
 * older version) comes out a little different without any change to it, and that isn't one.
 */
function asExcalidrawWrites(content: string): string {
  try {
    const data = JSON.parse(content) as { elements?: unknown[]; appState?: Record<string, unknown>; files?: BinaryFiles };
    const elements = restoreElements((data.elements ?? []) as Parameters<typeof restoreElements>[0], null);
    const appState = restoreAppState((data.appState ?? {}) as Parameters<typeof restoreAppState>[0], null);
    return `${serializeAsJSON(elements, appState, data.files ?? {}, 'local')}\n`;
  } catch {
    return content;
  }
}

/** The frames on the board that have a name: the diagrams links can point at. */
function namedFrames(ex: ExcalidrawImperativeAPI): { id: string; name: string }[] {
  return ex
    .getSceneElements()
    .filter((e) => (e.type === 'frame' || e.type === 'magicframe') && typeof e.name === 'string' && e.name.trim())
    .map((e) => ({ id: e.id, name: String((e as { name: string }).name).trim() }));
}

/** Copies text to the clipboard, saying so. */
async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${what}: paste it into a note`);
  } catch {
    showToast(`Couldn’t copy. The link is ${text}`, 'error');
  }
}

/**
 * A whiteboard: Excalidraw over a .excalidraw file of the notes folder, saved a moment after each
 * change. `frame` names a frame on it to show (from a [[Whiteboard#Frame]] link). Changes made
 * elsewhere (another device, another window) are taken in shape by shape, the newer of each kept.
 */
export function WhiteboardPage({ path, frame, embedded = false }: { path: string; frame: string | null; embedded?: boolean }) {
  const note = useNote(path);
  const name = note?.title ?? whiteboardName(path);
  const dark = useDark();
  const [board, setBoard] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>('loading');
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [frames, setFrames] = useState<{ id: string; name: string }[] | null>(null);
  const api$ = useRef<ExcalidrawImperativeAPI | null>(null);
  // Saves go from here, never from Excalidraw itself: leaving the page, it has let go of the drawing
  // before this page's last save, and what it would give then is an empty one.
  const latest = useRef<Scene | null>(null);
  const alive = useRef(false);
  // The file as last read or saved, and the same as Excalidraw writes it: a drawing equal to either needs no saving.
  const saved = useRef<{ text: string; hash: string | null; same: string }>({ text: '', hash: null, same: '' });
  const seen = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gone = useRef(false);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);

  // The file, once: Excalidraw keeps the drawing from then on.
  useEffect(() => {
    let cancelled = false;
    setBoard(null);
    setFailed(null);
    setState('loading');
    gone.current = false;
    api.whiteboard(path).then(
      (doc) => {
        if (cancelled) return;
        if (doc.hash === null) return setFailed('This whiteboard isn’t there. It may have been renamed or deleted.');
        try {
          JSON.parse(doc.content);
        } catch {
          return setFailed('This file isn’t a drawing Excalidraw can open, so it is left as it is.');
        }
        saved.current = { text: doc.content, hash: doc.hash, same: asExcalidrawWrites(doc.content) };
        setBoard(doc.content);
        setState('saved');
      },
      (err: unknown) => !cancelled && setFailed(messageOf(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  const initialData = useMemo((): ExcalidrawInitialDataState | null => {
    if (board === null) return null;
    const scene = JSON.parse(board) as { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
    return { elements: scene.elements ?? [], appState: scene.appState ?? {}, files: scene.files ?? {}, scrollToContent: !frame } as ExcalidrawInitialDataState;
    // The frame only matters for the first look (later ones are scrolled to below), so it isn't a dependency.
  }, [board]);

  /** Takes in the file as changed elsewhere: each shape as it was changed last, here or there. */
  const takeIn = useCallback((doc: NoteDoc) => {
    const scene = latest.current;
    if (!scene || doc.hash === null) return;
    const remote = JSON.parse(doc.content) as { elements?: unknown[]; files?: BinaryFiles };
    const theirs = restoreElements((remote.elements ?? []) as Parameters<typeof restoreElements>[0], null);
    const merged = reconcileElements(scene.elements, theirs as unknown as Parameters<typeof reconcileElements>[1], scene.appState) as unknown as Elements;
    const files = { ...remote.files, ...scene.files };
    latest.current = { elements: merged, appState: scene.appState, files };
    const ex = api$.current;
    if (alive.current && ex) {
      if (remote.files) ex.addFiles(Object.values(remote.files));
      ex.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    }
    saved.current = { text: doc.content, hash: doc.hash, same: asExcalidrawWrites(doc.content) };
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (!latest.current || gone.current) return;
    clearTimeout(timer.current);
    for (let attempt = 0; attempt < 3; attempt++) {
      const scene: Scene = latest.current;
      const text = fileText(scene);
      if (text === saved.current.text || text === saved.current.same) return setState('saved');
      setState('saving');
      try {
        const result = await api.saveWhiteboard(path, text, saved.current.hash);
        saved.current = { text, hash: result.hash, same: text };
        // Drawn on while saving: that is saved next.
        if (latest.current !== scene && latest.current && fileText(latest.current) !== text) {
          setState('unsaved');
          timer.current = setTimeout(() => void saveRef.current(), 800);
        } else setState('saved');
        return;
      } catch (err) {
        if (!(err instanceof SaveConflict)) {
          setState('error');
          showToast(`Could not save the whiteboard: ${messageOf(err)}`, 'error');
          return;
        }
        // Changed elsewhere since: both sets of changes go together, then that is saved.
        if (err.current.hash === null) {
          gone.current = true;
          return setState('gone');
        }
        takeIn(err.current);
      }
    }
  }, [path, takeIn]);

  saveRef.current = save;

  const saveLater = useCallback(() => {
    clearTimeout(timer.current);
    setState((s) => (s === 'gone' || s === 'loading' ? s : 'unsaved'));
    timer.current = setTimeout(() => void save(), 800);
  }, [save]);

  // Only a change to the drawing (not a scroll or a selection) needs saving; the drawing as just
  // opened doesn't, and nothing does while Excalidraw is still opening it.
  const onChange = useCallback(
    (elements: Elements, appState: AppState, files: BinaryFiles) => {
      if (appState.isLoading) return;
      latest.current = { elements, appState, files };
      const key = `${getSceneVersion(elements)}:${Object.keys(files).length}:${appState.viewBackgroundColor}:${appState.gridModeEnabled ? 1 : 0}`;
      if (key === seen.current) return;
      const first = seen.current === '';
      seen.current = key;
      if (!first) saveLater();
    },
    [saveLater],
  );

  // Changed in another window or on another device (by sync): taken in, if it isn't what was saved here.
  useEffect(
    () =>
      onServerEvent((event) => {
        if ((event.type !== 'changed' && event.type !== 'deleted') || event.path !== path) return;
        if (event.type === 'deleted') {
          gone.current = true;
          setState('gone');
          return;
        }
        if (event.type !== 'changed' || event.hash === saved.current.hash) return;
        void api.whiteboard(path).then((doc) => {
          if (doc.hash === null || doc.hash === saved.current.hash) return;
          gone.current = false;
          takeIn(doc);
          const now = latest.current && fileText(latest.current);
          if (now && now !== saved.current.text && now !== saved.current.same) saveLater();
          else setState('saved');
        });
      }),
    [path, takeIn, saveLater],
  );

  // What is left unsaved is saved on leaving the page, or the app going to the background.
  useEffect(() => {
    const hidden = () => document.visibilityState === 'hidden' && void save();
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      alive.current = false;
      void save();
    };
  }, [save]);

  // A [[Whiteboard#Frame]] link: that frame, filling the view.
  useEffect(() => {
    if (!excalidraw || !frame) return;
    let tries = 0;
    let handle = 0;
    const find = () => {
      const target = namedFrames(excalidraw).find((f) => f.name.toLowerCase() === frame.trim().toLowerCase());
      const element = target && excalidraw.getSceneElements().find((e) => e.id === target.id);
      if (element) return excalidraw.scrollToContent(element, { fitToViewport: true, viewportZoomFactor: 0.9, animate: tries > 0 });
      // The drawing may still be opening.
      if (++tries < 30) handle = window.setTimeout(find, 100);
      else showToast(`There’s no frame called “${frame}” on this whiteboard.`, 'error');
    };
    find();
    return () => clearTimeout(handle);
  }, [excalidraw, frame]);

  const showFrame = (id: string) => {
    const element = excalidraw?.getSceneElements().find((e) => e.id === id);
    if (element) excalidraw?.scrollToContent(element, { fitToViewport: true, viewportZoomFactor: 0.9, animate: true });
    setFrames(null);
  };

  const header = !embedded && (
    <header className="whiteboard-head">
      <h1 title={path}>{name}</h1>
      <span className={`save-status save-${state === 'unsaved' ? 'unsaved' : state}`} role="status">
        {STATE_TEXT[state]}
      </span>
      <div className="actions">
        <div className="popover-wrap">
          <button type="button" className="button small" aria-expanded={frames !== null} disabled={!excalidraw} onClick={() => setFrames(frames ? null : excalidraw ? namedFrames(excalidraw) : [])}>
            <Icon name="link" size={15} /> Link
          </button>
          {frames && (
            <div className="popover whiteboard-frames">
              <button type="button" className="link-button" onClick={() => void copy(`[[${name}]]`, 'a link to the whiteboard').then(() => setFrames(null))}>
                Copy a link to the whiteboard
              </button>
              <button type="button" className="link-button" onClick={() => void copy(`![[${name}]]`, 'a picture of the whiteboard').then(() => setFrames(null))}>
                Copy it as a picture, for a note
              </button>
              <p className="muted small">
                Or one of its frames: <Icon name="image" size={13} /> a picture of just that frame, which a note shows and keeps up to date, or <Icon name="link" size={13} /> a link that opens the whiteboard on it. Name a frame (double-click its title) to use it.
              </p>
              {frames.length === 0 && <p className="muted small">No named frames yet. The frame tool is in the toolbar (or press F).</p>}
              <ul>
                {frames.map((f) => (
                  <li key={f.id}>
                    <button type="button" className="link-button" title="Show it" onClick={() => showFrame(f.id)}>
                      {f.name}
                    </button>
                    <button type="button" className="icon-button" title={`Copy a picture of “${f.name}”, for a note`} aria-label={`Copy a picture of ${f.name}`} onClick={() => void copy(`![[${name}#${f.name}]]`, `a picture of “${f.name}”`).then(() => setFrames(null))}>
                      <Icon name="image" size={14} />
                    </button>
                    <button type="button" className="icon-button" title={`Copy a link to “${f.name}”`} aria-label={`Copy a link to ${f.name}`} onClick={() => void copy(`[[${name}#${f.name}]]`, `a link to “${f.name}”`).then(() => setFrames(null))}>
                      <Icon name="link" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <button type="button" className="icon-button" title="Rename" onClick={() => void save().then(() => renameNote(path, name))}>
          <Icon name="edit" />
        </button>
        <button type="button" className="icon-button" title="Delete" onClick={() => void deleteNote(path, name)}>
          <Icon name="trash" />
        </button>
      </div>
    </header>
  );

  return (
    <div className={embedded ? 'whiteboard-page embedded' : 'whiteboard-page'}>
      {header}
      {state === 'gone' && (
        <div className="banner" role="alert">
          <p>This whiteboard was moved or deleted elsewhere. What you draw here isn’t saved.</p>
        </div>
      )}
      {failed && <p className="error whiteboard-message">{failed}</p>}
      {!failed && !initialData && <p className="muted whiteboard-message">Opening the whiteboard…</p>}
      {initialData && (
        <div className="whiteboard-canvas">
          <Excalidraw
            initialData={initialData}
            excalidrawAPI={(ex) => {
              api$.current = ex;
              alive.current = true;
              setExcalidraw(ex);
            }}
            onChange={(elements, appState, files) => onChange(elements, appState, files)}
            theme={dark ? 'dark' : 'light'}
            name={name}
            UIOptions={{ canvasActions: { toggleTheme: false, saveToActiveFile: false, loadScene: true, export: { saveFileToDisk: true }, saveAsImage: true, clearCanvas: true, changeViewBackgroundColor: true } }}
            onLinkOpen={(element, event) => {
              // A shape's link to a note ([[Note]] or [[Note#Heading]]) opens it here; web links open as Excalidraw opens them.
              const wiki = /^\[\[(.+)\]\]$/.exec((element.link ?? '').trim());
              if (!wiki) return;
              event.preventDefault();
              const { target, heading } = parseWikiTarget(wiki[1] ?? '');
              void openLink({ kind: 'wiki', target, heading }, path);
            }}
          >
            <MainMenu>
              <MainMenu.DefaultItems.LoadScene />
              <MainMenu.DefaultItems.Export />
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.DefaultItems.Help />
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.Separator />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
            </MainMenu>
            <WelcomeScreen>
              <WelcomeScreen.Hints.MenuHint />
              <WelcomeScreen.Hints.ToolbarHint />
              <WelcomeScreen.Center>
                <WelcomeScreen.Center.Heading>Draw here. It is saved as you go, in your notes folder.</WelcomeScreen.Center.Heading>
              </WelcomeScreen.Center>
            </WelcomeScreen>
          </Excalidraw>
        </div>
      )}
    </div>
  );
}

export default WhiteboardPage;
