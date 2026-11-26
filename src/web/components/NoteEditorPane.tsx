import { useEffect, useRef } from 'react';
import { MarkdownEditor } from '../editor/MarkdownEditor.tsx';
import type { SaveStatus } from '../noteSession.ts';
import { useNoteSession } from '../useNoteSession.ts';

const STATUS_TEXT: Record<SaveStatus, string> = {
  loading: 'Loading…',
  saved: 'Saved',
  unsaved: 'Editing',
  saving: 'Saving…',
  conflict: 'Changed elsewhere',
  error: 'Not saved',
  gone: 'Moved or deleted',
};

export function SaveBadge({ status }: { status: SaveStatus }) {
  return (
    <span className={`save-status save-${status}`} role="status">
      {STATUS_TEXT[status]}
    </span>
  );
}

interface NoteEditorPaneProps {
  path: string;
  label: string;
  anchor?: string | null;
  autoFocus?: boolean;
  placeholder?: string;
  /** Called (at most every half second) with the note's current text. */
  onContent?: (content: string) => void;
  onStatus?: (status: SaveStatus) => void;
}

/** A note's editor with autosave, plus the banners for conflicts, errors and deleted notes. */
export function NoteEditorPane({ path, label, anchor, autoFocus, placeholder, onContent, onStatus }: NoteEditorPaneProps) {
  const { state, edit, resolveConflict, content } = useNoteSession(path);
  const { status, error, conflict, editor } = state;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(onContent);
  latest.current = onContent;

  useEffect(() => onStatus?.(status), [status, onStatus]);
  useEffect(() => {
    if (editor) latest.current?.(editor.content);
  }, [editor]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onChange = (text: string) => {
    edit(text);
    if (latest.current) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => latest.current?.(content()), 500);
    }
  };

  return (
    <div className="note-pane">
      {conflict && (
        <div className="banner" role="alert">
          <p>This note was changed somewhere else while you were editing it.</p>
          <div className="banner-actions">
            <button type="button" onClick={() => resolveConflict('disk')}>
              Use the saved version
            </button>
            <button type="button" onClick={() => resolveConflict('mine')}>
              Keep my version
            </button>
          </div>
        </div>
      )}
      {status === 'gone' && (
        <div className="banner" role="alert">
          <p>This note was moved or deleted. Your text below is not saved anywhere.</p>
        </div>
      )}
      {status === 'error' && error && (
        <p className="error" role="alert">
          {editor ? `Couldn’t save (${error}). Trying again in a few seconds.` : `Couldn’t load this note: ${error}`}
        </p>
      )}
      {editor && (
        <MarkdownEditor
          content={editor.content}
          version={editor.version}
          onChange={onChange}
          label={label}
          notePath={path}
          anchor={anchor ?? null}
          autoFocus={autoFocus ?? false}
          placeholder={placeholder ?? 'Start typing…'}
        />
      )}
    </div>
  );
}
