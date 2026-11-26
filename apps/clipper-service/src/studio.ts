import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import {
  RECORDINGS_DIR,
  INBOX,
  ARCHIVE_DIR,
  CLIPS_DIR,
  TEMP_DIR,
  MUSIC_DIR,
  isPathInsideMediaDirs,
} from './storage.js';
import { db, insertClip, getSetting } from './db.js';
import { probeDuration } from './downloader.js';
import {
  type ClipLayout,
  type FacecamPosition,
  type FacecamDetectionResult,
  detectFacecamInMedia,
  buildLayoutFilterArgs,
  getAspectRatioForLayout,
  resolveSystemFontFile,
  escapeDrawtextText,
} from './live/layout-utils.js';
import { assertEntitlement, EntitlementError } from './licensing.js';
import { generateKineticAssForClip, type CaptionStyle } from './features/captions.js';
import { scanAudioPeaks, calculateViralityScore } from './features/audio-peaks.js';
import { buildAudioEnhanceFilter, trimSilenceFromClip, listMusicTracks } from './features/audio-fx.js';
import { extractClipThumbnail, generateSocialMetadata } from './features/metadata-ai.js';

const YTDLP = process.env.YTDLP_BIN_PATH ?? 'yt-dlp';
const FFMPEG = process.env.FFMPEG_BIN_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN_PATH ?? 'ffprobe';
const VALID_CLIP_LAYOUTS = new Set<ClipLayout>([
  'split',
  'split-crop',
  'crop',
  'blur',
  'portrait-4x5',
  'square',
  'landscape',
]);
const VALID_CAPTION_STYLES = new Set<CaptionStyle>(['none', 'hormozi', 'neon', 'minimal']);
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class ProxyUrlError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class ClipNotFoundError extends Error {
  public readonly statusCode = 404;
  constructor(message = 'Clip not found') {
    super(message);
  }
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export function isBlockedIpAddress(rawIp: string): boolean {
  let ip = rawIp.trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);

  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) return isBlockedIpv4(mapped);
    const hexParts = mapped.split(':');
    if (hexParts.length === 2) {
      const hi = Number.parseInt(hexParts[0]!, 16);
      const lo = Number.parseInt(hexParts[1]!, 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isBlockedIpv4(ipv4);
      }
    }
  }

  if (ip.startsWith('::') && !ip.startsWith('::ffff:')) {
    const maybeV4 = ip.slice(2);
    if (net.isIPv4(maybeV4)) return isBlockedIpv4(maybeV4);
  }

  if (net.isIPv4(ip)) {
    return isBlockedIpv4(ip);
  }

  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') {
      return true;
    }
    const firstHextet = ip.split(':')[0] ?? '';
    const val = Number.parseInt(firstHextet || '0', 16);
    if ((val & 0xfe00) === 0xfc00) return true; // fc00::/7 Unique Local
    if ((val & 0xffc0) === 0xfe80) return true; // fe80::/10 Link-Local
    if ((val & 0xff00) === 0xff00) return true; // ff00::/8 Multicast
    return false;
  }

  return false;
}

export interface SafeRemoteUrlOptions {
  requireHttps?: boolean;
}

export function assertSafeRemoteUrlSyntax(
  rawUrl: string,
  options?: SafeRemoteUrlOptions,
): { parsed: URL; unbracketed: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProxyUrlError(400, 'Invalid URL');
  }
  if (options?.requireHttps) {
    if (parsed.protocol !== 'https:') {
      throw new ProxyUrlError(400, 'HTTPS URL protocol is required');
    }
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProxyUrlError(400, 'Invalid URL protocol');
  }
  if (parsed.username || parsed.password) {
    throw new ProxyUrlError(403, 'Credentials in remote URL are not allowed');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) {
    throw new ProxyUrlError(400, 'Invalid URL hostname');
  }
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new ProxyUrlError(403, 'Access to local or private hostnames is blocked');
  }

  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  if (net.isIP(unbracketed) && isBlockedIpAddress(unbracketed)) {
    throw new ProxyUrlError(403, 'Access to private, loopback, or link-local IP addresses is blocked');
  }

  return { parsed, unbracketed };
}

export async function assertSafeRemoteUrl(
  rawUrl: string,
  options?: SafeRemoteUrlOptions,
): Promise<URL> {
  const { parsed, unbracketed } = assertSafeRemoteUrlSyntax(rawUrl, options);
  if (net.isIP(unbracketed)) {
    return parsed;
  }

  let records: dns.LookupAddress[];
  try {
    records = await dns.promises.lookup(unbracketed, { all: true });
  } catch (err: any) {
    const code = String(err?.code ?? '');
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      throw new ProxyUrlError(400, `Hostname could not be resolved (${code}): ${unbracketed}`);
    }
    throw new ProxyUrlError(502, `DNS lookup failed for ${unbracketed}: ${err?.message ?? code}`);
  }

  if (!records || records.length === 0) {
    throw new ProxyUrlError(400, `Hostname resolved to no addresses: ${unbracketed}`);
  }
  for (const rec of records) {
    if (isBlockedIpAddress(rec.address)) {
      throw new ProxyUrlError(403, 'Target hostname resolves to a blocked private or loopback IP');
    }
  }
  return parsed;
}

async function assertSafeSourceOrStreamUrl(source: string, streamUrl?: string): Promise<void> {
  const trimmedSource = source.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedSource)) {
    await assertSafeRemoteUrl(trimmedSource);
  }
  const trimmedStream = streamUrl?.trim();
  if (trimmedStream && /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedStream)) {
    await assertSafeRemoteUrl(trimmedStream);
  }
}

export interface LocalVideoItem {
  name: string;
  path: string;
  folder: '05_streams' | '01_inbox' | '04_archive' | '03_clips';
  sizeBytes: number;
  modifiedAt: string;
}

export interface PastStreamItem {
  id: string;
  platform: 'twitch' | 'kick' | 'youtube';
  title: string;
  durationSec: number;
  url: string;
  streamUrl: string;
  thumbnail: string;
  createdAt: string;
  isLive: boolean;
}

export interface ProbedMedia {
  sourceType: 'local' | 'vod';
  source: string;
  title: string;
  durationSec: number;
  width?: number;
  height?: number;
  thumbnail?: string;
  platform?: 'twitch' | 'kick' | 'youtube' | 'other';
  playerMode: 'local' | 'hls' | 'proxy-video' | 'embed';
  playerUrl: string;
  rawStreamUrl?: string;
  embedUrl?: string;
}

export interface VodDownloadJob {
  id: string;
  url: string;
  title: string;
  status: 'DOWNLOADING' | 'DONE' | 'ERROR';
  percent: number;
  filePath?: string;
  error?: string;
  createdAt: string;
}

export const vodDownloads = new Map<string, VodDownloadJob>();

/**
 * Lists all video files across ClipperMedia subdirectories for manual clipping.
 */
export function listLocalVideos(): LocalVideoItem[] {
  const dirs: Array<{ dir: string; label: LocalVideoItem['folder'] }> = [
    { dir: RECORDINGS_DIR, label: '05_streams' },
    { dir: INBOX, label: '01_inbox' },
    { dir: ARCHIVE_DIR, label: '04_archive' },
    { dir: CLIPS_DIR, label: '03_clips' },
  ];

  const results: LocalVideoItem[] = [];
  for (const entry of dirs) {
    if (!fs.existsSync(entry.dir)) continue;
    try {
      const files = fs.readdirSync(entry.dir);
      for (const f of files) {
        if (!/\.(mp4|mkv|mov|webm|ts|flv|avi)$/i.test(f)) continue;
        const full = path.join(entry.dir, f);
        try {
          const stat = fs.statSync(full);
          if (!stat.isFile()) continue;
          results.push({
            name: f,
            path: full,
            folder: entry.label,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        } catch {}
      }
    } catch {}
  }

  return results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * Lists past live broadcasts / VODs for a given channel across Twitch, Kick, or YouTube.
 */
export async function listPastStreams(
  platform: 'twitch' | 'kick' | 'youtube',
  channelOrUrl: string,
): Promise<PastStreamItem[]> {
  const cleanChannel = channelOrUrl
    .replace(/^https?:\/\/(?:www\.)?(?:twitch\.tv|kick\.com|youtube\.com)\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^[@#]/, '')
    .trim();

  if (!cleanChannel) return [];

  if (platform === 'kick') {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(cleanChannel)}/videos`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Kick videos API returned ${res.status} for channel "${cleanChannel}"`);
    }
    const items = (await res.json()) as any[];
    if (!Array.isArray(items)) return [];

    return items.slice(0, 12).map((v) => ({
      id: String(v.id ?? crypto.randomUUID()),
      platform: 'kick',
      title: String(v.session_title ?? `Kick Stream ${v.id}`),
      durationSec: Math.round(Number(v.duration ?? 0) / 1000),
      url: v.video?.uuid
        ? `https://kick.com/${cleanChannel}/videos/${v.video.uuid}`
        : String(v.source ?? ''),
      streamUrl: String(v.source ?? ''),
      thumbnail: String(v.thumbnail?.src ?? ''),
      createdAt: String(v.created_at ?? v.start_time ?? ''),
      isLive: Boolean(v.is_live),
    }));
  }

  const targetListUrl = platform === 'twitch'
    ? `https://www.twitch.tv/${cleanChannel}/videos?filter=archives`
    : (channelOrUrl.startsWith('http')
        ? (channelOrUrl.includes('/streams') ? channelOrUrl : `${channelOrUrl.replace(/\/$/, '')}/streams`)
        : `https://www.youtube.com/@${cleanChannel}/streams`);

  const jsonStr = await runCommandCapture(YTDLP, [
    '--flat-playlist',
    '--playlist-items', '1-12',
    '--dump-single-json',
    '--',
    targetListUrl,
  ]);

  const parsed = JSON.parse(jsonStr) as { entries?: any[] };
  const entries = parsed.entries ?? [];

  return entries.map((e) => ({
    id: String(e.id ?? crypto.randomUUID()),
    platform,
    title: String(e.title ?? `${platform} stream`),
    durationSec: Math.round(Number(e.duration ?? 0)),
    url: String(
      e.webpage_url ??
      e.url ??
      (platform === 'twitch'
        ? `https://www.twitch.tv/videos/${String(e.id).replace(/^v/, '')}`
        : `https://www.youtube.com/watch?v=${e.id}`)
    ),
    streamUrl: '',
    thumbnail: String(e.thumbnail ?? e.thumbnails?.[0]?.url ?? ''),
    createdAt: formatYtdlpDate(e.upload_date),
    isLive: Boolean(e.is_live),
  }));
}

/**
 * Probes a local video file path or remote VOD/stream URL and returns playable UI metadata.
 */
export async function probeMediaSource(
  sourceInput: string,
  directStreamUrlHint?: string,
  titleHint?: string,
): Promise<ProbedMedia> {
  const trimmed = sourceInput.trim();
  if (!trimmed) throw new Error('Video path or URL is required');
  await assertSafeSourceOrStreamUrl(trimmed, directStreamUrlHint);

  // 1. Local video file path
  if (!/^https?:\/\//i.test(trimmed)) {
    const resolved = path.resolve(trimmed);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Local file not found: ${resolved}`);
    }
    const streamInfo = await probeClipStreamInfo(resolved);
    let durationSec = streamInfo.durationSec;
    if (durationSec <= 0) {
      try {
        durationSec = await probeDuration(resolved);
      } catch {
        durationSec = 0;
      }
    }

    return {
      sourceType: 'local',
      source: resolved,
      title: titleHint || path.basename(resolved),
      durationSec,
      width: streamInfo.width,
      height: streamInfo.height,
      playerMode: 'local',
      playerUrl: `/api/studio/stream?path=${encodeURIComponent(resolved)}`,
    };
  }

  // 2. Remote VOD / Stream URL
  const platform: ProbedMedia['platform'] = trimmed.includes('twitch.tv')
    ? 'twitch'
    : trimmed.includes('kick.com')
      ? 'kick'
      : (trimmed.includes('youtube.com') || trimmed.includes('youtu.be'))
        ? 'youtube'
        : 'other';

  // If Kick direct HLS stream URL was already provided (e.g. selected from Past Streams list)
  if (directStreamUrlHint && directStreamUrlHint.includes('.m3u8')) {
    let durationSec = 0;
    try {
      durationSec = await probeDuration(directStreamUrlHint);
    } catch {}
    return {
      sourceType: 'vod',
      source: trimmed,
      title: titleHint || 'Kick Past Stream',
      durationSec,
      platform: 'kick',
      playerMode: 'hls',
      playerUrl: `/api/studio/hls-proxy?url=${encodeURIComponent(directStreamUrlHint)}`,
      rawStreamUrl: directStreamUrlHint,
    };
  }

  // Kick web VOD URL resolution via Kick v2 API (yt-dlp often fails on UUID URLs)
  const kickMatch = trimmed.match(/kick\.com\/([^/]+)\/videos\/([a-f0-9-]+)/i);
  if (kickMatch) {
    const channel = kickMatch[1]!;
    const uuid = kickMatch[2]!;
    const streams = await listPastStreams('kick', channel);
    const found = streams.find(s => s.url.includes(uuid) || s.streamUrl.includes(uuid));
    if (found && found.streamUrl) {
      return {
        sourceType: 'vod',
        source: trimmed,
        title: titleHint || found.title,
        durationSec: found.durationSec,
        thumbnail: found.thumbnail,
        platform: 'kick',
        playerMode: 'hls',
        playerUrl: `/api/studio/hls-proxy?url=${encodeURIComponent(found.streamUrl)}`,
        rawStreamUrl: found.streamUrl,
      };
    }
  }

  // Direct .m3u8 / .mp4 URL pasted directly
  if (/\.m3u8(\?|$)/i.test(trimmed)) {
    let durationSec = 0;
    try { durationSec = await probeDuration(trimmed); } catch {}
    return {
      sourceType: 'vod',
      source: trimmed,
      title: titleHint || 'HLS Stream VOD',
      durationSec,
      platform,
      playerMode: 'hls',
      playerUrl: `/api/studio/hls-proxy?url=${encodeURIComponent(trimmed)}`,
      rawStreamUrl: trimmed,
    };
  }

  // Resolve metadata & best stream URL via yt-dlp
  const jsonStr = await runCommandCapture(YTDLP, [
    '--dump-single-json',
    '--no-playlist',
    '-f', 'best[height<=720][ext=mp4]/best[height<=720]/best',
    '--',
    trimmed,
  ]);
  const info = JSON.parse(jsonStr) as any;

  const rawUrl: string = info.url || '';
  const isHls = rawUrl.includes('.m3u8') || String(info.protocol ?? '').includes('m3u8');
  let embedUrl: string | undefined;

  if (platform === 'twitch' && info.id) {
    const vodId = String(info.id).replace(/^v/, '');
    embedUrl = `https://player.twitch.tv/?video=v${vodId}&parent=localhost&parent=127.0.0.1&autoplay=false`;
  } else if (platform === 'youtube' && info.id) {
    embedUrl = `https://www.youtube.com/embed/${info.id}`;
  }

  let playerMode: ProbedMedia['playerMode'] = 'embed';
  let playerUrl = embedUrl || rawUrl;

  if (rawUrl && isHls) {
    playerMode = 'hls';
    playerUrl = `/api/studio/hls-proxy?url=${encodeURIComponent(rawUrl)}`;
  } else if (rawUrl && /^https?:\/\//.test(rawUrl)) {
    playerMode = 'proxy-video';
    playerUrl = `/api/studio/media-proxy?url=${encodeURIComponent(rawUrl)}`;
  }

  return {
    sourceType: 'vod',
    source: trimmed,
    title: titleHint || String(info.title ?? 'Stream VOD'),
    durationSec: Number(info.duration ?? 0),
    thumbnail: String(info.thumbnail ?? ''),
    platform,
    playerMode,
    playerUrl,
    rawStreamUrl: rawUrl || undefined,
    embedUrl,
  };
}

/**
 * Starts an asynchronous VOD download into 05_streams/ so it can be scrubbed smoothly offline.
 */
export function startVodDownload(url: string, titleHint?: string): VodDownloadJob {
  assertSafeRemoteUrlSyntax(url.trim());
  const id = crypto.randomUUID();
  const cleanTitle = (titleHint || 'vod_stream').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(RECORDINGS_DIR, `${cleanTitle}_${stamp}.mp4`);

  const job: VodDownloadJob = {
    id,
    url,
    title: titleHint || url,
    status: 'DOWNLOADING',
    percent: 0,
    filePath: outPath,
    createdAt: new Date().toISOString(),
  };
  vodDownloads.set(id, job);

  const args = [
    '--output', outPath,
    '--format', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--newline',
    '--',
    url,
  ];

  const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let errLog = '';

  proc.on('error', (err) => {
    job.status = 'ERROR';
    job.error = err.message;
  });

  const parseProgress = (chunk: Buffer) => {
    const str = chunk.toString();
    const match = str.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      job.percent = Math.min(99, Number(match[1]));
    }
  };

  proc.stdout.on('data', parseProgress);
  proc.stderr.on('data', (d: Buffer) => {
    errLog += d.toString();
    parseProgress(d);
  });

  proc.on('close', (code) => {
    if (code === 0 && fs.existsSync(outPath)) {
      job.status = 'DONE';
      job.percent = 100;
    } else {
      job.status = 'ERROR';
      job.error = errLog.slice(-400) || `yt-dlp exited with code ${code}`;
    }
  });

  return job;
}

/**
 * Extracts a frame and runs OpenCV facecam detection at any timestamp for Studio UI inspection.
 */
export async function detectFacecamAtTimestamp(
  sourceOrStreamUrl: string,
  timestampSec = 0,
): Promise<{ detection: FacecamDetectionResult; frameBase64?: string }> {
  await assertSafeSourceOrStreamUrl(sourceOrStreamUrl);
  const { detection, frameBuffer } = await detectFacecamInMedia(
    sourceOrStreamUrl,
    Math.max(0, timestampSec),
    TEMP_DIR,
    true,
  );
  return {
    detection,
    frameBase64: frameBuffer ? `data:image/png;base64,${frameBuffer.toString('base64')}` : undefined,
  };
}

export interface ManualCutOptions {
  source: string;
  startSec: number;
  endSec: number;
  title?: string;
  layout?: ClipLayout;
  facecamPosition?: FacecamPosition;
  captionStyle?: CaptionStyle;
  watermarkText?: string;
  hookTitleText?: string;
  audioNormalize?: boolean;
  silenceCut?: boolean;
  musicTrack?: string;
  musicVolume?: number;
  audioDeltaDb?: number;
  sourcePlatform?: string;
  streamUrl?: string;
}

export interface CutClipResult {
  id: string;
  filePath: string;
  durationSec: number;
  width: number;
  height: number;
  fileSizeBytes: number;
  viralityScore: number;
  viralityReason: string;
  thumbnailPath: string;
  socialTitle: string;
  socialHashtags: string;
  aspectRatio: '16:9' | '4:5' | '1:1' | '9:16';
  audioNormalized: boolean;
}

export interface AutoClipTopMomentsOptions {
  source: string;
  streamUrl?: string;
  clipDurationSec?: number;
  maxClips?: number;
  titlePrefix?: string;
  layout?: ClipLayout;
  facecamPosition?: FacecamPosition;
  captionStyle?: CaptionStyle;
  watermarkText?: string;
  hookTitleText?: string;
  audioNormalize?: boolean;
  silenceCut?: boolean;
  musicTrack?: string;
  musicVolume?: number;
  sourcePlatform?: string;
}

export interface CompiledMontageResult {
  id: string;
  title: string;
  filePath: string;
  durationSec: number;
  width: number;
  height: number;
  fileSizeBytes: number;
  thumbnailPath: string;
  socialTitle: string;
  socialHashtags: string;
  aspectRatio: '16:9' | '4:5' | '1:1' | '9:16';
  clipCount: number;
}

function moveFileSync(src: string, dest: string): void {
  if (path.resolve(src) === path.resolve(dest)) return;
  try {
    fs.renameSync(src, dest);
  } catch (err: any) {
    if (err?.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

export function resolveMusicTrackPath(musicTrack?: string): string | null {
  const raw = musicTrack?.trim();
  if (!raw || raw === 'none') return null;

  const candidate = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(MUSIC_DIR, raw);

  const normMusicDir = process.platform === 'win32'
    ? path.resolve(MUSIC_DIR).toLowerCase()
    : path.resolve(MUSIC_DIR);
  const normCandidate = process.platform === 'win32'
    ? candidate.toLowerCase()
    : candidate;
  const rel = path.relative(normMusicDir, normCandidate);
  const insideMusicDir =
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel);

  if (!insideMusicDir || !isPathInsideMediaDirs(candidate)) {
    throw new Error('Invalid music track path: must reside inside ClipperMedia/06_music');
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  // Fallback by track name or title only for bare names (no path separators)
  if (!raw.includes('/') && !raw.includes('\\') && !path.isAbsolute(raw)) {
    const tracks = listMusicTracks();
    const found = tracks.find(
      (t) => t.name.toLowerCase() === raw.toLowerCase() || t.title.toLowerCase() === raw.toLowerCase()
    );
    if (found && isPathInsideMediaDirs(found.path) && fs.existsSync(found.path)) {
      return found.path;
    }
  }

  throw new Error(`Music track not found: ${path.basename(candidate)}`);
}

export async function probeClipStreamInfo(
  mediaPath: string,
): Promise<{ width: number; height: number; hasAudio: boolean; durationSec: number }> {
  return new Promise((resolve) => {
    const proc = spawn(
      FFPROBE,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', mediaPath],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    let settled = false;

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      if (!settled) {
        settled = true;
        resolve({ width: 0, height: 0, hasAudio: true, durationSec: 0 });
      }
    }, 30_000);

    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        resolve({ width: 0, height: 0, hasAudio: true, durationSec: 0 });
        return;
      }
      try {
        const parsed = JSON.parse(out) as {
          format?: { duration?: string };
          streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
        };
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const videoStream = streams.find((s) => s.codec_type === 'video');
        const hasAudio = streams.some((s) => s.codec_type === 'audio');
        const durationSec = Math.max(0, Number.parseFloat(parsed.format?.duration ?? '0') || 0);
        resolve({
          width: Number(videoStream?.width ?? 0) || 0,
          height: Number(videoStream?.height ?? 0) || 0,
          hasAudio,
          durationSec,
        });
      } catch {
        resolve({ width: 0, height: 0, hasAudio: true, durationSec: 0 });
      }
    });
    proc.on('error', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ width: 0, height: 0, hasAudio: true, durationSec: 0 });
    });
  });
}

function buildStudioFfmpegArgs(params: {
  inputMedia: string;
  effectiveStartSec: number;
  durationSec: number;
  outPath: string;
  layout: ClipLayout;
  facecamPosition: FacecamPosition;
  detectedCam: FacecamDetectionResult | null;
  assSubtitlePath: string | null;
  watermarkText: string;
  hookTitleText?: string;
  maxResolution: number;
  audioNormalize?: boolean;
  musicPath: string | null;
  musicVolume?: number;
  inputHasAudio: boolean;
}): string[] {
  const layoutFilterArgs = buildLayoutFilterArgs(
    params.layout,
    params.facecamPosition,
    params.detectedCam,
    {
      assSubtitlePath: params.assSubtitlePath,
      watermarkText: params.watermarkText,
      hookTitleText: params.hookTitleText,
      maxResolution: params.maxResolution,
    },
  );

  const audioFilter = buildAudioEnhanceFilter({
    normalize: Boolean(params.audioNormalize),
    hasMusic: Boolean(params.musicPath),
    musicVolume: params.musicVolume,
  });

  const inputArgs: string[] = [
    '-y',
    '-ss', params.effectiveStartSec.toFixed(2),
    '-i', params.inputMedia,
  ];
  if (params.musicPath) {
    inputArgs.push('-stream_loop', '-1', '-i', params.musicPath);
  }

  let combinedFilterArgs: string[];

  if (params.musicPath) {
    const audioGraph = params.inputHasAudio
      ? audioFilter.filterComplex!
      : `[1:a]volume=${audioFilter.musicVolume.toFixed(2)}[aout]`;
    const audioOutLabel = params.inputHasAudio ? (audioFilter.outputLabel ?? '[aout]') : '[aout]';

    const fcIdx = layoutFilterArgs.indexOf('-filter_complex');
    if (fcIdx !== -1 && layoutFilterArgs[fcIdx + 1]) {
      combinedFilterArgs = [...layoutFilterArgs];
      combinedFilterArgs[fcIdx + 1] = `${layoutFilterArgs[fcIdx + 1]};${audioGraph}`;
      const audioMapIdx = combinedFilterArgs.indexOf('0:a?');
      if (audioMapIdx !== -1) {
        combinedFilterArgs[audioMapIdx] = audioOutLabel;
      } else {
        combinedFilterArgs.push('-map', audioOutLabel);
      }
    } else {
      combinedFilterArgs = [
        '-filter_complex', audioGraph,
        '-map', '0:v',
        '-map', audioOutLabel,
      ];
    }
  } else {
    combinedFilterArgs = [...layoutFilterArgs];
    if (audioFilter.enabled && audioFilter.afFilter) {
      combinedFilterArgs.push('-af', audioFilter.afFilter);
    }
  }

  return [
    ...inputArgs,
    '-t', params.durationSec.toFixed(2),
    ...(params.musicPath ? ['-shortest'] : []),
    ...combinedFilterArgs,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-movflags', '+faststart',
    params.outPath,
  ];
}

function runFfmpeg(args: string[], errorLabel: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: 'pipe' });
    let errOut = '';
    proc.stderr.on('data', (d) => (errOut += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${errorLabel} (exit ${code}): ${errOut.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Scans a local video or remote HLS VOD for loud reaction peaks & hype spikes.
 */
export async function scanStudioAudioPeaks(
  source: string,
  streamUrl?: string,
  clipDurationSec = 25,
) {
  assertEntitlement('audio_peak', false);
  await assertSafeSourceOrStreamUrl(source, streamUrl);
  const mediaTarget = streamUrl && streamUrl.includes('.m3u8') ? streamUrl : source;
  return scanAudioPeaks(mediaTarget, { clipDurationSec, limit: 10 });
}

/**
 * Extracts a custom timestamp range [startSec, endSec] from either a local video
 * or a remote VOD / stream URL, renders with chosen layout & OpenCV facecam tracking,
 * burns optional kinetic captions/hook/watermark, mixes optional music, normalizes/trims audio,
 * extracts thumbnail + social metadata, scores virality, and records cleanly in SQLite.
 */
export async function cutManualClip(options: ManualCutOptions): Promise<CutClipResult> {
  const ent = assertEntitlement(undefined, true);
  if (options.captionStyle && options.captionStyle !== 'none') {
    assertEntitlement('auto_captions', false);
  }
  if (options.watermarkText && options.watermarkText.trim()) {
    assertEntitlement('custom_branding', false);
  }

  await assertSafeSourceOrStreamUrl(options.source, options.streamUrl);

  const layout: ClipLayout = options.layout ?? 'split';
  if (!VALID_CLIP_LAYOUTS.has(layout)) {
    throw new Error(`Unsupported clip layout: ${String(options.layout)}`);
  }

  const startSec = Math.max(0, Number(options.startSec) || 0);
  const endSec = Math.max(startSec + 1, Number(options.endSec) || startSec + 20);
  const durationSec = endSec - startSec;
  let facecamPosition: FacecamPosition = options.facecamPosition ?? 'auto';
  const resolvedMusicPath = resolveMusicTrackPath(options.musicTrack);

  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  const isRemote = /^https?:\/\//i.test(options.source);
  let inputMedia = options.source;
  let effectiveStartSec = startSec;
  let tempDownloadPath: string | null = null;
  let rawOutPath: string | null = null;

  if (!isRemote) {
    inputMedia = path.resolve(options.source);
    if (!fs.existsSync(inputMedia)) {
      throw new Error(`Source file not found: ${inputMedia}`);
    }
  } else if (options.streamUrl && options.streamUrl.includes('.m3u8')) {
    // Direct HLS VOD: FFmpeg can seek directly!
    inputMedia = options.streamUrl;
  } else {
    // Download just the target [startSec, endSec] slice using yt-dlp --download-sections
    tempDownloadPath = path.join(TEMP_DIR, `section_${crypto.randomUUID()}.mp4`);
    const padStart = Math.max(0, startSec - 1);
    const padEnd = endSec + 1;
    console.log(`[studio] Downloading section ${padStart}s-${padEnd}s via yt-dlp...`);

    await runCommandCapture(YTDLP, [
      '--download-sections', `*${padStart}-${padEnd}`,
      '--force-keyframes-at-cuts',
      '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', tempDownloadPath,
      '--',
      options.source,
    ]);

    if (!fs.existsSync(tempDownloadPath)) {
      throw new Error('Failed to download requested clip section from stream URL');
    }
    inputMedia = tempDownloadPath;
    effectiveStartSec = startSec - padStart;
  }

  let assSubtitlePath: string | null = null;
  let speechWords = 0;

  try {
    let detectedCam: FacecamDetectionResult | null = null;
    if ((layout === 'split' || layout === 'split-crop') && facecamPosition === 'auto') {
      const sampleTime = effectiveStartSec + durationSec / 2;
      const probeRes = await detectFacecamInMedia(inputMedia, sampleTime, TEMP_DIR);
      if (probeRes.detection.found) {
        detectedCam = probeRes.detection;
        facecamPosition = probeRes.detection.corner;
      } else {
        facecamPosition = 'top-left';
      }
    }

    const effectiveCaption: CaptionStyle =
      options.captionStyle && options.captionStyle !== 'none' && ent.plan.allow_auto_captions
        ? options.captionStyle
        : 'none';

    if (effectiveCaption !== 'none') {
      const audioSamplePath = path.join(TEMP_DIR, `cap_src_${crypto.randomUUID()}.mp4`);
      try {
        await new Promise<void>((resolve, reject) => {
          const p = spawn(FFMPEG, [
            '-y', '-ss', effectiveStartSec.toFixed(2), '-i', inputMedia,
            '-t', durationSec.toFixed(2), '-vn', '-c:a', 'aac', audioSamplePath,
          ], { stdio: 'ignore' });
          p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('audio slice failed'))));
          p.on('error', reject);
        });
        const capRes = await generateKineticAssForClip({
          sourceMediaPath: audioSamplePath,
          style: effectiveCaption,
          isVertical: layout !== 'landscape',
          fallbackHookText: options.title,
        });
        assSubtitlePath = capRes.assPath;
        speechWords = capRes.wordsCount;
      } catch {
        assSubtitlePath = null;
      } finally {
        try { if (fs.existsSync(audioSamplePath)) fs.unlinkSync(audioSamplePath); } catch {}
      }
    }

    const effectiveWatermark = options.watermarkText?.trim()
      ? options.watermarkText.trim()
      : (ent.plan.watermark_enabled ? getSetting('default_watermark_text', 'Clipper Studio') : '');

    const inputInfo = resolvedMusicPath
      ? await probeClipStreamInfo(inputMedia)
      : { width: 0, height: 0, hasAudio: true, durationSec };

    const baseName = (options.title || (isRemote ? 'vod_clip' : path.parse(options.source).name))
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50) || 'clip';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFilePath = path.join(
      CLIPS_DIR,
      `${baseName}_${stamp}_${crypto.randomUUID().slice(0, 6)}.mp4`,
    );

    const renderTargetPath = options.silenceCut === true
      ? (rawOutPath = path.join(TEMP_DIR, `raw_${crypto.randomUUID()}.mp4`))
      : outFilePath;

    const ffmpegArgs = buildStudioFfmpegArgs({
      inputMedia,
      effectiveStartSec,
      durationSec,
      outPath: renderTargetPath,
      layout,
      facecamPosition,
      detectedCam,
      assSubtitlePath,
      watermarkText: effectiveWatermark,
      hookTitleText: options.hookTitleText,
      maxResolution: ent.plan.max_resolution,
      audioNormalize: options.audioNormalize,
      musicPath: resolvedMusicPath,
      musicVolume: options.musicVolume,
      inputHasAudio: inputInfo.hasAudio,
    });

    console.log(
      `[studio] Rendering manual clip (${durationSec.toFixed(1)}s, layout: ${layout}, ` +
      `facecam: ${facecamPosition}, captions: ${effectiveCaption}) -> ${outFilePath}`
    );

    await runFfmpeg(ffmpegArgs, 'FFmpeg render failed');
    if (!fs.existsSync(renderTargetPath)) {
      throw new Error('FFmpeg finished without producing output file');
    }

    let finalDurationSec = durationSec;
    if (options.silenceCut === true) {
      const trimmed = await trimSilenceFromClip(renderTargetPath, outFilePath);
      if (!trimmed) {
        moveFileSync(renderTargetPath, outFilePath);
      } else {
        try {
          const probedDur = await probeDuration(outFilePath);
          if (Number.isFinite(probedDur) && probedDur > 0) {
            finalDurationSec = Number(probedDur.toFixed(2));
          }
        } catch {}
      }
    }

    const stat = fs.statSync(outFilePath);
    const outStreamInfo = await probeClipStreamInfo(outFilePath);
    const clipId = crypto.randomUUID();
    const jobId = `studio_${baseName}`;
    const displayTitle = options.title?.trim() || `${baseName} (${formatSec(startSec)}–${formatSec(endSec)})`;
    const virality = calculateViralityScore({
      audioDeltaDb: options.audioDeltaDb,
      durationSec: finalDurationSec,
      hasFacecam: Boolean(detectedCam?.found || layout === 'split' || layout === 'split-crop'),
      hasCaptions: Boolean(assSubtitlePath),
      hasSpeechWords: speechWords,
    });

    let thumbnailPath = '';
    try {
      const thumbRes = await extractClipThumbnail(outFilePath, clipId);
      thumbnailPath = thumbRes.thumbPath;
    } catch (err) {
      console.warn('[studio] Thumbnail extraction warning:', err);
    }

    const sourcePlatform = options.sourcePlatform ?? (isRemote ? 'vod' : 'local');
    const description = `After-live manual clip [${formatSec(startSec)} → ${formatSec(endSec)}] (${layout})`;
    let socialTitle = '';
    let socialHashtags = '';
    try {
      const socialMeta = await generateSocialMetadata({
        title: displayTitle,
        description,
        platform: sourcePlatform,
        viralityScore: virality.score,
      });
      socialTitle = socialMeta.socialTitle;
      socialHashtags = socialMeta.hashtags.join(' ');
    } catch (err) {
      console.warn('[studio] Social metadata generation warning:', err);
    }

    const aspectRatio = getAspectRatioForLayout(layout);
    const audioNormalized = Boolean(options.audioNormalize);

    insertClip({
      id: clipId,
      jobId,
      title: displayTitle,
      description,
      startSec,
      endSec,
      durationSec: finalDurationSec,
      filePath: outFilePath,
      fileSizeBytes: stat.size,
      viralityScore: virality.score,
      viralityReason: virality.reason,
      captionsStyle: effectiveCaption,
      layout,
      sourcePlatform,
      thumbnailPath,
      socialTitle,
      socialHashtags,
      aspectRatio,
      audioNormalized,
    });

    // Notify desktop/Discord/Telegram asynchronously
    void notifyStudioClip(displayTitle, outFilePath, stat.size);

    return {
      id: clipId,
      filePath: outFilePath,
      durationSec: finalDurationSec,
      width: outStreamInfo.width,
      height: outStreamInfo.height,
      fileSizeBytes: stat.size,
      viralityScore: virality.score,
      viralityReason: virality.reason,
      thumbnailPath,
      socialTitle,
      socialHashtags,
      aspectRatio,
      audioNormalized,
    };
  } finally {
    if (tempDownloadPath && fs.existsSync(tempDownloadPath)) {
      try { fs.unlinkSync(tempDownloadPath); } catch {}
    }
    if (rawOutPath && fs.existsSync(rawOutPath)) {
      try { fs.unlinkSync(rawOutPath); } catch {}
    }
    if (assSubtitlePath && fs.existsSync(assSubtitlePath)) {
      try { fs.unlinkSync(assSubtitlePath); } catch {}
    }
  }
}

/**
 * PRO/ULTRA batch auto-clipper: scans audio hype peaks and extracts up to 5 top moments sequentially.
 */
export async function autoClipTopMoments(options: AutoClipTopMomentsOptions): Promise<{
  clips: CutClipResult[];
  avgDb: number;
  scannedDurationSec: number;
  totalPeaksFound: number;
}> {
  if (!options.source?.trim()) {
    throw new Error('source file path or URL is required');
  }

  assertEntitlement('audio_peak', true);
  if (options.captionStyle && options.captionStyle !== 'none') {
    assertEntitlement('auto_captions', false);
  }
  if (options.watermarkText && options.watermarkText.trim()) {
    assertEntitlement('custom_branding', false);
  }

  await assertSafeSourceOrStreamUrl(options.source, options.streamUrl);

  const rawMax = Number(options.maxClips ?? 3);
  const maxClips = Math.min(5, Math.max(1, Number.isFinite(rawMax) ? Math.trunc(rawMax) : 3));
  const clipDurationSec = options.clipDurationSec ?? 25;

  const scan = await scanStudioAudioPeaks(options.source, options.streamUrl, clipDurationSec);
  if (scan.peaks.length === 0) {
    return {
      clips: [],
      avgDb: scan.avgDb,
      scannedDurationSec: scan.scannedDurationSec,
      totalPeaksFound: 0,
    };
  }

  const topPeaks = [...scan.peaks]
    .sort((a, b) => (b.viralityScore - a.viralityScore) || (b.deltaDb - a.deltaDb))
    .slice(0, maxClips);

  const isRemote = /^https?:\/\//i.test(options.source.trim());
  const baseTitle = options.titlePrefix?.trim() || (
    isRemote ? 'Auto Highlight' : path.parse(options.source.trim()).name
  );

  const clips: CutClipResult[] = [];
  for (let i = 0; i < topPeaks.length; i++) {
    const peak = topPeaks[i]!;
    try {
      const cut = await cutManualClip({
        source: options.source,
        streamUrl: options.streamUrl,
        startSec: peak.startSec,
        endSec: peak.endSec,
        title: `${baseTitle} #${i + 1}`,
        layout: options.layout ?? 'split',
        facecamPosition: options.facecamPosition ?? 'auto',
        captionStyle: options.captionStyle ?? 'none',
        watermarkText: options.watermarkText,
        hookTitleText: options.hookTitleText,
        audioNormalize: options.audioNormalize,
        silenceCut: options.silenceCut,
        musicTrack: options.musicTrack,
        musicVolume: options.musicVolume,
        audioDeltaDb: peak.deltaDb,
        sourcePlatform: options.sourcePlatform,
      });
      clips.push(cut);
    } catch (err) {
      if (err instanceof EntitlementError && clips.length > 0) {
        break;
      }
      throw err;
    }
  }

  return {
    clips,
    avgDb: scan.avgDb,
    scannedDurationSec: scan.scannedDurationSec,
    totalPeaksFound: scan.peaks.length,
  };
}

/**
 * Compiles >= 2 existing clips into a single normalized montage MP4 reel using FFmpeg `concat`,
 * extracts a thumbnail, generates social metadata, and persists the compiled clip in SQLite.
 */
export async function compileMontageReel(
  clipIds: string[],
  title?: string,
  musicTrack?: string,
  musicVolume?: number,
  audioNormalize?: boolean,
): Promise<CompiledMontageResult> {
  const ent = assertEntitlement(undefined, true);

  const cleanIds = Array.isArray(clipIds)
    ? clipIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean)
    : [];
  if (cleanIds.length < 2) {
    throw new Error('At least 2 clip IDs are required to compile a montage reel');
  }
  if (cleanIds.length > 20) {
    throw new Error('Maximum 20 clips can be compiled into a single montage reel');
  }

  const stmt = db.prepare('SELECT id, title, file_path, layout, aspect_ratio FROM clips WHERE id=?');
  const clipRows: Array<{
    id: string;
    title: string;
    file_path: string;
    layout: string;
    aspect_ratio: string;
  }> = [];

  for (const id of cleanIds) {
    const row = stmt.get(id) as
      | { id: string; title: string; file_path: string; layout: string; aspect_ratio: string }
      | undefined;
    if (!row || !row.file_path || !fs.existsSync(row.file_path)) {
      throw new Error(`Clip not found on disk: ${id}`);
    }
    clipRows.push(row);
  }

  if (clipRows.length < 2) {
    throw new Error('At least 2 existing clips on disk are required to compile a montage reel');
  }

  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

  const resolvedMusicPath = resolveMusicTrackPath(musicTrack);

  const probed = await Promise.all(clipRows.map((c) => probeClipStreamInfo(c.file_path)));
  const firstInfo = probed[0]!;
  let targetW = firstInfo.width >= 2 ? Math.floor(firstInfo.width / 2) * 2 : 1080;
  let targetH = firstInfo.height >= 2 ? Math.floor(firstInfo.height / 2) * 2 : 1920;

  if (ent.plan.max_resolution <= 720 && Math.min(targetW, targetH) > 720) {
    const scale = 720 / Math.min(targetW, targetH);
    targetW = Math.max(2, Math.floor((targetW * scale) / 2) * 2);
    targetH = Math.max(2, Math.floor((targetH * scale) / 2) * 2);
  }

  const inputArgs: string[] = ['-y'];
  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < clipRows.length; i++) {
    inputArgs.push('-i', clipRows[i]!.file_path);
    const info = probed[i]!;
    filterParts.push(
      `[${i}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`
    );
    if (info.hasAudio) {
      filterParts.push(
        `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`
      );
    } else {
      const segDur = Math.max(0.1, info.durationSec || 1);
      filterParts.push(`anullsrc=r=44100:cl=stereo:d=${segDur.toFixed(3)}[a${i}]`);
    }
    concatInputs.push(`[v${i}][a${i}]`);
  }

  filterParts.push(`${concatInputs.join('')}concat=n=${clipRows.length}:v=1:a=1[outv][outa]`);

  const musicIdx = clipRows.length;
  if (resolvedMusicPath) {
    inputArgs.push('-stream_loop', '-1', '-i', resolvedMusicPath);
  }
  const audioFilter = buildAudioEnhanceFilter({
    normalize: Boolean(audioNormalize),
    hasMusic: Boolean(resolvedMusicPath),
    musicVolume,
    voiceInputLabel: 'outa',
    musicInputLabel: `${musicIdx}:a`,
    outputLabel: 'mixa',
  });
  let audioMap = '[outa]';
  if (audioFilter.enabled && audioFilter.filterComplex) {
    filterParts.push(audioFilter.filterComplex);
    audioMap = audioFilter.outputLabel ?? '[mixa]';
  }

  const displayTitle = title?.trim() || `Highlight Montage (${clipRows.length} Clips)`;
  const safeBase = displayTitle.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) || 'montage_reel';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFilePath = path.join(
    CLIPS_DIR,
    `${safeBase}_${stamp}_${crypto.randomUUID().slice(0, 6)}.mp4`,
  );

  const ffmpegArgs = [
    ...inputArgs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]',
    '-map', audioMap,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-movflags', '+faststart',
    outFilePath,
  ];

  await runFfmpeg(ffmpegArgs, 'FFmpeg montage concat failed');
  if (!fs.existsSync(outFilePath)) {
    throw new Error('FFmpeg failed to produce montage reel output');
  }

  const stat = fs.statSync(outFilePath);
  const outInfo = await probeClipStreamInfo(outFilePath);
  const fallbackDur = probed.reduce((sum, p) => sum + (p.durationSec || 0), 0);
  let durationSec = outInfo.durationSec > 0 ? Number(outInfo.durationSec.toFixed(2)) : fallbackDur;
  try {
    if (durationSec <= 0) {
      const probedDur = await probeDuration(outFilePath);
      if (Number.isFinite(probedDur) && probedDur > 0) {
        durationSec = Number(probedDur.toFixed(2));
      }
    }
  } catch {}

  const clipId = crypto.randomUUID();
  let thumbnailPath = '';
  try {
    const thumbRes = await extractClipThumbnail(outFilePath, clipId);
    thumbnailPath = thumbRes.thumbPath;
  } catch (err) {
    console.warn('[studio] Montage thumbnail extraction warning:', err);
  }

  const description = `Compiled montage reel from ${clipRows.length} clips`;
  let socialTitle = '';
  let socialHashtags = '';
  try {
    const socialMeta = await generateSocialMetadata({
      title: displayTitle,
      description,
      platform: 'montage',
      viralityScore: 80,
    });
    socialTitle = socialMeta.socialTitle;
    socialHashtags = socialMeta.hashtags.join(' ');
  } catch (err) {
    console.warn('[studio] Montage social metadata warning:', err);
  }

  const firstLayoutRaw = clipRows[0]!.layout as ClipLayout;
  const layout: ClipLayout = VALID_CLIP_LAYOUTS.has(firstLayoutRaw)
    ? firstLayoutRaw
    : (targetW > targetH ? 'landscape' : 'split');
  const aspectRatio: CompiledMontageResult['aspectRatio'] =
    targetW > targetH
      ? '16:9'
      : targetW === targetH
        ? '1:1'
        : Math.abs(targetW / targetH - 0.8) < 0.05
          ? '4:5'
          : '9:16';

  insertClip({
    id: clipId,
    jobId: `montage_${clipId.slice(0, 8)}`,
    title: displayTitle,
    description,
    startSec: 0,
    endSec: durationSec,
    durationSec,
    filePath: outFilePath,
    fileSizeBytes: stat.size,
    viralityScore: 80,
    viralityReason: `Montage Reel (${clipRows.length} top clips)`,
    captionsStyle: 'none',
    layout,
    sourcePlatform: 'montage',
    thumbnailPath,
    socialTitle,
    socialHashtags,
    aspectRatio,
    audioNormalized: Boolean(audioNormalize),
  });

  void notifyStudioClip(displayTitle, outFilePath, stat.size);

  return {
    id: clipId,
    title: displayTitle,
    filePath: outFilePath,
    durationSec,
    width: outInfo.width || targetW,
    height: outInfo.height || targetH,
    fileSizeBytes: stat.size,
    thumbnailPath,
    socialTitle,
    socialHashtags,
    aspectRatio,
    clipCount: clipRows.length,
  };
}

async function notifyStudioClip(title: string, filePath: string, bytes: number): Promise<void> {
  try {
    const url = process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:4003';
    await fetch(`${url}/api/notifications/clip-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clipTitle: `✂ ${title}`,
        filePath,
        fileSizeMb: (bytes / 1e6).toFixed(1),
      }),
    });
  } catch {}
}

function runCommandCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${bin} exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

function formatYtdlpDate(yyyymmdd?: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return '';
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function formatSec(sec: number): string {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export interface ReexportClipOptions {
  trimStartSec?: number;
  trimEndSec?: number;
  speed?: number;
  flipHorizontal?: boolean;
  silenceCut?: boolean;
  audioNormalize?: boolean;
  musicTrack?: string;
  musicVolume?: number;
  hookTitleText?: string;
  watermarkText?: string;
  captionStyle?: CaptionStyle;
  title?: string;
}

export interface ReexportClipResult {
  clip: Record<string, unknown>;
  width: number;
  height: number;
  durationSec: number;
  fileSizeBytes: number;
}

function escapeFilterPathLocal(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\\\'");
}

function buildReexportDrawtextFilter(
  rawText: string,
  sysFont: string | null,
  styleExpr: string,
): string | null {
  const safeTxt = escapeDrawtextText(rawText);
  if (!safeTxt) return null;
  if (!sysFont && process.platform === 'win32') return null;
  const fontOpt = sysFont ? `fontfile='${escapeFilterPathLocal(sysFont)}':` : '';
  return `drawtext=${fontOpt}expansion=none:text=${safeTxt}:${styleExpr}`;
}

function buildAtempoFilters(speed: number): string[] {
  if (Math.abs(speed - 1) < 0.001) return [];
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2.0) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters;
}

/**
 * Re-exports an existing rendered clip into a new MP4 in `CLIPS_DIR` (never overwriting
 * the original file) with optional trim, speed, horizontal flip, silence cut, audio
 * normalization, looped background music, kinetic captions, hook banner, and watermark.
 */
export async function reexportClip(
  clipId: string,
  options: ReexportClipOptions = {},
): Promise<ReexportClipResult> {
  const cleanId = typeof clipId === 'string' ? clipId.trim() : '';
  if (!cleanId) {
    throw new ClipNotFoundError('Clip not found');
  }

  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(cleanId) as
    | {
        id: string;
        job_id: string;
        title: string;
        description: string;
        start_sec: number;
        end_sec: number;
        duration_sec: number;
        file_path: string;
        virality_score: number;
        virality_reason: string;
        captions_style: string;
        layout: string;
        source_platform: string;
        social_title: string;
        social_hashtags: string;
        aspect_ratio: string;
        tags: string;
        notes: string;
      }
    | undefined;

  if (!clip) {
    throw new ClipNotFoundError(`Clip not found: ${cleanId}`);
  }
  if (!clip.file_path) {
    throw new ClipNotFoundError('Clip video file path is missing');
  }

  const resolvedSource = path.resolve(clip.file_path);
  if (!isPathInsideMediaDirs(resolvedSource)) {
    throw new Error('Invalid clip file path: outside allowed media directories');
  }
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isFile()) {
    throw new ClipNotFoundError(`Clip video file not found on disk: ${resolvedSource}`);
  }

  const ent = assertEntitlement(undefined, true);

  const captionStyle: CaptionStyle = options.captionStyle ?? 'none';
  if (typeof captionStyle !== 'string' || !VALID_CAPTION_STYLES.has(captionStyle)) {
    throw new Error(`Invalid captionStyle: ${String(options.captionStyle)}`);
  }
  if (captionStyle !== 'none') {
    assertEntitlement('auto_captions', false);
  }

  if (options.hookTitleText !== undefined && typeof options.hookTitleText !== 'string') {
    throw new Error('hookTitleText must be a string');
  }
  const cleanHook = (options.hookTitleText ?? '').trim();
  if (cleanHook.length > 80) {
    throw new Error('hookTitleText must be 80 characters or fewer');
  }

  if (options.watermarkText !== undefined && typeof options.watermarkText !== 'string') {
    throw new Error('watermarkText must be a string');
  }
  const cleanCustomWatermark = (options.watermarkText ?? '').trim();
  if (cleanCustomWatermark.length > 60) {
    throw new Error('watermarkText must be 60 characters or fewer');
  }
  if (cleanCustomWatermark) {
    assertEntitlement('custom_branding', false);
  }
  const effectiveWatermark = cleanCustomWatermark
    ? cleanCustomWatermark
    : (ent.plan.watermark_enabled ? getSetting('default_watermark_text', 'Clipper Studio') : '');

  const speed = options.speed !== undefined ? Number(options.speed) : 1;
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
    throw new Error('speed must be a finite number between 0.5 and 2.0');
  }

  const musicVolume = options.musicVolume !== undefined ? Number(options.musicVolume) : 0.15;
  if (!Number.isFinite(musicVolume) || musicVolume < 0 || musicVolume > 1) {
    throw new Error('musicVolume must be a finite number between 0 and 1');
  }

  if (options.musicTrack !== undefined && typeof options.musicTrack !== 'string') {
    throw new Error('musicTrack must be a string');
  }
  const resolvedMusicPath = resolveMusicTrackPath(options.musicTrack);

  const inputInfo = await probeClipStreamInfo(resolvedSource);
  let sourceDuration = inputInfo.durationSec;
  if (sourceDuration <= 0) {
    try {
      sourceDuration = await probeDuration(resolvedSource);
    } catch {}
  }
  if (sourceDuration <= 0 && Number(clip.duration_sec) > 0) {
    sourceDuration = Number(clip.duration_sec);
  }

  const trimStartSec = options.trimStartSec !== undefined ? Number(options.trimStartSec) : 0;
  if (!Number.isFinite(trimStartSec) || trimStartSec < 0) {
    throw new Error('trimStartSec must be a finite number >= 0');
  }
  if (sourceDuration > 0 && trimStartSec >= sourceDuration) {
    throw new Error('trimStartSec must be less than clip duration');
  }

  let trimEndSec: number | undefined;
  if (options.trimEndSec !== undefined) {
    const rawTrimEnd = Number(options.trimEndSec);
    if (!Number.isFinite(rawTrimEnd) || rawTrimEnd <= trimStartSec) {
      throw new Error('trimEndSec must be a finite number greater than trimStartSec');
    }
    trimEndSec = sourceDuration > 0 ? Math.min(rawTrimEnd, sourceDuration) : rawTrimEnd;
    if (trimEndSec <= trimStartSec) {
      throw new Error('trimEndSec must be greater than trimStartSec');
    }
  } else if (sourceDuration > 0) {
    trimEndSec = sourceDuration;
  }

  const sliceDurationSec = trimEndSec !== undefined ? Math.max(0.1, trimEndSec - trimStartSec) : 0;

  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  let assSubtitlePath: string | null = null;
  let rawTempPath: string | null = null;

  try {
    const effectiveCaption: CaptionStyle =
      captionStyle !== 'none' && ent.plan.allow_auto_captions ? captionStyle : 'none';

    if (effectiveCaption !== 'none' && inputInfo.hasAudio) {
      const audioSamplePath = path.join(TEMP_DIR, `reexport_cap_${crypto.randomUUID()}.mp4`);
      try {
        const atempoForCap = buildAtempoFilters(speed);
        const capArgs = [
          '-y',
          ...(trimStartSec > 0 ? ['-ss', trimStartSec.toFixed(3)] : []),
          ...(trimEndSec !== undefined && (trimStartSec > 0 || options.trimEndSec !== undefined)
            ? ['-t', sliceDurationSec.toFixed(3)]
            : []),
          '-i', resolvedSource,
          '-vn',
          ...(atempoForCap.length > 0 ? ['-af', atempoForCap.join(',')] : []),
          '-c:a', 'aac',
          audioSamplePath,
        ];
        await runFfmpeg(capArgs, 'Re-export caption audio slice failed');
        const capRes = await generateKineticAssForClip({
          sourceMediaPath: audioSamplePath,
          style: effectiveCaption,
          isVertical: inputInfo.height >= inputInfo.width,
          fallbackHookText: cleanHook || clip.title,
        });
        assSubtitlePath = capRes.assPath;
      } catch {
        assSubtitlePath = null;
      } finally {
        try { if (fs.existsSync(audioSamplePath)) fs.unlinkSync(audioSamplePath); } catch {}
      }
    }

    const vFilters: string[] = [];
    if (options.flipHorizontal) {
      vFilters.push('hflip');
    }
    if (Math.abs(speed - 1) >= 0.001) {
      vFilters.push(`setpts=PTS/${speed.toFixed(4)}`);
    }

    const is720 = ent.plan.max_resolution <= 720;
    if (is720 && inputInfo.width > 0 && inputInfo.height > 0 && Math.min(inputInfo.width, inputInfo.height) > 720) {
      const scaleFactor = 720 / Math.min(inputInfo.width, inputInfo.height);
      const scaledW = Math.max(2, Math.floor((inputInfo.width * scaleFactor) / 2) * 2);
      const scaledH = Math.max(2, Math.floor((inputInfo.height * scaleFactor) / 2) * 2);
      vFilters.push(`scale=${scaledW}:${scaledH}`);
    }

    if (assSubtitlePath && fs.existsSync(assSubtitlePath)) {
      vFilters.push(`ass='${escapeFilterPathLocal(assSubtitlePath)}'`);
    }

    const sysFont = resolveSystemFontFile();
    if (cleanHook) {
      const baseFontSize = cleanHook.length > 36 ? 34 : 44;
      const hookFontSize = is720 ? Math.round(baseFontSize * 0.75) : baseFontSize;
      const hookFilter = buildReexportDrawtextFilter(
        cleanHook,
        sysFont,
        `fontsize=${hookFontSize}:fontcolor=white:x=(w-text_w)/2:y=h*0.07:box=1:boxcolor=black@0.72:boxborderw=18:enable='between(t,0,3.5)'`,
      );
      if (hookFilter) vFilters.push(hookFilter);
    }

    if (effectiveWatermark) {
      const wmFontSize = is720 ? 20 : 26;
      const wmFilter = buildReexportDrawtextFilter(
        effectiveWatermark,
        sysFont,
        `fontsize=${wmFontSize}:fontcolor=white@0.72:x=(w-text_w)-28:y=28:box=1:boxcolor=black@0.48:boxborderw=8`,
      );
      if (wmFilter) vFilters.push(wmFilter);
    }

    const atempoFilters = buildAtempoFilters(speed);
    const audioFilter = buildAudioEnhanceFilter({
      normalize: Boolean(options.audioNormalize),
      hasMusic: Boolean(resolvedMusicPath),
      musicVolume,
      voiceInputLabel: atempoFilters.length > 0 ? 'avoice' : '0:a',
      musicInputLabel: '1:a',
      outputLabel: 'aout',
    });

    const filterParts: string[] = [];
    let vMap = '0:v';
    if (vFilters.length > 0) {
      filterParts.push(`[0:v]${vFilters.join(',')}[outv]`);
      vMap = '[outv]';
    }

    let aMap: string | null = null;
    if (resolvedMusicPath) {
      if (inputInfo.hasAudio) {
        if (atempoFilters.length > 0) {
          filterParts.push(`[0:a]${atempoFilters.join(',')}[avoice]`);
        }
        if (audioFilter.filterComplex) {
          filterParts.push(audioFilter.filterComplex);
        }
        aMap = audioFilter.outputLabel ?? '[aout]';
      } else {
        filterParts.push(`[1:a]volume=${audioFilter.musicVolume.toFixed(2)}[aout]`);
        aMap = '[aout]';
      }
    } else if (inputInfo.hasAudio) {
      const voiceOps = [...atempoFilters, ...(audioFilter.voiceChain ? [audioFilter.voiceChain] : [])];
      if (voiceOps.length > 0) {
        filterParts.push(`[0:a]${voiceOps.join(',')}[aout]`);
        aMap = '[aout]';
      } else {
        aMap = '0:a?';
      }
    }

    const baseTitle = (options.title?.trim() || clip.title || 'clip')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 45) || 'clip';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFilePath = path.join(
      CLIPS_DIR,
      `${baseTitle}_reexport_${stamp}_${crypto.randomUUID().slice(0, 6)}.mp4`,
    );

    const renderTargetPath = options.silenceCut === true
      ? (rawTempPath = path.join(TEMP_DIR, `reexport_${crypto.randomUUID()}.mp4`))
      : outFilePath;

    const inputArgs: string[] = ['-y'];
    if (trimStartSec > 0) {
      inputArgs.push('-ss', trimStartSec.toFixed(3));
    }
    if (trimEndSec !== undefined && (trimStartSec > 0 || options.trimEndSec !== undefined)) {
      inputArgs.push('-t', sliceDurationSec.toFixed(3));
    }
    inputArgs.push('-i', resolvedSource);
    if (resolvedMusicPath) {
      inputArgs.push('-stream_loop', '-1', '-i', resolvedMusicPath);
    }

    const ffmpegArgs = [
      ...inputArgs,
      ...(resolvedMusicPath ? ['-shortest'] : []),
      ...(filterParts.length > 0 ? ['-filter_complex', filterParts.join(';')] : []),
      '-map', vMap,
      ...(aMap ? ['-map', aMap] : []),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      ...(aMap ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'] : []),
      '-movflags', '+faststart',
      renderTargetPath,
    ];

    await runFfmpeg(ffmpegArgs, 'FFmpeg re-export failed');
    if (!fs.existsSync(renderTargetPath)) {
      throw new Error('FFmpeg re-export finished without producing output file');
    }

    if (options.silenceCut === true) {
      const trimmed = await trimSilenceFromClip(renderTargetPath, outFilePath);
      if (!trimmed) {
        moveFileSync(renderTargetPath, outFilePath);
      }
    }

    const stat = fs.statSync(outFilePath);
    const outInfo = await probeClipStreamInfo(outFilePath);
    let finalDurationSec = outInfo.durationSec > 0
      ? Number(outInfo.durationSec.toFixed(2))
      : Number(((sliceDurationSec || sourceDuration || 0) / speed).toFixed(2));
    if (finalDurationSec <= 0) {
      try {
        const probedDur = await probeDuration(outFilePath);
        if (Number.isFinite(probedDur) && probedDur > 0) {
          finalDurationSec = Number(probedDur.toFixed(2));
        }
      } catch {}
    }

    const newClipId = crypto.randomUUID();
    let thumbnailPath = '';
    try {
      const thumbRes = await extractClipThumbnail(outFilePath, newClipId);
      thumbnailPath = thumbRes.thumbPath;
    } catch (err) {
      console.warn('[studio] Re-export thumbnail extraction warning:', err);
    }

    const existingTags = (clip.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const nextTags = Array.from(new Set([...existingTags, 'reexport']));

    const displayTitle = options.title?.trim()
      ? options.title.trim().slice(0, 120)
      : `${clip.title} (Re-export)`.slice(0, 120);

    insertClip({
      id: newClipId,
      jobId: clip.job_id || `reexport_${clip.id.slice(0, 8)}`,
      title: displayTitle,
      description: clip.description
        ? `${clip.description} [Re-exported from ${clip.id}]`
        : `Re-exported from clip ${clip.id}`,
      startSec: 0,
      endSec: finalDurationSec,
      durationSec: finalDurationSec,
      filePath: outFilePath,
      fileSizeBytes: stat.size,
      viralityScore: Number(clip.virality_score ?? 0),
      viralityReason: clip.virality_reason || 'Re-exported Clip',
      captionsStyle: effectiveCaption,
      layout: clip.layout || 'split',
      sourcePlatform: clip.source_platform || 'local',
      thumbnailPath,
      socialTitle: clip.social_title ?? '',
      socialHashtags: clip.social_hashtags ?? '',
      aspectRatio: clip.aspect_ratio || '9:16',
      audioNormalized: Boolean(options.audioNormalize),
      tags: nextTags,
      notes: clip.notes ?? '',
    });

    const insertedClip = db.prepare('SELECT * FROM clips WHERE id = ?').get(newClipId) as Record<string, unknown>;
    void notifyStudioClip(displayTitle, outFilePath, stat.size);

    return {
      clip: insertedClip,
      width: outInfo.width,
      height: outInfo.height,
      durationSec: finalDurationSec,
      fileSizeBytes: stat.size,
    };
  } finally {
    if (rawTempPath && fs.existsSync(rawTempPath)) {
      try { fs.unlinkSync(rawTempPath); } catch {}
    }
    if (assSubtitlePath && fs.existsSync(assSubtitlePath)) {
      try { fs.unlinkSync(assSubtitlePath); } catch {}
    }
  }
}

const CSV_FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;

/**
 * Escapes a single CSV cell according to RFC-4180 while mitigating spreadsheet
 * formula injection (OWASP CSV Injection) on `=`, `+`, `-`, `@`, `\t`, and `\r`.
 */
export function escapeCsvCell(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value);
  if (CSV_FORMULA_TRIGGER_RE.test(str) || CSV_FORMULA_TRIGGER_RE.test(str.trimStart())) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Verifies genuine audio container/frame magic bytes for `.mp3`, `.wav`, `.ogg`,
 * `.m4a`, and `.aac` buffers before saving uploaded music tracks to disk.
 */
export function detectAudioMagicBytes(buffer: Buffer, ext: string): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const normalizedExt = ext.trim().toLowerCase().startsWith('.')
    ? ext.trim().toLowerCase()
    : `.${ext.trim().toLowerCase()}`;

  if (normalizedExt === '.mp3') {
    const hasId3 = buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33;
    const hasMpegSync = buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0;
    return hasId3 || hasMpegSync;
  }

  if (normalizedExt === '.wav') {
    if (buffer.length < 12) return false;
    return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE';
  }

  if (normalizedExt === '.ogg') {
    return buffer.toString('ascii', 0, 4) === 'OggS';
  }

  if (normalizedExt === '.m4a') {
    return buffer.length >= 8 && buffer.toString('ascii', 4, 8) === 'ftyp';
  }

  if (normalizedExt === '.aac') {
    const hasFtyp = buffer.length >= 8 && buffer.toString('ascii', 4, 8) === 'ftyp';
    const hasAdtsSync = buffer[0] === 0xff && (buffer[1]! & 0xf6) === 0xf0;
    return hasFtyp || hasAdtsSync;
  }

  return false;
}
