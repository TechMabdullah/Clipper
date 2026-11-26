import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { resolveMediaRootDir } from '../storage.js';
import {
  type ClipLayout,
  type FacecamPosition,
  type FacecamDetectionResult,
  detectFacecamInMedia,
  buildLayoutFilterArgs,
  getAudioEnhanceFilters,
  getAspectRatioForLayout,
} from './layout-utils.js';
import { generateKineticAssForClip, type CaptionStyle } from '../features/captions.js';

export type { ClipLayout, FacecamPosition, FacecamDetectionResult };
export { getAspectRatioForLayout };

/**
 * Returns the display aspect ratio string (`16:9`, `4:5`, `1:1`, or `9:16`) for a ClipLayout.
 */
export function getAspectRatio(layout: ClipLayout): '16:9' | '4:5' | '1:1' | '9:16' {
  return getAspectRatioForLayout(layout);
}

export interface RecordedSegment {
  file: string;
  seq: number;
  startEpochMs: number;
  endEpochMs: number;
}

export interface StreamBufferOptions {
  channelOrUrl: string;
  platform?: 'twitch' | 'youtube' | 'kick';
  mediaRootDir?: string;
  quality?: string;
  /** Keep buffer duration in seconds (default: 240s = 4 minutes) */
  bufferWindowSec?: number;
  /** If true, retain all segments for the session and export MP4 to 05_streams/ on stop */
  saveRecording?: boolean;
}

export interface ExtractClipOptions {
  title?: string;
  vertical?: boolean;
  layout?: ClipLayout;
  facecamPosition?: FacecamPosition;
  captionStyle?: CaptionStyle;
  watermarkText?: string;
  hookTitleText?: string;
  audioNormalize?: boolean;
  maxResolution?: number;
  fallbackHookText?: string;
}

export class StreamBuffer {
  private channelOrUrl: string;
  private platform: 'twitch' | 'youtube' | 'kick';
  private quality: string;
  private bufferWindowSec: number;
  private saveRecording: boolean;
  private bufferDir: string;
  private clipsDir: string;
  private recordingsDir: string;

  private streamlinkProc: ChildProcess | null = null;
  private ffmpegProc: ChildProcess | null = null;
  private isBuffering = false;
  private segments: RecordedSegment[] = [];
  private segmentWatcherTimer: NodeJS.Timeout | null = null;
  private streamStartEpochMs = 0;

  constructor(options: StreamBufferOptions) {
    this.channelOrUrl = options.channelOrUrl;
    this.platform = options.platform ?? 'twitch';
    this.quality = options.quality ?? '720p60,720p,best';
    this.bufferWindowSec = options.bufferWindowSec ?? 240;
    this.saveRecording = Boolean(options.saveRecording);

    const mediaRoot = options.mediaRootDir ?? resolveMediaRootDir();
    const sessionId = `live_${crypto.randomUUID()}`;
    this.bufferDir = path.join(mediaRoot, '02_temp', 'live_buffer', sessionId);
    this.clipsDir = path.join(mediaRoot, '03_clips');
    this.recordingsDir = path.join(mediaRoot, '05_streams');

    fs.mkdirSync(this.bufferDir, { recursive: true });
    fs.mkdirSync(this.clipsDir, { recursive: true });
    fs.mkdirSync(this.recordingsDir, { recursive: true });
  }

  public async start(): Promise<void> {
    if (this.isBuffering) return;
    this.isBuffering = true;
    this.streamStartEpochMs = Date.now();

    let targetUrl = this.channelOrUrl.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      const cleanChannel = targetUrl.replace(/^[-@#/]+/, '');
      if (!cleanChannel) {
        this.isBuffering = false;
        throw new Error('Channel or stream URL is required');
      }
      if (this.platform === 'kick') {
        targetUrl = `https://kick.com/${cleanChannel}`;
      } else if (this.platform === 'youtube') {
        targetUrl = cleanChannel.startsWith('UC')
          ? `https://www.youtube.com/channel/${cleanChannel}/live`
          : `https://www.youtube.com/@${cleanChannel}/live`;
      } else {
        targetUrl = `https://www.twitch.tv/${cleanChannel}`;
      }
    }

    console.log(`[stream-buffer] Launching streamlink capture for ${this.platform}: ${targetUrl}`);

    const streamlinkArgs = [
      '--stdout',
      '--loglevel', 'warning',
    ];

    if (this.platform === 'twitch' || targetUrl.includes('twitch.tv')) {
      streamlinkArgs.push('--twitch-disable-ads');
    }
    streamlinkArgs.push(targetUrl, this.quality);

    this.streamlinkProc = spawn('streamlink', streamlinkArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.streamlinkProc.on('error', (err) => {
      console.error('[stream-buffer] Failed to launch streamlink:', err);
      this.isBuffering = false;
    });

    this.streamlinkProc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.warn(`[streamlink] ${msg}`);
    });

    const segmentPattern = path.join(this.bufferDir, 'seg_%05d.ts');
    const ffmpegArgs = [
      '-y',
      '-i', 'pipe:0',
      '-c', 'copy',
      '-f', 'segment',
      '-segment_time', '2',
      '-reset_timestamps', '1',
      segmentPattern,
    ];

    this.ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    this.ffmpegProc.on('error', (err) => {
      console.error('[stream-buffer] Failed to launch ffmpeg:', err);
      this.isBuffering = false;
    });

    this.ffmpegProc.stdin?.on('error', () => {
      // Ignore EPIPE when streamlink closes early
    });

    this.streamlinkProc.stdout?.pipe(this.ffmpegProc.stdin!);

    this.ffmpegProc.stderr?.on('data', (d: Buffer) => {
      const str = d.toString();
      if (str.includes('Error') || str.includes('Invalid')) {
        console.warn(`[ffmpeg-buffer] ${str.trim()}`);
      }
    });

    this.streamlinkProc.on('close', (code) => {
      console.log(`[stream-buffer] streamlink exited with code ${code}`);
      this.isBuffering = false;
    });

    this.ffmpegProc.on('close', (code) => {
      console.log(`[stream-buffer] ffmpeg buffer exited with code ${code}`);
      this.isBuffering = false;
    });

    this.segmentWatcherTimer = setInterval(() => this.indexAndPruneSegments(), 1500);
  }

  public async stop(): Promise<string | null> {
    this.isBuffering = false;
    if (this.segmentWatcherTimer) clearInterval(this.segmentWatcherTimer);

    if (this.streamlinkProc) {
      try { this.streamlinkProc.kill(); } catch {}
      this.streamlinkProc = null;
    }
    if (this.ffmpegProc) {
      try { this.ffmpegProc.kill(); } catch {}
      this.ffmpegProc = null;
    }

    let savedPath: string | null = null;
    if (this.saveRecording && this.segments.length > 0) {
      try {
        savedPath = await this.exportFullRecording();
      } catch (err) {
        console.warn('[stream-buffer] Failed to export full recording on stop:', err);
      }
    }

    setTimeout(() => {
      try {
        fs.rmSync(this.bufferDir, { recursive: true, force: true });
        console.log(`[stream-buffer] Cleaned up buffer folder: ${this.bufferDir}`);
      } catch {}
    }, 5000);

    return savedPath;
  }

  /**
   * Concatenates all currently stored buffer segments into a single MP4 inside 05_streams/
   * for manual post-stream scrubbing & clipping.
   */
  public async exportFullRecording(titleHint?: string): Promise<string | null> {
    this.indexAndPruneSegments();
    const validSegs = this.segments.filter(s => fs.existsSync(s.file));
    if (validSegs.length === 0) return null;

    const cleanName = (titleHint ?? this.channelOrUrl)
      .replace(/https?:\/\//, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(this.recordingsDir, `${cleanName}_${stamp}.mp4`);
    const concatList = path.join(this.bufferDir, `export_${crypto.randomUUID()}.txt`);

    fs.writeFileSync(
      concatList,
      validSegs.map(s => `file '${s.file.replace(/\\/g, '/')}'`).join('\n'),
      'utf8'
    );

    console.log(`[stream-buffer] 💾 Exporting ${validSegs.length} segments to VOD recording: ${outPath}`);
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn('ffmpeg', [
          '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
          '-c', 'copy', '-movflags', '+faststart', outPath,
        ], { stdio: 'ignore' });
        p.on('close', (code) => {
          if (code === 0 && fs.existsSync(outPath)) resolve();
          else reject(new Error(`FFmpeg mux exited ${code}`));
        });
        p.on('error', reject);
      });
    } finally {
      try { if (fs.existsSync(concatList)) fs.unlinkSync(concatList); } catch {}
    }

    return outPath;
  }

  private indexAndPruneSegments(): void {
    if (!fs.existsSync(this.bufferDir)) return;

    try {
      const files = fs.readdirSync(this.bufferDir)
        .filter(f => f.startsWith('seg_') && f.endsWith('.ts'))
        .sort();

      const now = Date.now();
      const SEG_DUR_MS = 2000;

      for (const f of files) {
        const fullPath = path.join(this.bufferDir, f);
        const match = f.match(/seg_(\d+)\.ts/);
        if (!match) continue;
        const seq = parseInt(match[1]!, 10);

        if (!this.segments.some(s => s.seq === seq)) {
          const stat = fs.statSync(fullPath);
          if (stat.size > 0) {
            const startEpochMs = this.streamStartEpochMs + (seq * SEG_DUR_MS);
            const endEpochMs = startEpochMs + SEG_DUR_MS;
            this.segments.push({
              file: fullPath,
              seq,
              startEpochMs,
              endEpochMs,
            });
          }
        }
      }

      if (!this.saveRecording) {
        const cutoff = now - (this.bufferWindowSec * 1000);
        while (this.segments.length > 0 && this.segments[0]!.endEpochMs < cutoff) {
          const oldSeg = this.segments.shift()!;
          try {
            if (fs.existsSync(oldSeg.file)) fs.unlinkSync(oldSeg.file);
          } catch {}
        }
      }
    } catch (err) {
      console.error('[stream-buffer] Error indexing segments:', err);
    }
  }

  /**
   * Attempts automatic face detection on a video segment using OpenCV.
   * Returns detected facecam bounding box and corner position.
   */
  public async detectFaceCam(sampleSegmentPath?: string): Promise<FacecamDetectionResult> {
    const targetFile = sampleSegmentPath ?? (this.segments.length > 0 ? this.segments[this.segments.length - 1]?.file : null);
    if (!targetFile || !fs.existsSync(targetFile)) {
      return { found: false, corner: 'top-left' };
    }

    const { detection } = await detectFacecamInMedia(targetFile, 0, this.bufferDir);
    if (detection.found && detection.corner) {
      console.log(`[stream-buffer] 👤 Auto Facecam detected in ${detection.corner}: x=${detection.crop_x}, y=${detection.crop_y}, w=${detection.crop_w}, h=${detection.crop_h}`);
    }
    return detection;
  }

  /**
   * Captures the most recent frame from the rolling buffer for the web live preview.
   */
  public async getLatestSnapshot(): Promise<Buffer | null> {
    if (this.segments.length === 0) return null;
    const latestSeg = this.segments[this.segments.length - 1];
    if (!latestSeg || !fs.existsSync(latestSeg.file)) return null;

    const tmpImg = path.join(this.bufferDir, `latest_preview_${crypto.randomUUID()}.png`);
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn('ffmpeg', [
          '-y', '-i', latestSeg.file,
          '-vframes', '1', '-update', '1', tmpImg
        ], { stdio: 'ignore' });
        p.on('close', (c) => c === 0 ? resolve() : reject(new Error('snapshot failed')));
        p.on('error', reject);
      });

      if (fs.existsSync(tmpImg)) {
        return fs.readFileSync(tmpImg);
      }
    } catch {
      return null;
    } finally {
      try { if (fs.existsSync(tmpImg)) fs.unlinkSync(tmpImg); } catch {}
    }
    return null;
  }

  public async extractClip(
    startEpochMs: number,
    endEpochMs: number,
    options: ExtractClipOptions = {}
  ): Promise<{
    filePath: string;
    durationSec: number;
    fileSizeBytes: number;
    hasFacecam: boolean;
    hasCaptions: boolean;
    aspectRatio: '16:9' | '4:5' | '1:1' | '9:16';
  }> {
    const layout: ClipLayout = options.layout ?? (options.vertical === false ? 'landscape' : 'split');
    const aspectRatio = getAspectRatioForLayout(layout);
    let facecamPosition: FacecamPosition = options.facecamPosition ?? 'auto';
    const title = (options.title ?? 'clip').replace(/[^a-zA-Z0-9_-]/g, '_');

    const matching = this.segments.filter(s =>
      s.endEpochMs >= (startEpochMs - 2000) && s.startEpochMs <= (endEpochMs + 2000)
    );

    if (matching.length === 0) {
      throw new Error(`No buffered video segments found for time range [${startEpochMs} - ${endEpochMs}]`);
    }

    const firstSeg = matching[0]!;
    const startOffsetSec = Math.max(0, (startEpochMs - firstSeg.startEpochMs) / 1000);
    const clipDurationSec = Math.max(1, (endEpochMs - startEpochMs) / 1000);

    const timestampStr = new Date(startEpochMs).toISOString().replace(/[:.]/g, '-');
    const outFileName = `${title}_${timestampStr}.mp4`;
    const outFilePath = path.join(this.clipsDir, outFileName);

    const concatFile = path.join(this.bufferDir, `concat_${crypto.randomUUID()}.txt`);
    const concatContent = matching
      .map(s => `file '${s.file.replace(/\\/g, '/')}'`)
      .join('\n');
    fs.writeFileSync(concatFile, concatContent, 'utf8');

    let assSubtitlePath: string | null = null;
    try {
      // Auto-detect or resolve facecam bounding box
      let detectedCam: FacecamDetectionResult | null = null;
      if (layout === 'split' || layout === 'split-crop') {
        if (facecamPosition === 'auto') {
          // Multi-segment candidate check across the clip window:
          // 1. Middle segment (active gameplay/streamer)
          // 2. Last segment
          // 3. First segment
          const candidates = [
            matching[Math.floor(matching.length / 2)],
            matching[matching.length - 1],
            matching[0],
          ].filter(Boolean);

          for (const cand of candidates) {
            if (cand && fs.existsSync(cand.file)) {
              const res = await this.detectFaceCam(cand.file);
              if (res.found) {
                detectedCam = res;
                facecamPosition = res.corner;
                break;
              }
            }
          }

          if (!detectedCam || !detectedCam.found) {
            facecamPosition = 'top-left'; // default fallback for top streamers
          }
        }
      }

      // Optional Kinetic Captions extraction on temporary raw slice
      if (options.captionStyle && options.captionStyle !== 'none') {
        const tmpSlice = path.join(this.bufferDir, `rawslice_${crypto.randomUUID()}.mp4`);
        try {
          await new Promise<void>((resolve, reject) => {
            const p = spawn('ffmpeg', [
              '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
              '-ss', startOffsetSec.toFixed(2), '-t', clipDurationSec.toFixed(2),
              '-c', 'copy', tmpSlice,
            ], { stdio: 'ignore' });
            p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('raw slice failed'))));
            p.on('error', reject);
          });
          const capRes = await generateKineticAssForClip({
            sourceMediaPath: tmpSlice,
            style: options.captionStyle,
            isVertical: layout !== 'landscape',
            fallbackHookText: options.fallbackHookText,
          });
          assSubtitlePath = capRes.assPath;
        } catch {
          assSubtitlePath = null;
        } finally {
          try { if (fs.existsSync(tmpSlice)) fs.unlinkSync(tmpSlice); } catch {}
        }
      }

      // Build FFmpeg filter args based on selected layout + captions + hook + watermark + audio enhance + plan resolution
      const filterArgs = buildLayoutFilterArgs(layout, facecamPosition, detectedCam, {
        assSubtitlePath,
        watermarkText: options.watermarkText,
        hookTitleText: options.hookTitleText,
        maxResolution: options.maxResolution,
      });
      const audioEnhanceArgs = getAudioEnhanceFilters(options.audioNormalize);

      const args = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-ss', startOffsetSec.toFixed(2),
        '-t', clipDurationSec.toFixed(2),
        ...filterArgs,
        ...audioEnhanceArgs,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '22',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-movflags', '+faststart',
        outFilePath,
      ];

      console.log(
        `[stream-buffer] Extracting clip (${clipDurationSec.toFixed(1)}s, layout: ${layout} [${aspectRatio}], ` +
        `facecam: ${facecamPosition}, captions: ${options.captionStyle ?? 'none'}) -> ${outFilePath}...`
      );

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg clip extraction failed with exit code ${code}`));
        });
        proc.on('error', reject);
      });

      const stat = fs.statSync(outFilePath);
      console.log(`[stream-buffer] ✅ Clip saved: ${outFilePath} (${(stat.size / 1e6).toFixed(1)} MB)`);

      return {
        filePath: outFilePath,
        durationSec: clipDurationSec,
        fileSizeBytes: stat.size,
        hasFacecam: Boolean(detectedCam?.found || layout === 'split' || layout === 'split-crop'),
        hasCaptions: Boolean(assSubtitlePath),
        aspectRatio,
      };
    } finally {
      try { if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile); } catch {}
      if (assSubtitlePath) {
        try { if (fs.existsSync(assSubtitlePath)) fs.unlinkSync(assSubtitlePath); } catch {}
      }
    }
  }
}
