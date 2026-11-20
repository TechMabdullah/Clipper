// ─── Job & Clip Status ───────────────────────────────────────────────────────

export type JobStatus =
  | 'PENDING'
  | 'DOWNLOADING'
  | 'TRANSCRIBING'
  | 'CLIPPING'
  | 'RENDERING'
  | 'DONE'
  | 'ERROR';

export type ClipStatus =
  | 'RENDERED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'DISCARDED';

export type Platform = 'youtube' | 'instagram' | 'tiktok';

// ─── Gotcha guard: Meta file-size cap ────────────────────────────────────────
/** Maximum safe MP4 size for Instagram resumable upload (~25 MB). */
export const META_MAX_BYTES = 25 * 1024 * 1024;

/** Maximum safe MP4 size for Discord file attachment (20 MiB). */
export const DISCORD_MAX_BYTES = 20 * 1024 * 1024;

/** Maximum safe MP4 size for Telegram file attachment (50 MB). */
export const TELEGRAM_MAX_BYTES = 50 * 1024 * 1024;

// ─── Shared DTOs ─────────────────────────────────────────────────────────────

export interface IngestJobDto {
  id: string;
  sourceUrl?: string;
  sourceFilePath?: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}

export interface ClipDto {
  id: string;
  jobId: string;
  title: string;
  description: string;
  startSec: number;
  endSec: number;
  filePath: string;
  fileSizeBytes: number;
  status: ClipStatus;
  platform: Platform;
  scheduledAt?: string;
  publishedAt?: string;
  platformVideoId?: string;
  createdAt: string;
}

export interface PublishQueueItem {
  clipId: string;
  platform: Platform;
  scheduledAt: string;
}

// ─── Platform-specific upload limits (Gotcha #2/#3 guards) ───────────────────

export interface PlatformUploadConstraints {
  maxBytes: number;
  maxDurationSec: number;
  requiresVertical: boolean;
  /** e.g. '#Shorts' must appear in title/description */
  requiredTags?: string[];
}

export const PLATFORM_CONSTRAINTS: Record<Platform, PlatformUploadConstraints> = {
  youtube: {
    maxBytes: 256 * 1024 * 1024 * 1024, // 256 GB
    maxDurationSec: 180,                  // 3 min for Shorts classification
    requiresVertical: true,
    requiredTags: ['#Shorts'],
  },
  instagram: {
    maxBytes: META_MAX_BYTES,             // ~25 MB hard limit for ProcessingFailedError
    maxDurationSec: 90,
    requiresVertical: true,
  },
  tiktok: {
    maxBytes: 4 * 1024 * 1024 * 1024,    // 4 GB
    maxDurationSec: 600,
    requiresVertical: true,
  },
};
