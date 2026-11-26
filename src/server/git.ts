import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { HistoryEntry } from '../shared/api.ts';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Notes app',
  GIT_AUTHOR_EMAIL: 'notes@localhost',
  GIT_COMMITTER_NAME: 'Notes app',
  GIT_COMMITTER_EMAIL: 'notes@localhost',
  GIT_TERMINAL_PROMPT: '0',
};
const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false'];

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...BASE_ARGS, ...args], { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve(stdout);
    });
  });
}

export interface HistoryOptions {
  /** Commit this long after the last change. */
  delayMs?: number;
  /** …but at least this often while changes keep coming. */
  maxWaitMs?: number;
}

/**
 * Keeps the notes folder's history in its own git repository: every change is committed a
 * little while after typing stops, so any earlier version can be looked at and restored.
 */
export class GitHistory {
  readonly #dir: string;
  readonly #delayMs: number;
  readonly #maxWaitMs: number;
  #enabled = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pendingSince: number | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, options: HistoryOptions = {}) {
    this.#dir = dir;
    this.#delayMs = options.delayMs ?? 60_000;
    this.#maxWaitMs = Math.max(this.#delayMs, options.maxWaitMs ?? 180_000);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Starts a repository in the notes folder if it has none of its own. Returns false if git isn't available. */
  async init(): Promise<boolean> {
    try {
      await git(['--version'], this.#dir);
    } catch {
      console.warn('git is not installed, so note history is off');
      return false;
    }
    const top = await git(['rev-parse', '--show-toplevel'], this.#dir).then(
      (out) => realpath(out.trim()),
      () => null,
    );
    // A repository further up (e.g. the code repository around dev-notes) must not receive the notes.
    if (top !== (await realpath(this.#dir))) await git(['init', '-q', '-b', 'main'], this.#dir);
    this.#enabled = true;
    await this.commitNow('Notes as they were when history started');
    return true;
  }

  /** Schedules a commit once changes have settled (or after a few minutes of non-stop changes). */
  touch(): void {
    if (!this.#enabled) return;
    const now = Date.now();
    this.#pendingSince ??= now;
    if (this.#timer) clearTimeout(this.#timer);
    const wait = Math.min(this.#delayMs, Math.max(0, this.#pendingSince + this.#maxWaitMs - now));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#pendingSince = null;
      void this.commitNow().catch((err: unknown) => console.error('could not save note history', err));
    }, wait);
  }

  /** Commits all changes now. Returns the commit hash, or null if nothing changed. */
  commitNow(message?: string): Promise<string | null> {
    const run = async (): Promise<string | null> => {
      if (!this.#enabled) return null;
      await git(['add', '-A'], this.#dir);
      const status = await git(['status', '--porcelain', '-z'], this.#dir);
      if (!status) return null;
      const changed = status.split('\0').filter((entry) => /^.. /.test(entry)).map((entry) => entry.slice(3));
      const subject = message ?? (changed.length === 1 ? `Update ${changed[0]}` : `Update ${changed.length} files`);
      await git(['commit', '-q', '--no-verify', '-m', subject], this.#dir);
      return (await git(['rev-parse', 'HEAD'], this.#dir)).trim();
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Versions of a file, newest first, following renames. */
  async log(rel: string, limit = 50): Promise<HistoryEntry[]> {
    if (!this.#enabled) return [];
    let out: string;
    try {
      out = await git(['log', `-n${limit}`, '--follow', '--name-only', '--format=%x1e%H%x1f%aI%x1f%s', '--', rel], this.#dir);
    } catch {
      return [];
    }
    return out
      .split('\x1e')
      .filter((chunk) => chunk.trim())
      .map((chunk) => {
        const [header = '', ...rest] = chunk.split('\n');
        const [commit = '', date = '', message = ''] = header.split('\x1f');
        const pathAtCommit = rest.map((l) => l.trim()).filter(Boolean).pop() ?? rel;
        return { commit, date, message, path: pathAtCommit };
      });
  }

  /** A file's content at a commit, or null if it didn't exist there. */
  async show(commit: string, rel: string): Promise<string | null> {
    if (!this.#enabled || !/^[0-9a-f]{7,64}$/.test(commit)) return null;
    try {
      return await git(['show', `${commit}:${rel}`], this.#dir);
    } catch {
      return null;
    }
  }

  /** Commits anything pending (used when shutting down). */
  async flush(): Promise<void> {
    this.#pendingSince = null;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.commitNow().catch(() => null);
  }
}
