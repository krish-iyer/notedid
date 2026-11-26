import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { VaultBlobInfo } from '../shared/api.ts';
import { atomicWrite, hasCode, hashContent, PathError } from './storage.ts';

const ID = /^[0-9a-f]{32}$/;
const MAX_KEY_FILE_BYTES = 64 * 1024;

/** The vault item (or key file) changed since the version the client had. */
export class VaultConflict extends Error {
  override name = 'VaultConflict';
  readonly currentHash: string | null;

  constructor(currentHash: string | null) {
    super('This vault item was changed somewhere else');
    this.currentHash = currentHash;
  }
}

/**
 * Stores the vault's encrypted blobs and key file. Everything here is ciphertext made in the
 * browser; the server never sees a passphrase, a key or a decrypted note.
 */
export class VaultStore {
  readonly #notesRoot: string;
  readonly #dir: string;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(notesRoot: string) {
    this.#notesRoot = notesRoot;
    this.#dir = path.join(notesRoot, 'vault');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const real = await fs.realpath(this.#dir);
    if (!real.startsWith(await fs.realpath(this.#notesRoot))) throw new Error('The vault folder must be inside the notes folder');
  }

  #blobFile(id: string): string {
    if (!ID.test(id)) throw new PathError('Invalid vault item');
    return path.join(this.#dir, `${id}.bin`);
  }

  async #readFile(file: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(file);
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return null;
      throw err;
    }
  }

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

  async keyFile(): Promise<{ text: string; hash: string } | null> {
    const bytes = await this.#readFile(path.join(this.#dir, 'key.json'));
    return bytes ? { text: bytes.toString('utf8'), hash: hashContent(bytes) } : null;
  }

  /** Creates the key file (baseHash null) or replaces it (passphrase change), checking the version. */
  async saveKeyFile(text: string, baseHash: string | null): Promise<{ hash: string }> {
    if (Buffer.byteLength(text) > MAX_KEY_FILE_BYTES) throw new PathError('Key file too large');
    try {
      JSON.parse(text);
    } catch {
      throw new PathError('The key file must be JSON');
    }
    return this.#oneAtATime('key', async () => {
      const file = path.join(this.#dir, 'key.json');
      const current = await this.#readFile(file);
      const currentHash = current ? hashContent(current) : null;
      if (currentHash !== baseHash) throw new VaultConflict(currentHash);
      await atomicWrite(file, text);
      return { hash: hashContent(text) };
    });
  }

  async list(): Promise<VaultBlobInfo[]> {
    const names = await fs.readdir(this.#dir).catch(() => [] as string[]);
    const items: VaultBlobInfo[] = [];
    for (const name of names) {
      const id = name.replace(/\.bin$/, '');
      if (!name.endsWith('.bin') || !ID.test(id)) continue;
      const file = path.join(this.#dir, name);
      const [stats, bytes] = await Promise.all([fs.stat(file), fs.readFile(file)]);
      items.push({ id, size: stats.size, mtime: stats.mtimeMs, hash: hashContent(bytes) });
    }
    return items;
  }

  async read(id: string): Promise<{ bytes: Buffer; hash: string } | null> {
    const bytes = await this.#readFile(this.#blobFile(id));
    return bytes ? { bytes, hash: hashContent(bytes) } : null;
  }

  async write(id: string, bytes: Uint8Array, baseHash: string | null): Promise<{ hash: string }> {
    const file = this.#blobFile(id);
    return this.#oneAtATime(id, async () => {
      const current = await this.#readFile(file);
      const currentHash = current ? hashContent(current) : null;
      const hash = hashContent(bytes);
      if (currentHash === hash) return { hash };
      if (currentHash !== baseHash) throw new VaultConflict(currentHash);
      await atomicWrite(file, bytes);
      return { hash };
    });
  }

  /** Moves a vault item to vault/trash/ (still encrypted). */
  async remove(id: string): Promise<void> {
    const file = this.#blobFile(id);
    await this.#oneAtATime(id, async () => {
      const trash = path.join(this.#dir, 'trash');
      await fs.mkdir(trash, { recursive: true, mode: 0o700 });
      try {
        await fs.rename(file, path.join(trash, `${id}-${Date.now()}.bin`));
      } catch (err) {
        if (!hasCode(err, 'ENOENT')) throw err;
      }
    });
  }
}
