import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerEvent } from './live.ts';
import { INITIAL_SESSION_STATE, NoteSession, type SessionState } from './noteSession.ts';

/**
 * Loads and autosaves the note at `path`, follows changes made to it elsewhere, and saves right
 * away when the page is hidden or the note is closed.
 */
export function useNoteSession(path: string) {
  const [state, setState] = useState<SessionState>(INITIAL_SESSION_STATE);
  const session = useRef<NoteSession | null>(null);

  useEffect(() => {
    const current = new NoteSession(path, setState);
    session.current = current;
    void current.load();

    const saveWhenHidden = () => {
      if (document.visibilityState === 'hidden') void current.flush({ keepalive: true });
    };
    const saveOnPageHide = () => void current.flush({ keepalive: true });
    document.addEventListener('visibilitychange', saveWhenHidden);
    window.addEventListener('pagehide', saveOnPageHide);
    const stopListening = onServerEvent((event) => {
      if (event.type === 'changed' && event.path === path) current.remoteChanged(event.hash);
      if (event.type === 'deleted' && event.path === path) current.remoteDeleted();
    });

    return () => {
      stopListening();
      document.removeEventListener('visibilitychange', saveWhenHidden);
      window.removeEventListener('pagehide', saveOnPageHide);
      current.close();
      if (session.current === current) session.current = null;
    };
  }, [path]);

  const edit = useCallback((content: string) => session.current?.edit(content), []);
  const resolveConflict = useCallback((choice: 'disk' | 'mine') => session.current?.resolveConflict(choice), []);
  const flush = useCallback(() => session.current?.flush() ?? Promise.resolve(), []);
  const content = useCallback(() => session.current?.content ?? '', []);

  return { state, edit, resolveConflict, flush, content };
}
