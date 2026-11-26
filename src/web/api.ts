import type {
  BacklinksResponse,
  CaptureRequest,
  ConflictResponse,
  DataDoc,
  HistoryResponse,
  NoteDoc,
  NoteSummary,
  PaperSummary,
  SaveNoteRequest,
  SaveNoteResponse,
  SearchResponse,
  Settings,
  SyncStatus,
  TagCount,
  TaskItem,
  VaultBlobInfo,
} from '../shared/api.ts';
import { appUrl } from './router.ts';

/** The note changed on disk since the version the save was based on. */
export class SaveConflict extends Error {
  override name = 'SaveConflict';
  readonly current: NoteDoc;

  constructor(current: NoteDoc) {
    super(`${current.path} changed on disk`);
    this.current = current;
  }
}

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  const message = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : `${res.status} ${res.statusText}`.trim();
  return new ApiError(res.status, message, body);
}

/** A request to the API. `body` goes as JSON, except form data and files (Blob), which go as they are. */
async function call<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const raw = body instanceof FormData || body instanceof Blob;
  const res = await fetch(appUrl(url), {
    method,
    ...init,
    headers: body === undefined || raw ? init.headers : { 'content-type': 'application/json', ...init.headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as T;
}

const q = (value: string) => encodeURIComponent(value);

export async function fetchNote(path: string, signal?: AbortSignal): Promise<NoteDoc> {
  return call<NoteDoc>('GET', `/api/note?path=${q(path)}`, undefined, { signal });
}

export async function saveNote(request: SaveNoteRequest, options: { keepalive?: boolean } = {}): Promise<SaveNoteResponse> {
  try {
    return await call<SaveNoteResponse>('PUT', '/api/note', request, { keepalive: options.keepalive ?? false });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) throw new SaveConflict((err.body as ConflictResponse).current);
    throw err;
  }
}

export function fileUrl(path: string): string {
  return appUrl(`/api/file?path=${q(path)}`);
}

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

export const api = {
  notes: () => call<NoteSummary[]>('GET', '/api/notes'),
  addExamples: (today: string) => call<{ added: string[]; kept: string[] }>('POST', `/api/examples?today=${today}`),
  removeExamples: () => call<{ removed: string[] }>('DELETE', '/api/examples'),
  syncStatus: () => call<SyncStatus>('GET', '/api/sync'),
  syncConnect: (appKey: string, code: string, verifier: string) => call<SyncStatus>('POST', '/api/sync/connect', { appKey, code, verifier }),
  syncDisconnect: () => call<SyncStatus>('DELETE', '/api/sync/connect'),
  syncRun: (deletes?: 'allow' | 'restore') => call<{ status: SyncStatus; more: boolean }>('POST', '/api/sync', deletes ? { deletes } : {}),
  tags: () => call<TagCount[]>('GET', '/api/tags'),
  createNote: (title: string, folder = 'notes') => call<{ path: string }>('POST', '/api/note/create', { title, folder }),
  createDashboard: (title: string) => call<{ path: string }>('POST', '/api/note/create', { title, kind: 'dashboard' }),
  createBoard: (title: string, tag: string) => call<{ path: string }>('POST', '/api/note/create', { title, kind: 'board', tag }),
  noteIdStatus: () => call<{ notes: number; missing: number; copies: number }>('GET', '/api/ids'),
  importNotes: (zip: Blob) => call<{ added: number; same: number; kept: string[]; skipped: string[] }>('POST', '/api/import', zip, { headers: { 'content-type': 'application/zip' } }),
  assignNoteIds: () => call<{ added: number; renewed: number }>('POST', '/api/ids'),
  renameNote: (path: string, title: string) => call<{ path: string; updated: string[] }>('POST', '/api/note/rename', { path, title }),
  deleteNote: (path: string) => call<{ trashPath: string }>('POST', '/api/note/delete', { path }),
  restoreNote: (path: string, version: string) => call<{ hash: string | null }>('POST', '/api/note/restore', { path, version }),
  search: (query: string, today: string) => call<SearchResponse>('GET', `/api/search?q=${q(query)}&today=${today}`),
  backlinks: (path: string) => call<BacklinksResponse>('GET', `/api/backlinks?path=${q(path)}`),
  linkMention: (path: string, line: number, term: string, target: string) => call<{ hash: string | null }>('POST', '/api/link-mention', { path, line, term, target }),
  tasks: (today: string) => call<TaskItem[]>('GET', `/api/tasks?today=${today}`),
  toggleTask: (task: Pick<TaskItem, 'path' | 'line' | 'raw'>, today: string) => call<{ hash: string | null }>('POST', '/api/tasks/toggle', { path: task.path, line: task.line, raw: task.raw, today }),
  capture: (request: CaptureRequest) => call<{ path: string }>('POST', '/api/capture', request),
  history: (path: string) => call<HistoryResponse>('GET', `/api/history?path=${q(path)}`),
  version: (path: string, version: string) => call<{ content: string }>('GET', `/api/history/version?path=${q(path)}&version=${q(version)}`),
  settings: () => call<Settings>('GET', '/api/settings'),
  saveSettings: (settings: Settings) => call<Settings>('PUT', '/api/settings', settings),
  unfurl: (url: string) => call<{ title: string | null }>('POST', '/api/unfurl', { url }),
  uploadFile: (file: File) => call<{ path: string }>('POST', '/api/files', form({ file })),
  data: <T>(path: string) => call<DataDoc<T | null>>('GET', `/api/data?path=${q(path)}`),
  saveData: (path: string, data: unknown, baseHash: string | null) => call<{ hash: string }>('PUT', '/api/data', { path, data, baseHash }),
  papers: () => call<PaperSummary[]>('GET', '/api/papers'),
  importPaper: (source: string) => call<{ key: string; path: string; pdf: boolean; existing: boolean }>('POST', '/api/papers/import', { source }),
  uploadPaper: (file: File) => call<{ key: string; path: string }>('POST', '/api/papers/upload', form({ file })),
  attachPdf: (path: string, file: File) => call<{ pdf: string }>('POST', '/api/papers/attach', form({ file, path })),
  vaultKey: () => call<{ text: string | null; hash: string | null }>('GET', '/api/vault/key'),
  saveVaultKey: (text: string, baseHash: string | null) => call<{ hash: string }>('PUT', '/api/vault/key', { text, baseHash }),
  vaultItems: () => call<VaultBlobInfo[]>('GET', '/api/vault/items'),
  async vaultItem(id: string): Promise<{ bytes: Uint8Array; hash: string }> {
    const res = await fetch(`/api/vault/item/${id}`);
    if (!res.ok) throw await errorFrom(res);
    return { bytes: new Uint8Array(await res.arrayBuffer()), hash: res.headers.get('x-hash') ?? '' };
  },
  async saveVaultItem(id: string, bytes: Uint8Array, baseHash: string | null): Promise<{ hash: string }> {
    const res = await fetch(`/api/vault/item/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-base-hash': baseHash ?? '' },
      body: bytes as BodyInit,
    });
    if (!res.ok) throw await errorFrom(res);
    return (await res.json()) as { hash: string };
  },
  deleteVaultItem: (id: string) => call<{ ok: true }>('DELETE', `/api/vault/item/${id}`),
};
