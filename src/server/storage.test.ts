import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, EncodingError, hashContent, normalizeNotePath, NoteStore, PathError } from './storage.ts';

let tmp: string;
let notesDir: string;
let store: NoteStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'notesapp-store-'));
  notesDir = path.join(tmp, 'notes');
  store = new NoteStore(notesDir);
  await store.init();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('normalizeNotePath', () => {
  it.each(['journal/2026-11-25.md', 'notes/My note.md', 'a.md', 'vault.md'])('accepts %j', (p) => {
    expect(normalizeNotePath(p)).toBe(p);
  });

  it('normalizes Unicode to NFC', () => {
    expect(normalizeNotePath('notes/café.md')).toBe('notes/café.md');
  });

  it.each([
    '',
    '/etc/passwd.md',
    '../outside.md',
    'notes/../../x.md',
    'a//b.md',
    './a.md',
    '.git/config.md',
    'notes/.hidden.md',
    'a\\b.md',
    'notes/x.txt',
    'vault/secret.md',
    'Vault/secret.md',
    'a\0b.md',
  ])('rejects %j', (p) => {
    expect(() => normalizeNotePath(p)).toThrow(PathError);
  });

  it('rejects non-strings', () => {
    expect(() => normalizeNotePath(42)).toThrow(PathError);
  });
});

describe('NoteStore', () => {
  it('reads a missing note as empty, with no hash', async () => {
    expect(await store.read('journal/2026-11-25.md')).toEqual({ path: 'journal/2026-11-25.md', content: '', hash: null });
  });

  it('creates a note and its folders, readable only by the owner', async () => {
    const saved = await store.write('journal/2026-11-25.md', '- 09:00 hello\n', null);
    expect(saved).toEqual({ path: 'journal/2026-11-25.md', hash: hashContent('- 09:00 hello\n') });
    const file = path.join(notesDir, 'journal/2026-11-25.md');
    expect(await fs.readFile(file, 'utf8')).toBe('- 09:00 hello\n');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('keeps content byte for byte, including CRLF line endings and a byte-order mark', async () => {
    const content = '\uFEFF# Title\r\n\r\n- [ ] task\r\n';
    await store.write('notes/crlf.md', content, null);
    const bytes = await fs.readFile(path.join(notesDir, 'notes/crlf.md'));
    expect(bytes.equals(Buffer.from(content, 'utf8'))).toBe(true);
    expect((await store.read('notes/crlf.md')).content).toBe(content);
  });

  it('keeps the permissions of an existing file', async () => {
    const file = path.join(notesDir, 'shared.md');
    await fs.writeFile(file, 'one');
    await fs.chmod(file, 0o644);
    await store.write('shared.md', 'two', hashContent('one'));
    expect((await fs.stat(file)).mode & 0o777).toBe(0o644);
  });

  it('updates a note when the base hash matches', async () => {
    const first = await store.write('notes/a.md', 'one', null);
    const second = await store.write('notes/a.md', 'two', first.hash);
    expect(second.hash).toBe(hashContent('two'));
    expect((await store.read('notes/a.md')).content).toBe('two');
  });

  it('refuses a save based on an old version and reports what is on disk', async () => {
    const first = await store.write('notes/a.md', 'one', null);
    await store.write('notes/a.md', 'two', first.hash);
    const error = await store.write('notes/a.md', 'three', first.hash).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).current).toEqual({ path: 'notes/a.md', content: 'two', hash: hashContent('two') });
    expect(await fs.readFile(path.join(notesDir, 'notes/a.md'), 'utf8')).toBe('two');
  });

  it('refuses to create a note that already exists', async () => {
    await store.write('notes/a.md', 'phone', null);
    await expect(store.write('notes/a.md', 'laptop', null)).rejects.toBeInstanceOf(ConflictError);
  });

  it('treats a retried save of content already on disk as a success', async () => {
    const first = await store.write('notes/a.md', 'one', null);
    await store.write('notes/a.md', 'two', first.hash);
    await expect(store.write('notes/a.md', 'two', first.hash)).resolves.toEqual({ path: 'notes/a.md', hash: hashContent('two') });
  });

  it('lets exactly one of two racing saves win', async () => {
    const base = await store.write('notes/a.md', 'base', null);
    const results = await Promise.allSettled([
      store.write('notes/a.md', 'left', base.hash),
      store.write('notes/a.md', 'right', base.hash),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof ConflictError)).toHaveLength(1);
  });

  it('leaves no temporary files behind', async () => {
    await store.write('notes/a.md', 'x', null);
    expect(await fs.readdir(path.join(notesDir, 'notes'))).toEqual(['a.md']);
  });

  it('does not follow symlinks out of the notes folder', async () => {
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
    await fs.symlink(outside, path.join(notesDir, 'linked'));

    await expect(store.read('linked/secret.md')).rejects.toBeInstanceOf(PathError);
    await expect(store.write('linked/new.md', 'x', null)).rejects.toBeInstanceOf(PathError);
    await expect(store.write('linked/deeper/new.md', 'x', null)).rejects.toBeInstanceOf(PathError);
    expect(await fs.readdir(outside)).toEqual(['secret.md']);
  });

  it('refuses to open or overwrite a file that is not UTF-8', async () => {
    await fs.writeFile(path.join(notesDir, 'latin1.md'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await expect(store.read('latin1.md')).rejects.toBeInstanceOf(EncodingError);
    await expect(store.write('latin1.md', 'replaced', null)).rejects.toBeInstanceOf(EncodingError);
  });
});
