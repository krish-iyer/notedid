import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { exportZip, importable, importZip } from './archive.ts';
import { NodeDisk } from './nodeDisk.ts';
import { makeTestServer, ORIGIN } from './testkit.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function folder(files: Record<string, string | Uint8Array> = {}): Promise<NodeDisk> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notesapp-archive-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const disk = new NodeDisk(dir);
  await disk.init();
  for (const [rel, content] of Object.entries(files)) await disk.write(rel, typeof content === 'string' ? new TextEncoder().encode(content) : content);
  return disk;
}

const text = (s: string) => new TextEncoder().encode(s);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff]);
const VAULT_ID = 'a'.repeat(32);

describe('export and import', () => {
  it('exports every file, the settings and the vault, and imports them into an empty folder unchanged', async () => {
    const from = await folder({
      'notes/a.md': '---\nid: k7q9m2vbfz4r\n---\n# A\n',
      'journal/2026-11-26.md': 'Today.\n',
      'papers/x.md': '---\ntype: paper\n---\n',
      'papers/x.pdf': PDF,
      'papers/x.highlights.json': '[]\n',
      'trash/notes/old.md': '# Old\n',
      [`vault/${VAULT_ID}.bin`]: new Uint8Array([1, 2, 3]),
      'vault/key.json': '{"v":1}',
      '.notedid/settings.json': '{"pinned":[]}\n',
    });
    await fs.mkdir(path.join(from.base, '.git'), { recursive: true });
    await fs.writeFile(path.join(from.base, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const zip = await exportZip(from);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(['.notedid/settings.json', 'journal/2026-11-26.md', 'notes/a.md', 'papers/x.highlights.json', 'papers/x.md', 'papers/x.pdf', 'trash/notes/old.md', `vault/${VAULT_ID}.bin`, 'vault/key.json']);

    const to = await folder();
    expect(await importZip(to, zip)).toEqual({ added: 9, same: 0, kept: [], skipped: [] });
    for (const rel of await from.list('')) expect(await to.read(rel)).toEqual(await from.read(rel));
    expect(new TextDecoder().decode((await to.read('.notedid/settings.json')) ?? new Uint8Array())).toBe('{"pinned":[]}\n');
    // Importing the same again adds nothing.
    expect(await importZip(to, zip)).toEqual({ added: 0, same: 9, kept: [], skipped: [] });
  });

  it('takes a zipped notes folder, never overwrites, and skips what isn\'t the app\'s', async () => {
    const to = await folder({ 'notes/mine.md': '# Mine, edited here\n' });
    const zip = zipSync({
      'dev-notes/notes/mine.md': text('# Mine, older\n'),
      'dev-notes/notes/new.md': text('# New\n'),
      'dev-notes/files/2026/p.png': PDF,
      'dev-notes/.git/config': text('[core]\n'),
      'dev-notes/notes/.DS_Store': text('x'),
      'dev-notes/notes/script.sh': text('rm -rf /'),
      'dev-notes/vault/notavault.txt': text('x'),
    });
    expect(await importZip(to, zip)).toEqual({ added: 2, same: 0, kept: ['notes/mine.md'], skipped: ['.git/config', 'notes/script.sh', 'vault/notavault.txt'] });
    expect(new TextDecoder().decode((await to.read('notes/mine.md')) ?? new Uint8Array())).toBe('# Mine, edited here\n');
    expect(await to.read('notes/new.md')).not.toBeNull();
    expect(await to.list('')).toEqual(['files/2026/p.png', 'notes/mine.md', 'notes/new.md']);
  });

  it('puts the settings of an export from before the app was named notedid where they are kept now', async () => {
    const to = await folder();
    const zip = zipSync({ 'notes/a.md': text('# A\n'), '.notesapp/settings.json': text('{"pinned":[]}\n') });
    expect(await importZip(to, zip)).toEqual({ added: 2, same: 0, kept: [], skipped: [] });
    expect(await to.read('.notedid/settings.json')).not.toBeNull();
    expect(await to.read('.notesapp/settings.json')).toBeNull();
  });

  it('refuses paths that would leave the folder or hide', () => {
    for (const bad of ['../x.md', '/etc/passwd.md', 'notes/../../x.md', '.git/config', 'notes/.hidden.md', 'a\\b.md', 'notes/x.exe', 'vault/x.md', '']) expect(importable(bad)).toBe(false);
    for (const good of ['notes/a.md', 'papers/x.pdf', 'papers/x.highlights.json', '.notedid/settings.json', `vault/${VAULT_ID}.bin`, 'vault/key.json', `vault/trash/${VAULT_ID}-1732600000000.bin`]) expect(importable(good)).toBe(true);
  });
});

describe('the export and import routes', () => {
  it('exports a zip to download, and imports one: the new notes are indexed and announced', async () => {
    const s = await makeTestServer({ files: { 'notes/here.md': '# Here\n' } });
    cleanups.push(s.cleanup);
    const exported = await s.get('/api/export');
    expect(exported.headers.get('content-type')).toBe('application/zip');
    expect(exported.headers.get('content-disposition')).toMatch(/^attachment; filename="notes-\d{4}-\d{2}-\d{2}\.zip"$/);
    expect(Object.keys(unzipSync(new Uint8Array(await exported.arrayBuffer())))).toEqual(['notes/here.md']);

    const zip = zipSync({ 'notes/new.md': text('# New one\n\nWith #imported things.\n'), 'notes/here.md': text('# Here, older\n') });
    const request = (body: Uint8Array, type: string) => s.app.request(`${ORIGIN}/api/import`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': type }, body });
    const imported = await request(new Uint8Array(zip), 'application/zip');
    expect(await imported.json()).toEqual({ added: 1, same: 0, kept: ['notes/here.md'], skipped: [] });
    expect(s.index.list().map((n) => n.path).sort()).toEqual(['notes/here.md', 'notes/new.md']);
    expect(s.received).toContainEqual(expect.objectContaining({ type: 'changed', path: 'notes/new.md' }));
    expect((await request(new Uint8Array([1, 2, 3]), 'application/zip')).status).toBe(400);
    expect((await request(new Uint8Array(zip), 'application/json')).status).toBe(400);
  });
});
