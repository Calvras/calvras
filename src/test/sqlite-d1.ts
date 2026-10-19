import type { DatabaseSync } from "node:sqlite";
import type { D1Database } from "../lib/runtime/ledger";

/**
 * Runs D1-shaped calls against real SQLite. The ledger decides who is on Pro, so a hand-written
 * stub would only prove the code called something; this proves the SQL itself.
 */
export function d1Shim(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { bound = values; return statement; },
        run() {
          const result = sqlite.prepare(sql).run(...(bound as never[]));
          return Promise.resolve({ meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } });
        },
        first<T>() {
          const row = sqlite.prepare(sql).get(...(bound as never[]));
          return Promise.resolve((row ?? null) as T | null);
        },
        all<T>() {
          return Promise.resolve({ results: sqlite.prepare(sql).all(...(bound as never[])) as T[] });
        },
      };
      return statement;
    },
  };
}
