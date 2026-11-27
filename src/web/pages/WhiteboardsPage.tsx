import { createWhiteboard } from '../actions.ts';
import { Icon } from '../components/Icon.tsx';
import { Link, noteHref } from '../router.ts';
import { useNotes } from '../stores.ts';
import { timeAgo } from '../util.ts';

/** Every whiteboard, the latest changed first. (Light: Excalidraw loads only with a whiteboard.) */
export function WhiteboardsPage() {
  const notes = useNotes();
  const boards = notes.filter((n) => n.kind === 'whiteboard').sort((a, b) => b.mtime - a.mtime);
  return (
    <div className="page narrow">
      <header className="page-head with-action">
        <h1>Whiteboards</h1>
        <button type="button" className="primary" onClick={() => void createWhiteboard()}>
          <Icon name="plus" size={16} /> New whiteboard
        </button>
      </header>
      <p className="muted">
        Drawings and diagrams, made with Excalidraw. Each is a .excalidraw file in the whiteboards folder, which the Excalidraw app opens too. Link one from a note with [[its name]], or one of
        its frames with [[its name#Frame]]. A dashboard can show one, and search finds the text on them.
      </p>
      {boards.length === 0 && <p className="muted">No whiteboards yet.</p>}
      <ul className="note-list">
        {boards.map((b) => (
          <li key={b.path}>
            <div className="note-row-head">
              <Icon name="whiteboard" size={15} />
              <Link to={noteHref(b.path, 'whiteboard')} className="result-title">
                {b.title}
              </Link>
              <span className="muted small">{timeAgo(b.mtime)}</span>
            </div>
            {b.excerpt && <p className="muted small whiteboard-excerpt">{b.excerpt}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
