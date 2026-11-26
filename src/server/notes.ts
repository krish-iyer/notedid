import type { CaptureRequest } from '../shared/api.ts';
import { appendBlock, formatCapture } from '../shared/capture.ts';
import { isISODate, journalDateOf, journalPath, localISODate, localTime } from '../shared/dates.ts';
import { setFrontmatterField } from '../shared/frontmatter.ts';
import { analyzeBody, lineIndex, linkKey, splitFrontmatter } from '../shared/markdown.ts';
import { newNoteId, noteIdOf, withNoteId } from '../shared/noteIds.ts';
import { slugify, uniqueName } from '../shared/slug.ts';
import { toggleTaskLine } from '../shared/tasks.ts';
import { stemOf } from './analyze.ts';
import type { EventHub } from './events.ts';
import type { GitBackup } from './git.ts';
import { findMention, type NoteIndex } from './noteIndex.ts';
import { dirname, join, relative as relativePath } from './posixPath.ts';
import { ConflictError, hashContent, type NoteStore, normalizeNotePath, PathError } from './storage.ts';
import type { VersionHistory } from './versions.ts';

/** A request that can't be carried out as asked (bad input, or the thing isn't there). */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

const FOLDERS = new Set(['notes', 'boards', 'dashboards', 'papers']);

export { appendBlock, formatCapture } from '../shared/capture.ts';

export interface NoteServiceDeps {
  store: NoteStore;
  index: NoteIndex;
  events: EventHub;
  /** The notes' versions. */
  versions: VersionHistory;
  /** A backup of the whole folder, where git is installed. */
  git: GitBackup | null;
}

export interface SaveOptions {
  /** False for a change that isn't worth a version of its own (giving a note an id). */
  version?: boolean;
}

/**
 * Every change to notes goes through here, so the index, the open browsers (events), the notes'
 * versions and the backup always hear about it.
 */
export class NoteService {
  readonly #store: NoteStore;
  readonly #index: NoteIndex;
  readonly #events: EventHub;
  readonly #versions: VersionHistory;
  readonly #git: GitBackup | null;
  readonly #captured = new Map<string, string>();
  #rescanTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: NoteServiceDeps) {
    this.#store = deps.store;
    this.#index = deps.index;
    this.#events = deps.events;
    this.#versions = deps.versions;
    this.#git = deps.git;
  }

  static indexable(rel: string): boolean {
    return rel.toLowerCase().endsWith('.md') && !rel.startsWith('trash/');
  }

  /** Indexes every note in the folder. Returns how many. */
  async loadAll(): Promise<number> {
    const paths = (await this.#store.list(['.md'])).filter(NoteService.indexable);
    for (const rel of paths) await this.refresh(rel, { quiet: true });
    return paths.length;
  }

  async save(rel: string, content: string, baseHash: string | null, options: SaveOptions = {}): Promise<{ path: string; hash: string }> {
    const version = options.version !== false && NoteService.indexable(rel);
    if (version) await this.#versions.beforeChange(rel);
    const saved = await this.#store.write(rel, content, baseHash);
    this.#afterWrite(saved.path, content, saved.hash, version);
    return saved;
  }

  #afterWrite(rel: string, content: string, hash: string, version = true): void {
    if (NoteService.indexable(rel)) this.#index.upsert(rel, content, Date.now(), hash);
    this.#events.emit({ type: 'changed', path: rel, hash });
    if (version && NoteService.indexable(rel)) this.#versions.touch(rel);
    this.#git?.touch();
  }

  /**
   * Re-reads a note after a change on disk (from another editor, a sync tool, …). `quiet` tells no
   * one (loading at start); `version: false` keeps no version of the change (notes that came with
   * their own history, from an import).
   */
  async refresh(rel: string, options: { quiet?: boolean; version?: boolean } = {}): Promise<void> {
    if (!NoteService.indexable(rel)) return;
    let doc;
    try {
      doc = await this.#store.read(rel);
    } catch {
      return; // not a valid note path, or not UTF-8: leave it alone
    }
    const known = this.#index.hashOf(rel);
    if (doc.hash === null) {
      if (known !== null) {
        this.#index.remove(rel);
        this.#events.emit({ type: 'deleted', path: rel });
        this.#git?.touch();
      }
      return;
    }
    if (doc.hash === known) return;
    const stat = await this.#store.stat(rel);
    this.#index.upsert(rel, doc.content, stat?.mtime ?? Date.now(), doc.hash);
    if (!options.quiet) {
      this.#events.emit({ type: 'changed', path: rel, hash: doc.hash });
      if (options.version !== false) this.#versions.touch(rel);
      this.#git?.touch();
    }
  }

  /** Brings the index in line with the folder (after folder moves, which file events don't spell out, or an import). */
  async rescan(options: { version?: boolean } = {}): Promise<void> {
    const onDisk = new Set((await this.#store.list(['.md'])).filter(NoteService.indexable));
    for (const rel of onDisk) await this.refresh(rel, options);
    for (const rel of this.#index.paths()) if (!onDisk.has(rel)) await this.refresh(rel, options);
  }

  /** Handles a file-system event; `rel` is null or a folder when the watcher can't say what changed. */
  onFileEvent(rel: string | null): void {
    if (rel && NoteService.indexable(rel)) {
      void this.refresh(rel);
      return;
    }
    if (this.#rescanTimer) clearTimeout(this.#rescanTimer);
    this.#rescanTimer = setTimeout(() => void this.rescan().catch((err: unknown) => console.error('rescan failed', err)), 500);
  }

  /** Reads, changes and saves a note, retrying if it changes in between. `change` returns null to leave it as is. */
  async #edit(rel: string, change: (content: string, exists: boolean) => string | null, options: SaveOptions = {}): Promise<{ hash: string | null }> {
    for (let attempt = 0; ; attempt++) {
      const doc = await this.#store.read(rel);
      const next = change(doc.content, doc.hash !== null);
      if (next === null || (doc.hash !== null && next === doc.content)) return { hash: doc.hash };
      try {
        return await this.save(rel, next, doc.hash, options);
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt >= 4) throw err;
      }
    }
  }

  async create(title: string, folder = 'notes', content?: string): Promise<string> {
    const name = title.trim();
    if (!name) throw new PathError('A note needs a title');
    if (!FOLDERS.has(folder)) throw new PathError(`Notes can be created in: ${[...FOLDERS].join(', ')}`);
    const existing = this.#index.paths();
    const slug = uniqueName(slugify(name), (candidate) => existing.includes(`${folder}/${candidate}.md`));
    const rel = `${folder}/${slug}.md`;
    await this.save(rel, withNoteId(content ?? `# ${name}\n\n`, newNoteId()), null);
    return rel;
  }

  /** Notes without an id, and notes that share one (copies): the oldest keeps it, the others need new ones. */
  async #idReport(): Promise<{ notes: number; missing: string[]; copies: string[]; taken: Set<string> }> {
    const paths = (await this.#store.list(['.md'])).filter(NoteService.indexable);
    const missing: string[] = [];
    const byId = new Map<string, { rel: string; mtime: number }[]>();
    for (const rel of paths) {
      const doc = await this.#store.read(rel);
      if (doc.hash === null) continue;
      const id = noteIdOf(doc.content);
      if (id === null) {
        missing.push(rel);
        continue;
      }
      const same = byId.get(id) ?? [];
      same.push({ rel, mtime: (await this.#store.stat(rel))?.mtime ?? 0 });
      byId.set(id, same);
    }
    const copies = [...byId.values()]
      .filter((same) => same.length > 1)
      .flatMap((same) => same.sort((a, b) => a.mtime - b.mtime || a.rel.localeCompare(b.rel)).slice(1))
      .map((note) => note.rel);
    return { notes: paths.length, missing, copies, taken: new Set(byId.keys()) };
  }

  /** How many notes have no id yet, and how many are copies sharing another note's id. */
  async idStatus(): Promise<{ notes: number; missing: number; copies: number }> {
    const { notes, missing, copies } = await this.#idReport();
    return { notes, missing: missing.length, copies: copies.length };
  }

  /**
   * Gives every note without an id one, and every copy (a note sharing another's id) a new one. Only
   * the `id:` line changes, so no versions are kept for it (a note's first version is kept when it
   * next changes). In the git backup, pending edits are committed first, so this is a commit of its own.
   */
  async assignIds(): Promise<{ added: number; renewed: number }> {
    const { missing, copies, taken } = await this.#idReport();
    const fresh = () => {
      let id = newNoteId();
      while (taken.has(id)) id = newNoteId();
      taken.add(id);
      return id;
    };
    await this.#git?.commitNow();
    let added = 0;
    for (const rel of missing) {
      let changed = false;
      await this.#edit(
        rel,
        (content, exists) => {
          changed = exists && noteIdOf(content) === null;
          return changed ? withNoteId(content, fresh()) : null;
        },
        { version: false },
      );
      if (changed) added++;
    }
    let renewed = 0;
    for (const rel of copies) {
      const id = noteIdOf((await this.#store.read(rel)).content);
      let changed = false;
      await this.#edit(
        rel,
        (content, exists) => {
          changed = exists && id !== null && noteIdOf(content) === id;
          return changed ? setFrontmatterField(content, 'id', fresh()) : null;
        },
        { version: false },
      );
      if (changed) renewed++;
    }
    if (added + renewed > 0) await this.#git?.commitNow(`Give ${added + renewed === 1 ? 'a note an id' : `${added + renewed} notes ids`}`);
    return { added, renewed };
  }

  /**
   * Renames a note: its file, its title, and every [[link]] and markdown link to it in other
   * notes. Returns the new path and the notes that were updated.
   */
  async rename(rel: string, newTitle: string): Promise<{ path: string; updated: string[] }> {
    const title = newTitle.trim();
    if (!title) throw new PathError('A note needs a title');
    if (journalDateOf(rel)) throw new PathError('Journal notes are named after their day');
    const note = this.#index.get(rel);
    if (!note) throw new NotFoundError(`${rel} does not exist`);
    const oldKeys = new Set([linkKey(rel), linkKey(note.title), linkKey(stemOf(rel))]);
    // Who links here, worked out before the title changes (the index matches links by name).
    const sources = new Set(this.#index.backlinks(rel).linked.map((l) => l.path));

    // 1. The title inside the note: front matter title, or the first level-1 heading.
    await this.#edit(rel, (content) => {
      const { bodyOffset } = splitFrontmatter(content);
      const front = content.slice(0, bodyOffset);
      const titleLine = /^title:.*$/m;
      if (front && titleLine.test(front)) return front.replace(titleLine, `title: ${JSON.stringify(title)}`) + content.slice(bodyOffset);
      const body = content.slice(bodyOffset);
      const h1 = /^#[ \t]+.*$/m;
      return h1.test(body) ? front + body.replace(h1, `# ${title}`) : null;
    });

    // 2. The file.
    const dir = dirname(rel);
    const existing = new Set(this.#index.paths());
    const slug = uniqueName(slugify(title), (candidate) => {
      const p = `${dir}/${candidate}.md`;
      return p !== rel && existing.has(p);
    });
    const newRel = `${dir}/${slug}.md`;
    if (newRel !== rel) {
      await this.#store.move(rel, newRel);
      const doc = await this.#store.read(newRel);
      this.#index.remove(rel);
      this.#events.emit({ type: 'deleted', path: rel });
      if (doc.hash) this.#afterWrite(newRel, doc.content, doc.hash);
    }

    // 2b. Files named after the note go with it: a paper's highlights, the reading view's comments.
    const moved = new Map<string, string>();
    if (newRel !== rel) {
      for (const suffix of ['.highlights.json', '.comments.md']) {
        const from = rel.replace(/\.md$/i, suffix);
        const to = newRel.replace(/\.md$/i, suffix);
        if (!(await this.#store.exists(from)) || (await this.#store.exists(to))) continue;
        await this.#store.move(from, to);
        moved.set(from, to);
        if (NoteService.indexable(from)) {
          await this.refresh(from);
          await this.refresh(to);
        }
      }
    }

    // 3. Links from other notes (a moved comments note is updated where it is now).
    const updated: string[] = [];
    for (const linking of sources) {
      const src = moved.get(linking) ?? linking;
      if (src === rel || src === newRel) continue;
      let changed = false;
      await this.#edit(src, (content) => {
        const next = rewriteLinks(content, src, oldKeys, title, newRel);
        changed = next !== null;
        return next;
      });
      if (changed) updated.push(src);
    }
    return { path: newRel, updated };
  }

  /** Moves a note to trash/. Returns where it went. */
  async remove(rel: string): Promise<string> {
    if (!(await this.#store.exists(rel))) throw new NotFoundError(`${rel} does not exist`);
    const dir = dirname(rel);
    const stem = stemOf(rel);
    let target = `trash/${rel}`;
    for (let n = 2; await this.#store.exists(target); n++) target = `trash/${dir}/${stem}-${n}.md`;
    await this.#store.move(rel, target);
    this.#index.remove(rel);
    this.#events.emit({ type: 'deleted', path: rel });
    this.#git?.touch();
    return target;
  }

  /** Ticks or unticks a task, after checking the line still holds the same task. */
  async toggleTask(rel: string, line: number, raw: string, today: string): Promise<{ hash: string | null }> {
    let found = false;
    const result = await this.#edit(rel, (content) => {
      const parts = content.split(/(\r?\n)/);
      let index = (line - 1) * 2;
      if (parts[index] !== raw) {
        // The task moved (lines added above it): accept it only if it now appears exactly once.
        const matches = parts.flatMap((p, i) => (i % 2 === 0 && p === raw ? [i] : []));
        if (matches.length !== 1) return null;
        index = matches[0] ?? -1;
      }
      const next = toggleTaskLine(parts[index] ?? '', today);
      if (next === null) return null;
      found = true;
      parts[index] = next;
      return parts.join('');
    });
    if (!found) throw new ConflictError({ path: rel, content: (await this.#store.read(rel)).content, hash: result.hash });
    return result;
  }

  /** Adds a capture to the day's journal note (or a target note). Retried captures with the same id are added once. */
  async capture(request: CaptureRequest): Promise<{ path: string }> {
    const text = request.text.trim();
    if (!text) throw new PathError('Nothing to capture');
    if (request.id && this.#captured.has(request.id)) return { path: this.#captured.get(request.id) ?? '' };
    const at = request.capturedAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(request.capturedAt) ? request.capturedAt : null;
    const date = at && isISODate(at.slice(0, 10)) ? at.slice(0, 10) : localISODate();
    const time = at ? at.slice(11, 16) : localTime();
    const rel = request.target ? normalizeNotePath(request.target) : journalPath(date);
    const block = formatCapture(text, request.target ? null : time);
    // A day's first capture makes its journal note, which gets an id like any new note.
    await this.#edit(rel, (content, exists) => (exists ? appendBlock(content, block) : withNoteId(appendBlock(content, block), newNoteId())));
    if (request.id) {
      this.#captured.set(request.id, rel);
      if (this.#captured.size > 1000) this.#captured.delete(this.#captured.keys().next().value ?? '');
    }
    return { path: rel };
  }

  /** Turns a plain mention of a note's title on one line into a [[link]]. */
  async linkMention(rel: string, line: number, term: string, targetPath: string): Promise<{ hash: string | null }> {
    const target = this.#index.get(targetPath);
    if (!target) throw new NotFoundError(`${targetPath} does not exist`);
    let done = false;
    const result = await this.#edit(rel, (content) => {
      const parts = content.split(/(\r?\n)/);
      const index = (line - 1) * 2;
      const text = parts[index];
      if (text === undefined) return null;
      const hit = findMention(text, term);
      if (!hit) return null;
      const link = hit.text === target.title ? `[[${target.title}]]` : `[[${target.title}|${hit.text}]]`;
      parts[index] = text.slice(0, hit.index) + link + text.slice(hit.index + hit.text.length);
      done = true;
      return parts.join('');
    });
    if (!done) throw new ConflictError({ path: rel, content: (await this.#store.read(rel)).content, hash: result.hash });
    return result;
  }

  /**
   * Makes an earlier version of a note its current text. The text it replaces is kept as a version
   * first, however new, and the note keeps its id whatever the version says.
   */
  async restore(rel: string, content: string): Promise<{ hash: string | null }> {
    await this.#versions.beforeChange(rel, { always: true });
    return this.#edit(rel, (current) => {
      const id = noteIdOf(current);
      if (id === null || noteIdOf(content) === id) return content;
      return noteIdOf(content) === null ? withNoteId(content, id) : setFrontmatterField(content, 'id', id);
    });
  }

  /** Changes a note with `change` (null leaves it alone), retrying if it changes in between. */
  async update(rel: string, change: (content: string, exists: boolean) => string | null): Promise<{ hash: string | null }> {
    return this.#edit(normalizeNotePath(rel), change);
  }

  hashOf(content: string): string {
    return hashContent(content);
  }
}

/** Rewrites [[links]] and markdown links in `content` that point at a renamed note. */
export function rewriteLinks(content: string, src: string, oldKeys: Set<string>, newTitle: string, newRel: string): string | null {
  const { bodyOffset } = splitFrontmatter(content);
  const { links } = analyzeBody(content.slice(bodyOffset), bodyOffset, lineIndex(content));
  const edits: { from: number; to: number; text: string }[] = [];
  const srcDir = dirname(src);
  for (const link of links) {
    if (link.kind === 'wiki' && oldKeys.has(linkKey(link.target))) {
      const usesPath = link.target.includes('/');
      const target = usesPath ? newRel.replace(/\.md$/i, '') : newTitle;
      const inner = `${target}${link.heading ? `#${link.heading}` : ''}${link.label ? `|${link.label}` : ''}`;
      edits.push({ from: link.from, to: link.to, text: `[[${inner}]]` });
    } else if (link.kind === 'md' && oldKeys.has(linkKey(join(srcDir, link.target)))) {
      const original = content.slice(link.from, link.to);
      const relative = relativePath(srcDir, newRel).replace(/ /g, '%20');
      const hash = link.heading ? `#${link.heading}` : '';
      edits.push({ from: link.from, to: link.to, text: original.replace(/\]\([^)]*\)$/, `](${relative}${hash})`) });
    }
  }
  if (edits.length === 0) return null;
  let next = content;
  for (const edit of edits.sort((a, b) => b.from - a.from)) next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
  return next;
}
