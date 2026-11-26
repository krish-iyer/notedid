/** Types shared by the API server and the web client. */

import type { PaperStatus } from './papers.ts';

/** A note as stored on disk. */
export interface NoteDoc {
  /** Path relative to the notes folder, with forward slashes, e.g. "journal/2026-11-25.md". */
  path: string;
  /** Exact file content; empty when the note doesn't exist yet. */
  content: string;
  /** SHA-256 of the content (hex), or null when the note doesn't exist yet. */
  hash: string | null;
}

export interface SaveNoteRequest {
  path: string;
  content: string;
  /** Hash of the version this edit started from; null for a note that doesn't exist yet. */
  baseHash: string | null;
}

export interface SaveNoteResponse {
  path: string;
  hash: string;
}

/** Sent with HTTP 409 when the note changed since `baseHash`. */
export interface ConflictResponse {
  error: 'conflict';
  current: NoteDoc;
}

export interface ErrorResponse {
  error: string;
}

export type NoteKind = 'journal' | 'note' | 'paper' | 'board' | 'dashboard' | 'comments';

/** What the index knows about a note; enough for lists, the switcher, cards and links. */
export interface NoteSummary {
  path: string;
  title: string;
  kind: NoteKind;
  /** Journal notes: their day. */
  date: string | null;
  /** Last modified, ms since epoch. */
  mtime: number;
  tags: string[];
  excerpt: string;
  openTasks: number;
  /** Selected front matter fields (type, tag, authors, year, pdf, about). */
  meta: Record<string, unknown>;
}

/** Search hits mark matched words with \u0001 … \u0002 in `snippet`. */
export interface SearchHit {
  path: string;
  title: string;
  kind: NoteKind;
  snippet: string;
}

export interface TaskItem {
  path: string;
  /** Title of the note the task is in. */
  title: string;
  line: number;
  text: string;
  /** The whole line, used to check the task is still there before changing it. */
  raw: string;
  done: boolean;
  due: string | null;
  doneDate: string | null;
}

export interface SearchResponse {
  mode: 'notes' | 'tasks';
  notes: SearchHit[];
  tasks: TaskItem[];
  errors: string[];
}

export interface BacklinkItem {
  path: string;
  title: string;
  line: number;
  context: string;
}

export interface UnlinkedMention extends BacklinkItem {
  /** The text that mentions the note, as written. */
  term: string;
}

export interface BacklinksResponse {
  linked: BacklinkItem[];
  unlinked: UnlinkedMention[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface HistoryEntry {
  commit: string;
  /** ISO timestamp. */
  date: string;
  message: string;
  /** The file's path in that version (it may have been renamed since). */
  path: string;
}

export interface SavedView {
  name: string;
  query: string;
}

export interface Settings {
  /** Note paths pinned in the sidebar. */
  pinned: string[];
  views: SavedView[];
  vaultAutoLockMinutes: number;
}

export type ServerEvent =
  | { type: 'changed'; path: string; hash: string }
  | { type: 'deleted'; path: string }
  | { type: 'settings' }
  | { type: 'vault' };

export interface CaptureRequest {
  text: string;
  /** Device-local timestamp with offset, e.g. "2026-11-25T14:32:00+03:00"; decides the day and time. */
  capturedAt?: string;
  /** Add to this note instead of the day's journal note. */
  target?: string;
  /** Client-generated ID, so a retried capture is only added once. */
  id?: string;
}

export interface PaperSummary {
  key: string;
  /** The review note. */
  path: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  /** From `status:` in the note; missing means to-read. */
  status: PaperStatus;
  tags: string[];
  /** Tags written in the note's properties (`tags:`), which the library can edit; `tags` also has #tags from the text. */
  metaTags: string[];
  doi: string | null;
  arxiv: string | null;
  url: string | null;
  /** When it was added (`added:` in the note, YYYY-MM-DD); null for papers added before that was recorded. */
  added: string | null;
  /** PDF path relative to the notes folder, if there is one. */
  pdf: string | null;
  highlights: number;
  mtime: number;
}

/** A highlight in a PDF. Rectangles are fractions of the page size, so they survive zooming. */
export interface Highlight {
  id: string;
  page: number;
  rects: { x: number; y: number; w: number; h: number }[];
  text: string;
  createdAt: string;
}

export interface DataDoc<T> {
  path: string;
  data: T;
  hash: string | null;
}

export interface VaultBlobInfo {
  id: string;
  size: number;
  mtime: number;
  hash: string;
}
