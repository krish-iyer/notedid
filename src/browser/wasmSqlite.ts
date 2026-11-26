import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { SqlDatabase, SqlValue } from '../server/noteIndex.ts';

/**
 * An empty in-memory SQLite database (SQLite compiled to WebAssembly, FTS5 included) with the calls
 * the note index makes, so the index runs in a browser exactly as on a server.
 */
export function wasmDatabase(sqlite3: Sqlite3Static): SqlDatabase {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  type Bind = Parameters<typeof db.selectObjects>[1];
  const bind = (params: SqlValue[]) => (params.length ? (params as unknown as Bind) : undefined);
  return {
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      return {
        run(...params) {
          db.exec({ sql, bind: bind(params) });
          return { changes: db.changes(), lastInsertRowid: Number(db.selectValue('SELECT last_insert_rowid()')) };
        },
        get: (...params) => db.selectObject(sql, bind(params)),
        all: (...params) => db.selectObjects(sql, bind(params)),
      };
    },
  };
}
