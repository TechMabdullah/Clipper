import { db } from './db.js';
import { downloadUrl, probeDuration } from './downloader.js';
import { transcribe } from './transcriber.js';
import { pickHighlights } from './highlight-picker.js';
import { renderClip, generateAss } from './renderer.js';
import fs from 'node:fs';

// ── concurrency = 1 ───────────────────────────────────────────────────────
let isProcessing = false;
const queue: string[] = [];

export function enqueue(jobId: string): void {
  queue.push(jobId);
  void drain();
}

async function drain(): Promise<void> {
  if (isProcessing || !queue.length) return;
  isProcessing = true;
  const jobId = queue.shift()!;
  try {
    await processJob(jobId);
  } catch (err) {
    console.error(`[pipeline] Job ${jobId} failed:`, err);
    db.prepare(`UPDATE ingest_jobs SET status='ERROR', error=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(String(err), jobId);
  } finally {
    isProcessing = false;
    void drain();
  }
}

async function processJob(jobId: string): Promise<void> {
  const job = db.prepare('SELECT * FROM ingest_jobs WHERE id=?').get(jobId) as {
    id: string; source_url: string | null; source_path: string | null;
  } | undefined;
  if (!job) throw new Error(`Job ${jobId} not found`);

  const setStatus = (status: string) =>
    db.prepare(`UPDATE ingest_jobs SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(status, jobId);

  // 1. Acquire source file
  setStatus('DOWNLOADING');
  let sourcePath: string;
  if (job.source_url) {
    sourcePath = await downloadUrl(job.source_url, jobId);
  } else if (job.source_path && fs.existsSync(job.source_path)) {
    sourcePath = job.source_path;
  } else {
    throw new Error('No valid source URL or file path');
  }

  // 2. Transcribe
  setStatus('TRANSCRIBING');
  const segments = await transcribe(sourcePath, jobId);
  console.log(`[pipeline] ${segments.length} segments transcribed`);

  // 3. Pick highlights
  setStatus('CLIPPING');
  const highlights = await pickHighlights(segments);
  if (!highlights.length) {
    const dur = await probeDuration(sourcePath);
    highlights.push({
      title: 'Clip 1',
      description: 'Auto-fallback: first 60s',
      startSec: 0,
      endSec: Math.min(60, dur),
    });
  }

  // 4. .ass captions
  const assPath = generateAss(segments, jobId);

  // 5. Render (sequential, priority lowered inside renderClip)
  setStatus('RENDERING');
  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i]!;
    const outputName = `${jobId}_clip${String(i + 1).padStart(2, '0')}`;
    console.log(`[pipeline] Rendering ${i + 1}/${highlights.length}: ${h.title}`);

    const rendered = await renderClip(sourcePath, h, assPath, outputName);
    const duration = h.endSec - h.startSec;

    db.prepare(`
      INSERT INTO clips (id, job_id, title, description, start_sec, end_sec, duration_sec, file_path, file_size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), jobId, h.title, h.description,
           h.startSec, h.endSec, duration, rendered.filePath, rendered.fileSizeBytes);

    // Fire-and-forget desktop notification
    void notifyClipReady(h.title, rendered.filePath, rendered.fileSizeBytes);
  }

  // 6. Cleanup .ass
  if (assPath && fs.existsSync(assPath)) fs.rmSync(assPath, { force: true });

  setStatus('DONE');
  console.log(`[pipeline] ✅ Job ${jobId} done — ${highlights.length} clips in 03_clips/`);
}

async function notifyClipReady(title: string, filePath: string, bytes: number): Promise<void> {
  try {
    const url = process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:4003';
    await fetch(`${url}/api/notifications/clip-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clipTitle: title,
        filePath,
        fileSizeMb: (bytes / 1e6).toFixed(1),
      }),
    });
  } catch { /* non-fatal if notifier is down */ }
}
