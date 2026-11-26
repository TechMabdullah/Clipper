import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MUSIC_DIR, TEMP_DIR } from '../storage.js';

const FFMPEG = process.env.FFMPEG_BIN_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN_PATH ?? 'ffprobe';
const PROCESS_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;

export interface MusicTrackItem {
  name: string;
  title: string;
  path: string;
  sizeBytes: number;
  ext: string;
  modifiedAt: string;
}

export interface TimeInterval {
  start: number;
  end: number;
}

export interface AudioEnhanceOptions {
  normalize?: boolean;
  hasMusic?: boolean;
  musicVolume?: number;
  voiceInputLabel?: string;
  musicInputLabel?: string;
  outputLabel?: string;
}

export interface AudioEnhanceFilterResult {
  enabled: boolean;
  voiceChain: string | null;
  afFilter: string | null;
  filterComplex: string | null;
  outputLabel: string | null;
  musicVolume: number;
}

interface MediaProbeInfo {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

const VOICE_CLARITY_CHAIN =
  'highpass=f=80,acompressor=threshold=-18dB:ratio=3,loudnorm=I=-14:TP=-1.5:LRA=11';

/**
 * Lists background music tracks available in ClipperMedia/06_music/.
 */
export function listMusicTracks(): MusicTrackItem[] {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  const tracks: MusicTrackItem[] = [];

  for (const entry of fs.readdirSync(MUSIC_DIR)) {
    if (!/\.(mp3|wav|m4a|aac|ogg)$/i.test(entry)) continue;
    const full = path.join(MUSIC_DIR, entry);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      tracks.push({
        name: entry,
        title: path.parse(entry).name,
        path: full,
        sizeBytes: stat.size,
        ext: path.extname(entry).toLowerCase(),
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Skip unreadable file entries
    }
  }

  return tracks.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Probes duration and stream presence (video/audio) for a local or remote media input.
 */
async function probeMediaStreams(mediaPath: string): Promise<MediaProbeInfo> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      FFPROBE,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', mediaPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let settled = false;

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      if (!settled) {
        settled = true;
        reject(new Error('ffprobe timed out'));
      }
    }, PROBE_TIMEOUT_MS);

    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        resolve({ durationSec: 0, hasVideo: true, hasAudio: true });
        return;
      }
      try {
        const parsed = JSON.parse(out) as {
          format?: { duration?: string };
          streams?: Array<{ codec_type?: string }>;
        };
        const durationSec = Math.max(0, Number.parseFloat(parsed.format?.duration ?? '0') || 0);
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        resolve({
          durationSec,
          hasVideo: streams.some((s) => s.codec_type === 'video'),
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
        });
      } catch {
        resolve({ durationSec: 0, hasVideo: true, hasAudio: true });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function parseClockDuration(text: string): number {
  const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Runs FFmpeg `silencedetect` and returns active non-silent speech/hype intervals
 * so dead-air pauses can be trimmed cleanly.
 */
export async function detectNonSilentIntervals(
  mediaPath: string,
  silenceDb = -36,
  minSilenceSec = 1.6,
): Promise<TimeInterval[]> {
  const source = mediaPath?.trim();
  if (!source) throw new Error('mediaPath is required');
  if (!/^https?:\/\//i.test(source) && !fs.existsSync(source)) {
    throw new Error(`Media file not found: ${source}`);
  }

  const probe = await probeMediaStreams(source);
  if (!probe.hasAudio) {
    return probe.durationSec > 0 ? [{ start: 0, end: Number(probe.durationSec.toFixed(3)) }] : [];
  }

  const safeDb = Number.isFinite(silenceDb) ? silenceDb : -36;
  const safeMinSilence = Math.max(0.1, Number.isFinite(minSilenceSec) ? minSilenceSec : 1.6);

  const stderrText = await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      FFMPEG,
      [
        '-y',
        '-i', source,
        '-vn', '-sn', '-dn',
        '-af', `silencedetect=noise=${safeDb}dB:d=${safeMinSilence}`,
        '-f', 'null',
        '-',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      if (!settled) {
        settled = true;
        reject(new Error('FFmpeg silencedetect timed out after 120s'));
      }
    }, PROCESS_TIMEOUT_MS);

    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0 || err.includes('silence_start:') || err.includes('Duration:')) {
        resolve(err);
      } else {
        reject(new Error(err.slice(-300) || `FFmpeg silencedetect failed (${code})`));
      }
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(e);
    });
  });

  const totalDuration = probe.durationSec > 0 ? probe.durationSec : parseClockDuration(stderrText);
  if (totalDuration <= 0) return [];

  const silences: TimeInterval[] = [];
  let pendingStart: number | null = null;

  for (const rawLine of stderrText.split(/\r?\n/)) {
    const startMatch = rawLine.match(/silence_start:\s*(-?[0-9.]+)/);
    if (startMatch) {
      const val = Number.parseFloat(startMatch[1]!);
      if (Number.isFinite(val)) pendingStart = Math.max(0, val);
      continue;
    }

    const endMatch = rawLine.match(/silence_end:\s*(-?[0-9.]+)/);
    if (endMatch) {
      const endVal = Number.parseFloat(endMatch[1]!);
      if (Number.isFinite(endVal)) {
        const s = pendingStart ?? 0;
        const e = Math.min(totalDuration, Math.max(s, endVal));
        silences.push({ start: s, end: e });
      }
      pendingStart = null;
    }
  }

  if (pendingStart !== null && pendingStart < totalDuration) {
    silences.push({ start: pendingStart, end: totalDuration });
  }

  const active: TimeInterval[] = [];
  let cursor = 0;

  for (const s of silences) {
    const silStart = Math.max(0, Math.min(totalDuration, s.start));
    const silEnd = Math.max(silStart, Math.min(totalDuration, s.end));
    if (silStart - cursor >= 0.15) {
      active.push({
        start: Number(cursor.toFixed(3)),
        end: Number(silStart.toFixed(3)),
      });
    }
    cursor = Math.max(cursor, silEnd);
  }

  if (totalDuration - cursor >= 0.15) {
    active.push({
      start: Number(cursor.toFixed(3)),
      end: Number(totalDuration.toFixed(3)),
    });
  }

  return active;
}

/**
 * Builds FFmpeg `-af` / `-filter_complex` snippets for broadcast `-14 LUFS` voice clarity
 * and optional background music mixing.
 */
export function buildAudioEnhanceFilter(
  options: AudioEnhanceOptions,
): AudioEnhanceFilterResult {
  const normalize = Boolean(options.normalize);
  const hasMusic = Boolean(options.hasMusic);
  const vol = Math.max(
    0.02,
    Math.min(1.0, Number.isFinite(options.musicVolume) ? Number(options.musicVolume) : 0.18),
  );

  if (!normalize && !hasMusic) {
    return {
      enabled: false,
      voiceChain: null,
      afFilter: null,
      filterComplex: null,
      outputLabel: null,
      musicVolume: vol,
    };
  }

  const voiceIn = options.voiceInputLabel ?? '0:a';
  const musicIn = options.musicInputLabel ?? '1:a';
  const outName = options.outputLabel ?? 'aout';
  const outBracketed = `[${outName}]`;

  if (normalize && !hasMusic) {
    return {
      enabled: true,
      voiceChain: VOICE_CLARITY_CHAIN,
      afFilter: VOICE_CLARITY_CHAIN,
      filterComplex: `[${voiceIn}]${VOICE_CLARITY_CHAIN}${outBracketed}`,
      outputLabel: outBracketed,
      musicVolume: vol,
    };
  }

  const mixSnippet = `amix=inputs=2:duration=first:dropout_transition=2:weights=1 ${vol.toFixed(2)}`;

  if (normalize && hasMusic) {
    return {
      enabled: true,
      voiceChain: VOICE_CLARITY_CHAIN,
      afFilter: null,
      filterComplex: `[${voiceIn}]${VOICE_CLARITY_CHAIN}[voice_norm];[voice_norm][${musicIn}]${mixSnippet}${outBracketed}`,
      outputLabel: outBracketed,
      musicVolume: vol,
    };
  }

  return {
    enabled: true,
    voiceChain: null,
    afFilter: null,
    filterComplex: `[${voiceIn}][${musicIn}]${mixSnippet}${outBracketed}`,
    outputLabel: outBracketed,
    musicVolume: vol,
  };
}

/**
 * Cuts dead-air pauses from a rendered clip using FFmpeg segment trim + concat.
 * Returns `true` if silence was trimmed and written to `outputPath`, or `false`
 * if no meaningful dead-air gaps were detected (leaving output untouched).
 */
export async function trimSilenceFromClip(
  inputPath: string,
  outputPath: string,
  options: { silenceDb?: number; minSilenceSec?: number } = {},
): Promise<boolean> {
  if (!inputPath?.trim() || !fs.existsSync(inputPath)) {
    throw new Error(`Input clip not found: ${inputPath}`);
  }
  if (!outputPath?.trim()) {
    throw new Error('outputPath is required');
  }

  const probe = await probeMediaStreams(inputPath);
  if (!probe.hasAudio || probe.durationSec <= 0) {
    return false;
  }

  let intervals = await detectNonSilentIntervals(
    inputPath,
    options.silenceDb ?? -36,
    options.minSilenceSec ?? 1.6,
  );

  // If the entire file is silent, keep original rather than emitting an empty clip
  if (intervals.length === 0) {
    return false;
  }

  const keptDuration = intervals.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
  const removedDuration = probe.durationSec - keptDuration;

  if (intervals.length === 1 && removedDuration < 0.35) {
    return false;
  }

  // Keep filtergraph compact on very long clips
  if (intervals.length > 30) {
    intervals = intervals.slice(0, 30);
  }

  const resolvedIn = path.resolve(inputPath);
  const resolvedOut = path.resolve(outputPath);
  const isInPlace = resolvedIn === resolvedOut;

  if (!fs.existsSync(path.dirname(resolvedOut))) {
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  }
  if (isInPlace && !fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const targetOut = isInPlace
    ? path.join(TEMP_DIR, `trim_${crypto.randomUUID()}${path.extname(resolvedOut) || '.mp4'}`)
    : resolvedOut;

  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < intervals.length; i++) {
    const seg = intervals[i]!;
    if (probe.hasVideo) {
      filterParts.push(
        `[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`
      );
      concatInputs.push(`[v${i}]`);
    }
    filterParts.push(
      `[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
    );
    concatInputs.push(`[a${i}]`);
  }

  const vOutCount = probe.hasVideo ? 1 : 0;
  const outMaps = probe.hasVideo ? '[outv][outa]' : '[outa]';
  filterParts.push(
    `${concatInputs.join('')}concat=n=${intervals.length}:v=${vOutCount}:a=1${outMaps}`
  );

  const ffmpegArgs = [
    '-y',
    '-i', resolvedIn,
    '-filter_complex', filterParts.join(';'),
    ...(probe.hasVideo ? ['-map', '[outv]'] : []),
    '-map', '[outa]',
    ...(probe.hasVideo
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22']
      : []),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-movflags', '+faststart',
    targetOut,
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(FFMPEG, ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      let settled = false;

      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        if (!settled) {
          settled = true;
          reject(new Error('FFmpeg silence trim timed out after 120s'));
        }
      }, PROCESS_TIMEOUT_MS);

      proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0 && fs.existsSync(targetOut) && fs.statSync(targetOut).size > 0) {
          resolve();
        } else {
          reject(new Error(err.slice(-300) || `FFmpeg silence trim failed (${code})`));
        }
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(e);
      });
    });

    if (isInPlace) {
      fs.copyFileSync(targetOut, resolvedOut);
    }

    return true;
  } finally {
    if (isInPlace && fs.existsSync(targetOut)) {
      try { fs.unlinkSync(targetOut); } catch {}
    }
  }
}
