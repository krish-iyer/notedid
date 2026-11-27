/**
 * Whiteboards: drawings made with Excalidraw, kept as Excalidraw's own files
 * (whiteboards/<name>.excalidraw), which the Excalidraw app opens too. The file's name is the
 * whiteboard's name. The app indexes a whiteboard as a note of its own kind, from the text on it:
 * so search finds it, its [[links]] and #tags count, and each named frame (a diagram on the board)
 * is a heading that [[Whiteboard#Frame]] links to.
 */

export const WHITEBOARD_EXTENSION = '.excalidraw';
export const WHITEBOARDS_FOLDER = 'whiteboards';

export function isWhiteboardPath(path: string): boolean {
  return path.toLowerCase().endsWith(WHITEBOARD_EXTENSION) && path.length > WHITEBOARD_EXTENSION.length;
}

/** A whiteboard's name: its file name without the folder and the extension. */
export function whiteboardName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.excalidraw$/i, '');
}

/** A file name for a whiteboard called `title`: the title itself, less what file systems and links can't take. */
export function whiteboardFileStem(title: string): string {
  const stem = title
    .normalize('NFC')
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return stem || 'Whiteboard';
}

/** An empty whiteboard, as Excalidraw writes one. */
export function emptyWhiteboard(): string {
  return `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'notedid', elements: [], appState: { viewBackgroundColor: '#ffffff', gridSize: 20 }, files: {} }, null, 2)}\n`;
}

interface SceneElement {
  id?: unknown;
  type?: unknown;
  isDeleted?: unknown;
  text?: unknown;
  originalText?: unknown;
  name?: unknown;
  frameId?: unknown;
  link?: unknown;
}

/** The drawing's elements that are still there (Excalidraw keeps deleted ones, marked), or null if it isn't a drawing. */
export function sceneElements(raw: string): SceneElement[] | null {
  let scene: unknown;
  try {
    scene = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!scene || typeof scene !== 'object' || !Array.isArray((scene as { elements?: unknown }).elements)) return null;
  return ((scene as { elements: unknown[] }).elements as SceneElement[]).filter((e) => e && typeof e === 'object' && e.isDeleted !== true);
}

/** Whether `raw` is a drawing Excalidraw can open: JSON with a list of elements. */
export function isWhiteboardContent(raw: string): boolean {
  return sceneElements(raw) !== null;
}

const isFrame = (e: SceneElement) => e.type === 'frame' || e.type === 'magicframe';

/** The whiteboard's frames that have a name, in the order they were drawn: the diagrams a link can point at. */
export function frameNames(raw: string): string[] {
  const names = (sceneElements(raw) ?? []).filter(isFrame).map((f) => (typeof f.name === 'string' ? f.name.trim() : ''));
  return [...new Set(names.filter(Boolean))];
}

/** Text from the drawing, as plain lines: none of them can turn into a heading of the index text. */
function textLines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^(\s*)(#{1,6}\s)/, '$1\\$2'))
    .join('\n')
    .trim();
}

/**
 * What the index keeps of a whiteboard: its kind and name, the text written on it, each named
 * frame as a heading over the text inside it, and the links set on its shapes.
 */
export function whiteboardIndexText(raw: string, title: string): string {
  const elements = sceneElements(raw) ?? [];
  // Each named frame's id, by its name: frames that share a name are one heading.
  const frames = new Map<string, Set<unknown>>();
  for (const f of elements.filter(isFrame)) {
    const name = typeof f.name === 'string' ? f.name.trim().replace(/\s+/g, ' ') : '';
    if (name) frames.set(name, (frames.get(name) ?? new Set()).add(f.id));
  }
  const inFrame = (frame: unknown) => [...frames.values()].some((ids) => ids.has(frame));
  const texts = elements.filter((e) => e.type === 'text').map((e) => ({ frame: e.frameId, text: textLines(String(e.originalText ?? e.text ?? '')) })).filter((t) => t.text);
  const lines = ['---', 'type: whiteboard', `title: ${JSON.stringify(title)}`, '---', ''];
  for (const t of texts.filter((t) => !inFrame(t.frame))) lines.push(t.text, '');
  for (const [name, ids] of frames) {
    lines.push(`## ${name}`, '');
    for (const t of texts.filter((t) => ids.has(t.frame))) lines.push(t.text, '');
  }
  const links = [...new Set(elements.map((e) => (typeof e.link === 'string' ? e.link.trim() : '')).filter(Boolean))];
  for (const link of links) lines.push(/^\[\[.+\]\]$/.test(link) ? link : /^https?:\/\//i.test(link) ? `<${link}>` : '', '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
