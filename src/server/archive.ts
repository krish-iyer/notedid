import { unzipSync, type Zippable, zipSync } from 'fflate';
import type { Disk } from './disk.ts';
import { SettingsStore } from './settings.ts';
import { DATA_EXTENSIONS, FILE_EXTENSIONS, NOTE_EXTENSIONS, normalizePath, PathError } from './storage.ts';

/**
 * The whole notes folder as one zip, and back: a backup you can keep anywhere, and the way notes get
 * into (or out of) the browser-only app. Importing never overwrites a file that is already there.
 */

/** The app's own top-level folders (a zip whose files all sit in one other folder was made from that folder). */
const APP_FOLDERS = new Set(['notes', 'journal', 'papers', 'boards', 'dashboards', 'files', 'trash', 'vault', '.notesapp']);
/** Formats that are compressed already: stored as they are. */
const COMPRESSED = /\.(pdf|png|jpe?g|gif|webp)$/i;
const VAULT_FILE = /^vault\/(key\.json|[0-9a-f]{32}\.bin|trash\/[0-9a-f]{32}-\d+\.bin)$/;
const EXTENSIONS = [...NOTE_EXTENSIONS, ...DATA_EXTENSIONS, ...FILE_EXTENSIONS];

/** Every file in the notes folder: notes, PDFs and pictures, data, the trash, the vault (still encrypted) and the settings. */
export async function exportZip(disk: Disk): Promise<Uint8Array> {
  const files: Zippable = {};
  for (const rel of [...(await disk.list('')), SettingsStore.FILE]) {
    const bytes = await disk.read(rel);
    if (bytes) files[rel] = [bytes, { level: COMPRESSED.test(rel) ? 0 : 6 }];
  }
  return zipSync(files);
}

/** A file an import may add: the app's kinds of files, its vault files and its settings; nothing hidden or outside. */
export function importable(rel: string): boolean {
  if (rel === SettingsStore.FILE || VAULT_FILE.test(rel)) return true;
  try {
    return normalizePath(rel, EXTENSIONS) === rel;
  } catch {
    return false;
  }
}

/** The folder a zip was made from, when all its files are in one folder that isn't one of the app's ("dev-notes"). */
function madeFrom(names: readonly string[]): string | null {
  const first = names[0]?.split('/')[0];
  if (!first || APP_FOLDERS.has(first)) return null;
  return names.every((name) => name.startsWith(`${first}/`)) ? first : null;
}

export interface ImportResult {
  /** Files added. */
  added: number;
  /** Files that were here already, the same. */
  same: number;
  /** Files here already with different content: left as they were. */
  kept: string[];
  /** Files that aren't the app's (other kinds, hidden, unsafe paths). */
  skipped: string[];
}

/** Adds the files in a zip (an export, or a zipped notes folder) to the notes folder. */
export async function importZip(disk: Disk, zip: Uint8Array): Promise<ImportResult> {
  let entries: ReturnType<typeof unzipSync>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw new PathError('That file is not a zip the app can read');
  }
  const names = Object.keys(entries).filter((name) => !name.endsWith('/') && !name.startsWith('__MACOSX/'));
  const root = madeFrom(names);
  const result: ImportResult = { added: 0, same: 0, kept: [], skipped: [] };
  for (const name of names) {
    const rel = (root ? name.slice(root.length + 1) : name).normalize('NFC');
    const bytes = entries[name];
    if (!bytes || !importable(rel)) {
      if (!/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(rel)) result.skipped.push(rel);
      continue;
    }
    const existing = await disk.read(rel);
    if (existing === null) {
      await disk.write(rel, bytes);
      result.added++;
    } else if (existing.length === bytes.length && existing.every((b, i) => b === bytes[i])) {
      result.same++;
    } else {
      result.kept.push(rel);
    }
  }
  return result;
}
