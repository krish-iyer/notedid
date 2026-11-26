import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Disk } from './disk.ts';
import { PathError } from './storage.ts';

/**
 * The notes folder on a computer's disk. Refuses anything that would leave the folder (symlinks
 * included), and writes files atomically: to a temporary file, flushed, then renamed into place.
 */
export class NodeDisk implements Disk {
  readonly root: string;
  #realRoot: string | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Creates the folder if needed. Call once before using it. */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.#realRoot = await fs.realpath(this.root);
  }

  /** The folder's real path (for git and the file watcher). */
  get base(): string {
    if (this.#realRoot === null) throw new Error('NodeDisk.init() has not been called');
    return this.#realRoot;
  }

  async read(rel: string): Promise<Uint8Array | null> {
    const file = await this.#existingFile(rel);
    if (file === null) return null;
    try {
      return await fs.readFile(file);
    } catch (err) {
      if (hasCode(err, 'ENOENT', 'ENOTDIR')) return null;
      if (hasCode(err, 'EISDIR')) throw new PathError('That path is a folder, not a file');
      throw err;
    }
  }

  async write(rel: string, bytes: Uint8Array): Promise<void> {
    await atomicWrite(await this.#writableFile(rel), bytes);
  }

  async stat(rel: string): Promise<{ size: number; mtime: number } | null> {
    const file = await this.#existingFile(rel);
    if (file === null) return null;
    const stats = await fs.stat(file);
    return { size: stats.size, mtime: stats.mtimeMs };
  }

  async move(fromRel: string, toRel: string): Promise<void> {
    const from = await this.#existingFile(fromRel);
    if (from === null) throw new PathError(`${fromRel} does not exist`);
    const to = await this.#writableFile(toRel);
    if ((await realpathOrNull(to)) !== null) throw new PathError(`${toRel} already exists`);
    await fs.rename(from, to);
  }

  /** Skips hidden files and folders, and symlinked folders. */
  async list(dir: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (folder: string, prefix: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(folder, { withFileTypes: true });
      } catch (err) {
        if (hasCode(err, 'ENOENT', 'ENOTDIR', 'EACCES')) return;
        throw err;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(folder, entry.name), rel);
        else if (entry.isFile()) found.push(rel.normalize('NFC'));
      }
    };
    await walk(dir ? path.join(this.base, dir) : this.base, dir);
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
}

/** Writes to a temporary file, flushes it to disk, then renames it into place, so a crash never leaves half a file. */
async function atomicWrite(file: string, content: Uint8Array): Promise<void> {
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

function hasCode(err: unknown, ...codes: string[]): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && codes.includes(String(err.code));
}
