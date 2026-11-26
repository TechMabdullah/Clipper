import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_BIN_PATH ?? 'ffmpeg';
const SCAN_TIMEOUT_MS = 120_000;

export interface AudioPeakCandidate {
  peakSec: number;
  startSec: number;
  endSec: number;
  peakDb: number;
  avgDb: number;
  deltaDb: number;
  viralityScore: number;
  reason: string;
}

export interface ViralityInput {
  audioDeltaDb?: number;
  chatMultiplier?: number;
  durationSec: number;
  hasFacecam?: boolean;
  hasCaptions?: boolean;
  hasSpeechWords?: number;
}

/**
 * Computes a 0-100 Viral Potential Score modeled after creator clip analytics:
 * weighs reaction/chat intensity, loudness excitement, optimal vertical pacing (20-40s),
 * facecam presence, and kinetic captions.
 */
export function calculateViralityScore(input: ViralityInput): { score: number; reason: string } {
  let score = 42;
  const reasons: string[] = [];

  if (input.chatMultiplier && input.chatMultiplier >= 2.0) {
    const bonus = Math.min(28, Math.round((input.chatMultiplier - 1.5) * 10));
    score += bonus;
    reasons.push(`Chat Spike ${input.chatMultiplier.toFixed(1)}x`);
  }

  if (input.audioDeltaDb && input.audioDeltaDb >= 4) {
    const bonus = Math.min(22, Math.round(input.audioDeltaDb * 1.8));
    score += bonus;
    reasons.push(`Audio Peak +${input.audioDeltaDb.toFixed(1)}dB`);
  }

  if (input.durationSec >= 18 && input.durationSec <= 42) {
    score += 12;
    reasons.push('Shorts Pacing');
  } else if (input.durationSec >= 10 && input.durationSec <= 60) {
    score += 6;
  }

  if (input.hasFacecam) {
    score += 10;
    reasons.push('Facecam Split');
  }

  if (input.hasCaptions) {
    score += 8;
    reasons.push('Kinetic Captions');
  }

  if (input.hasSpeechWords && input.hasSpeechWords > 15) {
    score += 6;
    reasons.push('Strong Hook Dialogue');
  }

  const clamped = Math.max(15, Math.min(99, Math.round(score)));
  const summary = reasons.length > 0 ? reasons.join(' + ') : 'Manual Creator Cut';
  return { score: clamped, reason: summary };
}

/**
 * Locally scans an offline video or VOD audio track via FFmpeg RMS loudness stats
 * (no AI API keys required) to locate high-energy screams, laughs, and hype clutches.
 */
export async function scanAudioPeaks(
  mediaSource: string,
  options: { maxScanSec?: number; clipDurationSec?: number; limit?: number } = {},
): Promise<{ avgDb: number; scannedDurationSec: number; peaks: AudioPeakCandidate[] }> {
  const source = mediaSource?.trim();
  if (!source) throw new Error('mediaSource is required');

  const maxScanSec = options.maxScanSec ?? 7200; // cap 2 hours per fast pass
  const clipDurationSec = Math.max(15, Math.min(60, options.clipDurationSec ?? 25));
  const limit = options.limit ?? 8;

  const args = [
    '-y',
    '-t', String(maxScanSec),
    '-i', source,
    '-vn', '-sn', '-dn',
    '-af', 'asetnsamples=n=48000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null',
    '-',
  ];

  const stdoutText = await new Promise<string>((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      if (!settled) {
        settled = true;
        reject(new Error('FFmpeg audio peak scan timed out after 120s'));
      }
    }, SCAN_TIMEOUT_MS);

    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (out.includes('pts_time:') || code === 0) resolve(out);
      else reject(new Error(err.slice(-300) || `FFmpeg peak scan failed (${code})`));
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(e);
    });
  });

  // Parse frame lines: frame:N pts:... pts_time:T \n lavfi.astats.Overall.RMS_level=-22.41
  const samples: Array<{ timeSec: number; rmsDb: number }> = [];
  let currentTime: number | null = null;
  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const timeMatch = line.match(/pts_time:([0-9.]+)/);
    if (timeMatch) {
      currentTime = parseFloat(timeMatch[1]!);
      continue;
    }
    const rmsMatch = line.match(/RMS_level=(-?[0-9.]+|-inf)/i);
    if (rmsMatch && currentTime !== null) {
      const val = rmsMatch[1]!.toLowerCase() === '-inf' ? -80 : parseFloat(rmsMatch[1]!);
      if (Number.isFinite(val)) {
        samples.push({ timeSec: currentTime, rmsDb: Math.max(-80, Math.min(0, val)) });
      }
      currentTime = null;
    }
  }

  if (samples.length === 0) {
    return { avgDb: -40, scannedDurationSec: 0, peaks: [] };
  }

  const validSamples = samples.filter(s => s.rmsDb > -75);
  const avgDb = validSamples.length > 0
    ? validSamples.reduce((acc, s) => acc + s.rmsDb, 0) / validSamples.length
    : -40;
  const maxTime = samples[samples.length - 1]!.timeSec;

  // Sort samples loudest first and apply cooldown separation (at least 30s apart)
  const ranked = [...samples].sort((a, b) => b.rmsDb - a.rmsDb);
  const picked: AudioPeakCandidate[] = [];

  for (const cand of ranked) {
    const deltaDb = cand.rmsDb - avgDb;
    if (deltaDb < 2.0) continue; // skip flat/quiet audio so it never emits a fake peak

    const tooClose = picked.some(p => Math.abs(p.peakSec - cand.timeSec) < 30);
    if (tooClose) continue;

    // Frame clip cleanly (-10s before reaction peak, +15s after by default)
    const startSec = Math.max(0, Number((cand.timeSec - 10).toFixed(1)));
    const endSec = Math.min(maxTime, startSec + clipDurationSec);
    if (endSec <= startSec) continue;
    const virality = calculateViralityScore({
      audioDeltaDb: Math.max(0, deltaDb),
      durationSec: endSec - startSec,
      hasFacecam: true,
    });

    picked.push({
      peakSec: Number(cand.timeSec.toFixed(1)),
      startSec,
      endSec: Number(endSec.toFixed(1)),
      peakDb: Number(cand.rmsDb.toFixed(1)),
      avgDb: Number(avgDb.toFixed(1)),
      deltaDb: Number(Math.max(0, deltaDb).toFixed(1)),
      viralityScore: virality.score,
      reason: `Loudest reaction spike (+${Math.max(0, deltaDb).toFixed(1)}dB above avg)`,
    });

    if (picked.length >= limit) break;
  }

  return {
    avgDb: Number(avgDb.toFixed(1)),
    scannedDurationSec: Number(maxTime.toFixed(1)),
    peaks: picked.sort((a, b) => a.startSec - b.startSec),
  };
}
