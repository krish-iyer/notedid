import { sha256Bytes, sha256Hex } from '../shared/sha256.ts';
import type { FetchFn } from './web.ts';

/**
 * The few Dropbox API calls sync needs, over fetch (so they run on the server and in the browser's
 * service worker alike). The app works in its own app folder (Dropbox → Apps → <app name>), so
 * paths are relative to it. Signing in is OAuth with PKCE (`shared/dropboxAuth.ts`): no secret, and
 * the refresh token lets the app get new short-lived access tokens on its own.
 */

/** Where the API is. Tests point this at a fake. */
export interface DropboxEndpoints {
  api: string;
  content: string;
}

export const DROPBOX: DropboxEndpoints = { api: 'https://api.dropboxapi.com', content: 'https://content.dropboxapi.com' };

export interface DropboxTokens {
  /** The Dropbox app's key (public: PKCE needs no secret). */
  appKey: string;
  refreshToken: string;
  accessToken: string | null;
  /** When the access token expires (ms since 1970). */
  expiresAt: number;
}

/** A file in the app folder. */
export interface RemoteFile {
  /** Its path as Dropbox shows it, without the leading slash: `notes/a.md`. */
  path: string;
  /** Dropbox compares paths without case: `notes/a.md` for `Notes/A.md`. */
  key: string;
  rev: string;
  /** Dropbox's content hash (see contentHash). */
  hash: string;
  size: number;
  /** When it last changed on Dropbox (ms since 1970). */
  modified: number;
}

export interface Changes {
  /** In order: a file as it is now, or a key with null for a file (or folder: everything below it) deleted. */
  entries: { key: string; file: RemoteFile | null }[];
  cursor: string;
}

export class DropboxError extends Error {
  override name = 'DropboxError';
  readonly status: number;
  /** Dropbox's error summary, e.g. `path/conflict/file/..`. */
  readonly summary: string;
  /** Seconds to wait before trying again (rate limits). */
  readonly retryAfter: number | null;

  constructor(message: string, status: number, summary = '', retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.summary = summary;
    this.retryAfter = retryAfter;
  }

  /** The file changed on Dropbox since the revision we know (or appeared there). */
  get conflict(): boolean {
    return this.status === 409 && /conflict/.test(this.summary);
  }

  get notFound(): boolean {
    return this.status === 409 && /not_found/.test(this.summary);
  }

  /** The cursor is too old: list everything again. */
  get reset(): boolean {
    return this.status === 409 && /^reset/.test(this.summary);
  }

  /** Signing in has to happen again (the app's access was removed, say). */
  get signedOut(): boolean {
    return (this.status === 401 && !this.missingScope) || /invalid_grant/.test(this.summary);
  }

  /** The Dropbox app lacks a permission (its Permissions tab), e.g. `files.content.write`; null if that isn't the trouble. */
  get missingScope(): string | null {
    return /^missing_scope/.test(this.summary) ? (/needs (\S+)/.exec(this.message)?.[1] ?? 'one') : null;
  }
}

/** Dropbox's content hash: SHA-256 of each 4 MB block's SHA-256, so local files can be compared without downloading. */
export function contentHash(bytes: Uint8Array): string {
  const BLOCK = 4 * 1024 * 1024;
  const blocks = Math.max(1, Math.ceil(bytes.length / BLOCK));
  const joined = new Uint8Array(blocks * 32);
  for (let i = 0; i < blocks; i++) joined.set(sha256Bytes(bytes.subarray(i * BLOCK, (i + 1) * BLOCK)), i * 32);
  return sha256Hex(joined);
}

/** Bytes as a request or response body (the DOM and Node typings disagree on which byte arrays fetch takes; all of them work). */
export const asBody = (bytes: Uint8Array) => bytes as unknown as ArrayBuffer;

/** JSON safe for an HTTP header: Dropbox wants characters beyond ASCII written as \uXXXX. */
export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

interface FileMetadata {
  '.tag': 'file';
  path_display: string;
  path_lower: string;
  rev: string;
  size: number;
  content_hash: string;
  server_modified: string;
}

interface Entry {
  '.tag': 'file' | 'folder' | 'deleted';
  path_lower: string;
  path_display?: string;
}

function remoteFile(m: FileMetadata): RemoteFile {
  return { path: m.path_display.replace(/^\//, '').normalize('NFC'), key: m.path_lower.replace(/^\//, '').normalize('NFC'), rev: m.rev, hash: m.content_hash, size: m.size, modified: Date.parse(m.server_modified) };
}

async function failure(res: Response, what: string): Promise<DropboxError> {
  const text = await res.text().catch(() => '');
  let summary = '';
  try {
    const body = JSON.parse(text) as { error_summary?: string; error?: string | { required_scope?: string }; error_description?: string };
    summary = body.error_summary ?? (typeof body.error === 'string' ? body.error : '');
    const scope = typeof body.error === 'object' ? body.error?.required_scope : undefined;
    if (scope) return new DropboxError(`Dropbox: ${what} failed: the app needs ${scope}`, res.status, summary);
  } catch {
    summary = text.slice(0, 200);
  }
  const retry = Number(res.headers.get('retry-after'));
  return new DropboxError(`Dropbox: ${what} failed (${res.status}${summary ? `: ${summary}` : ''})`, res.status, summary, Number.isFinite(retry) && retry > 0 ? retry : null);
}

/** Exchanges the code Dropbox showed for tokens. */
export async function tokensFromCode(appKey: string, code: string, verifier: string, fetchFn: FetchFn, endpoints = DROPBOX): Promise<DropboxTokens> {
  const res = await fetchFn(`${endpoints.api}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: code.trim(), client_id: appKey, code_verifier: verifier }),
  });
  if (!res.ok) throw await failure(res, 'signing in');
  const body = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  if (!body.refresh_token) throw new DropboxError('Dropbox gave no refresh token', 400);
  return { appKey, refreshToken: body.refresh_token, accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
}

export class Dropbox {
  #tokens: DropboxTokens;
  readonly #fetch: FetchFn;
  readonly #endpoints: DropboxEndpoints;
  readonly #saveTokens: (tokens: DropboxTokens) => Promise<void>;

  constructor(tokens: DropboxTokens, fetchFn: FetchFn, saveTokens: (tokens: DropboxTokens) => Promise<void>, endpoints: DropboxEndpoints = DROPBOX) {
    this.#tokens = tokens;
    this.#fetch = fetchFn;
    this.#saveTokens = saveTokens;
    this.#endpoints = endpoints;
  }

  /** A valid access token, refreshed when it is about to expire (or `force`d after Dropbox refused it). */
  async #token(force = false): Promise<string> {
    if (!force && this.#tokens.accessToken && this.#tokens.expiresAt - Date.now() > 5 * 60_000) return this.#tokens.accessToken;
    const res = await this.#fetch(`${this.#endpoints.api}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.#tokens.refreshToken, client_id: this.#tokens.appKey }),
    });
    if (!res.ok) throw await failure(res, 'renewing access');
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.#tokens = { ...this.#tokens, accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    await this.#saveTokens(this.#tokens);
    return body.access_token;
  }

  /** One request, with a fresh access token, tried once more when Dropbox says the token expired. Gives up after `timeoutMs`. */
  async #send(what: string, url: string, init: (token: string) => RequestInit, timeoutMs = 60_000): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(url, { ...init(await this.#token(attempt > 0)), signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
      const error = await failure(res, what);
      if (error.status === 401 && !error.missingScope && attempt === 0) continue;
      throw error;
    }
  }

  async #rpc<T>(what: string, endpoint: string, args: unknown): Promise<T> {
    const res = await this.#send(what, `${this.#endpoints.api}/2/${endpoint}`, (token) => ({
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    }));
    return (await res.json()) as T;
  }

  /** Every file (no cursor), or what changed since `cursor`. Throws a `reset` DropboxError when the cursor is too old. */
  async changes(cursor: string | null): Promise<Changes> {
    const result: Changes = { entries: [], cursor: cursor ?? '' };
    type Page = { entries: Entry[]; cursor: string; has_more: boolean };
    let page = cursor
      ? await this.#rpc<Page>('listing changes', 'files/list_folder/continue', { cursor })
      : await this.#rpc<Page>('listing files', 'files/list_folder', { path: '', recursive: true, include_deleted: false, limit: 2000 });
    for (;;) {
      for (const entry of page.entries) {
        if (entry['.tag'] === 'file') {
          const file = remoteFile(entry as unknown as FileMetadata);
          result.entries.push({ key: file.key, file });
        } else if (entry['.tag'] === 'deleted') result.entries.push({ key: entry.path_lower.replace(/^\//, '').normalize('NFC'), file: null });
      }
      result.cursor = page.cursor;
      if (!page.has_more) return result;
      page = await this.#rpc<Page>('listing changes', 'files/list_folder/continue', { cursor: page.cursor });
    }
  }

  /** A file's bytes: the current version, or revision `rev`. */
  async download(path: string, rev?: string): Promise<{ bytes: Uint8Array; file: RemoteFile }> {
    const res = await this.#send(`downloading ${path}`, `${this.#endpoints.content}/2/files/download`, (token) => ({
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'dropbox-api-arg': headerJson({ path: rev ? `rev:${rev}` : `/${path}` }) },
    }), 10 * 60_000);
    const meta = JSON.parse(res.headers.get('dropbox-api-result') ?? 'null') as FileMetadata | null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!meta) throw new DropboxError(`Dropbox: no details came with ${path}`, 502);
    return { bytes, file: remoteFile(meta) };
  }

  /**
   * Uploads a file: as a new file (`null`: fails if one is there), over revision `rev` (fails if
   * Dropbox has another), or over whatever is there (`'overwrite'`; Dropbox keeps the old one in
   * its version history).
   */
  async upload(path: string, bytes: Uint8Array, over: string | null | 'overwrite'): Promise<RemoteFile> {
    const mode = over === null ? 'add' : over === 'overwrite' ? 'overwrite' : { '.tag': 'update', update: over };
    const res = await this.#send(`uploading ${path}`, `${this.#endpoints.content}/2/files/upload`, (token) => ({
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'dropbox-api-arg': headerJson({ path: `/${path}`, mode, autorename: false, mute: true, strict_conflict: true }) },
      body: asBody(bytes),
    }), 10 * 60_000);
    return remoteFile((await res.json()) as FileMetadata);
  }

  /** Deletes a file if it is still revision `rev`. A file that is gone already is fine. */
  async remove(path: string, rev: string): Promise<void> {
    try {
      await this.#rpc('deleting', 'files/delete_v2', { path: `/${path}`, parent_rev: rev });
    } catch (err) {
      if (!(err instanceof DropboxError && err.notFound)) throw err;
    }
  }

  /** Whose Dropbox this is, to show. */
  async account(): Promise<{ name: string; email: string }> {
    const body = await this.#rpc<{ name: { display_name: string }; email: string }>('reading the account', 'users/get_current_account', null);
    return { name: body.name.display_name, email: body.email };
  }
}
