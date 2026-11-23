import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { Highlight } from './highlight-picker.js';

const FFMPEG = process.env.FFMPEG_BIN_PATH ?? 'ffmpeg';
const MEDIA_ROOT = process.env.MEDIA_ROOT_DIR ?? 'D:/ClipperMedia';
const CLIPS_DIR = path.join(MEDIA_ROOT, '03_clips');
const TEMP_DIR = path.join(MEDIA_ROOT, '02_temp');

// Gotcha #PC-lag: concurrency = 1 enforced by the pipeline queue in index.ts
// Here we just lower FFmpeg child process priority.

export interface RenderedClip {
  filePath: string;
  fileSizeBytes: number;
}

/**
 * Renders a 9:16 vertical MP4 clip with burned-in .ass captions.
 * Uses the exact FFmpeg preset from the README:
 *   scale=1080:1920 → crop=1080:1920 → ass subtitle burn
 *   libx264 veryfast crf23 maxrate 3.5M → 128k aac
 *   +faststart (required for Instagram/Meta)
 */
export async function renderClip(
  sourcePath: string,
  highlight: Highlight,
  assPath: string | null,
  outputName: string,
): Promise<RenderedClip> {
  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

  const outPath = path.join(CLIPS_DIR, `${outputName}.mp4`);

  const vfParts = [
    'scale=1080:1920:force_original_aspect_ratio=increase',
    'crop=1080:1920',
  ];
  if (assPath && fs.existsSync(assPath)) {
    // Escape Windows backslashes for FFmpeg filtergraph
    const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    vfParts.push(`ass=${escaped}`);
  }

  const args = [
    '-y',
    '-ss', String(highlight.startSec),
    '-to', String(highlight.endSec),
    '-i', sourcePath,
    '-vf', vfParts.join(','),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-maxrate', '3.5M',   // Gotcha #3: keeps Instagram under 25 MB
    '-bufsize', '7M',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-movflags', '+faststart', // Gotcha #3: required or Meta returns ProcessingFailedError
    outPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: 'pipe' });

    // Lower process priority so the PC doesn't lag
    proc.on('spawn', () => {
      try {
        os.setPriority(proc.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch { /* non-fatal */ }
    });

    proc.stderr.on('data', (d: Buffer) => {
      // Show only progress lines
      const line = d.toString();
      if (line.includes('frame=') || line.includes('time=')) process.stdout.write(`\r[ffmpeg] ${line.trim()}`);
    });

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg exited ${code}`));
      resolve();
    });
  });

  const { size } = fs.statSync(outPath);
  return { filePath: outPath, fileSizeBytes: size };
}

/**
 * Generates a minimal .ass subtitle file from whisper segments.
 * Returns the path to the generated file, or null if no segments.
 */
export function generateAss(
  segments: Array<{ start: number; end: number; text: string }>,
  outputBase: string,
): string | null {
  if (!segments.length) return null;
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  const assPath = path.join(TEMP_DIR, `${outputBase}.ass`);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV, Outline, Shadow
Style: Default,Arial,72,&H00FFFFFF,&H00000000,-1,0,2,80,80,120,3,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const toAssTime = (sec: number): string => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const cs = Math.round((sec % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  const events = segments
    .map((s) => `Dialogue: 0,${toAssTime(s.start)},${toAssTime(s.end)},Default,,0,0,0,,${s.text}`)
    .join('\n');

  fs.writeFileSync(assPath, header + events, 'utf8');
  return assPath;
}
