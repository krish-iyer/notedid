import type { BacklinksResponse, NoteKind, NoteSummary, SearchHit, SearchResponse, TagCount, TaskItem, UnlinkedMention } from '../shared/api.ts';
import { linkKey } from '../shared/markdown.ts';
import { dueMatches, isTaskQuery, type ParsedQuery, type SearchTerm } from '../shared/query.ts';
import { analyzeNote, stemOf } from './analyze.ts';
import { dirname, join } from './posixPath.ts';

/** A value SQLite takes as a parameter. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * The SQLite calls the index makes (node:sqlite's `DatabaseSync` has them, and so does the browser
 * adapter around SQLite compiled to WebAssembly), so the same index runs on a server and in a browser.
 */
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SqlValue[]): unknown;
    all(...params: SqlValue[]): unknown[];
  };
}

const SCHEMA = `
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  note_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  date TEXT,
  mtime INTEGER NOT NULL,
  hash TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  meta TEXT NOT NULL,
  meta_tags TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE TABLE note_keys (path TEXT NOT NULL, key TEXT NOT NULL, priority INTEGER NOT NULL);
CREATE INDEX note_keys_key ON note_keys(key);
CREATE INDEX note_keys_path ON note_keys(path);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE links (src TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, target_key TEXT NOT NULL, line INTEGER NOT NULL, context TEXT NOT NULL);
CREATE INDEX links_src ON links(src);
CREATE INDEX links_target ON links(target_key);
CREATE TABLE tags (path TEXT NOT NULL, tag TEXT NOT NULL);
CREATE INDEX tags_tag ON tags(tag);
CREATE INDEX tags_path ON tags(path);
CREATE TABLE tasks (path TEXT NOT NULL, line INTEGER NOT NULL, text TEXT NOT NULL, raw TEXT NOT NULL, done INTEGER NOT NULL, due TEXT, done_date TEXT);
CREATE INDEX tasks_path ON tasks(path);
`;

/** Front matter fields worth sending to the client with each note. */
const META_FIELDS = ['type', 'tag', 'tags', 'authors', 'year', 'pdf', 'about', 'arxiv', 'doi', 'venue', 'aliases', 'status', 'url', 'added'];

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function hasWordChar(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** A term for an FTS5 MATCH expression; the last plain word matches as a prefix (search as you type). */
function ftsTerm(term: SearchTerm, prefix: boolean): string {
  return `"${term.text.replace(/"/g, '""')}"${prefix && !term.phrase ? '*' : ''}`;
}

/** Hides [[links]], [text](links) and `code` so mentions inside them don't count. */
function maskLinks(line: string): string {
  return line.replace(/\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|`[^`]*`|https?:\/\/\S+/g, (m) => ' '.repeat(m.length));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Finds `term` as a whole word in `line`, outside links and code. Returns its position. */
export function findMention(line: string, term: string): { index: number; text: string } | null {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'iu');
  const match = pattern.exec(maskLinks(line));
  if (!match) return null;
  return { index: match.index, text: line.slice(match.index, match.index + term.length) };
}

/**
 * The searchable index of all notes: titles, full text, links, tags and tasks. It lives in an
 * in-memory database and is rebuilt from the files at startup; the files stay the source of truth.
 */
export class NoteIndex {
  readonly #db: SqlDatabase;

  /** `db`: an empty in-memory SQLite database, with FTS5. */
  constructor(db: SqlDatabase) {
    this.#db = db;
    this.#db.exec(SCHEMA);
  }

  get size(): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS n FROM notes').get() as Row).n);
  }

  hashOf(notePath: string): string | null {
    const row = this.#db.prepare('SELECT hash FROM notes WHERE path = ?').get(notePath) as Row | undefined;
    return row ? str(row.hash) : null;
  }

  paths(): string[] {
    return (this.#db.prepare('SELECT path FROM notes ORDER BY path').all() as Row[]).map((r) => str(r.path));
  }

  content(notePath: string): string | null {
    const row = this.#db.prepare('SELECT content FROM notes WHERE path = ?').get(notePath) as Row | undefined;
    return row ? str(row.content) : null;
  }

  /** Adds or replaces a note. */
  upsert(notePath: string, content: string, mtime: number, hash: string): void {
    const a = analyzeNote(notePath, content);
    const meta: Record<string, unknown> = {};
    for (const field of META_FIELDS) if (a.frontmatter[field] !== undefined) meta[field] = a.frontmatter[field];
    const lines = content.split(/\r?\n/);
    const contextOf = (line: number) => (lines[line - 1] ?? '').trim().slice(0, 300);
    const dir = dirname(notePath);

    this.#db.exec('BEGIN');
    try {
      this.#delete(notePath);
      const result = this.#db
        .prepare('INSERT INTO notes (path, note_id, title, kind, date, mtime, hash, excerpt, meta, meta_tags, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(notePath, a.id, a.title, a.kind, a.date, Math.round(mtime), hash, a.excerpt, JSON.stringify(meta), JSON.stringify(a.metaTags), content);
      this.#db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(result.lastInsertRowid, a.title, content);

      const keys: [string, number][] = [
        [linkKey(notePath), 0],
        [linkKey(a.title), 1],
        [linkKey(stemOf(notePath)), 2],
        ...a.aliases.map((alias): [string, number] => [linkKey(alias), 3]),
      ];
      if (a.kind === 'paper' && typeof a.frontmatter.pdf === 'string') {
        keys.push([a.frontmatter.pdf.toLowerCase(), 4], [`${dir}/${a.frontmatter.pdf}`.toLowerCase(), 4]);
      }
      const insertKey = this.#db.prepare('INSERT INTO note_keys (path, key, priority) VALUES (?, ?, ?)');
      for (const [key, priority] of new Map(keys.reverse())) insertKey.run(notePath, key, priority);

      const insertLink = this.#db.prepare('INSERT INTO links (src, kind, target, target_key, line, context) VALUES (?, ?, ?, ?, ?, ?)');
      for (const link of a.links) {
        let key: string;
        if (link.kind === 'date') key = `journal/${link.target}`;
        else if (link.kind === 'md') key = linkKey(join(dir, link.target));
        else if (link.kind === 'url') key = `url:${link.target}`;
        else key = /\.pdf$/i.test(link.target) ? link.target.toLowerCase() : linkKey(link.target);
        insertLink.run(notePath, link.kind, link.target, key, link.line, contextOf(link.line));
      }
      const insertTag = this.#db.prepare('INSERT INTO tags (path, tag) VALUES (?, ?)');
      for (const tag of a.tags) insertTag.run(notePath, tag);
      const insertTask = this.#db.prepare('INSERT INTO tasks (path, line, text, raw, done, due, done_date) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const t of a.tasks) insertTask.run(notePath, t.line, t.text, t.raw, t.done ? 1 : 0, t.due, t.doneDate);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  remove(notePath: string): boolean {
    this.#db.exec('BEGIN');
    try {
      const removed = this.#delete(notePath);
      this.#db.exec('COMMIT');
      return removed;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  #delete(notePath: string): boolean {
    const row = this.#db.prepare('SELECT id FROM notes WHERE path = ?').get(notePath) as Row | undefined;
    if (!row) return false;
    this.#db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(row.id as SqlValue);
    this.#db.prepare('DELETE FROM notes WHERE id = ?').run(row.id as SqlValue);
    for (const table of ['note_keys', 'tags', 'tasks']) this.#db.prepare(`DELETE FROM ${table} WHERE path = ?`).run(notePath);
    this.#db.prepare('DELETE FROM links WHERE src = ?').run(notePath);
    return true;
  }

  /** The note a link target refers to: by path, then title, then file name, then alias. */
  resolve(target: string, fromPath?: string): string | null {
    let key = /\.pdf$/i.test(target) ? target.toLowerCase() : linkKey(target);
    if (fromPath && /^\.{1,2}\//.test(target)) key = linkKey(join(dirname(fromPath), target));
    const row = this.#db.prepare('SELECT path FROM note_keys WHERE key = ? ORDER BY priority, path LIMIT 1').get(key) as Row | undefined;
    return row ? str(row.path) : null;
  }

  get(notePath: string): NoteSummary | null {
    return this.list([notePath])[0] ?? null;
  }

  /** Summaries of all notes (or the given ones), most recently changed first. */
  list(only?: string[]): NoteSummary[] {
    const filter = only ? `WHERE path IN (${only.map(() => '?').join(',')})` : '';
    const rows = this.#db.prepare(`SELECT path, note_id, title, kind, date, mtime, excerpt, meta FROM notes ${filter} ORDER BY mtime DESC`).all(...(only ?? [])) as Row[];
    const tags = new Map<string, string[]>();
    for (const r of this.#db.prepare('SELECT path, tag FROM tags').all() as Row[]) {
      const list = tags.get(str(r.path)) ?? [];
      list.push(str(r.tag));
      tags.set(str(r.path), list);
    }
    const open = new Map<string, number>();
    for (const r of this.#db.prepare('SELECT path, COUNT(*) AS n FROM tasks WHERE done = 0 GROUP BY path').all() as Row[]) open.set(str(r.path), Number(r.n));
    return rows.map((r) => ({
      path: str(r.path),
      id: r.note_id === null ? null : str(r.note_id),
      title: str(r.title),
      kind: str(r.kind) as NoteKind,
      date: r.date === null ? null : str(r.date),
      mtime: Number(r.mtime),
      tags: tags.get(str(r.path)) ?? [],
      excerpt: str(r.excerpt),
      openTasks: open.get(str(r.path)) ?? 0,
      meta: JSON.parse(str(r.meta)) as Record<string, unknown>,
    }));
  }

  tags(): TagCount[] {
    return (this.#db.prepare('SELECT tag, COUNT(DISTINCT path) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag').all() as Row[]).map((r) => ({
      tag: str(r.tag),
      count: Number(r.n),
    }));
  }

  /** Notes that link to `notePath`, and notes that mention its title without linking it. */
  backlinks(notePath: string): BacklinksResponse {
    const keys = (this.#db.prepare('SELECT key FROM note_keys WHERE path = ?').all(notePath) as Row[]).map((r) => str(r.key));
    if (keys.length === 0) return { linked: [], unlinked: [] };
    const rows = this.#db
      .prepare(
        `SELECT l.src, l.line, l.context, n.title FROM links l JOIN notes n ON n.path = l.src
         WHERE l.target_key IN (${keys.map(() => '?').join(',')}) AND l.src != ?
         ORDER BY n.mtime DESC, l.line`,
      )
      .all(...keys, notePath) as Row[];
    const seen = new Set<string>();
    const linked = rows
      .filter((r) => {
        const id = `${str(r.src)}:${str(r.line)}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((r) => ({ path: str(r.src), title: str(r.title), line: Number(r.line), context: str(r.context) }));
    return { linked, unlinked: this.#unlinkedMentions(notePath, new Set(linked.map((l) => l.path))) };
  }

  #unlinkedMentions(notePath: string, linkedFrom: Set<string>): UnlinkedMention[] {
    const note = this.#db.prepare('SELECT title, kind, meta FROM notes WHERE path = ?').get(notePath) as Row | undefined;
    if (!note || str(note.kind) === 'journal') return [];
    const meta = JSON.parse(str(note.meta)) as Record<string, unknown>;
    const names = [str(note.title), ...(Array.isArray(meta.aliases) ? meta.aliases.map(String) : [])].filter((n) => n.trim().length >= 3);
    const mentions: UnlinkedMention[] = [];
    for (const name of names) {
      if (!hasWordChar(name)) continue;
      const candidates = this.#db
        .prepare(
          `SELECT n.path, n.title, n.content FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
           WHERE notes_fts MATCH ? AND n.path != ? LIMIT 100`,
        )
        .all(`"${name.replace(/"/g, '""')}"`, notePath) as Row[];
      for (const c of candidates) {
        const src = str(c.path);
        if (linkedFrom.has(src) || mentions.some((m) => m.path === src)) continue;
        const lines = str(c.content).split(/\r?\n/);
        let found = 0;
        for (let i = 0; i < lines.length && found < 3; i++) {
          const hit = findMention(lines[i] ?? '', name);
          if (hit) {
            mentions.push({ path: src, title: str(c.title), line: i + 1, context: (lines[i] ?? '').trim().slice(0, 300), term: hit.text });
            found++;
          }
        }
      }
    }
    return mentions.slice(0, 50);
  }

  /** Open tasks, plus tasks done on or after `doneSince`. */
  tasks(doneSince: string | null): TaskItem[] {
    const rows = this.#db
      .prepare(
        `SELECT t.*, n.title FROM tasks t JOIN notes n ON n.path = t.path
         WHERE t.done = 0 OR (t.done_date IS NOT NULL AND t.done_date >= ?)
         ORDER BY t.done, t.due IS NULL, t.due, n.mtime DESC, t.line`,
      )
      .all(doneSince ?? '9999-12-31') as Row[];
    return rows.map(toTask);
  }

  search(query: ParsedQuery, options: { today: string; pinned: string[]; limit?: number }): SearchResponse {
    const limit = options.limit ?? 100;
    const where: string[] = [];
    const params: SqlValue[] = [];
    const taskMode = isTaskQuery(query);

    // Note-level filters. In task mode tags are matched per task instead (below).
    if (!taskMode) {
      for (const tag of query.tags) {
        where.push(`n.path IN (SELECT path FROM tags WHERE tag = ? OR tag LIKE ? ESCAPE '\\')`);
        params.push(tag, `${escapeLike(tag)}/%`);
      }
    }
    for (const tag of query.notTags) {
      where.push(`n.path NOT IN (SELECT path FROM tags WHERE tag = ? OR tag LIKE ? ESCAPE '\\')`);
      params.push(tag, `${escapeLike(tag)}/%`);
    }
    for (const place of query.in) {
      const kind = { journal: 'journal', notes: 'note', papers: 'paper', boards: 'board' }[place];
      if (kind) {
        where.push('n.kind = ?');
        params.push(kind);
      } else {
        where.push(`n.path LIKE ? ESCAPE '\\'`);
        params.push(`${escapeLike(place)}/%`);
      }
    }
    for (const value of query.is) {
      if (['journal', 'note', 'paper', 'board'].includes(value)) {
        where.push('n.kind = ?');
        params.push(value);
      } else if (value === 'pinned') {
        where.push(options.pinned.length ? `n.path IN (${options.pinned.map(() => '?').join(',')})` : '0');
        params.push(...options.pinned);
      }
    }
    for (const value of query.has) {
      if (value === 'link') where.push(`EXISTS (SELECT 1 FROM links l WHERE l.src = n.path AND l.kind IN ('wiki', 'md', 'url'))`);
      if (value === 'pdf') where.push(`(n.kind = 'paper' OR EXISTS (SELECT 1 FROM links l WHERE l.src = n.path AND lower(l.target) LIKE '%.pdf'))`);
      if (value === 'task') where.push('EXISTS (SELECT 1 FROM tasks t2 WHERE t2.path = n.path)');
      if (value === 'tag') where.push('EXISTS (SELECT 1 FROM tags g WHERE g.path = n.path)');
    }
    const dayOf = `COALESCE(n.date, date(n.mtime / 1000, 'unixepoch', 'localtime'))`;
    if (query.after) {
      where.push(`${dayOf} >= ?`);
      params.push(query.after);
    }
    if (query.before) {
      where.push(`${dayOf} < ?`);
      params.push(query.before);
    }

    const positive = query.terms.filter((t) => !t.negated && hasWordChar(t.text));
    const negative = query.terms.filter((t) => t.negated && hasWordChar(t.text));

    if (taskMode) return { mode: 'tasks', notes: [], tasks: this.#searchTasks(query, where, params, options.today, limit * 5), errors: query.errors };

    if (negative.length) {
      where.push('n.id NOT IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)');
      params.push(negative.map((t) => ftsTerm(t, false)).join(' OR '));
    }
    const clause = where.length ? `AND ${where.join(' AND ')}` : '';
    let rows: Row[];
    if (positive.length) {
      const match = positive.map((t, i) => ftsTerm(t, i === positive.length - 1)).join(' ');
      rows = this.#db
        .prepare(
          `SELECT n.path, n.title, n.kind, n.excerpt, snippet(notes_fts, 1, char(1), char(2), '…', 16) AS snip
           FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
           WHERE notes_fts MATCH ? ${clause}
           ORDER BY bm25(notes_fts, 8.0, 1.0) LIMIT ?`,
        )
        .all(match, ...params, limit) as Row[];
    } else if (where.length) {
      rows = this.#db.prepare(`SELECT n.path, n.title, n.kind, n.excerpt FROM notes n WHERE 1 ${clause} ORDER BY n.mtime DESC LIMIT ?`).all(...params, limit) as Row[];
    } else {
      rows = [];
    }
    const notes: SearchHit[] = rows.map((r) => ({
      path: str(r.path),
      title: str(r.title),
      kind: str(r.kind) as NoteKind,
      snippet: r.snip && str(r.snip).includes('\u0001') ? str(r.snip) : str(r.excerpt),
    }));
    return { mode: 'notes', notes, tasks: [], errors: query.errors };
  }

  #searchTasks(query: ParsedQuery, where: string[], params: SqlValue[], today: string, limit: number): TaskItem[] {
    const states = query.is.filter((v) => v === 'open' || v === 'done');
    if (states.length === 1) where.push(states[0] === 'open' ? 't.done = 0' : 't.done = 1');
    const rows = this.#db
      .prepare(
        `SELECT t.*, n.title, n.meta_tags FROM tasks t JOIN notes n ON n.path = t.path
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY t.done, t.due IS NULL, t.due, n.mtime DESC, t.line LIMIT 5000`,
      )
      .all(...params) as Row[];
    const lower = (s: string) => s.toLocaleLowerCase();
    return rows
      .filter((r) => {
        const text = lower(str(r.text));
        if (query.due && !dueMatches(query.due, r.due === null ? null : str(r.due), today)) return false;
        for (const term of query.terms) {
          const has = text.includes(lower(term.text));
          if (has === term.negated) return false;
        }
        if (query.tags.length) {
          const noteTags = JSON.parse(str(r.meta_tags)) as string[];
          const taskTags = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu)].map((m) => m[1] ?? '');
          const all = [...noteTags, ...taskTags];
          if (!query.tags.every((tag) => all.some((t) => t === tag || t.startsWith(`${tag}/`)))) return false;
        }
        return true;
      })
      .slice(0, limit)
      .map(toTask);
  }
}

function toTask(r: Row): TaskItem {
  return {
    path: str(r.path),
    title: str(r.title),
    line: Number(r.line),
    text: str(r.text),
    raw: str(r.raw),
    done: Number(r.done) === 1,
    due: r.due === null ? null : str(r.due),
    doneDate: r.done_date === null ? null : str(r.done_date),
  };
}
