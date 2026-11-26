import { watch } from 'node:fs';
import path from 'node:path';

/**
 * Watches the notes folder for changes made outside the app (another editor, a sync tool).
 * Calls `onChange` with the changed file's relative path, or null when the platform can't say.
 * Hidden files and folders (.git, .notedid, temporary files) are ignored. Returns a stop function.
 */
export function watchFolder(root: string, onChange: (rel: string | null) => void): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedule = (key: string, rel: string | null) => {
    const pending = timers.get(key);
    if (pending) clearTimeout(pending);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        onChange(rel);
      }, 150),
    );
  };

  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return schedule('*', null);
      const rel = String(filename).split(path.sep).join('/').normalize('NFC');
      const segments = rel.split('/');
      if (segments.some((s) => s.startsWith('.')) || segments[0] === 'vault') return;
      schedule(rel, rel);
    });
  } catch (err) {
    console.warn('Watching the notes folder is not possible here; edits made outside the app show up after a restart.', err);
    return () => undefined;
  }
  watcher.on('error', (err) => console.warn('file watcher error', err));
  return () => {
    watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
