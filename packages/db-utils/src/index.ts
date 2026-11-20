import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Opens (or creates) a SQLite database with:
 *  - WAL journal mode  → concurrent reads never block writes
 *  - busy_timeout 5 s  → writers retry instead of throwing SQLITE_BUSY
 *  - foreign_keys ON   → referential integrity enforced
 *  - synchronous NORMAL→ safe with WAL, faster than FULL
 *
 * Every service must call openDb() instead of `new Database()` directly.
 */
export function openDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // ── Gotcha #5 guard: WAL + busy_timeout ─────────────────────────────────
  db.pragma('journal_mode = WAL');       // multiple readers, one writer, no locks
  db.pragma('busy_timeout = 5000');      // wait up to 5 s before SQLITE_BUSY
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');     // safe in WAL, 2-3× faster than FULL
  db.pragma('cache_size = -32000');      // 32 MB page cache (negative = KiB)
  db.pragma('temp_store = MEMORY');

  return db;
}

/** Wraps fn in a transaction; re-throws and rolls back on error. */
export function withTransaction<T>(
  db: Database.Database,
  fn: (db: Database.Database) => T,
): T {
  return db.transaction(fn)(db);
}

export type { Database };
