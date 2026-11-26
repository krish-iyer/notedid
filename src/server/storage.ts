import type { NoteDoc } from '../shared/api.ts';
import { sha256Hex } from '../shared/sha256.ts';
import type { Disk } from './disk.ts';

/** Top-level folders the general file APIs never touch; they get their own APIs or none at all. */
const RESERVED_FOLDERS = new Set(['vault']);
const MAX_PATH_LENGTH = 512;
/** Strict UTF-8 that keeps a byte-order mark, so text round-trips exactly. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const NOTE_EXTENSIONS = ['.md'] as const;
export const DATA_EXTENSIONS = ['.json'] as const;
export const FILE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'] as const;

/** The path is not acceptable. */
export class PathError extends Error {
  override name = 'PathError';
}

/** The file isn't valid UTF-8, so editing it here could damage it. */
export class EncodingError extends Error {
  override name = 'EncodingError';
}

/** The file changed since the version an edit started from. */
export class ConflictError extends Error {
  override name = 'ConflictError';
  readonly current: NoteDoc;

  constructor(current: NoteDoc) {
    super(`${current.path} changed since it was loaded`);
    this.current = current;
  }
}

export function hashContent(content: string | Uint8Array): string {
  return sha256Hex(content);
}

/**
 * Checks a path sent by a client and returns its canonical form: relative, forward slashes,
 * no hidden segments, outside the reserved folders, and ending in one of `extensions`.
 */
export function normalizePath(input: unknown, extensions: readonly string[]): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_PATH_LENGTH) {
    throw new PathError('Invalid path');
  }
  const candidate = input.normalize('NFC');
  if (candidate.includes('\0') || candidate.includes('\\')) throw new PathError('Invalid path');
  if (candidate.startsWith('/')) throw new PathError('Paths must be relative');

  const segments = candidate.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw new PathError('Invalid path');
    if (segment.startsWith('.')) throw new PathError('Hidden files are not available');
  }
  const top = (segments[0] ?? '').toLowerCase();
  if (segments.length > 1 && RESERVED_FOLDERS.has(top)) {
    throw new PathError(`The ${top} folder is not available through this API`);
  }
  const lower = candidate.toLowerCase();
  if (!extensions.some((ext) => lower.endsWith(ext) && lower.length > ext.length)) {
    throw new PathError(`Expected a ${extensions.join(', ')} file`);
  }
  return candidate;
}

/** A note path: a `.md` file. */
export function normalizeNotePath(input: unknown): string {
  return normalizePath(input, NOTE_EXTENSIONS);
}

/**
 * Notes and other files inside the notes folder: text read and written as exact UTF-8, saves that
 * check the version they started from, and one write at a time per file. Where the files are is
 * the `Disk`'s business (a folder on a computer, or the browser's storage).
 */
export class NoteStore {
  readonly disk: Disk;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(disk: Disk) {
    this.disk = disk;
  }

  /** A note's content and hash (empty with a null hash when it doesn't exist). */
  async read(notePath: string): Promise<NoteDoc> {
    return this.readText(normalizeNotePath(notePath));
  }

  /**
   * Saves a note, but only if it is still the version the edit started from: `baseHash` is that
   * version's hash, or null when the note shouldn't exist yet. Otherwise throws ConflictError.
   * Saving content that is already on disk succeeds without writing (e.g. a retried request).
   */
  async write(notePath: string, content: string, baseHash: string | null): Promise<{ path: string; hash: string }> {
    return this.writeText(normalizeNotePath(notePath), content, baseHash);
  }

  /** Like read(), for any already-validated relative path to a text file. */
  async readText(rel: string): Promise<NoteDoc> {
    const bytes = await this.disk.read(rel);
    if (bytes === null) return { path: rel, content: '', hash: null };
    const content = decodeText(bytes);
    return { path: rel, content, hash: hashContent(content) };
  }

  /** Like write(), for any already-validated relative path to a text file. */
  async writeText(rel: string, content: string, baseHash: string | null): Promise<{ path: string; hash: string }> {
    return this.#oneAtATime(rel, async () => {
      const bytes = await this.disk.read(rel);
      const existing = bytes === null ? null : decodeText(bytes);
      const existingHash = existing === null ? null : hashContent(existing);
      const hash = hashContent(content);
      if (existingHash === hash) return { path: rel, hash };
      if (existingHash !== baseHash) {
        throw new ConflictError({ path: rel, content: existing ?? '', hash: existingHash });
      }
      await this.disk.write(rel, encoder.encode(content));
      return { path: rel, hash };
    });
  }

  /** Raw bytes of a validated path, or null if it doesn't exist. */
  async readBytes(rel: string): Promise<Uint8Array | null> {
    return this.disk.read(rel);
  }

  /** Creates a new file with these bytes; fails with PathError if it already exists. */
  async createBytes(rel: string, bytes: Uint8Array): Promise<void> {
    await this.#oneAtATime(rel, async () => {
      if ((await this.disk.stat(rel)) !== null) throw new PathError(`${rel} already exists`);
      await this.disk.write(rel, bytes);
    });
  }

  /** Moves a file to a new path inside the notes folder; fails if the target exists. */
  async move(fromRel: string, toRel: string): Promise<void> {
    await this.disk.move(fromRel, toRel);
  }

  async exists(rel: string): Promise<boolean> {
    return (await this.disk.stat(rel)) !== null;
  }

  async stat(rel: string): Promise<{ size: number; mtime: number } | null> {
    return this.disk.stat(rel);
  }

  /** Every file in the notes folder with one of `extensions`, leaving out hidden files and the reserved folders. */
  async list(extensions: readonly string[]): Promise<string[]> {
    return (await this.disk.list('')).filter((rel) => {
      const slash = rel.indexOf('/');
      if (slash > 0 && RESERVED_FOLDERS.has(rel.slice(0, slash).toLowerCase())) return false;
      const lower = rel.toLowerCase();
      return extensions.some((ext) => lower.endsWith(ext));
    });
  }

  /** Runs tasks for the same file one after another, so two writes can't interleave. */
  async #oneAtATime<T>(key: string, task: () => Promise<T>): Promise<T> {
    return serialize(this.#locks, key, task);
  }
}

const encoder = new TextEncoder();

function decodeText(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new EncodingError('This file is not valid UTF-8 text, so it is not opened here (saving could damage it)');
  }
}

/** Runs tasks with the same key one after another (keeps a promise per key in `locks`). */
export async function serialize<T>(locks: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  try {
    return await result;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
}
