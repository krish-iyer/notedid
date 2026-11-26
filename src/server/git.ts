import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'notedid',
  GIT_AUTHOR_EMAIL: 'notes@localhost',
  GIT_COMMITTER_NAME: 'notedid',
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

export interface BackupOptions {
  /** Commit this long after the last change. */
  delayMs?: number;
  /** …but at least this often while changes keep coming. */
  maxWaitMs?: number;
}

/** Files git leaves alone: the notes' versions (copies of the notes, which git has already) and the Dropbox sign-in and sync state. */
const IGNORED = ['/.notedid/history/', '/.notedid/sync/'];

/**
 * A backup of the whole notes folder in its own git repository, where git is installed (the
 * server; not the browser): every change is committed a little while after typing stops. The app
 * shows the notes' versions (`versions.ts`); this keeps everything else's past too (files, data,
 * the vault, settings), for `git log` and friends.
 */
export class GitBackup {
  readonly #dir: string;
  readonly #delayMs: number;
  readonly #maxWaitMs: number;
  #enabled = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pendingSince: number | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, options: BackupOptions = {}) {
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
    await this.#ignore();
    this.#enabled = true;
    await this.commitNow('Notes as they were when history started');
    return true;
  }

  /** Adds IGNORED to the repository's own exclude file (which isn't a file in the notes folder). */
  async #ignore(): Promise<void> {
    const file = path.resolve(this.#dir, (await git(['rev-parse', '--git-path', 'info/exclude'], this.#dir)).trim());
    const lines = (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/);
    const missing = IGNORED.filter((line) => !lines.includes(line));
    if (missing.length === 0) return;
    await mkdir(path.dirname(file), { recursive: true });
    const before = lines.join('\n');
    await appendFile(file, `${before && !before.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
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
