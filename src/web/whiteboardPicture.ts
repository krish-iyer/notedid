import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import { whiteboardName } from '../shared/whiteboards.ts';
import { api } from './api.ts';
import { navigate, noteHref } from './router.ts';
import { notesStore } from './stores.ts';
import { messageOf } from './util.ts';

/**
 * A whiteboard, or one frame of it, as a picture in a note: what ![[Whiteboard]] and
 * ![[Whiteboard#Frame]] show, in the editor (editor/livePreview.ts) and in the reading view and
 * cards (editor/markdownHtml.ts). Excalidraw draws it from the whiteboard's file, cut to the frame,
 * and draws it again whenever the whiteboard changes, so it's never out of date. Clicking it opens
 * the whiteboard on that frame.
 *
 * It's an element, <notedid-whiteboard path="…" frame="…">, so it works wherever a note's HTML
 * goes. What it shows is in its shadow root, out of the way of the note's text (the reading view
 * finds commented passages in that text).
 */

export const PICTURE_TAG = 'notedid-whiteboard';

type Excalidraw = typeof import('@excalidraw/excalidraw');
type ExportOptions = Parameters<Excalidraw['exportToSvg']>[0];
type Elements = ExportOptions['elements'];
type FrameElement = NonNullable<ExportOptions['exportingFrame']>;

interface Picture {
  /** The drawing as an SVG image, fonts and all. */
  url: string;
  width: number;
  height: number;
}
type Drawn = Picture | { problem: string };

/** What this needs to know of an element of the drawing (Excalidraw's own types say more). */
interface Shape {
  type?: unknown;
  name?: unknown;
  isDeleted?: unknown;
}

/** Draws the whiteboard at `path`, or only its frame called `frame` (named as in links: any case). */
async function draw(path: string, frame: string | null): Promise<Drawn> {
  const [{ exportToSvg, elementsOverlappingBBox }, doc] = await Promise.all([import('@excalidraw/excalidraw'), api.whiteboard(path)]);
  const name = whiteboardName(path);
  const scene = JSON.parse(doc.content) as { elements?: unknown[]; appState?: { viewBackgroundColor?: unknown }; files?: BinaryFiles };
  const elements = (scene.elements ?? []).filter((e): e is Shape => !!e && typeof e === 'object' && (e as Shape).isDeleted !== true);
  let found: Shape | undefined;
  let shown = elements;
  if (frame) {
    const wanted = frame.trim().toLowerCase();
    found = elements.find((e) => (e.type === 'frame' || e.type === 'magicframe') && typeof e.name === 'string' && e.name.trim().toLowerCase() === wanted);
    if (!found) return { problem: `There’s no frame called “${frame}” on ${name}.` };
    // The frame, what's in it and what reaches into it (cut at its edges), as Excalidraw exports a frame.
    shown = elementsOverlappingBBox({ elements: elements as unknown as Elements, bounds: found as unknown as FrameElement, type: 'overlap' }) as unknown as Shape[];
  }
  if (!shown.some((e) => e !== found)) return { problem: frame ? `The frame “${frame}” on ${name} is empty.` : `${name} is empty.` };
  const background = scene.appState?.viewBackgroundColor;
  const exportingFrame = (found ?? null) as FrameElement | null;
  const svg = await exportToSvg({
    elements: shown as unknown as Elements,
    // No background, so it sits on the note's own; dark mode is a filter over it (styles.css).
    appState: { exportBackground: false, exportWithDarkMode: false, exportEmbedScene: false, viewBackgroundColor: typeof background === 'string' ? background : '#ffffff' },
    files: scene.files ?? null,
    exportingFrame,
    exportPadding: 16,
  });
  const size = (attribute: string) => Math.max(1, Math.round(Number.parseFloat(svg.getAttribute(attribute) ?? '') || 1));
  const text = new XMLSerializer().serializeToString(svg);
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, width: size('width'), height: size('height') };
}

const frameKey = (path: string, frame: string | null) => `${path}\n${(frame ?? '').trim().toLowerCase()}`;

/** Pictures drawn or being drawn, by whiteboard, frame and version (its time of change). */
const drawn = new Map<string, Promise<Drawn>>();
/** The newest picture of each whiteboard and frame: shown at once while a newer one is drawn. */
const newest = new Map<string, Drawn>();
const KEEP = 40;

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  if (map.size >= KEEP) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

function picture(path: string, frame: string | null, version: number): Promise<Drawn> {
  const key = `${frameKey(path, frame)}\n${version}`;
  let found = drawn.get(key);
  if (!found) {
    found = draw(path, frame).catch((err: unknown) => {
      drawn.delete(key); // to try again next time
      return { problem: `Couldn’t draw ${whiteboardName(path)}: ${messageOf(err)}` };
    });
    remember(drawn, key, found);
    void found.then((result) => remember(newest, frameKey(path, frame), result));
  }
  return found;
}

const ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18v12H3zM12 16v4M8 20h8M7 12l3-3 2 2 4-4"/></svg>';

const STYLE = `
:host { display: block; max-width: 100%; margin: 6px 0; }
.picture { display: inline-flex; flex-direction: column; gap: 6px; max-width: 100%; box-sizing: border-box; padding: 10px 12px 8px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); cursor: pointer; vertical-align: top; }
.picture:hover, .picture:focus-visible { border-color: var(--accent); outline: none; }
img { display: block; max-width: 100%; height: auto; filter: var(--whiteboard-filter, none); }
.waiting { width: 320px; max-width: 100%; aspect-ratio: 8 / 3; }
.problem { margin: 0; max-width: 40em; color: var(--muted); font: 0.9em/1.4 var(--font-text); }
.caption { display: flex; align-items: center; gap: 6px; color: var(--muted); font: 12px/1.3 var(--font-text); }
.caption svg { flex: none; }
`;

/** The element, made once (not in tests, which run without a DOM). */
function define(): void {
  if (typeof customElements === 'undefined' || customElements.get(PICTURE_TAG)) return;
  customElements.define(
    PICTURE_TAG,
    class WhiteboardPicture extends HTMLElement {
      static observedAttributes = ['path', 'frame'];
      readonly #root = this.attachShadow({ mode: 'open' });
      readonly #box: HTMLElement;
      readonly #body: HTMLElement;
      readonly #name: HTMLElement;
      /** The version on show (or on its way), so a change to anything else doesn't draw it again. */
      #shown = '';
      #unsubscribe: (() => void) | null = null;

      constructor() {
        super();
        this.#root.innerHTML = `<style>${STYLE}</style><div class="picture" role="link" tabindex="0"><div class="body"></div><span class="caption">${ICON}<span class="name"></span></span></div>`;
        this.#box = this.#root.querySelector('.picture') as HTMLElement;
        this.#body = this.#root.querySelector('.body') as HTMLElement;
        this.#name = this.#root.querySelector('.name') as HTMLElement;
        this.#box.addEventListener('click', (event) => {
          event.preventDefault();
          this.#open();
        });
        this.#box.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          this.#open();
        });
      }

      connectedCallback(): void {
        this.#unsubscribe ??= notesStore.subscribe(() => this.#update());
        this.#update();
      }

      disconnectedCallback(): void {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
      }

      attributeChangedCallback(): void {
        if (this.isConnected) this.#update();
      }

      get #path(): string {
        return this.getAttribute('path') ?? '';
      }

      get #frame(): string | null {
        return this.getAttribute('frame')?.trim() || null;
      }

      #open(): void {
        if (this.#path) navigate(noteHref(this.#path, 'whiteboard', this.#frame));
      }

      #update(): void {
        const path = this.#path;
        const frame = this.#frame;
        const notes = notesStore.get();
        if (!path || !notes) return;
        const name = whiteboardName(path);
        this.#name.textContent = frame ? `${name} · ${frame}` : name;
        this.#box.title = frame ? `Open ${name} on “${frame}”` : `Open ${name}`;
        const version = notes.find((n) => n.path === path)?.mtime;
        const key = `${frameKey(path, frame)}\n${version ?? 'gone'}`;
        if (key === this.#shown) return;
        const first = this.#shown === '';
        this.#shown = key;
        if (version === undefined) {
          this.#show({ problem: `There’s no whiteboard ${name} any more.` });
          return;
        }
        // Until this version is drawn: what's on show already, or the newest picture of it, or a space.
        if (first) this.#show(newest.get(frameKey(path, frame)) ?? null);
        void picture(path, frame, version).then((result) => {
          if (this.#shown === key) this.#show(result);
        });
      }

      #show(result: Drawn | null): void {
        if (result === null) {
          const waiting = document.createElement('div');
          waiting.className = 'waiting';
          this.#body.replaceChildren(waiting);
        } else if ('problem' in result) {
          const problem = document.createElement('p');
          problem.className = 'problem';
          problem.textContent = result.problem;
          this.#body.replaceChildren(problem);
        } else {
          const img = this.#body.querySelector('img') ?? document.createElement('img');
          img.alt = this.#name.textContent ?? '';
          img.draggable = false;
          img.width = result.width;
          img.height = result.height;
          if (img.src !== result.url) img.src = result.url;
          if (img.parentNode !== this.#body) this.#body.replaceChildren(img);
        }
      }
    },
  );
}

define();

/** The picture of a whiteboard (at `path`) or of its frame called `frame`. */
export function whiteboardPicture(path: string, frame: string | null): HTMLElement {
  const element = document.createElement(PICTURE_TAG);
  element.setAttribute('path', path);
  if (frame) element.setAttribute('frame', frame);
  return element;
}
