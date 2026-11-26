import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { TEMP_DIR } from '../storage.js';

export type CaptionStyle = 'none' | 'hormozi' | 'neon' | 'minimal';

export interface WordSegment {
  start: number;
  end: number;
  text: string;
}

const FFMPEG = process.env.FFMPEG_BIN_PATH ?? 'ffmpeg';
const WHISPER_BIN = process.env.WHISPER_BIN_PATH ?? '';
const WHISPER_MODEL = process.env.WHISPER_MODEL_PATH ?? './models/ggml-base.en.bin';

async function extractCaptionChunks(
  sourceMediaPath: string,
  fallbackHookText?: string,
): Promise<{ chunks: WordSegment[]; engine: string }> {
  if (!sourceMediaPath?.trim() || !fs.existsSync(sourceMediaPath)) {
    return { chunks: [], engine: 'missing-source' };
  }

  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const wavPath = path.join(TEMP_DIR, `cap_${crypto.randomUUID()}.wav`);

  try {
    // 1. Extract 16kHz mono WAV (fast for Whisper/STT)
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        FFMPEG,
        ['-y', '-i', sourceMediaPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
        { stdio: 'ignore' }
      );
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg wav failed (${c})`))));
      p.on('error', reject);
    });

    if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 1000) {
      return { chunks: [], engine: 'no-audio' };
    }

    let chunks: WordSegment[] = [];
    let engine = 'none';

    // 2A. Try Groq / OpenAI Whisper API if key present
    const groqKey = process.env.GROQ_API_KEY?.trim() ?? '';
    const openaiKey =
      process.env.OPENAI_API_KEY?.trim() ||
      (process.env.LLM_PROVIDER === 'openai' ? (process.env.LLM_API_KEY?.trim() ?? '') : '');

    if (groqKey || openaiKey) {
      const isGroq = Boolean(groqKey);
      const apiUrl = isGroq
        ? 'https://api.groq.com/openai/v1/audio/transcriptions'
        : 'https://api.openai.com/v1/audio/transcriptions';
      const apiKey = isGroq ? groqKey : openaiKey;
      const model = isGroq ? 'whisper-large-v3-turbo' : 'whisper-1';

      try {
        chunks = await callWhisperApi(apiUrl, apiKey, model, wavPath);
        engine = isGroq ? 'groq-whisper' : 'openai-whisper';
      } catch (err) {
        console.warn(`[captions] Remote Whisper API warning:`, err);
      }
    }

    // 2B. Try local whisper.cpp binary if configured
    if (chunks.length === 0 && WHISPER_BIN && fs.existsSync(WHISPER_BIN)) {
      try {
        chunks = await callLocalWhisperCpp(wavPath);
        engine = 'whisper.cpp';
      } catch (err) {
        console.warn('[captions] Local whisper.cpp warning:', err);
      }
    }

    // 2C. If no speech engine extracted dialogue, optionally render a brief viral hook banner (e.g. chat explosion line)
    if (chunks.length === 0 && fallbackHookText?.trim()) {
      chunks = [
        { start: 0.2, end: 3.8, text: fallbackHookText.trim().slice(0, 64) },
      ];
      engine = 'hook-overlay';
    }

    return { chunks, engine };
  } catch {
    return { chunks: [], engine: 'error' };
  } finally {
    if (fs.existsSync(wavPath)) {
      try { fs.unlinkSync(wavPath); } catch {}
    }
  }
}

/**
 * Transcribes speech in a rendered/sliced audio clip using Whisper API (Groq/OpenAI)
 * or local whisper.cpp, then generates a styled kinetic .ass subtitle file.
 * Gracefully returns null (without throwing) if no STT backend is configured/available.
 */
export async function generateKineticAssForClip(options: {
  sourceMediaPath: string;
  style: CaptionStyle;
  isVertical?: boolean;
  fallbackHookText?: string;
}): Promise<{ assPath: string | null; wordsCount: number; engine: string }> {
  if (options.style === 'none') {
    return { assPath: null, wordsCount: 0, engine: 'none' };
  }

  const { chunks, engine } = await extractCaptionChunks(
    options.sourceMediaPath,
    options.fallbackHookText,
  );
  if (chunks.length === 0) {
    return { assPath: null, wordsCount: 0, engine };
  }

  const assPath = buildStyledAssFile(chunks, options.style, options.isVertical ?? true);
  return { assPath, wordsCount: chunks.length, engine };
}

/**
 * Transcribes speech in a clip (or falls back to `fallbackHookText`) and returns
 * clean `.srt` formatted subtitle text ready for download.
 */
export async function generateSrtTextForClip(
  sourceMediaPath: string,
  fallbackHookText?: string,
): Promise<string> {
  if (!sourceMediaPath?.trim() || !fs.existsSync(sourceMediaPath)) {
    throw new Error(`Source media file not found: ${sourceMediaPath}`);
  }
  const { chunks } = await extractCaptionChunks(sourceMediaPath, fallbackHookText);
  if (chunks.length === 0) return '';
  return buildSrtText(chunks);
}

async function callWhisperApi(
  url: string,
  apiKey: string,
  model: string,
  wavPath: string,
): Promise<WordSegment[]> {
  const form = new FormData();
  const blob = new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    words?: Array<{ word: string; start: number; end: number }>;
    segments?: Array<{ text: string; start: number; end: number }>;
  };

  if (Array.isArray(data.words) && data.words.length > 0) {
    return groupWordsIntoKineticChunks(data.words, 3);
  }
  if (Array.isArray(data.segments)) {
    return splitSegmentsIntoChunks(data.segments);
  }
  return [];
}

async function callLocalWhisperCpp(wavPath: string): Promise<WordSegment[]> {
  const jsonBase = wavPath.replace(/\.wav$/, '');
  await new Promise<void>((resolve, reject) => {
    const p = spawn(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '--output-json',
      '--output-file', jsonBase,
      '--language', 'auto',
      '--threads', '4',
    ], { stdio: 'ignore' });
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`whisper exited ${c}`))));
    p.on('error', reject);
  });

  const jsonPath = `${jsonBase}.json`;
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
    transcription?: Array<{ timestamps: { from: string; to: string }; text: string }>;
  };
  try { fs.unlinkSync(jsonPath); } catch {}

  const segs = (raw.transcription ?? []).map(s => ({
    start: parseWhisperTs(s.timestamps.from),
    end: parseWhisperTs(s.timestamps.to),
    text: s.text.trim(),
  }));
  return splitSegmentsIntoChunks(segs);
}

function parseWhisperTs(ts: string): number {
  const [hms = '0:0:0', ms = '0'] = ts.split(',');
  const [h = 0, m = 0, s = 0] = hms.split(':').map(Number);
  const total = h * 3600 + m * 60 + s + Number(ms) / 1000;
  return Number.isFinite(total) ? Math.max(0, total) : 0;
}

function groupWordsIntoKineticChunks(
  words: Array<{ word: string; start: number; end: number }>,
  wordsPerChunk = 3,
): WordSegment[] {
  const out: WordSegment[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const slice = words.slice(i, i + wordsPerChunk);
    const text = slice.map(w => w.word.trim()).filter(Boolean).join(' ');
    if (!text) continue;
    out.push({
      start: slice[0]!.start,
      end: slice[slice.length - 1]!.end,
      text,
    });
  }
  return out;
}

function splitSegmentsIntoChunks(segments: Array<{ start: number; end: number; text: string }>): WordSegment[] {
  const out: WordSegment[] = [];
  for (const s of segments) {
    const words = s.text.trim().split(/\s+/).filter(Boolean);
    if (words.length <= 3) {
      if (words.length > 0) out.push({ start: s.start, end: s.end, text: words.join(' ') });
      continue;
    }
    const dur = Math.max(0.4, s.end - s.start);
    const numChunks = Math.ceil(words.length / 3);
    const chunkDur = dur / numChunks;
    for (let i = 0; i < numChunks; i++) {
      const part = words.slice(i * 3, (i + 1) * 3).join(' ');
      out.push({
        start: s.start + i * chunkDur,
        end: s.start + (i + 1) * chunkDur,
        text: part,
      });
    }
  }
  return out;
}

export function buildStyledAssFile(
  chunks: WordSegment[],
  style: CaptionStyle,
  isVertical: boolean,
): string {
  const playW = isVertical ? 1080 : 1920;
  const playH = isVertical ? 1920 : 1080;
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const assPath = path.join(TEMP_DIR, `kinetic_${crypto.randomUUID()}.ass`);

  // ASS colors use &HAABBGGRR format
  let font = 'Arial';
  let fontSize = isVertical ? 76 : 62;
  let primary = '&H0000EAFF'; // Bright yellow-gold (Hormozi)
  let outlineColor = '&H00000000';
  let outlineWidth = 6;
  let shadow = 2;
  let marginV = isVertical ? 320 : 95;
  let usePopAnim = true;

  if (style === 'neon') {
    primary = '&H00FFFF00'; // Cyan
    outlineColor = '&H00AA00FF'; // Neon magenta glow border
    outlineWidth = 5;
    shadow = 3;
  } else if (style === 'minimal') {
    primary = '&H00FFFFFF';
    outlineColor = '&H0018181B';
    fontSize = isVertical ? 58 : 48;
    outlineWidth = 3;
    usePopAnim = false;
  }

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playW}
PlayResY: ${playH}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Kinetic,${font},${fontSize},${primary},&H00FFFFFF,${outlineColor},&H80000000,-1,0,0,0,100,100,0,0,1,${outlineWidth},${shadow},2,60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const toAssTime = (sec: number): string => {
    const safe = Number.isFinite(sec) ? Math.max(0, sec) : 0;
    const totalCs = Math.round(safe * 100);
    const cs = totalCs % 100;
    const totalSec = Math.floor(totalCs / 100);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  const lines = chunks.map(c => {
    const rawText = (style === 'hormozi' || style === 'neon') ? c.text.toUpperCase() : c.text;
    const escaped = rawText.replace(/[{}]/g, '');
    const animTag = usePopAnim ? '{\\fscx92\\fscy92\\t(0,80,\\fscx108\\fscy108)\\t(80,160,\\fscx100\\fscy100)}' : '';
    return `Dialogue: 0,${toAssTime(c.start)},${toAssTime(c.end)},Kinetic,,0,0,0,,${animTag}${escaped}`;
  });

  fs.writeFileSync(assPath, header + lines.join('\n'), 'utf8');
  return assPath;
}

function toSrtTime(sec: number): string {
  const safe = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function buildSrtText(chunks: WordSegment[]): string {
  const valid = chunks.filter((c) => Boolean(c.text?.trim()));
  if (valid.length === 0) return '';
  return valid
    .map((c, idx) => {
      const start = Number.isFinite(c.start) ? Math.max(0, c.start) : 0;
      const end = Number.isFinite(c.end) ? Math.max(start + 0.1, c.end) : start + 1;
      return `${idx + 1}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${c.text.trim()}`;
    })
    .join('\n\n')
    .concat('\n');
}
