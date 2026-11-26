import { type Completion, type CompletionContext, type CompletionResult, startCompletion } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { addDays, localISODate, localTime } from '../../shared/dates.ts';
import { fuzzyFilter } from '../../shared/fuzzy.ts';
import { notesStore, tagsStore } from '../stores.ts';
import { insertCards } from './cards.ts';
import { privateModeFacet } from './context.ts';
import { uploadAndInsert } from './paste.ts';
import { setAllQuotesFolded } from './quotes.ts';
import { insertTable } from './tableEditing.ts';

function insertWikiLink(view: EditorView, from: number, to: number, title: string): void {
  const closed = view.state.sliceDoc(to, to + 2) === ']]';
  const insert = closed ? title : `${title}]]`;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (closed ? 2 : 0) }, userEvent: 'input.complete' });
}

/** After "[[": note titles, best match first, plus "new note" for a title that doesn't exist yet. */
export function wikiLinkCompletion(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\[\[[^\]\n[]*$/);
  if (!before) return null;
  const typed = before.text.slice(2);
  if (typed.includes('|') || typed.includes('#')) return null;
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
