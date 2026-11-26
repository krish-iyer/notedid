import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../server/nodeSqlite.ts';
import { NoteIndex } from '../server/noteIndex.ts';
import { hashContent } from '../server/storage.ts';
import { parseQuery } from '../shared/query.ts';
import { wasmDatabase } from './wasmSqlite.ts';

const NOTES: Record<string, string> = {
  'notes/hbm.md': '---\nid: k7q9m2vbfz4r\naliases: [High Bandwidth Memory]\ntags: [hardware/memory]\n---\n# HBM\n\nStacked DRAM next to the FPGA. #fpga\n\n- [ ] Read the HBM2 spec due:2026-11-30\n',
  'papers/smith2024.md': '---\ntype: paper\ntitle: Fast kernels on FPGAs\npdf: smith2024.pdf\nauthors: [A. Smith]\nyear: 2024\n---\n## Summary\n\nKernels that use HBM. Reconfiguration in under a second.\n',
  'journal/2026-11-20.md': 'Read about high bandwidth memory today. [[HBM]] and [[smith2024.pdf#page=4|p. 4]] [x](../notes/hbm.md)\n- [x] Call Ana done:2026-11-20\n- [ ] Order cables #lab\n',
  'notes/café ☕.md': '# Café notes\n\nThe espresso machine needs descaling. Mentions HBM once.\n',
};

/** The same notes in an index over each database. */
async function indexes(): Promise<[NoteIndex, NoteIndex]> {
  const node = new NoteIndex(memoryDatabase());
  const wasm = new NoteIndex(wasmDatabase(await sqlite3InitModule()));
  for (const index of [node, wasm]) for (const [rel, content] of Object.entries(NOTES)) index.upsert(rel, content, Date.parse('2026-11-20T10:00:00Z'), hashContent(content));
  return [node, wasm];
}

describe('the note index over SQLite in WebAssembly', () => {
  it('answers exactly as over node:sqlite: lists, links, search, tasks, tags', async () => {
    const [node, wasm] = await indexes();
    const today = '2026-11-26';
    expect(wasm.size).toBe(4);
    expect(wasm.list()).toEqual(node.list());
    expect(wasm.tags()).toEqual(node.tags());
    expect(wasm.backlinks('notes/hbm.md')).toEqual(node.backlinks('notes/hbm.md'));
    expect(wasm.resolve('high bandwidth memory')).toBe('notes/hbm.md');
    for (const q of ['hbm', 'reconfig', '"stacked dram"', 'tag:fpga', 'is:open', 'due:week', 'café', 'type:paper hbm', 'kern']) {
      expect(wasm.search(parseQuery(q, today), { today, pinned: [] })).toEqual(node.search(parseQuery(q, today), { today, pinned: [] }));
    }
    expect(wasm.tasks('2026-11-01')).toEqual(node.tasks('2026-11-01'));
    expect(wasm.search(parseQuery('hbm', today), { today, pinned: [] }).notes.length).toBeGreaterThan(1);
  });

  it('updates and removes notes as over node:sqlite', async () => {
    const [node, wasm] = await indexes();
    for (const index of [node, wasm]) {
      index.upsert('notes/hbm.md', '# HBM\n\nNow about HBM3.\n', Date.parse('2026-11-21T10:00:00Z'), hashContent('x'));
      index.remove('journal/2026-11-20.md');
    }
    expect(wasm.list()).toEqual(node.list());
    expect(wasm.backlinks('notes/hbm.md')).toEqual(node.backlinks('notes/hbm.md'));
    expect(wasm.search(parseQuery('hbm3', '2026-11-26'), { today: '2026-11-26', pinned: [] })).toEqual(node.search(parseQuery('hbm3', '2026-11-26'), { today: '2026-11-26', pinned: [] }));
  });
});
