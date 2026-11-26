import crypto from 'node:crypto';
import { db } from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS social_upload_queue (
    id            TEXT PRIMARY KEY,
    clip_id       TEXT NOT NULL,
    platform      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',
    scheduled_for INTEGER,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    tags          TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    error_msg     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_social_upload_queue_clip ON social_upload_queue(clip_id);
  CREATE INDEX IF NOT EXISTS idx_social_upload_queue_status ON social_upload_queue(status, platform, created_at);
`);

export type SocialPlatform = 'youtube' | 'tiktok' | 'instagram' | 'twitter' | 'twitch_clips';
export type UploadStatus = 'queued' | 'in_progress' | 'done' | 'failed';

export const VALID_SOCIAL_PLATFORMS = new Set<SocialPlatform>([
  'youtube',
  'tiktok',
  'instagram',
  'twitter',
  'twitch_clips',
]);

export const VALID_UPLOAD_STATUSES = new Set<UploadStatus>([
  'queued',
  'in_progress',
  'done',
  'failed',
]);

export interface QueuedUpload {
  id: string;
  clip_id: string;
  platform: SocialPlatform;
  status: UploadStatus;
  scheduled_for: number | null;
  title: string;
  description: string;
  tags: string;
  created_at: number;
  updated_at: number;
  error_msg: string | null;
  clip_title?: string | null;
  clip_file_path?: string | null;
}

const SELECT_QUEUE_COLUMNS = `
  q.id, q.clip_id, q.platform, q.status, q.scheduled_for,
  q.title, q.description, q.tags, q.created_at, q.updated_at, q.error_msg,
  c.title AS clip_title, c.file_path AS clip_file_path
`;

/** Lists all queued social upload items newest-first, joined with clip metadata. */
export function listUploadQueue(): QueuedUpload[] {
  return db.prepare(`
    SELECT ${SELECT_QUEUE_COLUMNS}
    FROM social_upload_queue q
    LEFT JOIN clips c ON c.id = q.clip_id
    ORDER BY q.created_at DESC
  `).all() as unknown as QueuedUpload[];
}

/** Fetches a single upload queue item by ID, or null if not found. */
export function getUploadQueueItem(id: string): QueuedUpload | null {
  if (!id || typeof id !== 'string') return null;
  return (db.prepare(`
    SELECT ${SELECT_QUEUE_COLUMNS}
    FROM social_upload_queue q
    LEFT JOIN clips c ON c.id = q.clip_id
    WHERE q.id = ?
  `).get(id) as QueuedUpload | undefined) ?? null;
}

/** Enqueues a clip for upload/export to a target social platform. */
export function addToUploadQueue(params: {
  clipId: string;
  platform: SocialPlatform;
  title: string;
  description?: string;
  tags?: string;
  scheduledFor?: number | null;
}): QueuedUpload {
  const id = crypto.randomUUID();
  const scheduledFor =
    params.scheduledFor !== undefined && params.scheduledFor !== null && Number.isFinite(params.scheduledFor)
      ? Math.trunc(params.scheduledFor)
      : null;

  db.prepare(`
    INSERT INTO social_upload_queue (
      id, clip_id, platform, status, scheduled_for, title, description, tags
    ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
  `).run(
    id,
    params.clipId,
    params.platform,
    scheduledFor,
    params.title.trim(),
    (params.description ?? '').trim(),
    (params.tags ?? '').trim(),
  );

  return getUploadQueueItem(id)!;
}

/** Updates the upload status (and optional error message) for a queued item. */
export function updateUploadStatus(id: string, status: UploadStatus, errorMsg?: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const cleanError =
    errorMsg !== undefined
      ? (errorMsg.trim() ? errorMsg.trim().slice(0, 1000) : null)
      : (status === 'failed' ? undefined : null);

  if (cleanError === undefined) {
    const res = db.prepare(`
      UPDATE social_upload_queue
      SET status = ?, updated_at = unixepoch()
      WHERE id = ?
    `).run(status, id);
    return Number(res.changes) > 0;
  }

  const res = db.prepare(`
    UPDATE social_upload_queue
    SET status = ?, error_msg = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(status, cleanError, id);
  return Number(res.changes) > 0;
}

/** Deletes an item from the social upload queue. */
export function deleteFromUploadQueue(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const res = db.prepare(`DELETE FROM social_upload_queue WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}

export type PlatformQueueCounts = {
  queued: number;
  in_progress: number;
  done: number;
  failed: number;
};

/** Computes per-platform queue counts across all upload statuses. */
export function getUploadQueueStats(): Record<SocialPlatform, PlatformQueueCounts> {
  const stats: Record<SocialPlatform, PlatformQueueCounts> = {
    youtube: { queued: 0, in_progress: 0, done: 0, failed: 0 },
    tiktok: { queued: 0, in_progress: 0, done: 0, failed: 0 },
    instagram: { queued: 0, in_progress: 0, done: 0, failed: 0 },
    twitter: { queued: 0, in_progress: 0, done: 0, failed: 0 },
    twitch_clips: { queued: 0, in_progress: 0, done: 0, failed: 0 },
  };

  const rows = db.prepare(`
    SELECT platform, status, COUNT(*) AS cnt
    FROM social_upload_queue
    GROUP BY platform, status
  `).all() as Array<{ platform: string; status: string; cnt: number }>;

  for (const row of rows) {
    if (
      VALID_SOCIAL_PLATFORMS.has(row.platform as SocialPlatform) &&
      VALID_UPLOAD_STATUSES.has(row.status as UploadStatus)
    ) {
      stats[row.platform as SocialPlatform][row.status as UploadStatus] = Number(row.cnt) || 0;
    }
  }

  return stats;
}
