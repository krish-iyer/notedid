import os from 'node:os';
import path from 'node:path';

export interface Config {
  /** Absolute path of the folder that holds the notes. */
  notesDir: string;
  host: string;
  /** Port of this API server. */
  port: number;
  /** Port of the Vite dev server that serves the web client during development. */
  webPort: number;
  production: boolean;
  /** Browser origins allowed to send state-changing requests. */
  allowedOrigins: string[];
  /** Folder with the built web client, served in production. */
  webDist: string;
  /** Note history: commit this long after changes stop. */
  historyDelayMs: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
export const DEFAULT_PORT = 4321;
export const DEFAULT_WEB_PORT = 4322;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';

  // Development defaults to a scratch folder inside the repo, so building the app never touches real notes.
  const rawNotesDir = env.NOTES_DIR?.trim() || (production ? '' : 'dev-notes');
  if (!rawNotesDir) {
    throw new Error('Set NOTES_DIR to the folder that holds your notes (required in production).');
  }
  const notesDir = path.resolve(expandHome(rawNotesDir));

  const host = env.HOST?.trim() || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    // There is no login yet, so the server must not be reachable from other machines.
    throw new Error(`Refusing to listen on ${host}: until login exists, the server only listens on localhost.`);
  }

  const port = parsePort('PORT', env.PORT, DEFAULT_PORT);
  const webPort = parsePort('WEB_PORT', env.WEB_PORT, DEFAULT_WEB_PORT);

  const allowedOrigins = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    ...(production ? [] : [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`]),
  ];

  const historySeconds = Number(env.HISTORY_DELAY_SECONDS ?? 60);
  const historyDelayMs = Number.isFinite(historySeconds) && historySeconds >= 1 ? historySeconds * 1000 : 60_000;

  return { notesDir, host, port, webPort, production, allowedOrigins, webDist: path.resolve('dist/web'), historyDelayMs };
}

export function parsePort(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a whole number from 1 to 65535, got "${value}".`);
  }
  return port;
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}
