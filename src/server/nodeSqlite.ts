import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase } from './noteIndex.ts';

/** An empty in-memory SQLite database (node:sqlite), for the note index on a server and in tests. */
export function memoryDatabase(): SqlDatabase {
  return new DatabaseSync(':memory:');
}
