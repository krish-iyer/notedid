import type { VaultBlobInfo } from '../shared/api.ts';
import type { Disk } from './disk.ts';
import { hashContent, PathError, serialize } from './storage.ts';

const ID = /^[0-9a-f]{32}$/;
const MAX_KEY_FILE_BYTES = 64 * 1024;
const KEY_FILE = 'vault/key.json';

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
 * Stores the vault's encrypted blobs and key file, in the notes folder's `vault/`. Everything here
 * is ciphertext made in the browser; this code never sees a passphrase, a key or a decrypted note.
 */
export class VaultStore {
  readonly #disk: Disk;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(disk: Disk) {
    this.#disk = disk;
  }

  #blobPath(id: string): string {
    if (!ID.test(id)) throw new PathError('Invalid vault item');
    return `vault/${id}.bin`;
  }

  async keyFile(): Promise<{ text: string; hash: string } | null> {
    const bytes = await this.#disk.read(KEY_FILE);
    return bytes ? { text: new TextDecoder().decode(bytes), hash: hashContent(bytes) } : null;
  }

  /** Creates the key file (baseHash null) or replaces it (passphrase change), checking the version. */
  async saveKeyFile(text: string, baseHash: string | null): Promise<{ hash: string }> {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_KEY_FILE_BYTES) throw new PathError('Key file too large');
    try {
      JSON.parse(text);
    } catch {
      throw new PathError('The key file must be JSON');
    }
    return serialize(this.#locks, 'key', async () => {
      const current = await this.#disk.read(KEY_FILE);
      const currentHash = current ? hashContent(current) : null;
      if (currentHash !== baseHash) throw new VaultConflict(currentHash);
      await this.#disk.write(KEY_FILE, bytes);
      return { hash: hashContent(bytes) };
    });
  }

  async list(): Promise<VaultBlobInfo[]> {
    const items: VaultBlobInfo[] = [];
    for (const rel of await this.#disk.list('vault')) {
      const id = /^vault\/([0-9a-f]{32})\.bin$/.exec(rel)?.[1];
      if (!id) continue;
      const [stats, bytes] = await Promise.all([this.#disk.stat(rel), this.#disk.read(rel)]);
      if (stats && bytes) items.push({ id, size: stats.size, mtime: stats.mtime, hash: hashContent(bytes) });
    }
    return items;
  }

  async read(id: string): Promise<{ bytes: Uint8Array; hash: string } | null> {
    const bytes = await this.#disk.read(this.#blobPath(id));
    return bytes ? { bytes, hash: hashContent(bytes) } : null;
  }

  async write(id: string, bytes: Uint8Array, baseHash: string | null): Promise<{ hash: string }> {
    const rel = this.#blobPath(id);
    return serialize(this.#locks, id, async () => {
      const current = await this.#disk.read(rel);
      const currentHash = current ? hashContent(current) : null;
      const hash = hashContent(bytes);
      if (currentHash === hash) return { hash };
      if (currentHash !== baseHash) throw new VaultConflict(currentHash);
      await this.#disk.write(rel, bytes);
      return { hash };
    });
  }

  /** Moves a vault item to vault/trash/ (still encrypted). */
  async remove(id: string): Promise<void> {
    const rel = this.#blobPath(id);
    await serialize(this.#locks, id, async () => {
      if ((await this.#disk.stat(rel)) !== null) await this.#disk.move(rel, `vault/trash/${id}-${Date.now()}.bin`);
    });
  }
}
