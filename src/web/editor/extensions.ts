import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension, Prec } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap, placeholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { editorMarkdownExtensions } from '../../shared/markdown.ts';
import { cardEditing } from './cards.ts';
import { compareChanges } from './compare.ts';
import { slashCompletion, tagCompletion, wikiLinkCompletion } from './complete.ts';
import { notePathFacet, privateModeFacet } from './context.ts';
import { frontmatterFold } from './frontmatter.ts';
import { linkClicks } from './links.ts';
import { livePreview } from './livePreview.ts';
import { pasteHandling } from './paste.ts';
import { quoteFolding } from './quotes.ts';
import { tableEditing } from './tableEditing.ts';
import { tableKeymap } from './tables.ts';
import { taskCheckboxes, toggleTask } from './tasks.ts';
import { convertDueBeforeEnter, typingShortcuts } from './typing.ts';

/**
 * The line break to keep for this text: CRLF when most breaks are CRLF, otherwise
 * CodeMirror's default (LF). Without this, saving would turn every CRLF into LF.
 */
export function detectLineSeparator(text: string): string | undefined {
  const crlf = text.split('\r\n').length - 1;
  if (crlf === 0) return undefined;
  const lf = text.split('\n').length - 1 - crlf;
  return crlf >= lf ? '\r\n' : undefined;
}

const markdownHighlighting = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.5em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '650' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '650' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.92em' },
  { tag: t.quote, color: 'var(--muted)' },
  { tag: t.labelName, color: 'var(--tag)' },
  { tag: t.meta, color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: '0.85em' },
  // Markup characters such as #, *, >, list bullets and table pipes.
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--faint)' },
]);

const editorTheme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', fontSize: '1.0625rem' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-text)', lineHeight: '1.65' },
  '.cm-content': { padding: '4px 0 30vh', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-placeholder': { color: 'var(--faint)' },
  '.cm-tooltip': { border: '1px solid var(--line)', backgroundColor: 'var(--surface)', borderRadius: '8px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-text)', maxHeight: '16em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--on-accent)' },
  '.cm-completionDetail': { color: 'inherit', opacity: '0.65', marginLeft: '1em', fontStyle: 'normal' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--ink)', borderColor: 'var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--mark)' },
});

export interface EditorOptions {
  lineSeparator: string | undefined;
  /** Accessible name of the editing area. */
  label: string;
  /** The note being edited (relative links, images, completion); null for vault notes. */
  notePath: string | null;
  /** Vault mode: nothing is sent to the server unencrypted. */
  privateMode: boolean;
  placeholder: string;
  onChange: (text: string) => void;
}

export function editorExtensions(options: EditorOptions): Extension {
  return [
    notePathFacet.of(options.notePath),
    privateModeFacet.of(options.privateMode),
    options.lineSeparator ? EditorState.lineSeparator.of(options.lineSeparator) : [],
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    // GFM (tables, task lists, strikethrough, autolinks) plus [[links]], #tags and front matter.
    markdown({ base: markdownLanguage, extensions: editorMarkdownExtensions }),
    syntaxHighlighting(markdownHighlighting),
    livePreview,
    frontmatterFold,
    quoteFolding,
    tableEditing,
    cardEditing,
    compareChanges,
    taskCheckboxes,
    linkClicks,
    autocompletion({ override: [wikiLinkCompletion, tagCompletion, slashCompletion], icons: false }),
    search({ top: true }),
    Prec.highest(keymap.of([...tableKeymap, { key: 'Enter', run: convertDueBeforeEnter }])),
    keymap.of([{ key: 'Mod-Enter', run: toggleTask }, ...completionKeymap, ...searchKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap]),
    typingShortcuts,
    pasteHandling,
    placeholder(options.placeholder),
    editorTheme,
    EditorView.contentAttributes.of({ 'aria-label': options.label, spellcheck: 'true', autocapitalize: 'sentences' }),
    EditorView.updateListener.of((update) => {
      // sliceDoc joins lines with the note's own line break (doc.toString() would always use LF).
      if (update.docChanged) options.onChange(update.state.sliceDoc());
    }),
  ];
}
