import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export interface RecordedSegment {
  file: string;
  seq: number;
  startEpochMs: number;
  endEpochMs: number;
}

export interface StreamBufferOptions {
  channelOrUrl: string;
  mediaRootDir?: string;
  quality?: string;
  /** Keep buffer duration in seconds (default: 240s = 4 minutes) */
  bufferWindowSec?: number;
}

export class StreamBuffer {
  private channelOrUrl: string;
  private quality: string;
  private bufferWindowSec: number;
  private bufferDir: string;
  private clipsDir: string;

  private streamlinkProc: ChildProcess | null = null;
  private ffmpegProc: ChildProcess | null = null;
  private isBuffering = false;
  private segments: RecordedSegment[] = [];
  private segmentWatcherTimer: NodeJS.Timeout | null = null;
  private streamStartEpochMs = 0;

  constructor(options: StreamBufferOptions) {
    this.channelOrUrl = options.channelOrUrl;
    this.quality = options.quality ?? '720p60,720p,best';
    this.bufferWindowSec = options.bufferWindowSec ?? 240;

    const mediaRoot = options.mediaRootDir ?? process.env.MEDIA_ROOT_DIR ?? 'D:/ClipperMedia';
    const sessionId = `live_${Date.now()}`;
    this.bufferDir = path.join(mediaRoot, '02_temp', 'live_buffer', sessionId);
    this.clipsDir = path.join(mediaRoot, '03_clips');

    fs.mkdirSync(this.bufferDir, { recursive: true });
    fs.mkdirSync(this.clipsDir, { recursive: true });
  }

  public async start(): Promise<void> {
    if (this.isBuffering) return;
    this.isBuffering = true;
    this.streamStartEpochMs = Date.now();

    console.log(`[stream-buffer] Launching streamlink capture for: ${this.channelOrUrl}`);

    // Resolve URL for streamlink
    let targetUrl = this.channelOrUrl;
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = `https://www.twitch.tv/${targetUrl}`;
    }

    const streamlinkArgs = [
      targetUrl,
      this.quality,
      '--stdout',
      '--twitch-disable-ads',
      '--loglevel', 'warning',
    ];

    this.streamlinkProc = spawn('streamlink', streamlinkArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
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

    // Pipe streamlink stdout directly into ffmpeg stdin
    this.streamlinkProc.stdout?.pipe(this.ffmpegProc.stdin!);

    this.ffmpegProc.stderr?.on('data', (d: Buffer) => {
      // Keep stderr quiet unless severe
      const str = d.toString();
      if (str.includes('Error') || str.includes('Invalid')) {
        console.warn(`[ffmpeg-buffer] ${str.trim()}`);
      }
    });

    // Handle exits
    this.streamlinkProc.on('close', (code) => {
      console.log(`[stream-buffer] streamlink exited with code ${code}`);
      this.isBuffering = false;
    });

    this.ffmpegProc.on('close', (code) => {
      console.log(`[stream-buffer] ffmpeg buffer exited with code ${code}`);
      this.isBuffering = false;
    });

    // Watch buffer directory and index segments
    this.segmentWatcherTimer = setInterval(() => this.indexAndPruneSegments(), 1500);
  }

  public stop(): void {
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

    // Clean up temporary buffer folder
    setTimeout(() => {
      try {
        fs.rmSync(this.bufferDir, { recursive: true, force: true });
        console.log(`[stream-buffer] Cleaned up buffer folder: ${this.bufferDir}`);
      } catch {}
    }, 5000);
  }

  /**
   * Scans buffer folder, assigns epoch timestamps to newly written chunks,
   * and unlinks chunks that are older than bufferWindowSec.
   */
  private indexAndPruneSegments(): void {
    if (!fs.existsSync(this.bufferDir)) return;

    try {
      const files = fs.readdirSync(this.bufferDir)
        .filter(f => f.startsWith('seg_') && f.endsWith('.ts'))
        .sort();

      const now = Date.now();
      const SEG_DUR_MS = 2000; // 2s segment time

      for (const f of files) {
        const fullPath = path.join(this.bufferDir, f);
        const match = f.match(/seg_(\d+)\.ts/);
        if (!match) continue;
        const seq = parseInt(match[1]!, 10);

        if (!this.segments.some(s => s.seq === seq)) {
          // Check file size > 0 to ensure it has begun writing
          const stat = fs.statSync(fullPath);
          if (stat.size > 0) {
            // Timestamp is offset from stream start based on seq
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

      // Prune old segments older than bufferWindowSec
      const cutoff = now - (this.bufferWindowSec * 1000);
      while (this.segments.length > 0 && this.segments[0]!.endEpochMs < cutoff) {
        const oldSeg = this.segments.shift()!;
        try {
          if (fs.existsSync(oldSeg.file)) fs.unlinkSync(oldSeg.file);
        } catch {}
      }
    } catch (err) {
      console.error('[stream-buffer] Error indexing segments:', err);
    }
  }

  /**
   * Extracts a clip spanning [startEpochMs, endEpochMs].
   * Handles segment selection, concat demuxer, precise trim, and vertical crop.
   */
  public async extractClip(
    startEpochMs: number,
    endEpochMs: number,
    options: {
      title?: string;
      vertical?: boolean;
    } = {}
  ): Promise<{ filePath: string; durationSec: number; fileSizeBytes: number }> {
    const vertical = options.vertical ?? true;
    const title = (options.title ?? 'clip').replace(/[^a-zA-Z0-9_-]/g, '_');

    // Find all segments covering this time window
    // (Include 1 segment padding on each side for clean keyframe boundary)
    const matching = this.segments.filter(s =>
      s.endEpochMs >= (startEpochMs - 2000) && s.startEpochMs <= (endEpochMs + 2000)
    );

    if (matching.length === 0) {
      throw new Error(`No buffered video segments found for time range [${startEpochMs} - ${endEpochMs}]`);
    }

    const firstSeg = matching[0]!;
    // Offset in seconds from start of the first segment
    const startOffsetSec = Math.max(0, (startEpochMs - firstSeg.startEpochMs) / 1000);
    const clipDurationSec = Math.max(1, (endEpochMs - startEpochMs) / 1000);

    const timestampStr = new Date(startEpochMs).toISOString().replace(/[:.]/g, '-');
    const outFileName = `${title}_${timestampStr}.mp4`;
    const outFilePath = path.join(this.clipsDir, outFileName);

    // Create temporary concat manifest
    const concatFile = path.join(this.bufferDir, `concat_${Date.now()}.txt`);
    const concatContent = matching
      .map(s => `file '${s.file.replace(/\\/g, '/')}'`)
      .join('\n');
    fs.writeFileSync(concatFile, concatContent, 'utf8');

    // Build FFmpeg command
    const vfArgs = vertical
      ? ['-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920']
      : [];

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-ss', startOffsetSec.toFixed(2),
      '-t', clipDurationSec.toFixed(2),
      ...vfArgs,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-movflags', '+faststart',
      outFilePath,
    ];

    console.log(`[stream-buffer] Extracting clip (${clipDurationSec.toFixed(1)}s) -> ${outFilePath}...`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
      proc.on('close', (code) => {
        try { fs.unlinkSync(concatFile); } catch {}
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
    };
  }
}
