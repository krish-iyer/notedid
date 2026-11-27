import { type Completion, type CompletionContext, type CompletionResult, startCompletion } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { NoteSummary } from '../../shared/api.ts';
import { addDays, localISODate, localTime } from '../../shared/dates.ts';
import { fuzzyFilter } from '../../shared/fuzzy.ts';
import { frameNames } from '../../shared/whiteboards.ts';
import { api } from '../api.ts';
import { notesStore, resolveNote, tagsStore } from '../stores.ts';
import { insertCards } from './cards.ts';
import { notePathFacet, privateModeFacet } from './context.ts';
import { uploadAndInsert } from './paste.ts';
import { setAllQuotesFolded } from './quotes.ts';
import { insertTable } from './tableEditing.ts';

function insertWikiLink(view: EditorView, from: number, to: number, title: string): void {
  const closed = view.state.sliceDoc(to, to + 2) === ']]';
  const insert = closed ? title : `${title}]]`;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (closed ? 2 : 0) }, userEvent: 'input.complete' });
}

/** A whiteboard's named frames, by its path and version: what [[Whiteboard#…]] can point at. */
const frameLists = new Map<string, Promise<string[]>>();

function framesOf(board: NoteSummary): Promise<string[]> {
  const key = `${board.path}\n${board.mtime}`;
  let found = frameLists.get(key);
  if (!found) {
    found = api.whiteboard(board.path).then(
      (doc) => frameNames(doc.content),
      () => {
        frameLists.delete(key);
        return [];
      },
    );
    if (frameLists.size >= 100) frameLists.delete(frameLists.keys().next().value as string);
    frameLists.set(key, found);
  }
  return found;
}

/** After "[[Whiteboard#": its frames. */
async function frameCompletion(board: NoteSummary, typed: string, from: number): Promise<CompletionResult> {
  const ranked = fuzzyFilter(await framesOf(board), typed, (name) => name, 40);
  const options: Completion[] = ranked.map(({ item }) => ({ label: item, detail: 'frame', apply: (view, _completion, f, t) => insertWikiLink(view, f, t, item) }));
  return { from, options, filter: false };
}

/** After "![[": whiteboards and their frames, to show as a picture. */
async function pictureCompletion(typed: string, from: number): Promise<CompletionResult> {
  const boards = (notesStore.get() ?? []).filter((n) => n.kind === 'whiteboard');
  const frames = await Promise.all(boards.map(framesOf));
  const choices = boards.flatMap((board, i) => [
    { text: board.title, detail: 'whole whiteboard' },
    ...(frames[i] ?? []).map((frame) => ({ text: `${board.title}#${frame}`, detail: 'frame' })),
  ]);
  const ranked = fuzzyFilter(choices, typed, (choice) => choice.text, 40);
  const options: Completion[] = ranked.map(({ item }) => ({ label: item.text, detail: item.detail, apply: (view, _completion, f, t) => insertWikiLink(view, f, t, item.text) }));
  return { from, options, filter: false };
}

/**
 * After "[[": note titles, best match first, plus "new note" for a title that doesn't exist yet.
 * After "![[": whiteboards and their frames. After "[[Whiteboard#": its frames.
 */
export function wikiLinkCompletion(context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null {
  const before = context.matchBefore(/\[\[[^\]\n[]*$/);
  if (!before) return null;
  const typed = before.text.slice(2);
  if (typed.includes('|')) return null;
  const hash = typed.indexOf('#');
  if (hash >= 0) {
    const board = resolveNote(typed.slice(0, hash), context.state.facet(notePathFacet) ?? undefined);
    return board?.kind === 'whiteboard' ? frameCompletion(board, typed.slice(hash + 1), before.from + 3 + hash) : null;
  }
  if (context.state.sliceDoc(before.from - 1, before.from) === '!' && !context.state.facet(privateModeFacet)) return pictureCompletion(typed, before.from + 2);
  const notes = notesStore.get() ?? [];
  const ranked = fuzzyFilter(notes, typed, (n) => n.title, 40);
  const options: Completion[] = ranked.map(({ item }) => ({
    label: item.title,
    detail: item.kind === 'journal' ? 'journal' : item.path.split('/')[0],
    apply: (view, _completion, from, to) => insertWikiLink(view, from, to, item.title),
  }));
  const wanted = typed.trim();
  if (wanted && !ranked.some((r) => r.item.title.toLowerCase() === wanted.toLowerCase())) {
    options.push({ label: wanted, detail: 'new note', apply: (view, _completion, from, to) => insertWikiLink(view, from, to, wanted) });
  }
  return { from: before.from + 2, options, filter: false };
}

/** After "#word": existing tags. */
export function tagCompletion(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/(?:^|[\s(])#[\p{L}\p{N}_\-/]+$/u);
  if (!before) return null;
  const from = before.from + before.text.indexOf('#') + 1;
  const options = tagsStore.get().map((t) => ({ label: t.tag, detail: String(t.count) }));
  return options.length ? { from, options, validFor: /^[\p{L}\p{N}_\-/]*$/u } : null;
}

interface SlashCommand {
  label: string;
  detail: string;
  /** Only offered at the start of a line. */
  lineStart?: boolean;
  /** Not offered in the vault. */
  needsServer?: boolean;
  run: (view: EditorView, from: number, to: number) => void;
}

function insertText(text: string | (() => string), then?: (view: EditorView) => void): SlashCommand['run'] {
  return (view, from, to) => {
    const insert = typeof text === 'function' ? text() : text;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.complete' });
    then?.(view);
  };
}

/** Removes the typed "/command", then does something other than inserting text. */
function removeThen(action: (view: EditorView) => void): SlashCommand['run'] {
  return (view, from, to) => {
    view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, userEvent: 'input.complete' });
    action(view);
  };
}

function insertBlock(block: () => string, cursorFromEnd = 0): SlashCommand['run'] {
  return (view, from, to) => {
    const line = view.state.doc.lineAt(from);
    const before = from > line.from ? view.state.lineBreak : '';
    const text = block().replace(/\n/g, view.state.lineBreak);
    const insert = view.state.toText(`${before}${text}${view.state.lineBreak}`);
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length - cursorFromEnd }, userEvent: 'input.complete' });
  };
}

const COMMANDS: SlashCommand[] = [
  { label: 'Task', detail: '- [ ]', run: insertText('- [ ] ') },
  { label: 'Bullet list', detail: '-', run: insertText('- ') },
  { label: 'Numbered list', detail: '1.', run: insertText('1. ') },
  { label: 'Heading 1', detail: '#', lineStart: true, run: insertText('# ') },
  { label: 'Heading 2', detail: '##', lineStart: true, run: insertText('## ') },
  { label: 'Heading 3', detail: '###', lineStart: true, run: insertText('### ') },
  { label: 'Quote', detail: '>', lineStart: true, run: insertText('> ') },
  { label: 'Fold quotes', detail: 'all in this note', run: removeThen((view) => setAllQuotesFolded(view, true)) },
  { label: 'Unfold quotes', detail: 'all in this note', run: removeThen((view) => setAllQuotesFolded(view, false)) },
  { label: 'Table', detail: '3 columns', run: insertTable },
  { label: 'Cards', detail: 'heading + status::', run: insertCards },
  { label: 'Code block', detail: '```', run: insertBlock(() => '```\n\n```', 5) },
  { label: 'Divider', detail: '---', run: insertBlock(() => '---') },
  { label: 'Link to note', detail: '[[ ]]', run: insertText('[[', (view) => startCompletion(view)) },
  { label: 'Whiteboard picture', detail: '![[ ]]', needsServer: true, run: insertText('![[', (view) => startCompletion(view)) },
  { label: 'Date', detail: 'today', run: insertText(() => localISODate()) },
  { label: 'Time', detail: 'now', run: insertText(() => localTime()) },
  { label: 'Due today', detail: 'due:', run: insertText(() => `due:${localISODate()} `) },
  { label: 'Due tomorrow', detail: 'due:', run: insertText(() => `due:${addDays(localISODate(), 1)} `) },
  { label: 'Due next week', detail: 'due:', run: insertText(() => `due:${addDays(localISODate(), 7)} `) },
  {
    label: 'Image or file…',
    detail: 'upload',
    needsServer: true,
    run: (view, from, to) => {
      view.dispatch({ changes: { from, to, insert: '' } });
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = () => void uploadAndInsert(view, [...(input.files ?? [])], from);
      input.click();
    },
  },
];

/** After "/" at the start of a line or after a space: commands that insert markdown. */
export function slashCompletion(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/(?:^|\s)\/[\w-]*$/);
  if (!before) return null;
  const slash = before.from + before.text.indexOf('/');
  const line = context.state.doc.lineAt(slash);
  const atLineStart = line.text.slice(0, slash - line.from).trim() === '';
  const privateMode = context.state.facet(privateModeFacet);
  const options: Completion[] = COMMANDS.filter((c) => (!c.lineStart || atLineStart) && !(c.needsServer && privateMode)).map((c) => ({
    label: c.label,
    detail: c.detail,
    apply: (view, _completion, _from, to) => c.run(view, slash, to),
  }));
  return { from: slash + 1, options, validFor: /^[\w-]*$/ };
}
