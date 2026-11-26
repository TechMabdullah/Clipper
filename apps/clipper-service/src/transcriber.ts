import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { TEMP_DIR, MEDIA_ROOT } from './storage.js';

const WHISPER_BIN   = process.env.WHISPER_BIN_PATH ?? '';
const WHISPER_MODEL = process.env.WHISPER_MODEL_PATH ?? './models/ggml-base.en.bin';

export interface Segment {
  start: number;
  end: number;
  text: string;
}

/**
 * Converts video → 16kHz WAV, then runs whisper.cpp for timestamped segments.
 * Falls back to evenly-spaced stub segments when whisper is not installed —
 * the pipeline still runs and produces clips; they just won't have caption text.
 */
export async function transcribe(videoPath: string, jobId: string): Promise<Segment[]> {
  if (!fs.existsSync(MEDIA_ROOT)) fs.mkdirSync(MEDIA_ROOT, { recursive: true });
  if (!fs.existsSync(TEMP_DIR))   fs.mkdirSync(TEMP_DIR, { recursive: true });

  const wavPath = path.join(TEMP_DIR, `${jobId}.wav`);

  // ── Step 1: convert to 16kHz mono WAV ─────────────────────────────────
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-i', videoPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath,
    ], { stdio: 'pipe' });
    proc.on('error', (e) => reject(new Error(`ffmpeg wav: ${e.message}`)));
    proc.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg wav exited ${c}`))));
  });

  // ── Step 2: whisper stub fallback if binary not found ─────────────────
  const whisperExists = WHISPER_BIN !== '' && fs.existsSync(WHISPER_BIN);
  if (!whisperExists) {
    console.warn(`[transcriber] whisper binary not found — using stub segments`);
    if (fs.existsSync(wavPath)) fs.rmSync(wavPath, { force: true });
    return ruleBasedStubSegments(await probeDuration(videoPath));
  }

  // ── Step 3: run whisper.cpp ────────────────────────────────────────────
  const jsonBase = path.join(TEMP_DIR, jobId);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '--output-json',
      '--output-file', jsonBase,
      '--language', 'auto',
      '--threads', '4',
    ], { stdio: 'pipe' });
    proc.on('error', (e) => reject(new Error(`whisper spawn: ${e.message}`)));
    proc.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    proc.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`whisper exited ${c}`))));
  });

  if (fs.existsSync(wavPath)) fs.rmSync(wavPath, { force: true });

  // ── Step 4: parse output ───────────────────────────────────────────────
  type WhisperJson = {
    transcription: Array<{ timestamps: { from: string; to: string }; text: string }>;
  };
  const jsonPath = `${jsonBase}.json`;
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as WhisperJson;
  fs.rmSync(jsonPath, { force: true });

  return raw.transcription.map((s) => ({
    start: parseTimestamp(s.timestamps.from),
    end:   parseTimestamp(s.timestamps.to),
    text:  s.text.trim(),
  }));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseTimestamp(ts: string): number {
  const [hms = '0:0:0', ms = '0'] = ts.split(',');
  const [h = 0, m = 0, s = 0] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + Number(ms) / 1000;
}

/** Evenly-spaced 10s stub segments covering totalSec. */
function ruleBasedStubSegments(totalSec: number): Segment[] {
  const CHUNK = 10;
  const segs: Segment[] = [];
  for (let t = 0; t < totalSec; t += CHUNK) {
    segs.push({ start: t, end: Math.min(t + CHUNK, totalSec), text: `[segment ${segs.length + 1}]` });
  }
  return segs;
}

async function probeDuration(filePath: string): Promise<number> {
  const ffprobe = process.env.FFPROBE_BIN_PATH || 'ffprobe';
  return new Promise((resolve) => {
    const proc = spawn(
      ffprobe,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-i', filePath],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      if (!settled) {
        settled = true;
        resolve(90);
      }
    }, 20_000);

    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.on('error', () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(90);
      }
    });
    proc.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        const j = JSON.parse(out) as { format?: { duration?: string } };
        const val = parseFloat(j.format?.duration ?? '');
        resolve(Number.isFinite(val) && val > 0 ? val : 90);
      } catch {
        resolve(90); // safe fallback
      }
    });
  });
}
