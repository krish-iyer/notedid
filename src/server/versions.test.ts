import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HistoryResponse } from '../shared/api.ts';
import { makeTestServer, type TestServer } from './testkit.ts';
import { HISTORY_FOLDER, historyIdOf, isVersionFile, versionName, versionsToThin, versionTime } from './versions.ts';

const ID = 'k7q9m2vbfz4r';
const note = (text: string, id = ID) => `---\nid: ${id}\n---\n# A\n\n${text}\n`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.cleanup();
});

async function server(options: Parameters<typeof makeTestServer>[0]): Promise<TestServer> {
  const s = await makeTestServer(options);
  servers.push(s);
  return s;
}

/** Makes a file look as if it was last changed at `ms`. */
async function age(s: TestServer, rel: string, ms: number): Promise<void> {
  await fs.utimes(path.join(s.dir, rel), ms / 1000, ms / 1000);
}

async function save(s: TestServer, rel: string, content: string): Promise<void> {
  const doc = (await (await s.get(`/api/note?path=${encodeURIComponent(rel)}`)).json()) as { hash: string | null };
  const res = await s.put('/api/note', { path: rel, content, baseHash: doc.hash });
  expect(res.status).toBe(200);
}

const history = async (s: TestServer, rel = 'notes/a.md') => (await (await s.get(`/api/history?path=${encodeURIComponent(rel)}`)).json()) as HistoryResponse;
const versionText = async (s: TestServer, version: string, rel = 'notes/a.md') => {
  const res = await s.get(`/api/history/version?path=${encodeURIComponent(rel)}&version=${encodeURIComponent(version)}`);
  return res.status === 200 ? ((await res.json()) as { content: string }).content : res.status;
};
const texts = async (s: TestServer, rel = 'notes/a.md') => Promise.all((await history(s, rel)).versions.map(async (v) => versionText(s, v.version, rel)));
const second = (ms: number) => Math.floor(ms / 1000) * 1000;

describe('version names', () => {
  it('name a moment in UTC to the second, and read back', () => {
    const at = Date.UTC(2026, 10, 26, 14, 5, 33, 999);
    expect(versionName(at)).toBe('2026-11-26 14.05.33 UTC');
    expect(versionTime('2026-11-26 14.05.33 UTC')).toBe(Date.UTC(2026, 10, 26, 14, 5, 33));
    for (const bad of ['2026-11-26 14.05.33', '2026-02-30 10.00.00 UTC', '2026-11-26 24.00.00 UTC', '../2026-11-26 14.05.33 UTC', '']) expect(versionTime(bad)).toBeNull();
  });

  it('tell version files and the ids that can have them', () => {
    expect(isVersionFile(`.notedid/history/${ID}/2026-11-26 14.05.33 UTC.md`)).toBe(true);
    expect(isVersionFile('.notedid/history/my-own-id/2026-11-26 14.05.33 UTC.md')).toBe(true);
    for (const bad of [`.notedid/history/${ID}/notes.md`, `.notedid/history/${ID}/2026-13-26 14.05.33 UTC.md`, '.notedid/history/../x/2026-11-26 14.05.33 UTC.md', `.notedid/history/${ID}/sub/2026-11-26 14.05.33 UTC.md`, `notes/2026-11-26 14.05.33 UTC.md`]) {
      expect(isVersionFile(bad)).toBe(false);
    }
    expect(historyIdOf(note('x'))).toBe(ID);
    expect(historyIdOf('# No id\n')).toBeNull();
    expect(historyIdOf('---\nid: ../../etc\n---\n')).toBeNull();
  });

  it('thin out: everything from the last day, the last of each hour for a week, then the last of each day', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0);
    const at = (ms: number) => versionName(now - ms);
    const recent = [at(5 * 60_000), at(10 * 60_000), at(23 * HOUR)];
    const threeDaysAgo = [at(3 * DAY + 10 * 60_000), at(3 * DAY + 20 * 60_000), at(3 * DAY + 30 * 60_000)];
    const tenDaysAgo = [at(10 * DAY + 2 * HOUR), at(10 * DAY + 5 * HOUR), at(10 * DAY + 9 * HOUR)];
    const thinned = versionsToThin([...recent, ...threeDaysAgo, ...tenDaysAgo, 'not a version'], now);
    // The newest of each hour or day stays (it is the first of each list here: the least time ago).
    expect(thinned.sort()).toEqual([...threeDaysAgo.slice(1), ...tenDaysAgo.slice(1)].sort());
  });
});

describe('a note’s versions', () => {
  it('keeps the text from before an edit, and the new text once the edits settle', async () => {
    const s = await server({ files: { 'notes/a.md': note('one') } });
    const written = Date.now() - HOUR;
    await age(s, 'notes/a.md', written);
    expect(await history(s)).toEqual({ id: ID, versions: [] });

    await save(s, 'notes/a.md', note('two'));
    // The text it had for the last hour, from when it was written.
    expect(await history(s)).toEqual({ id: ID, versions: [{ version: versionName(written), date: new Date(second(written)).toISOString() }] });
    await save(s, 'notes/a.md', note('three'));
    expect((await history(s)).versions).toHaveLength(1);

    await s.versions.flush();
    expect(await texts(s)).toEqual([note('three'), note('one')]);
    // Nothing new to keep.
    await s.versions.flush();
    await save(s, 'notes/a.md', note('three'));
    expect((await history(s)).versions).toHaveLength(2);
    // They are plain files in the notes folder.
    const files = await fs.readdir(path.join(s.dir, HISTORY_FOLDER, ID));
    expect(files.sort()).toEqual((await history(s)).versions.map((v) => `${v.version}.md`).sort());
  });

  it('keeps a version a while after the last change, by itself', async () => {
    const s = await server({ versionDelayMs: 50, files: { 'notes/a.md': note('one') } });
    await save(s, 'notes/a.md', note('two'));
    await s.versions.idle();
    expect((await texts(s))[0]).toBe(note('two'));
  });

  it('follows a note through a rename, by its id', async () => {
    const s = await server({ files: { 'notes/a.md': note('one') } });
    await save(s, 'notes/a.md', note('two'));
    await s.versions.flush();
    const renamed = (await (await s.post('/api/note/rename', { path: 'notes/a.md', title: 'Bee' })).json()) as { path: string };
    expect(renamed.path).toBe('notes/bee.md');
    await s.versions.flush();
    expect(await texts(s, 'notes/bee.md')).toEqual([note('two').replace('# A', '# Bee'), note('two')]);
  });

  it('keeps no versions of a note without an id, and none for giving it one', async () => {
    const s = await server({ files: { 'notes/a.md': '# A\n\nNo id.\n' } });
    await age(s, 'notes/a.md', Date.now() - HOUR);
    await save(s, 'notes/a.md', '# A\n\nStill no id.\n');
    await s.versions.flush();
    expect(await history(s)).toEqual({ id: null, versions: [] });
    expect(await (await s.post('/api/ids', {})).json()).toEqual({ added: 1, renewed: 0 });
    await s.versions.flush();
    expect((await history(s)).versions).toEqual([]);
    await expect(fs.stat(path.join(s.dir, HISTORY_FOLDER))).rejects.toThrow();
  });

  it('restores a version, keeping the text it replaces however new, and the note’s id', async () => {
    const s = await server({ files: { 'notes/a.md': note('one') } });
    await age(s, 'notes/a.md', Date.now() - HOUR);
    await save(s, 'notes/a.md', note('two'));
    const [first] = (await history(s)).versions;
    // Typed a moment ago, not kept yet.
    await save(s, 'notes/a.md', note('three'));
    const res = await s.post('/api/note/restore', { path: 'notes/a.md', version: first?.version });
    expect(res.status).toBe(200);
    expect(await s.read('notes/a.md')).toBe(note('one'));
    expect(await texts(s)).toEqual([note('three'), note('one')]);

    // A version with another id (a copy's, say) still restores under this note's id.
    const stray = versionName(Date.now() - 2 * HOUR);
    await s.write(`${HISTORY_FOLDER}/${ID}/${stray}.md`, note('stray', 'zzzzzzzzzzzz'));
    s.versions.forget();
    await s.post('/api/note/restore', { path: 'notes/a.md', version: stray });
    expect(await s.read('notes/a.md')).toBe(note('stray'));

    expect((await s.post('/api/note/restore', { path: 'notes/a.md', version: '2020-01-01 00.00.00 UTC' })).status).toBe(404);
    expect(await versionText(s, '../../notes/a')).toBe(404);
  });

  it('gives a version that would share a second with another the next second', async () => {
    const s = await server({ files: { 'notes/a.md': note('two') } });
    const written = Date.now() - HOUR;
    await age(s, 'notes/a.md', written);
    await s.write(`${HISTORY_FOLDER}/${ID}/${versionName(written)}.md`, note('one'));
    await save(s, 'notes/a.md', note('three'));
    expect((await history(s)).versions.map((v) => v.version).slice(-2)).toEqual([versionName(written + 1000), versionName(written)]);
  });

  it('thins out older versions as new ones are kept', async () => {
    const now = Date.now();
    const s = await server({ files: { 'notes/a.md': note('new') } });
    // Three versions within one hour, three days ago.
    const hour = Math.floor((now - 3 * DAY) / HOUR) * HOUR;
    const old = [10, 20, 30].map((minutes) => versionName(hour + minutes * 60_000));
    for (const name of old) await s.write(`${HISTORY_FOLDER}/${ID}/${name}.md`, note(name));
    await age(s, 'notes/a.md', now - HOUR);
    await save(s, 'notes/a.md', note('newer'));
    // The note's text from an hour ago is kept, and of the three, the last stays.
    expect((await history(s)).versions.map((v) => v.version)).toEqual([versionName(now - HOUR), old[2]]);
  });
});
