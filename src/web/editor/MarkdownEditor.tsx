import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { detectLineSeparator, editorExtensions } from './extensions.ts';
import { registerEditor, replaceEditorText } from './registry.ts';

interface MarkdownEditorProps {
  /** The text to show. When `version` changes, the editor takes the new text, keeping the cursor where it can. */
  content: string;
  version: number;
  onChange: (content: string) => void;
  /** Accessible name of the editing area. */
  label: string;
  /** The note being edited; null for vault notes. */
  notePath: string | null;
  /** Key under which other parts of the app can reach this editor (defaults to the note path). */
  registryKey?: string;
  /** Scroll to this heading, or "L12" for line 12, when opening. */
  anchor?: string | null;
  autoFocus?: boolean;
  /** Vault mode: nothing typed or pasted is sent to the server unencrypted. */
  privateMode?: boolean;
  placeholder?: string;
}

function scrollToAnchor(view: EditorView, anchor: string): void {
  const doc = view.state.doc;
  let lineNumber = /^L(\d+)$/.exec(anchor) ? Number(anchor.slice(1)) : 0;
  if (!lineNumber) {
    const wanted = anchor.trim().toLowerCase();
    for (let n = 1; n <= doc.lines; n++) {
      const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(doc.line(n).text);
      if (heading && heading[1]?.toLowerCase() === wanted) {
        lineNumber = n;
        break;
      }
    }
  }
  if (lineNumber < 1 || lineNumber > doc.lines) return;
  const line = doc.line(lineNumber);
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 80 }) });
  view.focus();
}

/** CodeMirror editing the markdown text itself, so the file is exactly what was typed. */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const { content, version, onChange, label, notePath, registryKey, anchor, autoFocus = false, privateMode = false, placeholder = 'Start typing…' } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const shownVersion = useRef(version);
  const latestOnChange = useRef(onChange);

  useLayoutEffect(() => {
    latestOnChange.current = onChange;
  });

  // The editor owns its text after mounting; later `version` changes bring in outside edits.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: content,
        extensions: editorExtensions({
          lineSeparator: detectLineSeparator(content),
          label,
          notePath,
          privateMode,
          placeholder,
          onChange: (text) => latestOnChange.current(text),
        }),
      }),
    });
    view.current = editor;
    shownVersion.current = version;
    const key = registryKey ?? notePath;
    const unregister = key ? registerEditor(key, editor) : () => undefined;
    if (anchor) scrollToAnchor(editor, anchor);
    else if (autoFocus) {
      editor.focus();
      editor.dispatch({ selection: { anchor: editor.state.doc.length }, scrollIntoView: true });
    }
    return () => {
      unregister();
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    if (view.current && version !== shownVersion.current) {
      shownVersion.current = version;
      replaceEditorText(view.current, content, { remote: true });
    }
  }, [version, content]);

  return <div ref={host} className="editor" />;
}
