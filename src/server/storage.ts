import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteDoc } from '../shared/api.ts';

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
  return createHash('sha256').update(content).digest('hex');
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

/** Reads and writes files inside the notes folder, refusing anything that would leave it. */
export class NoteStore {
  readonly root: string;
  #realRoot: string | null = null;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Creates the notes folder if needed. Call once before using the store. */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.#realRoot = await fs.realpath(this.root);
  }

  get base(): string {
    if (this.#realRoot === null) throw new Error('NoteStore.init() has not been called');
    return this.#realRoot;
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
    const file = await this.#existingFile(rel);
    const content = file === null ? null : await readText(file);
    if (content === null) return { path: rel, content: '', hash: null };
    return { path: rel, content, hash: hashContent(content) };
  }

  /** Like write(), for any already-validated relative path to a text file. */
  async writeText(rel: string, content: string, baseHash: string | null): Promise<{ path: string; hash: string }> {
    return this.#oneAtATime(rel, async () => {
      const file = await this.#writableFile(rel);
      const existing = await readText(file);
      const existingHash = existing === null ? null : hashContent(existing);
      const hash = hashContent(content);
      if (existingHash === hash) return { path: rel, hash };
      if (existingHash !== baseHash) {
        throw new ConflictError({ path: rel, content: existing ?? '', hash: existingHash });
      }
      await atomicWrite(file, content);
      return { path: rel, hash };
    });
  }

  /** Raw bytes of a validated path, or null if it doesn't exist. */
  async readBytes(rel: string): Promise<Buffer | null> {
    const file = await this.#existingFile(rel);
    if (file === null) return null;
    try {
      return await fs.readFile(file);
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return null;
      if (hasCode(err, 'EISDIR')) throw new PathError('That path is a folder');
      throw err;
    }
  }

  /** Creates a new file with these bytes; fails with PathError if it already exists. */
  async createBytes(rel: string, bytes: Uint8Array): Promise<void> {
    await this.#oneAtATime(rel, async () => {
      const file = await this.#writableFile(rel);
      if ((await realpathOrNull(file)) !== null) throw new PathError(`${rel} already exists`);
      await atomicWrite(file, bytes);
    });
  }

  /** Moves a file to a new path inside the notes folder; fails if the target exists. */
  async move(fromRel: string, toRel: string): Promise<void> {
    const from = await this.#existingFile(fromRel);
    if (from === null) throw new PathError(`${fromRel} does not exist`);
    const to = await this.#writableFile(toRel);
    if ((await realpathOrNull(to)) !== null) throw new PathError(`${toRel} already exists`);
    await fs.rename(from, to);
  }

  async exists(rel: string): Promise<boolean> {
    return (await this.#existingFile(rel)) !== null;
  }

  async stat(rel: string): Promise<{ size: number; mtime: number } | null> {
    const file = await this.#existingFile(rel);
    if (file === null) return null;
    const stats = await fs.stat(file);
    return { size: stats.size, mtime: stats.mtimeMs };
  }

  /** Absolute path of an existing, validated file (for streaming it). */
  async absolute(rel: string): Promise<string | null> {
    return this.#existingFile(rel);
  }

  /**
   * Every file below the notes folder with one of `extensions`, as relative paths. Skips hidden
   * files and folders, symlinked folders, and the reserved folders.
   */
  async list(extensions: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (hasCode(err, 'ENOENT', 'ENOTDIR', 'EACCES')) return;
        throw err;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!prefix && RESERVED_FOLDERS.has(entry.name.toLowerCase())) continue;
          await walk(path.join(dir, entry.name), rel);
        } else if (entry.isFile() && extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
          found.push(rel.normalize('NFC'));
        }
      }
    };
    await walk(this.base, '');
    return found.sort();
  }

  #assertInside(realPath: string): void {
    const base = this.base;
    if (realPath !== base && !realPath.startsWith(base + path.sep)) {
      throw new PathError('That path leads outside the notes folder');
    }
  }

  /** The file's real path if it exists, or null. Refuses symlinks that lead outside the notes folder. */
  async #existingFile(rel: string): Promise<string | null> {
    const real = await realpathOrNull(path.join(this.base, rel));
    if (real !== null) this.#assertInside(real);
    return real;
  }

  /** The path to write to, with its folders created. Refuses symlinks that lead outside the notes folder. */
  async #writableFile(rel: string): Promise<string> {
    const file = path.join(this.base, rel);
    const dir = path.dirname(file);
    // Check before creating anything, so a symlinked folder can't make us create folders elsewhere.
    this.#assertInside(await realpathOfDeepestExisting(dir));
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      if (hasCode(err, 'EEXIST', 'ENOTDIR')) throw new PathError('A file is in the way of this path');
      throw err;
    }
    this.#assertInside(await fs.realpath(dir));
    const real = await realpathOrNull(file);
    if (real !== null) this.#assertInside(real);
    return real ?? file;
  }

  /** Runs tasks for the same file one after another, so two writes can't interleave. */
  async #oneAtATime<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(key, settled);
    try {
      return await result;
    } finally {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    }
  }
}

async function readText(file: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (err) {
    if (hasCode(err, 'ENOENT', 'ENOTDIR')) return null;
    if (hasCode(err, 'EISDIR')) throw new PathError('That path is a folder, not a file');
    throw err;
  }
  try {
    return utf8.decode(bytes);
  } catch {
    throw new EncodingError('This file is not valid UTF-8 text, so it is not opened here (saving could damage it)');
  }
}

/** Writes to a temporary file, flushes it to disk, then renames it into place, so a crash never leaves half a file. */
export async function atomicWrite(file: string, content: string | Uint8Array): Promise<void> {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const mode = await fs.stat(file).then(
    (stats) => stats.mode & 0o777,
    () => 0o600,
  );
  const handle = await fs.open(temp, 'wx', mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    await fs.rename(temp, file);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true });
    throw err;
  }
  await syncFolder(dir);
}

async function syncFolder(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Not every platform can fsync a folder; the rename is atomic either way.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch (err) {
    if (hasCode(err, 'ENOENT', 'ENOTDIR')) return null;
    if (hasCode(err, 'ELOOP')) throw new PathError('That path is a symlink loop');
    throw err;
  }
}

async function realpathOfDeepestExisting(p: string): Promise<string> {
  let current = p;
  for (;;) {
    const real = await realpathOrNull(current);
    if (real !== null) return real;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing folder above ${p}`);
    current = parent;
  }
}

export function hasCode(err: unknown, ...codes: string[]): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && codes.includes(String(err.code));
}
