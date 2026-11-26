import { useEffect, useRef, useState } from 'react';
import { parseBoard } from '../../shared/board.ts';
import { addToBoard, createBoard } from '../actions.ts';
import { fetchNote } from '../api.ts';
import { navigate, noteHref } from '../router.ts';
import { useNotes } from '../stores.ts';
import { showToast } from '../toast.ts';
import { messageOf } from '../util.ts';
import { Icon } from './Icon.tsx';

interface BoardChoice {
  path: string;
  kind: 'board' | 'dashboard';
  title: string;
  clusters: { id: string; title: string }[];
}

/** A button that puts this note (or paper) on a project board or a dashboard, in the cluster or tab you pick. */
export function AddToBoard({ path, title }: { path: string; title: string }) {
  const notes = useNotes();
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<BoardChoice[] | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBoards(null);
    void Promise.all(
      notes
        .filter((n) => n.kind === 'board' || n.kind === 'dashboard')
        .map(async (n): Promise<BoardChoice> => {
          const board = parseBoard((await fetchNote(n.path)).content);
          return { path: n.path, kind: n.kind === 'dashboard' ? 'dashboard' : 'board', title: board.title || n.title, clusters: board.clusters.map((c) => ({ id: c.id, title: c.title })) };
        }),
    )
      .then((list) => [...list.filter((b) => b.kind === 'board'), ...list.filter((b) => b.kind === 'dashboard')])
      .then((list) => !cancelled && setBoards(list))
      .catch((err: unknown) => showToast(`Could not load the boards: ${messageOf(err)}`, 'error'));
    const close = (event: MouseEvent) => !root.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => {
      cancelled = true;
      document.removeEventListener('mousedown', close);
    };
  }, [open]);

  const add = async (board: BoardChoice, clusterId: string, clusterTitle: string) => {
    setOpen(false);
    try {
      const result = await addToBoard(board.path, clusterId, path, title);
      showToast(result === 'added' ? `Added to ${board.title} › ${clusterTitle}` : `Already on ${board.title}`, 'info', {
        label: board.kind === 'dashboard' ? 'Open dashboard' : 'Open board',
        run: () => navigate(noteHref(board.path, board.kind)),
      });
    } catch (err) {
      showToast(`Could not add it: ${messageOf(err)}`, 'error');
    }
  };

  return (
    <div className="popover-wrap" ref={root}>
      <button type="button" className={open ? 'icon-button pressed' : 'icon-button'} title="Add to a board or dashboard" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="board" />
      </button>
      {open && (
        <div className="popover" role="menu" aria-label="Add to a board or dashboard">
          <p className="popover-title">Add to a board or dashboard</p>
          {!boards && <p className="muted small">Loading…</p>}
          {boards?.length === 0 && <p className="muted small">No boards or dashboards yet.</p>}
          {boards?.map((board) => (
            <div key={board.path} className="popover-group">
              <p className="popover-group-title">
                <Icon name={board.kind} size={13} /> {board.title}
              </p>
              {board.clusters.length === 0 && <p className="muted small">{board.kind === 'dashboard' ? 'This dashboard has no tabs.' : 'This board has no clusters.'}</p>}
              {board.clusters.map((c) => (
                <button key={c.id} type="button" role="menuitem" className="popover-item" onClick={() => void add(board, c.id, c.title)}>
                  {c.title}
                </button>
              ))}
            </div>
          ))}
          <button
            type="button"
            className="link-button small"
            onClick={() => {
              setOpen(false);
              void createBoard();
            }}
          >
            + New board
          </button>
        </div>
      )}
    </div>
  );
}
