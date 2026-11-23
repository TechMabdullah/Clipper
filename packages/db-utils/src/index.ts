import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export type Db = DatabaseSync;

/**
 * Opens (or creates) a SQLite database using Node.js 22 built-in node:sqlite.
 * No native compilation required — works out of the box.
 *
 * Applies:
 *  - WAL journal mode  → concurrent reads never block writes        (Gotcha #5)
 *  - busy_timeout 5 s  → writers retry instead of throwing SQLITE_BUSY
 *  - foreign_keys ON
 *  - synchronous NORMAL (safe with WAL, 2-3× faster than FULL)
 */
export function openDb(dbPath: string): DatabaseSync {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbPath);

  // Gotcha #5 guard ─────────────────────────────────────────────────────────
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA cache_size = -32000");   // 32 MB page cache
  db.exec("PRAGMA temp_store = MEMORY");

  return db;
}

/**
 * Runs fn inside a BEGIN/COMMIT transaction.
 * Rolls back and re-throws on error.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
