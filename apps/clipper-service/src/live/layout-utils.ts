import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TEMP_DIR } from '../storage.js';

export type ClipLayout =
  | 'split'
  | 'split-crop'
  | 'crop'
  | 'blur'
  | 'portrait-4x5'
  | 'square'
  | 'landscape';
export type FacecamPosition = 'auto' | 'bottom-left' | 'top-left' | 'bottom-right' | 'top-right';

export interface FacecamDetectionResult {
  found: boolean;
  corner: FacecamPosition;
  crop_x?: number;
  crop_y?: number;
  crop_w?: number;
  crop_h?: number;
  img_width?: number;
  img_height?: number;
}

const FFMPEG = process.env.FFMPEG_BIN_PATH ?? 'ffmpeg';
const PYTHON_BIN = process.env.PYTHON_BIN_PATH ?? 'python';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveDetectFaceScript(): string {
  const localScript = path.resolve(MODULE_DIR, 'detect_face.py');
  if (fs.existsSync(localScript)) return localScript;
  return path.resolve(process.cwd(), 'apps/clipper-service/src/live/detect_face.py');
}

/**
 * Runs OpenCV face detection on an extracted PNG frame.
 */
export async function detectFacecamInImage(imagePath: string): Promise<FacecamDetectionResult> {
  const pyScript = resolveDetectFaceScript();
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(PYTHON_BIN, [pyScript, imagePath], { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      let settled = false;
      const timer = setTimeout(() => {
        try { p.kill(); } catch {}
        if (!settled) {
          settled = true;
          reject(new Error('detect_face timed out'));
        }
      }, 15_000);
      p.stdout?.on('data', (d) => (buf += d.toString()));
      p.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(buf.trim());
        }
      });
      p.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });

    const data = JSON.parse(out) as FacecamDetectionResult;
    if (data.found && data.corner) {
      return data;
    }
  } catch {
    // Fallback below
  }
  return { found: false, corner: 'top-left' };
}

/**
 * Extracts a frame from a local video or remote HLS/stream URL at `timestampSec`
 * and runs OpenCV facecam detection on it.
 */
export async function detectFacecamInMedia(
  mediaPathOrUrl: string,
  timestampSec = 0,
  workDir = TEMP_DIR,
  returnFrameBuffer = false,
): Promise<{ detection: FacecamDetectionResult; frameBuffer?: Buffer }> {
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
  const sampleImg = path.join(workDir, `detect_${crypto.randomUUID()}.png`);

  try {
    const ssArgs = timestampSec > 0 ? ['-ss', timestampSec.toFixed(2)] : [];
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        FFMPEG,
        ['-y', ...ssArgs, '-i', mediaPathOrUrl, '-vframes', '1', '-update', '1', sampleImg],
        { stdio: 'ignore' }
      );
      let settled = false;
      const timer = setTimeout(() => {
        try { p.kill(); } catch {}
        if (!settled) {
          settled = true;
          reject(new Error('frame extract timed out'));
        }
      }, 20_000);
      p.on('close', (c) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          if (c === 0) resolve();
          else reject(new Error('frame extract failed'));
        }
      });
      p.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });

    const detection = await detectFacecamInImage(sampleImg);
    const frameBuffer = returnFrameBuffer && fs.existsSync(sampleImg)
      ? fs.readFileSync(sampleImg)
      : undefined;

    try { fs.unlinkSync(sampleImg); } catch {}
    return { detection, frameBuffer };
  } catch {
    try { if (fs.existsSync(sampleImg)) fs.unlinkSync(sampleImg); } catch {}
    return { detection: { found: false, corner: 'top-left' } };
  }
}

export interface LayoutPostOptions {
  assSubtitlePath?: string | null;
  watermarkText?: string | null;
  hookTitleText?: string | null;
  maxResolution?: number;
  audioNormalize?: boolean;
}

/**
 * Returns the display aspect ratio string for a given ClipLayout.
 */
export function getAspectRatioForLayout(layout: ClipLayout): '16:9' | '4:5' | '1:1' | '9:16' {
  if (layout === 'landscape') return '16:9';
  if (layout === 'portrait-4x5') return '4:5';
  if (layout === 'square') return '1:1';
  return '9:16';
}

/**
 * Returns broadcast-grade FFmpeg audio normalization/enhancement `-af` arguments
 * when `audioNormalize` is enabled.
 */
export function getAudioEnhanceFilters(audioNormalize?: boolean): string[] {
  if (!audioNormalize) return [];
  return ['-af', 'highpass=f=80,acompressor=threshold=-18dB:ratio=3,loudnorm=I=-14:TP=-1.5:LRA=11'];
}

export function resolveSystemFontFile(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        'C:/Windows/Fonts/arialbd.ttf',
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/segoeui.ttf',
      ]
    : process.platform === 'darwin'
      ? ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf']
      : [
          '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
          '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
          '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
        ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function escapeFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\\\'");
}

/**
 * Escapes arbitrary user text for unquoted FFmpeg `drawtext=text=...` inside `-filter_complex`
 * (covering filtergraph + filter-option parser layers: `\`, `:`, `,`, `;`, `[`, `]`, `=`, `'`, and newlines).
 * Paired with `expansion=none` so `%` renders literally without strftime/expr failures.
 */
export function escapeDrawtextText(raw: string): string {
  return raw
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\\\\\:')
    .replace(/,/g, '\\\\\\,')
    .replace(/;/g, '\\\\\\;')
    .replace(/\[/g, '\\\\\\[')
    .replace(/\]/g, '\\\\\\]')
    .replace(/=/g, '\\\\\\=')
    .replace(/'/g, "\\\\\\'");
}

function buildDrawtextFilter(
  rawText: string,
  sysFont: string | null,
  styleExpr: string,
): string | null {
  const safeTxt = escapeDrawtextText(rawText);
  if (!safeTxt) return null;
  if (!sysFont && process.platform === 'win32') return null;

  const fontOpt = sysFont ? `fontfile='${escapeFilterPath(sysFont)}':` : '';
  return `drawtext=${fontOpt}expansion=none:text=${safeTxt}:${styleExpr}`;
}

const SCALE_720P_BY_LAYOUT: Record<ClipLayout, string> = {
  split: 'scale=720:1280',
  'split-crop': 'scale=720:1280',
  crop: 'scale=720:1280',
  blur: 'scale=720:1280',
  'portrait-4x5': 'scale=720:900',
  square: 'scale=720:720',
  landscape: 'scale=-2:720',
};

/**
 * Builds shared FFmpeg video/audio mapping arguments for all 7 Clipper Studio layouts,
 * optionally burning kinetic .ass captions, viral top hook banners, branding watermarks,
 * resolution limits, and broadcast audio normalization.
 */
export function buildLayoutFilterArgs(
  layout: ClipLayout,
  facecamPosition: FacecamPosition,
  detectedCam: FacecamDetectionResult | null,
  post: LayoutPostOptions = {},
): string[] {
  const effectivePos = (detectedCam?.found && detectedCam.corner) ? detectedCam.corner : facecamPosition;
  const is720 = Boolean(post.maxResolution && post.maxResolution <= 720);
  const sysFont = resolveSystemFontFile();

  const postFilters: string[] = [];
  if (is720) {
    postFilters.push(SCALE_720P_BY_LAYOUT[layout]);
  }
  if (post.assSubtitlePath && fs.existsSync(post.assSubtitlePath)) {
    postFilters.push(`ass='${escapeFilterPath(post.assSubtitlePath)}'`);
  }
  if (post.hookTitleText && post.hookTitleText.trim()) {
    const cleanHook = post.hookTitleText.trim().slice(0, 120);
    const baseFontSize = cleanHook.length > 36 ? 34 : 44;
    const hookFontSize = is720 ? Math.round(baseFontSize * 0.75) : baseFontSize;
    const hookFilter = buildDrawtextFilter(
      cleanHook,
      sysFont,
      `fontsize=${hookFontSize}:fontcolor=white:x=(w-text_w)/2:y=h*0.07:box=1:boxcolor=black@0.72:boxborderw=18:enable='between(t,0,3.5)'`,
    );
    if (hookFilter) postFilters.push(hookFilter);
  }
  if (post.watermarkText && post.watermarkText.trim()) {
    const wmFontSize = is720 ? 20 : 26;
    const wmFilter = buildDrawtextFilter(
      post.watermarkText,
      sysFont,
      `fontsize=${wmFontSize}:fontcolor=white@0.72:x=(w-text_w)-28:y=28:box=1:boxcolor=black@0.48:boxborderw=8`,
    );
    if (wmFilter) postFilters.push(wmFilter);
  }

  let baseGraph = '';
  if (layout === 'split' || layout === 'split-crop') {
    let camCrop = '';
    if (detectedCam && detectedCam.found && detectedCam.crop_w && detectedCam.crop_h) {
      camCrop = `crop=${detectedCam.crop_w}:${detectedCam.crop_h}:${detectedCam.crop_x}:${detectedCam.crop_y}`;
    } else if (effectivePos === 'bottom-left') {
      camCrop = 'crop=w=iw*0.30:h=iw*0.30*(720/1080):x=0:y=ih-h';
    } else if (effectivePos === 'top-right') {
      camCrop = 'crop=w=iw*0.30:h=iw*0.30*(720/1080):x=iw-w:y=0';
    } else if (effectivePos === 'bottom-right') {
      camCrop = 'crop=w=iw*0.30:h=iw*0.30*(720/1080):x=iw-w:y=ih-h';
    } else {
      camCrop = 'crop=w=iw*0.30:h=iw*0.30*(720/1080):x=0:y=0';
    }

    let gameChain = '';
    if (layout === 'split-crop') {
      gameChain = `[game_in]crop=w=ih*(1080/1200):h=ih:x=(iw-ow)/2:y=0,scale=1080:1200[game]`;
    } else {
      gameChain = [
        `[game_in]split=2[gbg][gfg]`,
        `[gbg]scale=1080:1200:force_original_aspect_ratio=increase,crop=1080:1200,boxblur=25:5[bg_blur]`,
        `[gfg]scale=1080:-2[fg_scaled]`,
        `[bg_blur][fg_scaled]overlay=0:(1200-h)/2[game]`,
      ].join(';');
    }

    baseGraph = [
      `[0:v]split=2[cam_in][game_in]`,
      `[cam_in]${camCrop},scale=1080:720[cam]`,
      gameChain,
      `[cam][game]vstack=inputs=2[basev]`,
    ].join(';');
  } else if (layout === 'blur') {
    baseGraph = [
      `[0:v]split=2[bg][fg]`,
      `[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[bg_blurred]`,
      `[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fg_scaled]`,
      `[bg_blurred][fg_scaled]overlay=(W-w)/2:(H-h)/2[basev]`,
    ].join(';');
  } else if (layout === 'portrait-4x5') {
    baseGraph = [
      `[0:v]split=2[bg][fg]`,
      `[bg]scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350,boxblur=25:5,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.35:t=fill[bg_blurred]`,
      `[fg]scale=1080:1350:force_original_aspect_ratio=decrease[fg_scaled]`,
      `[bg_blurred][fg_scaled]overlay=(W-w)/2:(H-h)/2[basev]`,
    ].join(';');
  } else if (layout === 'square') {
    baseGraph = [
      `[0:v]split=2[bg][fg]`,
      `[bg]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,boxblur=25:5[bg_blurred]`,
      `[fg]scale=1080:1080:force_original_aspect_ratio=decrease[fg_scaled]`,
      `[bg_blurred][fg_scaled]overlay=(W-w)/2:(H-h)/2[basev]`,
    ].join(';');
  } else if (layout === 'crop') {
    baseGraph = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[basev]`;
  } else {
    if (postFilters.length === 0) return getAudioEnhanceFilters(post.audioNormalize);
    baseGraph = `[0:v]null[basev]`;
  }

  const finalGraph = postFilters.length > 0
    ? `${baseGraph};[basev]${postFilters.join(',')}[outv]`
    : baseGraph.replace('[basev]', '[outv]');

  return [
    '-filter_complex', finalGraph,
    '-map', '[outv]',
    '-map', '0:a?',
    ...getAudioEnhanceFilters(post.audioNormalize),
  ];
}
