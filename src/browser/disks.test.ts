import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import type { Disk } from '../server/disk.ts';
import { NodeDisk } from '../server/nodeDisk.ts';
import { PathError } from '../server/storage.ts';
import { IdbDisk, openNotesDatabase } from './idbDisk.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const makers: [string, () => Promise<Disk>][] = [
  [
    'a folder (NodeDisk)',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notesapp-disk-'));
      cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
      const disk = new NodeDisk(dir);
      await disk.init();
      return disk;
    },
  ],
  ['IndexedDB (IdbDisk)', async () => new IdbDisk(await openNotesDatabase('notes', new IDBFactory()))],
];

const text = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

describe.each(makers)('%s', (_name, make) => {
  it('reads what was written, and null for a missing file', async () => {
    const disk = await make();
    expect(await disk.read('notes/a.md')).toBeNull();
    expect(await disk.stat('notes/a.md')).toBeNull();
    await disk.write('notes/a.md', text('# A\n'));
    expect(str(await disk.read('notes/a.md'))).toBe('# A\n');
    await disk.write('notes/a.md', text('# A again\n'));
    expect(str(await disk.read('notes/a.md'))).toBe('# A again\n');
    const stat = await disk.stat('notes/a.md');
    expect(stat?.size).toBe(10);
    expect(Math.abs((stat?.mtime ?? 0) - Date.now())).toBeLessThan(60_000);
    const bytes = new Uint8Array([0, 255, 1, 254, 0xef, 0xbb, 0xbf]);
    await disk.write('files/2026/x.png', bytes);
    expect([...((await disk.read('files/2026/x.png')) ?? [])]).toEqual([...bytes]);
  });

  it('moves a file, refusing a missing source or a taken target', async () => {
    const disk = await make();
    await disk.write('notes/a.md', text('a'));
    await disk.write('notes/b.md', text('b'));
    await expect(disk.move('notes/a.md', 'notes/b.md')).rejects.toBeInstanceOf(PathError);
    await expect(disk.move('notes/none.md', 'notes/c.md')).rejects.toBeInstanceOf(PathError);
    expect(str(await disk.read('notes/a.md'))).toBe('a');
    await disk.move('notes/a.md', 'trash/notes/a.md');
    expect(await disk.read('notes/a.md')).toBeNull();
    expect(str(await disk.read('trash/notes/a.md'))).toBe('a');
  });

  it('lists files below a folder, sorted, leaving out hidden ones', async () => {
    const disk = await make();
    for (const rel of ['notes/b.md', 'notes/a.md', 'journal/2026-11-26.md', 'vault/k.bin', 'vault/trash/old.bin', '.notedid/settings.json', 'notes/.draft.md']) await disk.write(rel, text(rel));
    expect(await disk.list('')).toEqual(['journal/2026-11-26.md', 'notes/a.md', 'notes/b.md', 'vault/k.bin', 'vault/trash/old.bin']);
    expect(await disk.list('vault')).toEqual(['vault/k.bin', 'vault/trash/old.bin']);
    expect(await disk.list('nothing')).toEqual([]);
    // Hidden files are still there for whoever asks for them by name (settings).
    expect(str(await disk.read('.notedid/settings.json'))).toBe('.notedid/settings.json');
  });
});
