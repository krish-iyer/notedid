import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BacklinksResponse, HistoryEntry, HistoryResponse } from '../../shared/api.ts';
import { type DiffPart, diffStats, diffText } from '../../shared/diff.ts';
import { analyzeBody, lineIndex, splitFrontmatter } from '../../shared/markdown.ts';
import { giveNotesIds } from '../actions.ts';
import { api, fetchNote } from '../api.ts';
import { askConfirm } from '../dialogs.ts';
import { compareEditor, scrollEditorTo } from '../editor/registry.ts';
import { NO_SIDE_PANEL } from '../hooks.ts';
import { onServerEvent } from '../live.ts';
import { Link, noteHref } from '../router.ts';
import { showToast } from '../toast.ts';
import { messageOf, timeAgo } from '../util.ts';
import { Icon, type IconName } from './Icon.tsx';

type Tab = 'links' | 'outline' | 'history';

/** A line of markdown as plain text: [[a|b]] → b, [x](y) → x, no list or task markers. */
function plainLine(line: string): string {
  return line
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/^#+\s+/, '')
    .replace(/[*_`]+/g, '');
}

function useBacklinks(path: string): BacklinksResponse | null {
  const [data, setData] = useState<BacklinksResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api
        .backlinks(path)
        .then((d) => !cancelled && setData(d))
        .catch(() => undefined);
    void load();
    const stop = onServerEvent((event) => {
      if (event.type === 'changed' || event.type === 'deleted') {
        clearTimeout(timer);
        timer = setTimeout(load, 600);
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stop();
    };
  }, [path]);
  return data;
}

function LinksTab({ path, title }: { path: string; title: string }) {
  const data = useBacklinks(path);
  if (!data) return <p className="muted">Loading…</p>;
  const linkMention = async (m: BacklinksResponse['unlinked'][number]) => {
    try {
      await api.linkMention(m.path, m.line, m.term, path);
      showToast(`Linked “${m.term}” in ${m.title}`);
    } catch (err) {
      showToast(`Could not link it: ${messageOf(err)}`, 'error');
    }
  };
  return (
    <div className="panel-body">
      <h3>Linked from {data.linked.length ? `(${data.linked.length})` : ''}</h3>
      {data.linked.length === 0 && <p className="muted small">No notes link here yet. Type [[{title}]] in a note to link it.</p>}
      <ul className="ref-list">
        {data.linked.map((l) => (
          <li key={`${l.path}:${l.line}`}>
            <Link to={noteHref(l.path, undefined, `L${l.line}`)} className="ref-title">
              {l.title}
            </Link>
            <span className="ref-context">{plainLine(l.context)}</span>
          </li>
        ))}
      </ul>
      {data.unlinked.length > 0 && (
        <>
          <h3>Mentioned in, without a link ({data.unlinked.length})</h3>
          <ul className="ref-list">
            {data.unlinked.map((m) => (
              <li key={`${m.path}:${m.line}`}>
                <Link to={noteHref(m.path, undefined, `L${m.line}`)} className="ref-title">
                  {m.title}
                </Link>
                <span className="ref-context">{plainLine(m.context)}</span>
                <button type="button" className="link-button small" onClick={() => void linkMention(m)}>
                  Link it
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function OutlineTab({ path, content, onJump }: { path: string; content: string; onJump: () => void }) {
  const headings = useMemo(() => {
    const { bodyOffset } = splitFrontmatter(content);
    return analyzeBody(content.slice(bodyOffset), bodyOffset, lineIndex(content)).headings;
  }, [content]);
  if (headings.length === 0) return <p className="muted small panel-body">No headings yet. Lines starting with # become the outline.</p>;
  return (
    <ul className="outline panel-body">
      {headings.map((h, i) => (
        <li key={`${h.line}-${i}`} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              // From the panel over the note (a narrow screen), to the note: without a phone's keyboard opening.
              const over = window.matchMedia(NO_SIDE_PANEL).matches;
              scrollEditorTo(path, h.line, { focus: !over });
              onJump();
            }}
          >
            {h.text || '(untitled heading)'}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Unchanged text between changes: long stretches fold to a few lines of context. */
function unchanged(text: string, first: boolean, last: boolean, key: number): ReactNode {
  const lines = text.split('\n');
  const keep = 3;
  if (lines.length <= keep * 2 + 4) return <span key={key}>{text}</span>;
  const head = first ? [] : lines.slice(0, keep);
  const tail = last ? [] : lines.slice(-keep);
  const hidden = lines.length - head.length - tail.length;
  return (
    <span key={key}>
      {head.length > 0 && `${head.join('\n')}\n`}
      <span className="diff-fold">
        ⋯ {hidden} unchanged line{hidden === 1 ? '' : 's'} ⋯
      </span>
      {tail.length > 0 && `\n${tail.join('\n')}`}
    </span>
  );
}

function DiffView({ parts }: { parts: DiffPart[] }) {
  return (
    <pre className="version-text diff">
      {parts.map((p, i) => {
        if (p.kind === 'add') return <ins key={i}>{p.text}</ins>;
        if (p.kind === 'del') return <del key={i}>{p.text}</del>;
        return unchanged(p.text, i === 0, i === parts.length - 1, i);
      })}
    </pre>
  );
}

function whenLabel(date: string): string {
  return new Date(date).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * The note's saved versions (from the notes folder's git history). Opening one shows what changed
 * since then in the note itself, word by word, like tracked changes; it can also be restored.
 * `onShowChanges` is called when the changes are shown, for a page that has to switch to the note.
 */
export function HistoryTab({ path, current, onShowChanges }: { path: string; current?: string; onShowChanges?: () => void }) {
  const [log, setLog] = useState<HistoryResponse | 'failed' | null>(null);
  const [viewing, setViewing] = useState<{ entry: HistoryEntry; content: string; now: string; inEditor: boolean } | null>(null);
  const [mode, setMode] = useState<'changes' | 'version'>('changes');
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void api
        .history(path)
        .then((l) => !cancelled && setLog(l))
        .catch(() => !cancelled && setLog('failed'));
    load();
    // New versions are kept a minute or so after you stop typing.
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, loads]);

  const open = async (entry: HistoryEntry) => {
    try {
      const [version, now] = await Promise.all([api.version(path, entry.version), current === undefined ? fetchNote(path).then((d) => d.content) : Promise.resolve(current)]);
      const inEditor = compareEditor(path, { text: version.content, label: whenLabel(entry.date) });
      setViewing({ entry, content: version.content, now, inEditor });
      setMode('changes');
      if (inEditor) onShowChanges?.();
    } catch (err) {
      showToast(`Could not open that version: ${messageOf(err)}`, 'error');
    }
  };

  // Keep comparing with the text as it is now while you edit.
  useEffect(() => {
    if (current !== undefined) setViewing((v) => (v && v.now !== current ? { ...v, now: current } : v));
  }, [current]);

  const parts = useMemo(() => (viewing ? diffText(viewing.content, viewing.now) : []), [viewing]);
  const stats = useMemo(() => diffStats(parts), [parts]);

  const restore = async () => {
    if (!viewing) return;
    const ok = await askConfirm({ title: 'Restore this version?', message: 'It becomes the current text. The version you have now stays in the history.', confirmLabel: 'Restore' });
    if (!ok) return;
    try {
      await api.restoreNote(path, viewing.entry.version);
      compareEditor(path, null);
      setViewing(null);
      setLoads((n) => n + 1);
      showToast('Restored');
    } catch (err) {
      showToast(`Could not restore: ${messageOf(err)}`, 'error');
    }
  };

  if (!log) return <p className="muted panel-body">Loading…</p>;
  if (log === 'failed') return <p className="muted small panel-body">Could not load this note’s history.</p>;
  if (log.id === null)
    return (
      <div className="panel-body">
        <p className="muted small">This note has no ID yet, so no versions of it are kept. An ID is a permanent name for a note, which its history and syncing go by.</p>
        <button type="button" onClick={() => void giveNotesIds().then(() => setLoads((n) => n + 1))}>
          Give notes IDs…
        </button>
      </div>
    );
  const entries = log.versions;
  if (entries.length === 0) return <p className="muted small panel-body">No versions yet. Once you edit this note, its versions appear here: the text from before your edit, and a new version a minute or so after you stop typing.</p>;
  const unchangedSince = viewing !== null && viewing.content === viewing.now;
  return (
    <div className="panel-body">
      <ul className="history-list">
        {entries.map((e) => (
          <li key={e.version}>
            <button type="button" className={viewing?.entry.version === e.version ? 'history-item active' : 'history-item'} onClick={() => void open(e)}>
              <span>{timeAgo(Date.parse(e.date))}</span>
              <span className="muted small">{new Date(e.date).toLocaleString()}</span>
            </button>
          </li>
        ))}
      </ul>
      {viewing && (
        <div className="version">
          <div className="version-actions">
            <strong>{new Date(viewing.entry.date).toLocaleString()}</strong>
            <div className="segmented small" role="group" aria-label="Show">
              <button type="button" className={mode === 'changes' ? 'active' : ''} aria-pressed={mode === 'changes'} onClick={() => setMode('changes')}>
                Changes since
              </button>
              <button type="button" className={mode === 'version' ? 'active' : ''} aria-pressed={mode === 'version'} onClick={() => setMode('version')}>
                That version
              </button>
            </div>
          </div>
          {mode === 'changes' ? (
            <>
              <p className="muted small diff-summary">
                {unchangedSince ? (
                  'No changes since this version.'
                ) : (
                  <>
                    Since then: <ins>+{stats.added} word{stats.added === 1 ? '' : 's'}</ins> <del>−{stats.removed} word{stats.removed === 1 ? '' : 's'}</del>
                  </>
                )}
              </p>
              {!unchangedSince &&
                (viewing.inEditor ? (
                  <p className="small diff-in-note">
                    The changes are marked in the note: <ins>added text</ins> and <del>removed text</del>. Press <strong>Done</strong> at the top of the note to stop.
                  </p>
                ) : (
                  <DiffView parts={parts} />
                ))}
            </>
          ) : (
            <pre className="version-text">{viewing.content}</pre>
          )}
          <div className="version-actions">
            <button type="button" className="primary" disabled={unchangedSince} onClick={() => void restore()}>
              Restore this version
            </button>
            <button
              type="button"
              onClick={() => {
                compareEditor(path, null);
                setViewing(null);
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Where a page puts buttons of its own in the bar along the top of a phone's screen (App). */
export const BAR_SLOT = 'mobile-bar-actions';

/**
 * Opens a page's side panel, on a screen too narrow to show it beside the page: in the page's header, and on a
 * phone in the bar along the top of the screen instead, which stays in view however far down a note you are.
 */
export function PanelButton({ label, icon = 'panel', count, onClick }: { label: string; icon?: IconName; count?: number; onClick: () => void }) {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  useEffect(() => setBar(document.getElementById(BAR_SLOT)), []);
  const button = (where: 'in-head' | 'in-bar') => (
    <button type="button" className={`icon-button panel-toggle ${where}`} title={label} aria-label={label} onClick={onClick}>
      <Icon name={icon} />
      {count ? <span className="strip-count">{count}</span> : null}
    </button>
  );
  return (
    <>
      {button('in-head')}
      {bar && createPortal(button('in-bar'), bar)}
    </>
  );
}

/** Closes a side panel opened over the page (shown only then). */
export function PanelClose({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="icon-button panel-close" title="Close" aria-label="Close the panel" onClick={onClose}>
      <Icon name="close" />
    </button>
  );
}

/**
 * A page's side panel: beside the page on a wide screen. On a narrower one it opens from a PanelButton, over the
 * page: from the right, or from the bottom on a phone. A link followed from it closes it.
 */
export function PanelFrame({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('.panel-close')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      {open && <div className="panel-scrim" onClick={onClose} />}
      <aside ref={panel} className={open ? 'side-panel open' : 'side-panel'} aria-label={label} onClick={(e) => (e.target as Element).closest('a') && onClose()}>
        {children}
      </aside>
    </>
  );
}

/** Beside a note: what links here, its outline, and its history. */
export function SidePanel({ path, title, content, open, onClose }: { path: string; title: string; content: string; open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('links');
  return (
    <PanelFrame open={open} onClose={onClose} label="About this note">
      <div className="tabs" role="tablist">
        {(
          [
            ['links', 'link', 'Links'],
            ['outline', 'outline', 'Outline'],
            ['history', 'history', 'History'],
          ] as const
        ).map(([id, icon, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>
            <Icon name={icon} size={15} /> {label}
          </button>
        ))}
        <PanelClose onClose={onClose} />
      </div>
      {tab === 'links' && <LinksTab path={path} title={title} />}
      {tab === 'outline' && <OutlineTab path={path} content={content} onJump={onClose} />}
      {tab === 'history' && <HistoryTab path={path} current={content} onShowChanges={onClose} />}
    </PanelFrame>
  );
}
