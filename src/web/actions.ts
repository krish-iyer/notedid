import { addCard, cardLine, cardsOf, parseBoard, serializeBoard } from '../shared/board.ts';
import { formatCapture } from '../shared/capture.ts';
import { journalPath, localISODate, localTime, localTimestamp } from '../shared/dates.ts';
import { tagify } from '../shared/slug.ts';
import { api, fetchNote, SaveConflict, saveNote } from './api.ts';
import { askConfirm, askText } from './dialogs.ts';
import { appendToEditor } from './editor/registry.ts';
import { navigate, noteHref } from './router.ts';
import { refreshNotes, resolveNote, updateSettings } from './stores.ts';
import { showToast } from './toast.ts';
import { messageOf, randomId } from './util.ts';

/** Actions used from several screens (sidebar, switcher, note headers). */

export async function createNote(title?: string | null): Promise<void> {
  const name = title ?? (await askText({ title: 'New note', placeholder: 'Title', confirmLabel: 'Create' }));
  if (!name) return;
  try {
    const { path } = await api.createNote(name);
    await refreshNotes();
    navigate(noteHref(path));
  } catch (err) {
    showToast(`Could not create the note: ${messageOf(err)}`, 'error');
  }
}

export async function createDashboard(): Promise<void> {
  const title = await askText({ title: 'New dashboard', placeholder: 'Name, e.g. Research', confirmLabel: 'Create' });
  if (!title) return;
  try {
    const { path } = await api.createDashboard(title);
    await refreshNotes();
    navigate(noteHref(path, 'dashboard'));
  } catch (err) {
    showToast(`Could not create the dashboard: ${messageOf(err)}`, 'error');
  }
}

export async function createBoard(): Promise<void> {
  const title = await askText({ title: 'New project board', placeholder: 'Project name', confirmLabel: 'Next' });
  if (!title) return;
  const tag = await askText({
    title: 'Project tag',
    message: 'A word, without # or brackets. Notes tagged #word show up in the board’s tray, ready to be placed.',
    initial: tagify(title),
    confirmLabel: 'Create board',
  });
  if (!tag) return;
  try {
    const { path } = await api.createBoard(title, tagify(tag) || tagify(title));
    await refreshNotes();
    navigate(noteHref(path, 'board'));
  } catch (err) {
    showToast(`Could not create the board: ${messageOf(err)}`, 'error');
  }
}

/** Adds a line to today's journal note: straight into the editor if it's open, else through the server. */
export async function captureToToday(text: string): Promise<void> {
  const today = localISODate();
  const path = journalPath(today);
  if (appendToEditor(path, formatCapture(text, localTime()))) return;
  try {
    await api.capture({ text, capturedAt: localTimestamp(), id: randomId() });
    showToast('Added to today', 'info', { label: 'Open', run: () => navigate('/') });
  } catch (err) {
    showToast(`Could not add it: ${messageOf(err)}`, 'error');
  }
}

export async function renameNote(path: string, currentTitle: string): Promise<void> {
  const title = await askText({ title: 'Rename note', initial: currentTitle, confirmLabel: 'Rename', message: 'Links to this note in other notes are updated too.' });
  if (!title || title === currentTitle) return;
  try {
    const result = await api.renameNote(path, title);
    await refreshNotes();
    navigate(noteHref(result.path), { replace: true });
    showToast(result.updated.length ? `Renamed, and updated links in ${result.updated.length} note${result.updated.length === 1 ? '' : 's'}` : 'Renamed');
  } catch (err) {
    showToast(`Could not rename: ${messageOf(err)}`, 'error');
  }
}

export async function deleteNote(path: string, title: string): Promise<void> {
  const ok = await askConfirm({ title: `Delete “${title}”?`, message: 'It moves to the trash folder in your notes, and stays in the history.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api.deleteNote(path);
    await refreshNotes();
    navigate('/notes', { replace: true });
    showToast(`Deleted “${title}”`);
  } catch (err) {
    showToast(`Could not delete: ${messageOf(err)}`, 'error');
  }
}

export async function togglePin(path: string): Promise<void> {
  try {
    await updateSettings((s) => ({ ...s, pinned: s.pinned.includes(path) ? s.pinned.filter((p) => p !== path) : [...s.pinned, path] }));
  } catch (err) {
    showToast(`Could not save: ${messageOf(err)}`, 'error');
  }
}

export async function saveView(query: string): Promise<void> {
  const name = await askText({ title: 'Save this search', message: `It appears in the sidebar and runs “${query}”.`, placeholder: 'Name', confirmLabel: 'Save' });
  if (!name) return;
  try {
    await updateSettings((s) => ({ ...s, views: [...s.views.filter((v) => v.name !== name), { name, query }] }));
    showToast(`Saved “${name}”`);
  } catch (err) {
    showToast(`Could not save: ${messageOf(err)}`, 'error');
  }
}

export async function removeView(name: string): Promise<void> {
  await updateSettings((s) => ({ ...s, views: s.views.filter((v) => v.name !== name) })).catch((err: unknown) => showToast(messageOf(err), 'error'));
}

/** How a card should name a note: its title, unless another note has the same title (then its path). */
export function cardTargetFor(notePath: string, title: string): string {
  return resolveNote(title)?.path === notePath ? title : notePath.replace(/\.md$/i, '');
}

/** Adds a note to a board's cluster as a [[link]] card, unless it's on the board already. */
/** Changes a note's text on disk (e.g. its properties), re-reading and retrying if it changed meanwhile. */
export async function updateNoteText(path: string, change: (content: string) => string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await fetchNote(path);
    const content = change(doc.content);
    if (content === doc.content) return;
    try {
      await saveNote({ path, content, baseHash: doc.hash });
      return;
    } catch (err) {
      if (!(err instanceof SaveConflict)) throw err;
    }
  }
  throw new Error('the note kept changing; try again');
}

export async function addToBoard(boardPath: string, clusterId: string, notePath: string, title: string): Promise<'added' | 'already'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await fetchNote(boardPath);
    const board = parseBoard(doc.content);
    const onBoard = board.clusters.flatMap(cardsOf).some((c) => c.kind === 'note' && c.target && resolveNote(c.target, boardPath)?.path === notePath);
    if (onBoard) return 'already';
    const content = serializeBoard(addCard(board, clusterId, cardLine('note', cardTargetFor(notePath, title))));
    try {
      await saveNote({ path: boardPath, content, baseHash: doc.hash });
      return 'added';
    } catch (err) {
      if (!(err instanceof SaveConflict)) throw err;
    }
  }
  throw new Error('the board kept changing; try again');
}

/**
 * Ctrl+K "Give every note an ID": notes made before notes had ids get one (an `id:` line in their
 * front matter), and copies sharing another note's id get their own. Asks first; nothing else changes.
 */
export async function giveNotesIds(): Promise<void> {
  try {
    const { notes, missing, copies } = await api.noteIdStatus();
    if (missing === 0 && copies === 0) {
      showToast(`All ${notes} note${notes === 1 ? ' has' : 's have'} an ID already.`);
      return;
    }
    const what = [missing ? `${missing} note${missing === 1 ? '' : 's'} without one` : '', copies ? `${copies} cop${copies === 1 ? 'y' : 'ies'} sharing another note’s` : ''].filter(Boolean).join(' and ');
    const ok = await askConfirm({
      title: 'Give every note an ID?',
      message: `An ID is a permanent name for a note that stays the same when you rename or move it. A note's history and syncing between devices go by it. This adds one line (id: and 12 random letters and digits) to the front matter of ${what}. Nothing else in your notes changes.`,
      confirmLabel: 'Add IDs',
    });
    if (!ok) return;
    const { added, renewed } = await api.assignNoteIds();
    await refreshNotes();
    const total = added + renewed;
    showToast(`${total} note${total === 1 ? '' : 's'} got an ID.`);
  } catch (err) {
    showToast(`Could not give notes IDs: ${messageOf(err)}`, 'error');
  }
}

/**
 * Ctrl+K "Export all notes": saves the whole notes folder as a zip (notes, PDFs, the vault still
 * encrypted, settings). Fetched first and saved from memory: a plain download link would bypass the
 * browser-only app's service worker, which is what holds the notes there.
 */
export async function exportNotes(): Promise<void> {
  try {
    showToast('Making the zip…');
    const response = await fetch('/api/export');
    if (!response.ok) throw new Error(`the app answered ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `notes-${localISODate()}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    showToast(`Could not export: ${messageOf(err)}`, 'error');
  }
}

/** Picks files (a folder, or one zip), for the import below. */
function pickFiles(options: { folder: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (options.folder) input.webkitdirectory = true;
    else input.accept = '.zip,application/zip';
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

/**
 * Ctrl+K "Import notes from a folder…" or "…from a .zip…": adds the notes, PDFs and other files
 * in it. Notes already here are never overwritten. A folder is zipped here first, leaving out
 * hidden folders such as .git.
 */
export async function importNotes(from: 'folder' | 'zip'): Promise<void> {
  const files = await pickFiles({ folder: from === 'folder' });
  if (files.length === 0) return;
  try {
    let zip: Blob;
    if (from === 'zip') {
      zip = files[0] as File;
    } else {
      const { zipSync } = await import('fflate');
      const entries: Record<string, Uint8Array> = {};
      for (const file of files) {
        const rel = file.webkitRelativePath || file.name;
        const hidden = rel.split('/').some((part, i) => part.startsWith('.') && !(i === 1 && (part === '.notedid' || part === '.notesapp')));
        if (!hidden) entries[rel] = new Uint8Array(await file.arrayBuffer());
      }
      zip = new Blob([zipSync(entries, { level: 0 })], { type: 'application/zip' });
    }
    showToast('Importing…');
    const result = await api.importNotes(zip);
    await refreshNotes();
    const parts = [`${result.added} file${result.added === 1 ? '' : 's'} added`];
    if (result.same) parts.push(`${result.same} already here`);
    if (result.kept.length) {
      const which = `${result.kept.slice(0, 3).join(', ')}${result.kept.length > 3 ? ', …' : ''}`;
      parts.push(`${result.kept.length} not replaced, because yours ${result.kept.length === 1 ? 'is' : 'are'} different (${which})`);
    }
    if (result.skipped.length) parts.push(`${result.skipped.length} skipped (not notes or files the app uses)`);
    showToast(`Imported: ${parts.join('; ')}.`);
  } catch (err) {
    showToast(`Could not import: ${messageOf(err)}`, 'error');
  }
}
