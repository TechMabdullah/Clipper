// ─── Job & Clip Status ───────────────────────────────────────────────────────

export type JobStatus =
  | 'PENDING'
  | 'DOWNLOADING'
  | 'TRANSCRIBING'
  | 'CLIPPING'
  | 'RENDERING'
  | 'DONE'
  | 'ERROR';

export type ClipStatus = 'READY' | 'ARCHIVED';

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
  filePath: string;      // local path — user copies this to upload manually
  fileSizeBytes: number;
  durationSec: number;
  status: ClipStatus;
  createdAt: string;
}

export interface PipelineProgress {
  jobId: string;
  status: JobStatus;
  clipsRendered: number;
  error?: string;
}
