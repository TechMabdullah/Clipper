import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export type ClipLayout = 'split' | 'crop' | 'blur' | 'landscape';
export type FacecamPosition = 'auto' | 'bottom-left' | 'top-left' | 'bottom-right' | 'top-right';

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

export interface ExtractClipOptions {
  title?: string;
  vertical?: boolean;
  layout?: ClipLayout;
  facecamPosition?: FacecamPosition;
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

    setTimeout(() => {
      try {
        fs.rmSync(this.bufferDir, { recursive: true, force: true });
        console.log(`[stream-buffer] Cleaned up buffer folder: ${this.bufferDir}`);
      } catch {}
    }, 5000);
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
   * Attempts automatic face detection on a video segment using OpenCV.
   * Returns detected corner: 'bottom-left' | 'top-left' | 'bottom-right' | 'top-right'.
   */
  private async detectFaceCorner(sampleSegmentPath: string): Promise<FacecamPosition> {
    const sampleImg = path.join(this.bufferDir, `detect_${Date.now()}.jpg`);
    const pyScript = path.resolve('apps/clipper-service/src/live/detect_face.py');

    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn('ffmpeg', [
          '-y', '-ss', '0.5', '-i', sampleSegmentPath,
          '-vframes', '1', '-q:v', '2', sampleImg
        ], { stdio: 'ignore' });
        p.on('close', (c) => c === 0 ? resolve() : reject(new Error('frame extract failed')));
        p.on('error', reject);
      });

      const out = await new Promise<string>((resolve, reject) => {
        const p = spawn('python', [pyScript, sampleImg], { stdio: ['ignore', 'pipe', 'ignore'] });
        let buf = '';
        p.stdout?.on('data', (d) => buf += d.toString());
        p.on('close', () => resolve(buf.trim()));
        p.on('error', reject);
      });

      try { fs.unlinkSync(sampleImg); } catch {}

      const data = JSON.parse(out);
      if (data.found && data.corner) {
        console.log(`[stream-buffer] 👤 Auto Facecam detected in: ${data.corner}`);
        return data.corner as FacecamPosition;
      }
    } catch (err) {
      console.warn('[stream-buffer] Auto face detection fallback to bottom-left');
    }

    try { if (fs.existsSync(sampleImg)) fs.unlinkSync(sampleImg); } catch {}
    return 'bottom-left';
  }

  public async extractClip(
    startEpochMs: number,
    endEpochMs: number,
    options: ExtractClipOptions = {}
  ): Promise<{ filePath: string; durationSec: number; fileSizeBytes: number }> {
    const layout: ClipLayout = options.layout ?? (options.vertical === false ? 'landscape' : 'split');
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

    const concatFile = path.join(this.bufferDir, `concat_${Date.now()}.txt`);
    const concatContent = matching
      .map(s => `file '${s.file.replace(/\\/g, '/')}'`)
      .join('\n');
    fs.writeFileSync(concatFile, concatContent, 'utf8');

    // Auto-resolve facecam corner if set to auto
    if (layout === 'split' && facecamPosition === 'auto') {
      facecamPosition = await this.detectFaceCorner(firstSeg.file);
    }

    // Build FFmpeg filter args based on selected layout
    let filterArgs: string[] = [];

    if (layout === 'split') {
      // ── Split-Screen Layout: Facecam Top (1080x720) + Gameplay Bottom (1080x1200) ──
      let camCrop = 'crop=w=iw*0.35:h=ih*0.45:x=0:y=ih*0.55'; // default bottom-left
      if (facecamPosition === 'top-left') {
        camCrop = 'crop=w=iw*0.35:h=ih*0.45:x=0:y=0';
      } else if (facecamPosition === 'bottom-right') {
        camCrop = 'crop=w=iw*0.35:h=ih*0.45:x=iw*0.65:y=ih*0.55';
      } else if (facecamPosition === 'top-right') {
        camCrop = 'crop=w=iw*0.35:h=ih*0.45:x=iw*0.65:y=0';
      }

      const splitFilter = [
        `[0:v]split=2[cam_in][game_in]`,
        `[cam_in]${camCrop},scale=1080:720:force_original_aspect_ratio=increase,crop=1080:720[cam]`,
        `[game_in]crop=w=ih*(1080/1200):h=ih:x=(iw-ow)/2:y=0,scale=1080:1200[game]`,
        `[cam][game]vstack=inputs=2[outv]`
      ].join(';');

      filterArgs = [
        '-filter_complex', splitFilter,
        '-map', '[outv]',
        '-map', '0:a?'
      ];
    } else if (layout === 'blur') {
      // ── Blurred Background Layout (16:9 gameplay centered + vertical blur) ──
      const blurFilter = [
        `[0:v]split=2[bg][fg]`,
        `[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[bg_blurred]`,
        `[fg]scale=1080:-1[fg_scaled]`,
        `[bg_blurred][fg_scaled]overlay=(W-w)/2:(H-h)/2[outv]`
      ].join(';');

      filterArgs = [
        '-filter_complex', blurFilter,
        '-map', '[outv]',
        '-map', '0:a?'
      ];
    } else if (layout === 'crop') {
      // ── Standard 9:16 Center Crop ──
      filterArgs = [
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
      ];
    } else {
      // ── 16:9 Landscape ──
      filterArgs = [];
    }

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-ss', startOffsetSec.toFixed(2),
      '-t', clipDurationSec.toFixed(2),
      ...filterArgs,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-movflags', '+faststart',
      outFilePath,
    ];

    console.log(`[stream-buffer] Extracting clip (${clipDurationSec.toFixed(1)}s, layout: ${layout}, facecam: ${facecamPosition}) -> ${outFilePath}...`);

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
