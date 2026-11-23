import path from 'node:path';
import crypto from 'node:crypto';
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

export interface InsertClipParams {
  id?: string;
  jobId?: string;
  title: string;
  description?: string;
  startSec?: number;
  endSec?: number;
  durationSec?: number;
  filePath: string;
  fileSizeBytes?: number;
  status?: string;
}

/**
 * Safely inserts a clip into SQLite, guaranteeing that the parent
 * ingest_jobs row exists first to prevent FOREIGN KEY constraint violations.
 */
export function insertClip(params: InsertClipParams): string {
  const clipId = params.id ?? crypto.randomUUID();
  const jobId = params.jobId ?? 'default';

  // Ensure parent job exists so SQLite FOREIGN KEY constraint is always satisfied
  db.prepare(`
    INSERT OR IGNORE INTO ingest_jobs (id, source_url, status)
    VALUES (?, ?, 'DONE')
  `).run(jobId, 'system');

  const startSec = params.startSec ?? 0;
  const duration = params.durationSec ?? Math.max(0, (params.endSec ?? 0) - startSec);
  const endSec = params.endSec ?? (startSec + duration);

  db.prepare(`
    INSERT INTO clips (id, job_id, title, description, start_sec, end_sec, duration_sec, file_path, file_size_bytes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clipId,
    jobId,
    params.title,
    params.description ?? '',
    startSec,
    endSec,
    duration,
    params.filePath,
    params.fileSizeBytes ?? 0,
    params.status ?? 'READY'
  );

  return clipId;
}

