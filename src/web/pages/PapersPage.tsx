import { type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { PaperSummary } from '../../shared/api.ts';
import { toBibtex } from '../../shared/bibtex.ts';
import { addCluster, type Board, cardLine, parseBoard, renameCluster, serializeBoard } from '../../shared/board.ts';
import { addToCollection, COLLECTIONS_PATH, collectionsOf, deleteCollection, newCollectionsContent, type PaperCollection, removeFromCollection } from '../../shared/collections.ts';
import { setFrontmatterField } from '../../shared/frontmatter.ts';
import { PAPER_STATUSES, type PaperStatus } from '../../shared/papers.ts';
import { tagify } from '../../shared/slug.ts';
import { cardTargetFor, updateNoteText } from '../actions.ts';
import { api, fetchNote, SaveConflict, saveNote } from '../api.ts';
import { AddToBoard } from '../components/AddToBoard.tsx';
import { Icon } from '../components/Icon.tsx';
import { askConfirm, askText } from '../dialogs.ts';
import { useLiveData } from '../hooks.ts';
import { Link, navigate, noteHref } from '../router.ts';
import { notesStore, refreshNotes, resolveNote, useNotes } from '../stores.ts';
import { showToast } from '../toast.ts';
import { messageOf } from '../util.ts';

/*
 * The paper library, like Zotero's: on the left the whole library, the collections you make (a
 * paper can be in several), and filters by reading status and tag; a sortable table in the middle;
 * the selected paper's details on the right. Status, tags and details are written to the paper's
 * review note; collections to papers/collections.md (each ## heading a collection).
 */

const STATUS_LABEL = new Map(PAPER_STATUSES.map((s) => [s.value, s.label]));
const STATUS_ORDER: Record<PaperStatus, number> = { 'to-read': 0, reading: 1, read: 2 };

type Collection = 'all' | PaperStatus | 'unfiled' | 'nopdf' | `tag:${string}` | `col:${string}`;

const PAPER_DRAG = 'application/x-notesapp-papers';
type SortKey = 'title' | 'authors' | 'year' | 'venue' | 'added' | 'status' | 'highlights';
interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: 'title', label: 'Title', className: 'col-title' },
  { key: 'authors', label: 'Authors', className: 'col-authors' },
  { key: 'year', label: 'Year', className: 'col-year' },
  { key: 'venue', label: 'Venue', className: 'col-venue' },
  { key: 'added', label: 'Added', className: 'col-added' },
  { key: 'status', label: 'Status', className: 'col-status' },
  { key: 'highlights', label: 'Highlights', className: 'col-notes' },
];

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered in a private window.
  }
}

function lastName(author: string): string {
  return author.trim().split(/\s+/).pop() ?? '';
}

function authorsShort(authors: string[]): string {
  if (authors.length === 0) return '';
  if (authors.length === 1) return lastName(authors[0] ?? '');
  if (authors.length === 2) return `${lastName(authors[0] ?? '')} & ${lastName(authors[1] ?? '')}`;
  return `${lastName(authors[0] ?? '')} et al.`;
}

/** The date a paper was added: recorded on import, else the last change as the best guess. */
function addedOf(p: PaperSummary): string {
  if (p.added) return p.added;
  const d = new Date(p.mtime);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function compare(a: PaperSummary, b: PaperSummary, key: SortKey): number {
  const text = (x: string, y: string) => x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true });
  switch (key) {
    case 'title':
      return text(a.title, b.title);
    case 'authors':
      return text(lastName(a.authors[0] ?? '~'), lastName(b.authors[0] ?? '~'));
    case 'year':
      return (a.year ?? 0) - (b.year ?? 0);
    case 'venue':
      return text(a.venue ?? '~', b.venue ?? '~');
    case 'added':
      return text(addedOf(a), addedOf(b)) || a.mtime - b.mtime;
    case 'status':
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    case 'highlights':
      return a.highlights - b.highlights;
  }
}

function inCollection(p: PaperSummary, collection: Collection, collections: PaperCollection[]): boolean {
  if (collection === 'all') return true;
  if (collection === 'unfiled') return !collections.some((c) => c.paths.has(p.path));
  if (collection.startsWith('col:')) return collections.find((c) => c.title === collection.slice(4))?.paths.has(p.path) ?? false;
  if (collection === 'nopdf') return !p.pdf;
  if (collection.startsWith('tag:')) return p.tags.includes(collection.slice(4));
  return p.status === collection;
}

function bibOf(p: PaperSummary): string {
  return toBibtex({ key: p.key, title: p.title, authors: p.authors, year: p.year, venue: p.venue, doi: p.doi, arxiv: p.arxiv, url: p.url });
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-bibtex' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The text of the "## Abstract" section of a review note, if it has one. */
function abstractOf(content: string): string | null {
  const match = /^##\s+Abstract\s*$([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/im.exec(content);
  const text = match?.[1]?.trim();
  return text || null;
}

/** The selected paper: everything about it, and the changes you can make from the library. */
/** "Add to collection…": a plain list of the collections, and "New collection…". */
function CollectionPicker({ titles, onPick, onNew }: { titles: string[]; onPick: (title: string) => void; onNew: () => void }) {
  return (
    <select
      className="collection-picker"
      value=""
      aria-label="Add to collection"
      onChange={(e) => {
        const value = e.target.value;
        if (value === '\u0000new') onNew();
        else if (value) onPick(value);
      }}
    >
      <option value="">Add to collection…</option>
      {titles.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
      <option value={'\u0000new'}>New collection…</option>
    </select>
  );
}

interface CollectionActions {
  /** Every collection, by name. */
  titles: string[];
  /** The collections each paper is in. */
  of: (path: string) => string[];
  add: (title: string, paths: string[]) => void;
  remove: (title: string, paths: string[]) => void;
  create: (paths: string[]) => void;
}

function Details({ paper, collections, onChanged }: { paper: PaperSummary; collections: CollectionActions; onChanged: (path?: string) => void }) {
  const [abstract, setAbstract] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [form, setForm] = useState({ title: '', authors: '', year: '', venue: '', doi: '', arxiv: '', url: '' });

  useEffect(() => {
    let cancelled = false;
    setAbstract(null);
    setEditing(false);
    fetchNote(paper.path)
      .then((doc) => !cancelled && setAbstract(abstractOf(doc.content)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [paper.path]);

  const change = async (what: string, edit: (content: string) => string, path = paper.path) => {
    setBusy(true);
    try {
      await updateNoteText(path, edit);
      onChanged(path);
    } catch (err) {
      showToast(`Could not change the ${what}: ${messageOf(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (status: PaperStatus) => void change('status', (c) => setFrontmatterField(c, 'status', status));
  const setTags = (tags: string[]) => void change('tags', (c) => setFrontmatterField(c, 'tags', tags));

  const addTag = () => {
    const tag = tagify(newTag);
    setNewTag('');
    if (tag && !paper.metaTags.includes(tag)) setTags([...paper.metaTags, tag]);
  };

  const startEditing = () => {
    setForm({
      title: paper.title,
      authors: paper.authors.join('\n'),
      year: paper.year ? String(paper.year) : '',
      venue: paper.venue ?? '',
      doi: paper.doi ?? '',
      arxiv: paper.arxiv ?? '',
      url: paper.url ?? '',
    });
    setEditing(true);
  };

  const saveDetails = async () => {
    setBusy(true);
    try {
      let path = paper.path;
      // A new title renames the note and updates links to it, like renaming any note.
      if (form.title.trim() && form.title.trim() !== paper.title) path = (await api.renameNote(path, form.title.trim())).path;
      const year = Number(form.year.trim());
      await updateNoteText(path, (c) => {
        let next = setFrontmatterField(
          c,
          'authors',
          form.authors
            .split(/\n|;/)
            .map((a) => a.trim())
            .filter(Boolean),
        );
        next = setFrontmatterField(next, 'year', Number.isInteger(year) && year > 0 ? year : null);
        for (const key of ['venue', 'doi', 'arxiv', 'url'] as const) next = setFrontmatterField(next, key, form[key].trim() || null);
        return next;
      });
      await refreshNotes();
      setEditing(false);
      onChanged(path);
    } catch (err) {
      showToast(`Could not save the details: ${messageOf(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyBibtex = async () => {
    try {
      await navigator.clipboard.writeText(bibOf(paper));
      showToast('BibTeX copied');
    } catch {
      download(`${paper.key}.bib`, bibOf(paper));
    }
  };

  const bodyTags = paper.tags.filter((t) => !paper.metaTags.includes(t));
  return (
    <aside className="library-details" aria-label="Paper details">
      <h2>{paper.title}</h2>
      <p className="muted small">{[paper.authors.join(', '), paper.year, paper.venue].filter(Boolean).join(' · ') || 'No details yet: use Edit details.'}</p>
      <div className="library-actions">
        <Link to={noteHref(paper.path, 'paper')} className="button primary">
          <Icon name="paper" size={15} /> Open
        </Link>
        <button type="button" onClick={() => void copyBibtex()}>
          Copy BibTeX
        </button>
        <AddToBoard path={paper.path} title={paper.title} />
      </div>

      <h3>Status</h3>
      <div className="segmented small" role="group" aria-label="Reading status">
        {PAPER_STATUSES.map((s) => (
          <button key={s.value} type="button" disabled={busy} className={paper.status === s.value ? 'active' : ''} aria-pressed={paper.status === s.value} onClick={() => setStatus(s.value)}>
            {s.label}
          </button>
        ))}
      </div>

      <h3>Tags</h3>
      <div className="tag-row">
        {paper.metaTags.map((t) => (
          <span key={t} className="tag-chip removable">
            #{t}
            <button type="button" aria-label={`Remove the tag ${t}`} title="Remove" disabled={busy} onClick={() => setTags(paper.metaTags.filter((x) => x !== t))}>
              ×
            </button>
          </span>
        ))}
        {bodyTags.map((t) => (
          <span key={t} className="tag-chip" title="Written as #tag in the review note">
            #{t}
          </span>
        ))}
        <form
          className="tag-add"
          onSubmit={(e) => {
            e.preventDefault();
            addTag();
          }}
        >
          <input className="text-input" value={newTag} placeholder="+ tag" aria-label="Add a tag" onChange={(e) => setNewTag(e.target.value)} />
        </form>
      </div>

      <h3>Collections</h3>
      <div className="tag-row">
        {collections.of(paper.path).map((t) => (
          <span key={t} className="collection-chip">
            {t}
            <button type="button" aria-label={`Take it out of ${t}`} title={`Take it out of “${t}” (it stays in the library)`} onClick={() => collections.remove(t, [paper.path])}>
              ×
            </button>
          </span>
        ))}
        <CollectionPicker titles={collections.titles.filter((t) => !collections.of(paper.path).includes(t))} onPick={(t) => collections.add(t, [paper.path])} onNew={() => collections.create([paper.path])} />
      </div>

      {editing ? (
        <form
          className="library-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void saveDetails();
          }}
        >
          {(
            [
              ['title', 'Title'],
              ['year', 'Year'],
              ['venue', 'Venue (journal or conference)'],
              ['doi', 'DOI'],
              ['arxiv', 'arXiv ID'],
              ['url', 'Web page'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <span>{label}</span>
              <input className="text-input" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
            </label>
          ))}
          <label>
            <span>Authors (one per line)</span>
            <textarea rows={4} value={form.authors} onChange={(e) => setForm({ ...form, authors: e.target.value })} />
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <h3>Details</h3>
          <dl className="library-fields">
            <dt>PDF</dt>
            <dd>{paper.pdf ? 'Yes' : 'Not yet (open the paper to add it)'}</dd>
            <dt>Highlights</dt>
            <dd>{paper.highlights}</dd>
            <dt>Added</dt>
            <dd>{paper.added ?? `${addedOf(paper)} (last changed)`}</dd>
            {paper.doi && (
              <>
                <dt>DOI</dt>
                <dd>
                  <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noopener noreferrer">
                    {paper.doi}
                  </a>
                </dd>
              </>
            )}
            {paper.arxiv && (
              <>
                <dt>arXiv</dt>
                <dd>
                  <a href={`https://arxiv.org/abs/${paper.arxiv}`} target="_blank" rel="noopener noreferrer">
                    {paper.arxiv}
                  </a>
                </dd>
              </>
            )}
            {paper.url && (
              <>
                <dt>Web</dt>
                <dd>
                  <a href={paper.url} target="_blank" rel="noopener noreferrer">
                    {paper.url.replace(/^https?:\/\//, '')}
                  </a>
                </dd>
              </>
            )}
          </dl>
          <button type="button" className="link-button small" onClick={startEditing}>
            Edit details
          </button>
          {abstract && (
            <>
              <h3>Abstract</h3>
              <p className="library-abstract">{abstract}</p>
            </>
          )}
        </>
      )}
    </aside>
  );
}

/** Several papers selected: put them in a collection, take them out, set their status, copy their BibTeX. */
function ManyDetails({ papers, viewing, collections, onChanged }: { papers: PaperSummary[]; viewing: string | null; collections: CollectionActions; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const paths = papers.map((p) => p.path);
  const setStatus = async (status: PaperStatus) => {
    setBusy(true);
    try {
      for (const p of papers) await updateNoteText(p.path, (c) => setFrontmatterField(c, 'status', status));
      showToast(`${papers.length} papers marked “${STATUS_LABEL.get(status)}”`);
      onChanged();
    } catch (err) {
      showToast(`Could not change the status: ${messageOf(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    const text = papers.map(bibOf).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast(`BibTeX for ${papers.length} papers copied`);
    } catch {
      download('selection.bib', text);
    }
  };
  return (
    <aside className="library-details" aria-label="Selected papers">
      <h2>{papers.length} papers selected</h2>
      <div className="library-actions">
        <CollectionPicker titles={collections.titles} onPick={(t) => collections.add(t, paths)} onNew={() => collections.create(paths)} />
        {viewing && (
          <button type="button" onClick={() => collections.remove(viewing, paths)}>
            Remove from “{viewing}”
          </button>
        )}
      </div>
      <h3>Status</h3>
      <div className="segmented small" role="group" aria-label="Set the reading status of all of them">
        {PAPER_STATUSES.map((s) => (
          <button key={s.value} type="button" disabled={busy} className={papers.every((p) => p.status === s.value) ? 'active' : ''} onClick={() => void setStatus(s.value)}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="library-actions">
        <button type="button" onClick={() => void copy()}>
          Copy BibTeX
        </button>
      </div>
      <ul className="library-selection">
        {papers.map((p) => (
          <li key={p.path}>{p.title}</li>
        ))}
      </ul>
    </aside>
  );
}

export function PapersPage() {
  const { data, error, reload } = useLiveData(() => api.papers(), []);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [collection, setCollectionState] = useState<Collection>(() => readJson<Collection>('notesapp-library-collection', 'all'));
  const [sort, setSortState] = useState<Sort>(() => readJson<Sort>('notesapp-library-sort', { key: 'added', dir: -1 }));
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [draggingPaths, setDraggingPaths] = useState<string[] | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const notes = useNotes();
  const { data: collectionsDoc, reload: reloadCollections } = useLiveData(() => fetchNote(COLLECTIONS_PATH), []);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const table = useRef<HTMLDivElement>(null);

  const setCollection = (c: Collection) => {
    setCollectionState(c);
    writeJson('notesapp-library-collection', c);
  };
  const sortBy = (key: SortKey) => {
    const next: Sort = sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: key === 'added' || key === 'year' || key === 'highlights' ? -1 : 1 };
    setSortState(next);
    writeJson('notesapp-library-sort', next);
  };

  const all = data ?? [];
  const resolvePath = (target: string) => resolveNote(target, COLLECTIONS_PATH)?.path ?? null;
  const collections = useMemo(
    () => collectionsOf(parseBoard(collectionsDoc?.content || newCollectionsContent()), resolvePath).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })),
    [collectionsDoc, notes],
  );
  const viewing = collection.startsWith('col:') ? collection.slice(4) : null;

  /** Changes papers/collections.md, re-reading and retrying if it changed meanwhile. */
  const changeCollections = async (change: (board: Board) => Board, done?: string) => {
    try {
      for (let attempt = 0; ; attempt++) {
        const doc = await fetchNote(COLLECTIONS_PATH);
        const content = serializeBoard(change(parseBoard(doc.content || newCollectionsContent())));
        if (content === doc.content) break;
        try {
          await saveNote({ path: COLLECTIONS_PATH, content, baseHash: doc.hash });
          break;
        } catch (err) {
          if (!(err instanceof SaveConflict) || attempt >= 2) throw err;
        }
      }
      reloadCollections();
      if (done) showToast(done);
    } catch (err) {
      showToast(`Could not change the collections: ${messageOf(err)}`, 'error');
    }
  };
  const idOf = (board: Board, title: string) => board.clusters.find((c) => c.title === title)?.id ?? '';
  const linesFor = (paths: string[]) =>
    paths.map((path) => {
      const note = (notesStore.get() ?? []).find((n) => n.path === path);
      return { path, line: cardLine('note', cardTargetFor(path, note?.title ?? path.replace(/\.md$/, ''))) };
    });
  const plural = (paths: string[]) => (paths.length === 1 ? 'the paper' : `${paths.length} papers`);
  const collectionActions: CollectionActions = {
    titles: collections.map((c) => c.title),
    of: (path) => collections.filter((c) => c.paths.has(path)).map((c) => c.title),
    add: (title, paths) => void changeCollections((b) => addToCollection(b, idOf(b, title), linesFor(paths), resolvePath), `Added ${plural(paths)} to “${title}”`),
    remove: (title, paths) =>
      void changeCollections((b) => removeFromCollection(b, idOf(b, title), new Set(paths), resolvePath)).then(() =>
        showToast(`Took ${plural(paths)} out of “${title}”`, 'info', { label: 'Undo', run: () => void changeCollections((b) => addToCollection(b, idOf(b, title), linesFor(paths), resolvePath)) }),
      ),
    create: (paths) => void createCollection(paths),
  };
  const movePapers = (from: string, to: string, paths: string[]) =>
    void changeCollections((b) => addToCollection(removeFromCollection(b, idOf(b, from), new Set(paths), resolvePath), idOf(b, to), linesFor(paths), resolvePath), `Moved ${plural(paths)} to “${to}”`);

  const createCollection = async (paths: string[] = []) => {
    const title = await askText({ title: 'New collection', placeholder: 'Name, e.g. Thesis', confirmLabel: 'Create' });
    if (!title) return;
    if (collections.some((c) => c.title === title)) return showToast(`There is already a collection called “${title}”`, 'error');
    await changeCollections((b) => {
      const next = addCluster(b, title);
      return paths.length ? addToCollection(next, idOf(next, title), linesFor(paths), resolvePath) : next;
    }, paths.length ? `Made “${title}” with ${plural(paths)}` : undefined);
    if (!paths.length) setCollection(`col:${title}`);
  };
  const renameCollection = async (title: string) => {
    const next = await askText({ title: 'Rename collection', initial: title, confirmLabel: 'Rename' });
    if (!next || next === title) return;
    if (collections.some((c) => c.title === next)) return showToast(`There is already a collection called “${next}”`, 'error');
    await changeCollections((b) => renameCluster(b, idOf(b, title), next));
    setCollection(`col:${next}`);
  };
  const removeCollection = async (c: PaperCollection) => {
    const ok = await askConfirm({
      title: `Delete the collection “${c.title}”?`,
      message: c.paths.size ? `Its ${c.paths.size} paper${c.paths.size === 1 ? '' : 's'} stay in your library (and in any other collection).` : undefined,
      confirmLabel: 'Delete collection',
      danger: true,
    });
    if (!ok) return;
    await changeCollections((b) => deleteCollection(b, idOf(b, c.title)), `Deleted “${c.title}”`);
    setCollection('all');
  };

  const counts = useMemo(() => {
    const count = (c: Collection) => all.filter((p) => inCollection(p, c, collections)).length;
    return { all: all.length, 'to-read': count('to-read'), reading: count('reading'), read: count('read'), unfiled: count('unfiled'), nopdf: count('nopdf') } as Record<string, number>;
  }, [all, collections]);
  const tags = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of all) for (const t of p.tags) map.set(t, (map.get(t) ?? 0) + 1);
    return [...map].sort((a, b) => a[0].localeCompare(b[0]));
  }, [all]);

  const papers = useMemo(() => {
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all
      .filter((p) => inCollection(p, collection, collections))
      .filter((p) => {
        if (words.length === 0) return true;
        const text = [p.title, ...p.authors, p.venue ?? '', p.year ?? '', p.doi ?? '', p.arxiv ?? '', ...p.tags.map((t) => `#${t}`)].join(' ').toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .sort((a, b) => sort.dir * compare(a, b, sort.key) || compare(a, b, 'title'));
  }, [all, filter, collection, sort, collections]);

  const chosen = papers.filter((p) => selected.includes(p.path));
  const current = chosen.length === 1 ? (chosen[0] ?? null) : null;

  // Keep the selected row in view when moving with the keyboard.
  useEffect(() => {
    if (anchor.current) table.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(anchor.current)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  /** Click: select one. Ctrl/⌘-click: add or drop one. Shift-click: select a range. */
  const onRowClick = (event: ReactMouseEvent, path: string, index: number) => {
    const from = papers.findIndex((p) => p.path === anchor.current);
    if (event.shiftKey && from >= 0) {
      setSelected(papers.slice(Math.min(from, index), Math.max(from, index) + 1).map((p) => p.path));
      return;
    }
    anchor.current = path;
    if (event.ctrlKey || event.metaKey) setSelected(selected.includes(path) ? selected.filter((p) => p !== path) : [...selected, path]);
    else setSelected([path]);
  };

  const onTableKey = (event: KeyboardEvent) => {
    const at = papers.findIndex((p) => p.path === anchor.current);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = papers[Math.max(0, Math.min(papers.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        anchor.current = next.path;
        setSelected([next.path]);
      }
    } else if (event.key === 'Enter' && current) {
      navigate(noteHref(current.path, 'paper'));
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && viewing && chosen.length) {
      event.preventDefault();
      collectionActions.remove(viewing, chosen.map((p) => p.path));
    }
  };

  /** Dropping papers on a collection adds them; with Shift (from another collection) it moves them. */
  const dropTarget = (title: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!draggingPaths || !e.dataTransfer.types.includes(PAPER_DRAG)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.shiftKey && viewing && viewing !== title ? 'move' : 'copy';
      setDropOn(title);
    },
    onDragLeave: (e: DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropOn(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const paths = draggingPaths ?? [];
      setDropOn(null);
      setDraggingPaths(null);
      if (!paths.length) return;
      if (e.shiftKey && viewing && viewing !== title) movePapers(viewing, title, paths);
      else collectionActions.add(title, paths);
    },
  });

  const afterAdding = async (path: string | null, message: string | null) => {
    await refreshNotes();
    reload();
    if (path) {
      anchor.current = path;
      setSelected([path]);
      // Added while looking at a collection: it goes in that collection too.
      if (viewing) collectionActions.add(viewing, [path]);
    }
    if (message) showToast(message);
  };

  const importPaper = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.importPaper(source.trim());
      setSource('');
      await afterAdding(result.path, result.existing ? 'That paper is already in the library' : result.pdf ? 'Imported, with its PDF' : 'Imported the details. Open the paper to add its PDF.');
    } catch (err) {
      setProblem(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (files: File[]) => {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (pdfs.length < files.length) showToast('Only PDF files can be added as papers', 'error');
    let last: string | null = null;
    for (const file of pdfs) {
      try {
        last = (await api.uploadPaper(file)).path;
      } catch (err) {
        showToast(`Could not add ${file.name}: ${messageOf(err)}`, 'error');
      }
    }
    if (pdfs.length) await afterAdding(last, pdfs.length === 1 ? 'Added. Use Edit details to fill in the authors and year.' : `Added ${pdfs.length} PDFs`);
  };

  const collectionName = collection === 'all' ? 'library' : collection.replace(/^(tag|col):/, '');
  const libraryViews: { id: Collection; label: string }[] = [
    { id: 'all', label: 'All papers' },
    { id: 'unfiled', label: 'Unfiled' },
    { id: 'nopdf', label: 'No PDF yet' },
  ];
  const view = (id: Collection, label: string, count: number) => (
    <button key={id} type="button" className={collection === id ? 'active' : ''} aria-pressed={collection === id} onClick={() => setCollection(id)}>
      <span>{label}</span>
      <span className="count">{count}</span>
    </button>
  );

  return (
    <div
      className={dragging ? 'library-page dropping' : 'library-page'}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        void upload([...e.dataTransfer.files]);
      }}
    >
      <header className="library-head">
        <h1>Papers</h1>
        <form
          className="add-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (source.trim()) void importPaper();
          }}
        >
          <input className="text-input" value={source} placeholder="Add by arXiv link or ID, or DOI" aria-label="arXiv link, arXiv ID or DOI" onChange={(e) => setSource(e.target.value)} />
          <button type="submit" className="primary" disabled={busy || !source.trim()}>
            {busy ? 'Importing…' : 'Import'}
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={16} /> Add PDF
          </button>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => void upload([...(e.target.files ?? [])])} />
        </form>
        {problem && <p className="error">{problem}</p>}
      </header>

      <div className="library">
        <nav className="library-collections" aria-label="Collections">
          <p className="library-section">My library</p>
          {libraryViews.map((v) => view(v.id, v.label, counts[v.id] ?? 0))}

          <p className="library-section with-action">
            Collections
            <button type="button" className="icon-button" title="New collection" aria-label="New collection" onClick={() => void createCollection()}>
              <Icon name="plus" size={14} />
            </button>
          </p>
          {collections.length === 0 && <p className="muted small library-none">None yet. Make one with +, then drag papers onto it.</p>}
          {collections.map((c) => {
            const id: Collection = `col:${c.title}`;
            const active = collection === id;
            return (
              <div key={c.id} className={`library-collection${active ? ' active' : ''}${dropOn === c.title ? ' drop-target' : ''}`} {...dropTarget(c.title)}>
                <button type="button" className={active ? 'active' : ''} aria-pressed={active} title="Double-click to rename" onClick={() => setCollection(id)} onDoubleClick={() => void renameCollection(c.title)}>
                  <span>
                    <Icon name="folder" size={13} /> {c.title}
                  </span>
                  <span className="count">{[...c.paths].filter((p) => all.some((x) => x.path === p)).length}</span>
                </button>
                {active && (
                  <>
                    <button type="button" className="icon-button" title="Rename" aria-label={`Rename ${c.title}`} onClick={() => void renameCollection(c.title)}>
                      <Icon name="edit" size={13} />
                    </button>
                    <button type="button" className="icon-button" title="Delete the collection (papers stay)" aria-label={`Delete ${c.title}`} onClick={() => void removeCollection(c)}>
                      <Icon name="trash" size={13} />
                    </button>
                  </>
                )}
              </div>
            );
          })}

          <p className="library-section">Reading status</p>
          {PAPER_STATUSES.map((s) => view(s.value, s.label, counts[s.value] ?? 0))}
          {tags.length > 0 && <p className="library-section">Tags</p>}
          {tags.map(([t, n]) => view(`tag:${t}`, `#${t}`, n))}
        </nav>

        <section className="library-main" aria-label="Papers">
          <div className="library-toolbar">
            <input className="text-input" value={filter} placeholder="Search title, author, venue, year, DOI or #tag" aria-label="Search the library" onChange={(e) => setFilter(e.target.value)} />
            <span className="muted small">
              {papers.length} paper{papers.length === 1 ? '' : 's'}
            </span>
            <button type="button" disabled={papers.length === 0} title="Download these papers as a BibTeX file" onClick={() => download(`${collectionName}.bib`, papers.map(bibOf).join('\n'))}>
              Export .bib
            </button>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="library-table" ref={table} tabIndex={0} role="grid" aria-label="Papers" onKeyDown={onTableKey}>
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={c.className} aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => sortBy(c.key)}>
                        {c.label}
                        {sort.key === c.key && <span aria-hidden="true">{sort.dir === 1 ? ' ▲' : ' ▼'}</span>}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {papers.map((p, i) => (
                  <tr
                    key={p.path}
                    data-path={p.path}
                    className={selected.includes(p.path) ? 'selected' : ''}
                    aria-selected={selected.includes(p.path)}
                    draggable
                    onDragStart={(e) => {
                      const paths = selected.includes(p.path) ? chosen.map((x) => x.path) : [p.path];
                      if (!selected.includes(p.path)) setSelected([p.path]);
                      e.dataTransfer.setData(PAPER_DRAG, JSON.stringify(paths));
                      e.dataTransfer.setData('text/plain', paths.length === 1 ? p.title : `${paths.length} papers`);
                      e.dataTransfer.effectAllowed = 'copyMove';
                      setDraggingPaths(paths);
                    }}
                    onDragEnd={() => {
                      setDraggingPaths(null);
                      setDropOn(null);
                    }}
                    onClick={(e) => onRowClick(e, p.path, i)}
                    onDoubleClick={() => navigate(noteHref(p.path, 'paper'))}
                  >
                    <td className="col-title">
                      <div className="library-title-cell">
                        <span className="library-title">{p.title}</span>
                        {!p.pdf && <span className="badge muted">no PDF</span>}
                      </div>
                    </td>
                    <td className="col-authors">{authorsShort(p.authors)}</td>
                    <td className="col-year">{p.year ?? ''}</td>
                    <td className="col-venue">{p.venue ?? ''}</td>
                    <td className="col-added">{addedOf(p)}</td>
                    <td className="col-status">
                      <span className={`badge status-${p.status}`}>{STATUS_LABEL.get(p.status)}</span>
                    </td>
                    <td className="col-notes">{p.highlights || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && all.length === 0 && <p className="muted library-empty">No papers yet. Import one by arXiv link or DOI, or drop PDFs anywhere on this page.</p>}
            {data && all.length > 0 && papers.length === 0 && <p className="muted library-empty">No papers here.</p>}
          </div>
          <p className="muted small library-hint">
            Click a paper for its details; Ctrl/⌘-click or Shift-click to pick several. Drag papers onto a collection to add them (hold Shift to move them from this one). Double-click or Enter opens; Delete takes them
            out of the collection you are in.
          </p>
        </section>

        {current ? (
          <Details
            paper={current}
            collections={collectionActions}
            onChanged={(path) => {
              reload();
              if (path) {
                anchor.current = path;
                setSelected([path]);
              }
            }}
          />
        ) : chosen.length > 1 ? (
          <ManyDetails papers={chosen} viewing={viewing} collections={collectionActions} onChanged={reload} />
        ) : (
          <aside className="library-details empty" aria-label="Paper details">
            <p className="muted">Select a paper to see its details, put it in collections, change its status and tags, or copy its BibTeX.</p>
          </aside>
        )}
      </div>
    </div>
  );
}
