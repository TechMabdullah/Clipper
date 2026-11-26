import crypto from 'node:crypto';
import { db } from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS clip_comments (
    id            TEXT PRIMARY KEY,
    clip_id       TEXT NOT NULL,
    author        TEXT NOT NULL DEFAULT 'admin',
    body          TEXT NOT NULL,
    timestamp_sec REAL,
    resolved      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_clip_comments_clip ON clip_comments(clip_id, resolved, created_at);
`);

export interface ClipComment {
  id: string;
  clip_id: string;
  author: string;
  body: string;
  timestamp_sec: number | null;
  resolved: number;
  created_at: number;
}

/** Adds a timestamped review comment to a clip. */
export function addComment(
  clipId: string,
  body: string,
  author?: string,
  timestampSec?: number | null,
): ClipComment {
  const id = crypto.randomUUID();
  const cleanAuthor = (author?.trim() || 'admin').slice(0, 50);
  const cleanBody = body.trim();
  const cleanTs =
    timestampSec !== undefined && timestampSec !== null && Number.isFinite(timestampSec) && timestampSec >= 0
      ? Number(timestampSec)
      : null;

  db.prepare(`
    INSERT INTO clip_comments (id, clip_id, author, body, timestamp_sec, resolved)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(id, clipId, cleanAuthor, cleanBody, cleanTs);

  return getCommentById(id)!;
}

/** Lists all comments for a clip ordered by timestamp (un-timestamped comments last) then creation time. */
export function listComments(clipId: string): ClipComment[] {
  return db.prepare(`
    SELECT id, clip_id, author, body, timestamp_sec, resolved, created_at
    FROM clip_comments
    WHERE clip_id = ?
    ORDER BY COALESCE(timestamp_sec, 999999) ASC, created_at ASC
  `).all(clipId) as unknown as ClipComment[];
}

/** Fetches a single comment by ID, or null if not found. */
export function getCommentById(id: string): ClipComment | null {
  if (!id || typeof id !== 'string') return null;
  return (db.prepare(`
    SELECT id, clip_id, author, body, timestamp_sec, resolved, created_at
    FROM clip_comments
    WHERE id = ?
  `).get(id) as ClipComment | undefined) ?? null;
}

/** Resolves, unresolves, or toggles the resolved state of a clip comment. */
export function toggleCommentResolved(id: string, resolved?: boolean): ClipComment | null {
  const existing = getCommentById(id);
  if (!existing) return null;
  const nextResolved = resolved === undefined ? (existing.resolved === 1 ? 0 : 1) : (resolved ? 1 : 0);
  db.prepare(`UPDATE clip_comments SET resolved = ? WHERE id = ?`).run(nextResolved, id);
  return getCommentById(id);
}

/** Deletes a comment by ID. */
export function deleteComment(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const res = db.prepare(`DELETE FROM clip_comments WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}

/** Returns the count of unresolved comments on a clip. */
export function getUnresolvedCommentCount(clipId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM clip_comments WHERE clip_id = ? AND resolved = 0
  `).get(clipId) as { cnt: number } | undefined;
  return Number(row?.cnt ?? 0);
}
