import path from 'node:path';
import { openDb, type Db } from '@clipper/db-utils';

const DATA_DIR = process.env.DATA_DIR ?? './data';
export const db: Db = openDb(path.join(DATA_DIR, 'clipper.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS ingest_jobs (
    id          TEXT PRIMARY KEY,
    source_url  TEXT,
    source_path TEXT,
    status      TEXT NOT NULL DEFAULT 'PENDING',
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS clips (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES ingest_jobs(id),
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    start_sec       REAL NOT NULL,
    end_sec         REAL NOT NULL,
    duration_sec    REAL NOT NULL DEFAULT 0,
    file_path       TEXT NOT NULL DEFAULT '',
    file_size_bytes INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'READY',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  INSERT OR IGNORE INTO ingest_jobs (id, source_url, status)
  VALUES ('default', 'system', 'DONE');
`);
