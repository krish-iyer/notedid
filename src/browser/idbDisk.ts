import type { Disk } from '../server/disk.ts';
import { PathError } from '../server/storage.ts';

/**
 * The notes folder in a browser: an IndexedDB database with a record per file (its bytes, and
 * separately its size and last change, so listing and checking files never reads their contents).
 * Each write or move is one transaction, so a file is never half written.
 */

const DATA = 'data';
const META = 'meta';

interface Meta {
  size: number;
  mtime: number;
}

/** Opens (creating it the first time) the database that holds the notes. */
export function openNotesDatabase(name = 'notesapp', factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('An older version of the app has the notes open: close its other tabs and reload'));
  });
}

function settled(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('The change was not saved'));
  });
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

export class IdbDisk implements Disk {
  readonly #db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.#db = db;
  }

  async read(rel: string): Promise<Uint8Array | null> {
    return bytesOf(await settled(this.#db.transaction(DATA, 'readonly').objectStore(DATA).get(rel)));
  }

  async write(rel: string, bytes: Uint8Array): Promise<void> {
    const tx = this.#db.transaction([DATA, META], 'readwrite');
    tx.objectStore(DATA).put(bytes, rel);
    tx.objectStore(META).put({ size: bytes.byteLength, mtime: Date.now() } satisfies Meta, rel);
    await committed(tx);
  }

  async stat(rel: string): Promise<Meta | null> {
    const meta = (await settled(this.#db.transaction(META, 'readonly').objectStore(META).get(rel))) as Meta | undefined;
    return meta ? { size: meta.size, mtime: meta.mtime } : null;
  }

  async move(from: string, to: string): Promise<void> {
    const tx = this.#db.transaction([DATA, META], 'readwrite');
    const data = tx.objectStore(DATA);
    const meta = tx.objectStore(META);
    const done = committed(tx);
    const [bytes, info, existing] = await Promise.all([settled(data.get(from)), settled(meta.get(from)), settled(meta.getKey(to))]);
    let refusal: PathError | null = null;
    if (bytesOf(bytes) === null || !info) refusal = new PathError(`${from} does not exist`);
    else if (existing !== undefined) refusal = new PathError(`${to} already exists`);
    if (refusal) {
      tx.abort();
      await done.catch(() => undefined);
      throw refusal;
    }
    // Like a rename on disk: the file keeps its last-change time.
    data.put(bytes, to);
    meta.put(info, to);
    data.delete(from);
    meta.delete(from);
    await done;
  }

  async remove(rel: string): Promise<void> {
    const tx = this.#db.transaction([DATA, META], 'readwrite');
    tx.objectStore(DATA).delete(rel);
    tx.objectStore(META).delete(rel);
    await committed(tx);
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir ? `${dir}/` : '';
    // Only the keys below the folder: every path that starts with "dir/".
    const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}\uffff`) : undefined;
    const keys = (await settled(this.#db.transaction(META, 'readonly').objectStore(META).getAllKeys(range))) as string[];
    return keys.filter((rel) => rel.startsWith(prefix) && !rel.slice(prefix.length).split('/').some((part) => part.startsWith('.'))).sort();
  }
}
