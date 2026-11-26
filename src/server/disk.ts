/**
 * The files below the notes folder, by relative path with forward slashes. The note logic (notes,
 * the vault, settings, papers) works on this interface, so the same code runs on a server with a
 * real folder (`nodeDisk.ts`) and in a browser. Paths here are trusted: what clients send is
 * checked before it gets this far (`normalizePath`).
 */
export interface Disk {
  /** A file's bytes, or null when there is no such file. */
  read(rel: string): Promise<Uint8Array | null>;
  /** Writes a whole file, making its folders, so that a crash never leaves half a file. */
  write(rel: string, bytes: Uint8Array): Promise<void>;
  /** Size in bytes and last change (ms since 1970), or null when there is no such file. */
  stat(rel: string): Promise<{ size: number; mtime: number } | null>;
  /** Moves a file. Fails (PathError) when there is no such file or something is at `to` already. */
  move(from: string, to: string): Promise<void>;
  /** Every file below folder `dir` ('' for all of them), sorted. Hidden files and folders are left out. */
  list(dir: string): Promise<string[]>;
}
