import type { SavedView, Settings } from '../shared/api.ts';
import type { Disk } from './disk.ts';
import { normalizeNotePath } from './storage.ts';

export const DEFAULT_SETTINGS: Settings = {
  pinned: [],
  views: [
    { name: 'Open tasks', query: 'is:open' },
    { name: 'Due this week', query: 'due:week' },
  ],
  vaultAutoLockMinutes: 10,
};

function validNotePath(value: unknown): value is string {
  try {
    normalizeNotePath(value);
    return true;
  } catch {
    return false;
  }
}

/** Keeps only well-formed values, so a hand-edited settings file can't break the app. */
export function sanitizeSettings(input: unknown): Settings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const pinned = Array.isArray(raw.pinned) ? [...new Set(raw.pinned.filter(validNotePath))].slice(0, 200) : DEFAULT_SETTINGS.pinned;
  const views = Array.isArray(raw.views)
    ? raw.views
        .filter((v): v is SavedView => typeof v === 'object' && v !== null && typeof (v as SavedView).name === 'string' && typeof (v as SavedView).query === 'string')
        .map((v) => ({ name: v.name.trim().slice(0, 60), query: v.query.trim().slice(0, 500) }))
        .filter((v) => v.name && v.query)
        .slice(0, 50)
    : DEFAULT_SETTINGS.views;
  const minutes = Number(raw.vaultAutoLockMinutes);
  const vaultAutoLockMinutes = Number.isInteger(minutes) && minutes >= 1 && minutes <= 240 ? minutes : DEFAULT_SETTINGS.vaultAutoLockMinutes;
  return { pinned, views, vaultAutoLockMinutes };
}

/** Settings live in the notes folder (.notesapp/settings.json), so they travel with the notes and their history. */
export class SettingsStore {
  static readonly FILE = '.notesapp/settings.json';
  readonly #disk: Disk;

  constructor(disk: Disk) {
    this.#disk = disk;
  }

  async load(): Promise<Settings> {
    const bytes = await this.#disk.read(SettingsStore.FILE);
    if (bytes === null) return structuredClone(DEFAULT_SETTINGS);
    try {
      return sanitizeSettings(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (err) {
      if (err instanceof SyntaxError) return structuredClone(DEFAULT_SETTINGS);
      throw err;
    }
  }

  async save(input: unknown): Promise<Settings> {
    const settings = sanitizeSettings(input);
    await this.#disk.write(SettingsStore.FILE, new TextEncoder().encode(`${JSON.stringify(settings, null, 2)}\n`));
    return settings;
  }
}
