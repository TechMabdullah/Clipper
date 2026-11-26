import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { db, insertClip, getSetting } from './db.js';
import { assertEntitlement, EntitlementError } from './licensing.js';
import { downloadUrl, probeDuration } from './downloader.js';
import { transcribe } from './transcriber.js';
import { pickHighlights } from './highlight-picker.js';
import { renderClip, generateAss } from './renderer.js';
import { calculateViralityScore } from './features/audio-peaks.js';
import { buildLayoutFilterArgs } from './live/layout-utils.js';

const FFMPEG = process.env.FFMPEG_BIN_PATH ?? 'ffmpeg';

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
    const errMsg = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE ingest_jobs SET status='ERROR', error=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(errMsg, jobId);
  } finally {
    isProcessing = false;
    void drain();
  }
}

/**
 * Enforces plan-level resolution cap (e.g. 720p on Free) and watermark overlay
 * on a clip rendered by `renderer.ts` without modifying `renderer.ts` itself.
 */
async function applyPlanRenderConstraints(
  filePath: string,
  maxResolution: number,
  watermarkText: string,
): Promise<number> {
  const needsDownscale = maxResolution <= 720;
  const cleanWatermark = watermarkText.trim();
  if (!needsDownscale && !cleanWatermark) {
    return fs.statSync(filePath).size;
  }

  const filterArgs = buildLayoutFilterArgs('crop', 'auto', null, {
    maxResolution,
    watermarkText: cleanWatermark || null,
  });
  if (filterArgs.length === 0) {
    return fs.statSync(filePath).size;
  }

  const tmpOut = path.join(path.dirname(filePath), `plan_${crypto.randomUUID()}.mp4`);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(FFMPEG, [
        '-y',
        '-i', filePath,
        ...filterArgs,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-maxrate', '3.5M',
        '-bufsize', '7M',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        tmpOut,
      ], { stdio: 'pipe' });
      let errOut = '';
      proc.stderr.on('data', (d: Buffer) => { errOut += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(tmpOut)) resolve();
        else reject(new Error(`Plan constraint FFmpeg pass failed (${code}): ${errOut.slice(-200)}`));
      });
      proc.on('error', reject);
    });
    fs.renameSync(tmpOut, filePath);
    return fs.statSync(filePath).size;
  } finally {
    if (fs.existsSync(tmpOut)) {
      try { fs.rmSync(tmpOut, { force: true }); } catch {}
    }
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

  try {
    // Fail fast if daily clip quota is already exhausted before downloading/transcribing
    assertEntitlement(undefined, true);

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

    // 3. Re-verify entitlement & plan capabilities before AI highlight picking
    const ent = assertEntitlement(undefined, true);
    const allowCaptions = Boolean(ent.plan.allow_auto_captions);
    const maxResolution = ent.plan.max_resolution;
    const watermarkText = ent.plan.watermark_enabled
      ? getSetting('default_watermark_text', 'Clipper Studio')
      : '';

    // 4. Pick highlights
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

    const highlightsToRender = ent.usage.unlimited
      ? highlights
      : highlights.slice(0, Math.max(0, ent.usage.remaining));

    if (!ent.usage.unlimited && highlightsToRender.length < highlights.length) {
      console.warn(
        `[pipeline] Capped highlights from ${highlights.length} to ${highlightsToRender.length} ` +
        `due to ${ent.plan.name} daily quota (${ent.usage.remaining} remaining).`
      );
    }

    // 5. .ass captions (gated by plan.allow_auto_captions)
    const assPath = allowCaptions ? generateAss(segments, jobId) : null;

    // 6. Render (sequential, priority lowered inside renderClip)
    setStatus('RENDERING');
    try {
      for (let i = 0; i < highlightsToRender.length; i++) {
        const loopEnt = assertEntitlement(undefined, true);
        const h = highlightsToRender[i]!;
        const outputName = `${jobId}_clip${String(i + 1).padStart(2, '0')}`;
        console.log(
          `[pipeline] Rendering ${i + 1}/${highlightsToRender.length}: ${h.title} ` +
          `(${maxResolution}p, captions=${allowCaptions ? 'on' : 'off'}, watermark=${watermarkText ? 'on' : 'off'})`
        );

        const rendered = await renderClip(sourcePath, h, assPath, outputName);
        const finalWatermark = loopEnt.plan.watermark_enabled
          ? (watermarkText || getSetting('default_watermark_text', 'Clipper Studio'))
          : '';
        const finalFileSizeBytes = await applyPlanRenderConstraints(
          rendered.filePath,
          loopEnt.plan.max_resolution,
          finalWatermark,
        );

        const duration = h.endSec - h.startSec;
        const wordsCount = segments
          .filter(s => s.start >= h.startSec && s.end <= h.endSec)
          .reduce((acc, s) => acc + s.text.split(/\s+/).filter(Boolean).length, 0);
        const virality = calculateViralityScore({
          durationSec: duration,
          hasCaptions: Boolean(assPath),
          hasSpeechWords: wordsCount,
        });

        insertClip({
          jobId,
          title: h.title,
          description: h.description,
          startSec: h.startSec,
          endSec: h.endSec,
          durationSec: duration,
          filePath: rendered.filePath,
          fileSizeBytes: finalFileSizeBytes,
          viralityScore: virality.score,
          viralityReason: virality.reason,
          captionsStyle: assPath ? 'minimal' : 'none',
          layout: 'crop',
          sourcePlatform: 'batch',
        });

        // Fire-and-forget desktop notification
        void notifyClipReady(h.title, rendered.filePath, finalFileSizeBytes);
      }
    } finally {
      // 7. Cleanup .ass
      if (assPath && fs.existsSync(assPath)) fs.rmSync(assPath, { force: true });
    }

    setStatus('DONE');
    console.log(`[pipeline] ✅ Job ${jobId} done — ${highlightsToRender.length} clips in 03_clips/`);
  } catch (err) {
    if (err instanceof EntitlementError) {
      console.warn(`[pipeline] Job ${jobId} blocked by plan entitlement (${err.code}): ${err.message}`);
      db.prepare(`UPDATE ingest_jobs SET status='ERROR', error=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(err.message, jobId);
      return;
    }
    throw err;
  }
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
