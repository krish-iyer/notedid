import { asBody, contentHash } from './dropbox.ts';
import type { FetchFn } from './web.ts';

/**
 * A Dropbox app folder in memory, answering the same HTTP calls as Dropbox (the ones sync uses),
 * for tests: two "devices" syncing through one of these behave as with the real thing. Paths
 * ignore case, revisions are kept, cursors replay what changed since.
 */

interface Revision {
  rev: string;
  bytes: Uint8Array;
  modified: number;
}

interface StoredFile {
  path: string;
  revisions: Revision[];
  deleted: boolean;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const fail = (summary: string, status = 409) => json({ error_summary: `${summary}/..`, error: { '.tag': summary.split('/')[0] } }, status);

export class FakeDropbox {
  readonly files = new Map<string, StoredFile>();
  /** Every change, in order: cursors are positions in it. */
  readonly #log: string[] = [];
  #revs = 0;
  #tokens = 0;
  readonly #accessTokens = new Set<string>();
  /** Refresh tokens handed out; remove one to take the app's access away. */
  readonly refreshTokens = new Set<string>();
  /** Files per listing page (Dropbox pages too). */
  pageSize = 1000;
  /** Calls made, by endpoint (to see what sync did). */
  readonly calls: string[] = [];
  /** Answer the next calls with these (rate limits, outages). */
  readonly failNext: Response[] = [];

  /** Puts a file in the folder, as another device would. */
  put(path: string, content: string | Uint8Array, modified = Date.now()): string {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const key = path.toLowerCase();
    const file = this.files.get(key) ?? { path, revisions: [], deleted: false };
    if (file.deleted) file.path = path;
    const rev = `${(++this.#revs).toString(16).padStart(9, '0')}a1b2c3`;
    file.revisions.push({ rev, bytes, modified });
    file.deleted = false;
    this.files.set(key, file);
    this.#log.push(key);
    return rev;
  }

  /** Deletes a file, as another device would. */
  delete(path: string): void {
    const file = this.files.get(path.toLowerCase());
    if (!file || file.deleted) return;
    file.deleted = true;
    this.#log.push(path.toLowerCase());
  }

  /** The current text of a file, or null. */
  text(path: string): string | null {
    const file = this.files.get(path.toLowerCase());
    const current = file && !file.deleted ? file.revisions.at(-1) : undefined;
    return current ? new TextDecoder().decode(current.bytes) : null;
  }

  /** Every file there now, by path. */
  paths(): string[] {
    return [...this.files.values()].filter((f) => !f.deleted).map((f) => f.path).sort();
  }

  #metadata(file: StoredFile, revision = file.revisions.at(-1) as Revision) {
    return {
      '.tag': 'file',
      name: file.path.split('/').pop(),
      path_display: `/${file.path}`,
      path_lower: `/${file.path.toLowerCase()}`,
      rev: revision.rev,
      size: revision.bytes.length,
      content_hash: contentHash(revision.bytes),
      server_modified: new Date(revision.modified).toISOString().replace(/\.\d+Z$/, 'Z'),
      client_modified: new Date(revision.modified).toISOString().replace(/\.\d+Z$/, 'Z'),
    };
  }

  #entry(key: string) {
    const file = this.files.get(key);
    if (!file || file.deleted) return { '.tag': 'deleted', path_lower: `/${key}`, path_display: `/${file?.path ?? key}` };
    return this.#metadata(file);
  }

  #page(keys: string[], position: number) {
    const entries = keys.slice(0, this.pageSize).map((key) => this.#entry(key));
    const rest = keys.slice(this.pageSize);
    // A cursor holds where in the log it is, and what of this listing is still to come.
    return { entries, cursor: btoa(JSON.stringify({ position, rest })), has_more: rest.length > 0 };
  }

  readonly fetch: FetchFn = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const endpoint = url.pathname.replace(/^\/(2\/)?/, '');
    this.calls.push(endpoint);
    const next = this.failNext.shift();
    if (next) return next;
    const headers = new Headers(init?.headers);
    if (endpoint === 'oauth2/token') return this.#token(new URLSearchParams(String(init?.body ?? '')));
    const auth = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!this.#accessTokens.has(auth)) return json({ error_summary: 'expired_access_token/..', error: { '.tag': 'expired_access_token' } }, 401);
    const arg = headers.get('dropbox-api-arg');
    const args = (arg ? JSON.parse(arg) : init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    const bodyBytes = async () => new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
    switch (endpoint) {
      case 'files/list_folder': {
        const keys = [...this.files.entries()].filter(([, f]) => !f.deleted).map(([key]) => key).sort();
        return json(this.#page(keys, this.#log.length));
      }
      case 'files/list_folder/continue': {
        let cursor: { position: number; rest: string[] };
        try {
          cursor = JSON.parse(atob(String(args?.cursor ?? ''))) as typeof cursor;
        } catch {
          return fail('reset');
        }
        if (cursor.rest.length) return json(this.#page(cursor.rest, cursor.position));
        const changed = [...new Set(this.#log.slice(cursor.position))];
        return json(this.#page(changed, this.#log.length));
      }
      case 'files/download': {
        const path = String(args?.path ?? '');
        let file: StoredFile | undefined;
        let revision: Revision | undefined;
        if (path.startsWith('rev:')) {
          for (const f of this.files.values()) {
            const r = f.revisions.find((x) => x.rev === path.slice(4));
            if (r) [file, revision] = [f, r];
          }
        } else {
          file = this.files.get(path.slice(1).toLowerCase());
          revision = file && !file.deleted ? file.revisions.at(-1) : undefined;
        }
        if (!file || !revision) return fail('path/not_found');
        return new Response(asBody(revision.bytes), { headers: { 'dropbox-api-result': JSON.stringify(this.#metadata(file, revision)) } });
      }
      case 'files/upload': {
        const path = String(args?.path ?? '').slice(1);
        const key = path.toLowerCase();
        const bytes = await bodyBytes();
        const existing = this.files.get(key);
        const current = existing && !existing.deleted ? existing.revisions.at(-1) : undefined;
        const mode = args?.mode as string | { '.tag': string; update: string };
        if (mode === 'add' && current) {
          if (contentHash(current.bytes) === contentHash(bytes)) return json(this.#metadata(existing as StoredFile));
          return fail('path/conflict/file');
        }
        if (typeof mode === 'object' && current?.rev !== mode.update) return fail('path/conflict/file');
        this.put(current ? (existing as StoredFile).path : path, bytes);
        return json(this.#metadata(this.files.get(key) as StoredFile));
      }
      case 'files/delete_v2': {
        const key = String(args?.path ?? '').slice(1).toLowerCase();
        const file = this.files.get(key);
        if (!file || file.deleted) return fail('path_lookup/not_found');
        if (args?.parent_rev && file.revisions.at(-1)?.rev !== args.parent_rev) return fail('path_lookup/conflict');
        this.delete(file.path);
        return json({ metadata: this.#entry(key) });
      }
      case 'users/get_current_account':
        return json({ name: { display_name: 'Test Person' }, email: 'person@example.com' });
      default:
        return json({ error: `no such endpoint ${endpoint}` }, 400);
    }
  };

  #token(form: URLSearchParams): Response {
    if (form.get('grant_type') === 'authorization_code') {
      if (!form.get('code') || !form.get('code_verifier') || !form.get('client_id')) return json({ error: 'invalid_grant' }, 400);
      const refresh = `refresh-${++this.#tokens}`;
      this.refreshTokens.add(refresh);
      return json({ ...this.#access(), refresh_token: refresh, account_id: 'dbid:test' });
    }
    if (form.get('grant_type') === 'refresh_token' && this.refreshTokens.has(form.get('refresh_token') ?? '')) return json(this.#access());
    return json({ error: 'invalid_grant', error_description: 'refresh token is invalid or revoked' }, 400);
  }

  #access() {
    const token = `access-${++this.#tokens}`;
    this.#accessTokens.add(token);
    return { access_token: token, token_type: 'bearer', expires_in: 14400 };
  }

  /** Makes every access token expire (the app has to renew it). */
  expireTokens(): void {
    this.#accessTokens.clear();
  }
}
