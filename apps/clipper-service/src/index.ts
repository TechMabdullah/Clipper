import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import cron from 'node-cron';
import chokidar from 'chokidar';
import {
  db,
  getSetting,
  clipExists,
  updateClipSocialMetadata,
  updateClipThumbnail,
  createApiKey,
  validateApiKey,
  listApiKeys,
  revokeApiKey,
  updateClipTags,
  updateClipNotes,
  toggleClipFavourite,
  logAuditEvent,
  listAuditLogs,
  listScheduledJobs,
  getScheduledJobById,
  createScheduledJob,
  toggleScheduledJob,
  deleteScheduledJob,
  updateScheduledJobLastRun,
  listPresets,
  getPresetById,
  createPreset,
  deletePreset,
  createOutboundWebhook,
  listOutboundWebhooks,
  getOutboundWebhookDispatchTarget,
  toggleOutboundWebhook,
  deleteOutboundWebhook,
  listCollections,
  createCollection,
  getCollectionById,
  updateCollection,
  deleteCollection,
  addClipToCollection,
  removeClipFromCollection,
  listCollectionClipDetails,
  getClipCollections,
  rateClip,
  getClipRating,
  getTopRatedClipDetails,
  addChapter,
  listChapters,
  deleteChapter,
  createClipShare,
  getClipShare,
  listClipShares,
  deleteClipShare,
  createAbExperiment,
  getAbExperiment,
  getClipsWithRatings,
  updateClipArchived,
  deleteClipCascade,
  insertStreamSnapshot,
  listStreamSnapshots,
  listStreamSnapshotSessions,
  pruneOldSnapshots,
  type ScheduledJobRecord,
} from './db.js';
import { enqueue } from './pipeline.js';
import { liveManager } from './live/live-manager.js';
import {
  INBOX,
  CLIPS_DIR,
  ARCHIVE_DIR,
  RECORDINGS_DIR,
  MUSIC_DIR,
  getStorageInfo,
  registerAllowedMediaDir,
  isPathInsideMediaDirs,
} from './storage.js';
import { probeDuration } from './downloader.js';
import {
  listLocalVideos,
  listPastStreams,
  probeMediaSource,
  startVodDownload,
  vodDownloads,
  detectFacecamAtTimestamp,
  scanStudioAudioPeaks,
  cutManualClip,
  autoClipTopMoments,
  compileMontageReel,
  reexportClip,
  resolveMusicTrackPath,
  escapeCsvCell,
  detectAudioMagicBytes,
  ClipNotFoundError,
  ProxyUrlError,
  assertSafeRemoteUrl,
} from './studio.js';
import {
  kelviqWebhookMiddleware,
  registerSaasAndAdminRoutes,
  handleErrorStatus,
  requireAdminAuth,
  hasAdminSession,
  LOCAL_ORIGIN_RE,
  VALID_LIVE_PLATFORMS,
  VALID_CLIP_LAYOUTS,
  VALID_FACECAM_POSITIONS,
  VALID_CAPTION_STYLES,
} from './admin-routes.js';
import {
  getActiveEntitlement,
  assertEntitlement,
  getPlanById,
  planExists,
  resolveCheckoutUrl,
  isUsingDefaultAdminPassword,
  maskLicenseKeyValue,
  redactLicenseKeysInObject,
} from './licensing.js';
import { pollWatchlistStatuses } from './features/watchlist.js';
import { generateSrtTextForClip, type CaptionStyle } from './features/captions.js';
import { listMusicTracks } from './features/audio-fx.js';
import { extractClipThumbnail, generateSocialMetadata } from './features/metadata-ai.js';
import { dispatchOutboundWebhookSingle, dispatchOutboundWebhooks } from './features/webhooks.js';
import {
  addComment,
  listComments,
  getCommentById,
  toggleCommentResolved,
  deleteComment,
} from './features/clip-comments.js';
import {
  getActiveVariant,
  computeAbWinner,
  recordAbView,
  recordAbClick,
} from './features/ab-testing.js';
import { validateClipShareAccess } from './features/clip-share.js';
import {
  VALID_SOCIAL_PLATFORMS,
  VALID_UPLOAD_STATUSES,
  listUploadQueue,
  addToUploadQueue,
  getUploadQueueItem,
  updateUploadStatus,
  deleteFromUploadQueue,
  getUploadQueueStats,
  type SocialPlatform,
  type UploadStatus,
} from './features/social-upload.js';
import { scoreStreamHealth } from './features/stream-health.js';
import type { LivePlatform } from './live/chat-tracker.js';
import type { ClipLayout, FacecamPosition } from './live/layout-utils.js';

const execFileAsync = promisify(execFile);
const app = express();
const STUDIO_VIDEO_EXT_RE = /\.(mp4|mkv|mov|webm|ts|flv|avi)$/i;
const MUSIC_UPLOAD_FILENAME_RE = /^[a-zA-Z0-9._-]{1,80}\.(mp3|wav|m4a|aac|ogg)$/i;
const VALID_WEBHOOK_EVENTS = new Set(['clip.ready', 'live.explosion', 'job.completed']);
const MAX_AUDIO_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MiB
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HLS_PROXY_MAX_BYTES = 5 * 1024 * 1024;    // 5 MiB
const MEDIA_PROXY_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB

function getClientIp(req: express.Request): string {
  return String(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function isSameOrInsideDirPath(baseDir: string, candidatePath: string): boolean {
  const normBase = process.platform === 'win32' ? path.resolve(baseDir).toLowerCase() : path.resolve(baseDir);
  const normCandidate = process.platform === 'win32' ? path.resolve(candidatePath).toLowerCase() : path.resolve(candidatePath);
  const rel = path.relative(normBase, normCandidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function resolveSafeClipFilePath(
  rawPath?: string | null,
): { ok: true; realPath: string } | { ok: false; status: number; error: string } {
  if (!rawPath || typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) {
    return { ok: false, status: 404, error: 'File not found' };
  }
  const resolved = path.resolve(rawPath);
  if (!isPathInsideMediaDirs(resolved)) {
    return { ok: false, status: 403, error: 'Access denied: clip path is outside allowed media directories' };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, status: 404, error: 'File not found' };
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    return { ok: false, status: 404, error: 'File not found' };
  }
  if (!isPathInsideMediaDirs(realPath)) {
    return { ok: false, status: 403, error: 'Access denied: resolved clip path is outside allowed media directories' };
  }
  try {
    if (!fs.statSync(realPath).isFile()) {
      return { ok: false, status: 404, error: 'File not found' };
    }
  } catch {
    return { ok: false, status: 404, error: 'File not found' };
  }
  return { ok: true, realPath };
}

function hasClipDeleteAuthorization(req: express.Request, res: express.Response): boolean {
  const hasCsrfHeader = req.headers['x-clipper-csrf'] === '1';
  const hasAdmin = hasAdminSession(req);
  const hasValidApiKey = Boolean(res.locals.apiKeyAuthenticated);
  return hasCsrfHeader || hasAdmin || hasValidApiKey;
}

function safeUnlinkMediaFile(rawPath?: string | null): void {
  if (!rawPath || typeof rawPath !== 'string') return;
  const resolved = path.resolve(rawPath);
  if (!fs.existsSync(resolved)) return;
  try {
    const realPath = fs.realpathSync(resolved);
    if (isPathInsideMediaDirs(realPath) && fs.statSync(realPath).isFile()) {
      fs.unlinkSync(realPath);
    }
  } catch {}
}

const SHARE_GRANT_TTL_SEC = 300;

function createShareStreamGrant(token: string): string {
  const secret = getSetting('admin_session_secret', 'fallback_secret');
  const expSec = Math.floor(Date.now() / 1000) + SHARE_GRANT_TTL_SEC;
  const payload = `share_grant:${token}:${expSec}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${expSec}.${sig}`;
}

function verifyShareStreamGrant(token: string, grant?: string): boolean {
  if (!grant || typeof grant !== 'string') return false;
  const dotIdx = grant.indexOf('.');
  if (dotIdx <= 0) return false;
  const expStr = grant.slice(0, dotIdx);
  const sigHex = grant.slice(dotIdx + 1);
  if (!/^\d+$/.test(expStr) || !/^[0-9a-f]+$/i.test(sigHex)) return false;

  const expSec = Number.parseInt(expStr, 10);
  if (!Number.isFinite(expSec) || expSec < Math.floor(Date.now() / 1000)) return false;

  const secret = getSetting('admin_session_secret', 'fallback_secret');
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(`share_grant:${token}:${expStr}`)
    .digest('hex');

  const actualBuf = Buffer.from(sigHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function isSystemOrRootDirectory(dirPath: string): boolean {
  const resolved = path.resolve(dirPath);
  let realDir = resolved;
  try {
    realDir = fs.realpathSync(resolved);
  } catch {}
  if (path.parse(resolved).root === resolved) return true;
  if (path.parse(realDir).root === realDir) return true;

  const norm = process.platform === 'win32' ? realDir.toLowerCase() : realDir;
  const blockedPrefixes: string[] = [];
  if (process.platform === 'win32') {
    const winDir = (process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows').toLowerCase();
    blockedPrefixes.push(winDir, 'c:\\windows', 'c:\\program files', 'c:\\program files (x86)');
  } else {
    blockedPrefixes.push('/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/root');
  }

  for (const prefix of blockedPrefixes) {
    const rel = path.relative(prefix, norm);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

function validateLocalVideoFilePath(
  rawPath: string,
  requireInsideMediaDirs = false,
): { ok: true; resolved: string; dir: string } | { ok: false; status: number; error: string } {
  if (!rawPath || rawPath.includes('\0')) {
    return { ok: false, status: 400, error: 'Invalid local file path' };
  }
  const resolved = path.resolve(rawPath);
  if (!STUDIO_VIDEO_EXT_RE.test(resolved)) {
    return { ok: false, status: 403, error: 'Unsupported local video file extension' };
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return { ok: false, status: 404, error: `Local file not found: ${resolved}` };
  }
  let realFile = resolved;
  try {
    realFile = fs.realpathSync(resolved);
  } catch {}
  const dir = path.dirname(realFile);
  if (isSystemOrRootDirectory(dir)) {
    return { ok: false, status: 403, error: 'Access to filesystem root or system directories is blocked' };
  }
  if (requireInsideMediaDirs && !isPathInsideMediaDirs(realFile)) {
    return { ok: false, status: 403, error: 'Path is outside allowed media directories' };
  }
  return { ok: true, resolved: realFile, dir };
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

async function assertSafeRemoteProxyUrl(rawUrl: string): Promise<URL> {
  return assertSafeRemoteUrl(rawUrl);
}

async function safeProxyFetch(
  initialUrl: string,
  headers: Record<string, string>,
  maxRedirects = 3,
  maxBytes?: number,
): Promise<{ response: globalThis.Response; finalUrl: string }> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeRemoteProxyUrl(currentUrl);
    const response = await fetch(currentUrl, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: currentUrl };
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (maxBytes !== undefined) {
      const contentLen = response.headers.get('content-length');
      if (contentLen) {
        const parsedLen = Number.parseInt(contentLen, 10);
        if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
          try { await response.body?.cancel(); } catch {}
          throw new ProxyUrlError(413, `Upstream response exceeds limit of ${maxBytes} bytes`);
        }
      }
    }
    return { response, finalUrl: currentUrl };
  }
  throw new ProxyUrlError(502, 'Too many upstream redirects');
}

async function readLimitedText(response: globalThis.Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ProxyUrlError(413, `Upstream playlist exceeds limit of ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return merged.toString('utf8');
}

function pipeWithByteLimit(
  upstreamStream: Readable,
  res: express.Response,
  maxBytes: number,
): void {
  let totalBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        callback(new ProxyUrlError(413, `Upstream stream exceeds limit of ${maxBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });

  upstreamStream.on('error', () => {
    limiter.destroy();
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });

  limiter.on('error', (err) => {
    upstreamStream.destroy();
    if (!res.headersSent) {
      const status = err instanceof ProxyUrlError ? err.statusCode : 502;
      res.status(status).send(err.message);
    } else {
      res.destroy();
    }
  });

  upstreamStream.pipe(limiter).pipe(res);
}

// Kelviq Webhook MUST receive raw Buffer body before express.json() for HMAC verification
app.post('/api/webhooks/kelviq', ...kelviqWebhookMiddleware);

const defaultJsonParser = express.json({ limit: '2mb' });
const musicUploadJsonParser = express.json({ limit: '22mb' });
const musicUploadRawParser = express.raw({
  type: ['application/octet-stream', 'audio/*'],
  limit: '15mb',
});

app.use((req, res, next) => {
  if (req.path.replace(/\/+$/, '') === '/api/studio/music/upload') {
    next();
    return;
  }
  defaultJsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

function parseMusicUploadBody(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  const parser = ct.includes('application/json') ? musicUploadJsonParser : musicUploadRawParser;
  parser(req, res, (err?: any) => {
    if (!err) {
      next();
      return;
    }
    if (err.type === 'entity.too.large' || err.status === 413) {
      res.status(413).json({ error: 'Audio upload exceeds maximum allowed size (15 MiB)' });
      return;
    }
    res.status(400).json({ error: err?.message ?? 'Invalid upload payload' });
  });
}

// ── Security Headers ──────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; frame-src 'self' https://player.twitch.tv https://player.kick.com https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'none'",
  );
  next();
});

// ── Tiered API Rate Limiter ───────────────────────────────────────────────
type RateTier = 'auth' | 'mutation' | 'read';
const RATE_LIMIT_TIERS: Record<RateTier, { limit: number; windowMs: number }> = {
  auth: { limit: 20, windowMs: 60_000 },
  mutation: { limit: 60, windowMs: 60_000 },
  read: { limit: 240, windowMs: 60_000 },
};
const _rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function pruneExpiredRateLimits(now = Date.now()): void {
  for (const [k, v] of _rateLimitStore) {
    if (now > v.resetAt) _rateLimitStore.delete(k);
  }
}

setInterval(() => {
  if (_rateLimitStore.size > 0) pruneExpiredRateLimits();
}, 60_000).unref();

app.use('/api', (req, res, next) => {
  if (req.path === '/live/chat/stream') {
    next();
    return;
  }

  const tier: RateTier =
    req.path === '/admin/login' ||
    req.path === '/billing/activate' ||
    (req.path.startsWith('/share/') && req.method.toUpperCase() === 'POST')
      ? 'auth'
      : MUTATING_METHODS.has(req.method.toUpperCase())
        ? 'mutation'
        : 'read';

  const cfg = RATE_LIMIT_TIERS[tier];
  const ip = getClientIp(req);
  const bucketKey = `${ip}:${tier}`;
  const now = Date.now();
  const entry = _rateLimitStore.get(bucketKey);

  if (!entry || now > entry.resetAt) {
    if (_rateLimitStore.size > 10_000) {
      pruneExpiredRateLimits(now);
    }
    _rateLimitStore.set(bucketKey, { count: 1, resetAt: now + cfg.windowMs });
    next();
    return;
  }

  entry.count += 1;
  if (entry.count > cfg.limit) {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    });
    return;
  }
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && LOCAL_ORIGIN_RE.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Clipper-CSRF');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
  } else if (req.method === 'OPTIONS') {
    if (origin) {
      res.status(403).end();
      return;
    }
    res.sendStatus(204);
    return;
  }
  next();
});

// Reject state-changing /api/* requests with untrusted Origin or Referer headers
app.use('/api', (req, res, next) => {
  if (!MUTATING_METHODS.has(req.method.toUpperCase()) || req.path === '/webhooks/kelviq') {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && !LOCAL_ORIGIN_RE.test(origin)) {
    res.status(403).json({ error: 'Forbidden: untrusted Origin header' });
    return;
  }
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer.trim()) {
    let refOrigin = '';
    try {
      refOrigin = new URL(referer).origin;
    } catch {
      refOrigin = '';
    }
    if (!refOrigin || !LOCAL_ORIGIN_RE.test(refOrigin)) {
      res.status(403).json({ error: 'Forbidden: untrusted Referer header' });
      return;
    }
  }
  next();
});

// ── API Key Authentication Middleware (mounted BEFORE /api/clipper & /api/studio) ──
function apiKeyAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const authHeader = req.headers.authorization ?? '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice('bearer '.length).trim();
    if (token.startsWith('csk_')) {
      if (!validateApiKey(token)) {
        res.status(401).json({ error: 'Invalid or revoked API key' });
        return;
      }
      res.locals.apiKeyAuthenticated = true;
      next();
      return;
    }
    if (process.env.REQUIRE_API_KEY === 'true') {
      res.status(401).json({ error: 'Valid csk_* API key required' });
      return;
    }
  } else if (process.env.REQUIRE_API_KEY === 'true' && !hasAdminSession(req)) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const isLocalBrowser =
      (typeof origin === 'string' && LOCAL_ORIGIN_RE.test(origin)) ||
      (typeof referer === 'string' && (() => {
        try { return LOCAL_ORIGIN_RE.test(new URL(referer).origin); } catch { return false; }
      })());
    if (!isLocalBrowser) {
      res.status(401).json({ error: 'API key required (Authorization: Bearer csk_...)' });
      return;
    }
  }
  next();
}

app.use(['/api/clipper', '/api/studio'], apiKeyAuth);

const PORT        = Number(process.env.CLIPPER_PORT ?? 4001);
const HOST        = process.env.HOST ?? '127.0.0.1';
const RETENTION   = Number(process.env.HDD_RETENTION_DAYS ?? 30);

// ── Serve Local Web Dashboard & Protected Admin Console ───────────────────
const publicDir = path.resolve('apps/clipper-service/src/public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.get('/admin', (_req, res) => {
    const adminHtml = path.join(publicDir, 'admin.html');
    if (fs.existsSync(adminHtml)) res.sendFile(adminHtml);
    else res.status(404).send('Admin dashboard not found');
  });
  app.get('/upgrade', (_req, res) => {
    const upgradeHtml = path.join(publicDir, 'upgrade.html');
    if (fs.existsSync(upgradeHtml)) res.sendFile(upgradeHtml);
    else res.status(404).send('Upgrade page not found');
  });
}

// ── Watch 01_inbox/ — auto-ingest any video dropped in ───────────────────
if (fs.existsSync(INBOX)) {
  chokidar
    .watch(INBOX, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 3000 } })
    .on('add', (filePath) => {
      if (!/\.(mp4|mkv|mov|webm|avi)$/i.test(filePath)) return;
      console.log(`[watcher] 📥 New file: ${filePath}`);
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO ingest_jobs (id, source_path) VALUES (?, ?)`).run(id, filePath);
      enqueue(id);
    });
  console.log(`[clipper-service] Watching ${INBOX}`);
}

// ── Health ────────────────────────────────────────────────────────────────
app.get('/api/clipper/health', (_req, res) => {
  res.json({ ok: true, inbox: INBOX, clipsDir: CLIPS_DIR, ts: new Date().toISOString() });
});

// ── Jobs ──────────────────────────────────────────────────────────────────
app.get('/api/clipper/jobs', (_req, res) => {
  res.json(db.prepare('SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT 100').all());
});

app.get('/api/clipper/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM ingest_jobs WHERE id=?').get(req.params.id);
  if (!job) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(job);
});

/** Submit a URL (yt-dlp download) or a local file path */
app.post('/api/clipper/jobs', async (req, res) => {
  const { sourceUrl, sourceFilePath } = (req.body ?? {}) as {
    sourceUrl?: unknown; sourceFilePath?: unknown;
  };
  const cleanUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  const cleanFilePath = typeof sourceFilePath === 'string' ? sourceFilePath.trim() : '';

  if (!cleanUrl && !cleanFilePath) {
    res.status(400).json({ error: 'sourceUrl or sourceFilePath required' });
    return;
  }

  let validatedFilePath: string | null = null;
  if (cleanUrl) {
    if (sourceUrl !== undefined && typeof sourceUrl !== 'string') {
      res.status(400).json({ error: 'sourceUrl must be a string' });
      return;
    }
    try {
      await assertSafeRemoteProxyUrl(cleanUrl);
    } catch (err: any) {
      if (err instanceof ProxyUrlError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err?.message ?? 'Invalid sourceUrl' });
      return;
    }
  }

  if (cleanFilePath) {
    if (sourceFilePath !== undefined && typeof sourceFilePath !== 'string') {
      res.status(400).json({ error: 'sourceFilePath must be a string' });
      return;
    }
    const localCheck = validateLocalVideoFilePath(cleanFilePath, false);
    if (!localCheck.ok) {
      res.status(localCheck.status).json({ error: localCheck.error });
      return;
    }
    validatedFilePath = localCheck.resolved;
  }

  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO ingest_jobs (id, source_url, source_path) VALUES (?, ?, ?)`)
    .run(id, cleanUrl || null, validatedFilePath);
  enqueue(id);
  res.status(202).json({ id, status: 'PENDING' });
});

// ── Clips ─────────────────────────────────────────────────────────────────
app.get('/api/clipper/clips', (req, res) => {
  const rawArchived = req.query.archived !== undefined ? String(req.query.archived).trim().toLowerCase() : '';
  let archivedFilter: boolean | undefined;
  if (rawArchived === '0' || rawArchived === 'false') {
    archivedFilter = false;
  } else if (rawArchived === '1' || rawArchived === 'true') {
    archivedFilter = true;
  } else if (rawArchived && rawArchived !== 'all') {
    res.status(400).json({ error: 'archived query parameter must be 0, 1, or all' });
    return;
  }
  res.json(getClipsWithRatings({ archived: archivedFilter, limit: 200 }));
});

/** Search/filter clips (MUST be registered before /api/clipper/clips/:id) */
app.get('/api/clipper/clips/search', (req, res) => {
  const tag = String(req.query.tag ?? '').trim();
  const platform = String(req.query.platform ?? '').trim();
  const rawMinScore = req.query.minScore !== undefined ? Number(req.query.minScore) : 0;
  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
  const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : 0;

  if (req.query.minScore !== undefined && (!Number.isFinite(rawMinScore) || rawMinScore < 0)) {
    res.status(400).json({ error: 'minScore must be a finite number >= 0' });
    return;
  }
  if (req.query.limit !== undefined && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
    res.status(400).json({ error: 'limit must be a finite number >= 1' });
    return;
  }
  if (req.query.offset !== undefined && (!Number.isFinite(rawOffset) || rawOffset < 0)) {
    res.status(400).json({ error: 'offset must be a finite number >= 0' });
    return;
  }

  const minScore = rawMinScore;
  const limit = Math.min(100, Math.max(1, Math.trunc(rawLimit)));
  const offset = Math.max(0, Math.trunc(rawOffset));
  const favourite = req.query.favourite === '1';

  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (tag) {
    const escapedTag = tag.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    conditions.push("tags LIKE '%' || ? || '%' ESCAPE '\\'");
    values.push(escapedTag);
  }
  if (platform) {
    conditions.push('source_platform = ?');
    values.push(platform);
  }
  if (minScore > 0) {
    conditions.push('virality_score >= ?');
    values.push(minScore);
  }
  if (favourite) {
    conditions.push('is_favourite = 1');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const clips = db.prepare(`SELECT * FROM clips ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...values, limit, offset);
  res.json({ ok: true, clips, limit, offset });
});

app.get('/api/clipper/clips/favourites', (_req, res) => {
  const clips = db.prepare(`SELECT * FROM clips WHERE is_favourite=1 ORDER BY created_at DESC LIMIT 200`).all();
  res.json({ ok: true, clips });
});

/** Top rated clips joined with clip_ratings (MUST precede :id route) */
app.get('/api/clipper/clips/top-rated', (req, res) => {
  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : 10;
  if (req.query.limit !== undefined && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
    res.status(400).json({ error: 'limit must be a finite number >= 1' });
    return;
  }
  const limit = Math.min(50, Math.max(1, Math.trunc(rawLimit)));
  res.json({ ok: true, clips: getTopRatedClipDetails(limit) });
});

/** Export clips metadata as formula-injection-safe RFC-4180 CSV (MUST precede :id route) */
app.get('/api/clipper/clips/export.csv', (req, res) => {
  const favouritesOnly =
    req.query.favouritesOnly === '1' ||
    req.query.favouritesOnly === 'true' ||
    req.query.favourite === '1';
  const tag = String(req.query.tag ?? '').trim();
  const platform = String(req.query.platform ?? '').trim();
  const q = String(req.query.q ?? '').trim();

  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (favouritesOnly) {
    conditions.push('is_favourite = 1');
  }
  if (tag) {
    const escapedTag = tag.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    conditions.push("tags LIKE '%' || ? || '%' ESCAPE '\\'");
    values.push(escapedTag);
  }
  if (platform) {
    conditions.push('source_platform = ?');
    values.push(platform);
  }
  if (q) {
    const escapedQ = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    conditions.push(
      "(title LIKE '%' || ? || '%' ESCAPE '\\' OR description LIKE '%' || ? || '%' ESCAPE '\\' OR social_title LIKE '%' || ? || '%' ESCAPE '\\' OR tags LIKE '%' || ? || '%' ESCAPE '\\')",
    );
    values.push(escapedQ, escapedQ, escapedQ, escapedQ);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      id, title, social_title, description, social_hashtags, source_platform,
      duration_sec, virality_score, tags, notes, is_favourite, file_path, created_at
    FROM clips
    ${where}
    ORDER BY created_at DESC
    LIMIT 1000
  `).all(...values) as Array<{
    id: string;
    title: string;
    social_title: string;
    description: string;
    social_hashtags: string;
    source_platform: string;
    duration_sec: number;
    virality_score: number;
    tags: string;
    notes: string;
    is_favourite: number;
    file_path: string;
    created_at: string;
  }>;

  const header = [
    'id',
    'title',
    'social_title',
    'social_description',
    'hashtags',
    'platform',
    'duration_sec',
    'virality_score',
    'tags',
    'notes',
    'is_favourite',
    'file_path',
    'created_at',
  ].join(',');

  const lines = rows.map((r) => [
    escapeCsvCell(r.id),
    escapeCsvCell(r.title),
    escapeCsvCell(r.social_title),
    escapeCsvCell(r.description),
    escapeCsvCell(r.social_hashtags),
    escapeCsvCell(r.source_platform),
    escapeCsvCell(r.duration_sec),
    escapeCsvCell(r.virality_score),
    escapeCsvCell(r.tags),
    escapeCsvCell(r.notes),
    escapeCsvCell(r.is_favourite ? '1' : '0'),
    escapeCsvCell(r.file_path),
    escapeCsvCell(r.created_at),
  ].join(','));

  const csvBody = [header, ...lines].join('\r\n') + '\r\n';
  logAuditEvent('clipper', 'clips.export_csv', `${rows.length} clip(s)`, getClientIp(req), {
    favouritesOnly,
    tag,
    platform,
    q,
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="clipper-clips.csv"');
  res.send(csvBody);
});

/** Batch-generate and persist social titles & hashtags for 1..20 clips (MUST precede :id route) */
app.post('/api/clipper/clips/batch-metadata', async (req, res) => {
  const { clipIds } = (req.body ?? {}) as { clipIds?: unknown };
  if (!Array.isArray(clipIds) || clipIds.length === 0) {
    res.status(400).json({ error: 'clipIds must be a non-empty array of 1 to 20 IDs' });
    return;
  }
  if (clipIds.length > 20) {
    res.status(400).json({ error: 'Maximum 20 clipIds allowed per batch-metadata request' });
    return;
  }

  const cleanIds: string[] = [];
  const seen = new Set<string>();
  for (const rawId of clipIds) {
    if (typeof rawId !== 'string' || !rawId.trim()) {
      res.status(400).json({ error: 'Every entry in clipIds must be a non-empty string' });
      return;
    }
    const id = rawId.trim();
    if (!seen.has(id)) {
      seen.add(id);
      cleanIds.push(id);
    }
  }

  const stmt = db.prepare(
    'SELECT id, title, description, source_platform, virality_score FROM clips WHERE id = ?',
  );

  let updatedCount = 0;
  const results: Array<{
    clipId: string;
    ok: boolean;
    socialTitle?: string;
    socialDescription?: string;
    hashtags?: string[];
    error?: string;
  }> = [];

  for (const id of cleanIds) {
    const clip = stmt.get(id) as
      | { id: string; title: string; description: string; source_platform: string; virality_score: number }
      | undefined;
    if (!clip) {
      results.push({ clipId: id, ok: false, error: 'Clip not found' });
      continue;
    }
    try {
      const metadata = await generateSocialMetadata({
        title: clip.title,
        description: clip.description,
        platform: clip.source_platform,
        viralityScore: clip.virality_score,
      });
      updateClipSocialMetadata(clip.id, metadata.socialTitle, metadata.hashtags.join(' '));
      updatedCount += 1;
      results.push({
        clipId: clip.id,
        ok: true,
        socialTitle: metadata.socialTitle,
        socialDescription: metadata.socialDescription,
        hashtags: metadata.hashtags,
      });
    } catch (err: any) {
      results.push({
        clipId: clip.id,
        ok: false,
        error: err?.message ?? 'Metadata generation failed',
      });
    }
  }

  logAuditEvent('clipper', 'clips.batch_metadata', `${updatedCount} clip(s)`, getClientIp(req), {
    requested: cleanIds.length,
    updatedCount,
  });

  res.json({ ok: true, updatedCount, results });
});

app.get('/api/clipper/clips/:id', (req, res) => {
  const clip = db.prepare('SELECT * FROM clips WHERE id=?').get(req.params.id);
  if (!clip) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(clip);
});

/** Serve the MP4 file for inline preview (with Range seeking) or download (?download=1) */
app.get('/api/clipper/clips/:id/file', (req, res) => {
  const clip = db.prepare('SELECT file_path FROM clips WHERE id=?').get(req.params.id) as
    { file_path: string } | undefined;
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  const check = resolveSafeClipFilePath(clip.file_path);
  if (!check.ok) {
    res.status(check.status).json({ error: check.error });
    return;
  }
  if (req.query.download === '1') {
    res.download(check.realPath);
  } else {
    res.sendFile(check.realPath);
  }
});

/** Serve cover JPEG thumbnail (generating lazily if missing) */
app.get('/api/clipper/clips/:id/thumbnail', async (req, res) => {
  const clip = db.prepare('SELECT id, file_path, thumbnail_path FROM clips WHERE id=?').get(req.params.id) as
    { id: string; file_path: string; thumbnail_path: string } | undefined;
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  if (clip.thumbnail_path && fs.existsSync(clip.thumbnail_path) && isPathInsideMediaDirs(clip.thumbnail_path)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.resolve(clip.thumbnail_path));
    return;
  }

  if (!clip.file_path || !fs.existsSync(clip.file_path)) {
    res.status(404).json({ error: 'Clip video file not found' });
    return;
  }

  try {
    const { thumbPath } = await extractClipThumbnail(clip.file_path, clip.id);
    updateClipThumbnail(clip.id, thumbPath);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.resolve(thumbPath));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Failed to generate thumbnail' });
  }
});

/** Generate or manually update social title, description & hashtags for a clip */
app.post('/api/clipper/clips/:id/metadata', async (req, res) => {
  const clip = db.prepare(
    'SELECT id, title, description, source_platform, virality_score FROM clips WHERE id=?'
  ).get(req.params.id) as
    { id: string; title: string; description: string; source_platform: string; virality_score: number } | undefined;
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  const { socialTitle, socialHashtags, mode } = (req.body ?? {}) as {
    socialTitle?: unknown;
    socialHashtags?: unknown;
    mode?: unknown;
  };
  const isManual =
    mode === 'manual' ||
    typeof socialTitle === 'string' ||
    typeof socialHashtags === 'string';

  if (isManual) {
    if (socialTitle !== undefined && typeof socialTitle !== 'string') {
      res.status(400).json({ error: 'socialTitle must be a string' });
      return;
    }
    if (socialHashtags !== undefined && typeof socialHashtags !== 'string') {
      res.status(400).json({ error: 'socialHashtags must be a string' });
      return;
    }
    const titleStr = typeof socialTitle === 'string' ? socialTitle.trim() : '';
    const hashtagsStr = typeof socialHashtags === 'string' ? socialHashtags.trim() : '';

    if (titleStr.length > 200) {
      res.status(400).json({ error: 'socialTitle exceeds maximum length of 200 characters' });
      return;
    }
    if (hashtagsStr.length > 500) {
      res.status(400).json({ error: 'socialHashtags exceeds maximum length of 500 characters' });
      return;
    }

    updateClipSocialMetadata(clip.id, titleStr, hashtagsStr);
    const updated = db.prepare('SELECT * FROM clips WHERE id = ?').get(clip.id);
    logAuditEvent('clipper', 'clip.metadata_manual_update', clip.id, getClientIp(req));
    res.json({
      ok: true,
      socialTitle: titleStr,
      socialHashtags: hashtagsStr,
      clip: updated,
    });
    return;
  }

  try {
    const metadata = await generateSocialMetadata({
      title: clip.title,
      description: clip.description,
      platform: clip.source_platform,
      viralityScore: clip.virality_score,
    });
    const socialHashtagsStr = metadata.hashtags.join(' ');
    updateClipSocialMetadata(clip.id, metadata.socialTitle, socialHashtagsStr);
    const updated = db.prepare('SELECT * FROM clips WHERE id = ?').get(clip.id);
    res.json({
      ok: true,
      socialTitle: metadata.socialTitle,
      socialDescription: metadata.socialDescription,
      hashtags: metadata.hashtags,
      socialHashtags: socialHashtagsStr,
      clip: updated,
    });
  } catch (err) {
    handleErrorStatus(res, err);
  }
});

/** Export downloadable .srt subtitle file for a clip */
app.get('/api/clipper/clips/:id/srt', async (req, res) => {
  const clip = db.prepare('SELECT id, title, file_path FROM clips WHERE id=?').get(req.params.id) as
    { id: string; title: string; file_path: string } | undefined;
  if (!clip || !clip.file_path || !fs.existsSync(clip.file_path)) {
    res.status(404).json({ error: 'Clip file not found' });
    return;
  }

  try {
    const srtText = await generateSrtTextForClip(clip.file_path, clip.title);
    const safeName = (clip.title || clip.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || clip.id;
    res.setHeader('Content-Type', 'text/srt; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.srt"`);
    res.send(srtText);
  } catch (err) {
    handleErrorStatus(res, err);
  }
});

/** Compile a ready-to-post Creator Kit bundle JSON for Shorts, TikTok & Reels */
app.get('/api/clipper/clips/:id/kit', async (req, res) => {
  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(req.params.id) as
    | {
        id: string;
        title: string;
        description: string;
        file_path: string;
        source_platform: string;
        virality_score: number;
        social_title: string;
        social_hashtags: string;
        tags: string;
        notes: string;
        [key: string]: unknown;
      }
    | undefined;
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  let socialTitle = (clip.social_title ?? '').trim();
  let socialDescription = (clip.description ?? '').trim();
  let hashtags = (clip.social_hashtags ?? '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (!socialTitle || hashtags.length === 0 || !socialDescription) {
    try {
      const generated = await generateSocialMetadata({
        title: clip.title,
        description: clip.description,
        platform: clip.source_platform,
        viralityScore: clip.virality_score,
      });
      if (!socialTitle) socialTitle = generated.socialTitle;
      if (!socialDescription) socialDescription = generated.socialDescription;
      if (hashtags.length === 0) hashtags = generated.hashtags;
    } catch {}
  }

  const hashtagLine = hashtags.join(' ');
  const platforms = {
    youtubeShorts: {
      title: `${socialTitle || clip.title} #Shorts`.trim().slice(0, 100),
      description: [socialDescription, hashtagLine].filter(Boolean).join('\n\n'),
      tags: hashtags.map((h) => h.replace(/^#/, '')),
    },
    tiktok: {
      caption: [socialTitle || clip.title, socialDescription, hashtagLine]
        .filter(Boolean)
        .join(' ')
        .slice(0, 2200),
      hashtags,
    },
    instagramReels: {
      caption: [socialTitle || clip.title, socialDescription, hashtagLine]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 2200),
      hashtags,
    },
  };

  let srt = '';
  if (clip.file_path && fs.existsSync(clip.file_path) && isPathInsideMediaDirs(clip.file_path)) {
    try {
      srt = await generateSrtTextForClip(clip.file_path, clip.title);
    } catch {}
  }

  const tags = (clip.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  res.json({
    ok: true,
    clip,
    socialTitle,
    socialDescription,
    hashtags,
    platforms,
    tags,
    notes: clip.notes ?? '',
    srt,
  });
});

/** Trim, speed-adjust, flip, or re-polish an existing clip into a new MP4 file */
app.post('/api/clipper/clips/:id/re-export', async (req, res) => {
  const body = req.body ?? {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }

  const {
    trimStartSec,
    trimEndSec,
    speed,
    flipHorizontal,
    silenceCut,
    trimSilence,
    audioNormalize,
    musicTrack,
    musicPath,
    musicVolume,
    hookTitleText,
    watermarkText,
    captionStyle,
    title,
  } = body as Record<string, unknown>;

  const resolvedMusicTrack =
    typeof musicTrack === 'string'
      ? musicTrack
      : (typeof musicPath === 'string' ? musicPath : undefined);

  try {
    const result = await reexportClip(req.params.id, {
      trimStartSec: trimStartSec !== undefined ? Number(trimStartSec) : undefined,
      trimEndSec: trimEndSec !== undefined ? Number(trimEndSec) : undefined,
      speed: speed !== undefined ? Number(speed) : undefined,
      flipHorizontal: flipHorizontal !== undefined ? Boolean(flipHorizontal) : undefined,
      silenceCut: (silenceCut ?? trimSilence) !== undefined ? Boolean(silenceCut ?? trimSilence) : undefined,
      audioNormalize: audioNormalize !== undefined ? Boolean(audioNormalize) : undefined,
      musicTrack: resolvedMusicTrack,
      musicVolume: musicVolume !== undefined ? Number(musicVolume) : undefined,
      hookTitleText: hookTitleText as string | undefined,
      watermarkText: watermarkText as string | undefined,
      captionStyle: captionStyle as CaptionStyle | undefined,
      title: typeof title === 'string' ? title : undefined,
    });

    logAuditEvent('studio', 'clip.reexport', String(result.clip.id ?? ''), getClientIp(req), {
      sourceClipId: req.params.id,
      durationSec: result.durationSec,
    });

    void dispatchOutboundWebhooks('clip.ready', {
      source: 'studio.reexport',
      clip: result.clip,
      width: result.width,
      height: result.height,
    });

    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ClipNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof ProxyUrlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleErrorStatus(res, err);
  }
});

/** Archive or unarchive a clip (move to/from 04_archive/) */
app.post('/api/clipper/clips/:id/archive', (req, res) => {
  if (req.body !== undefined && !isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { archived } = (req.body ?? {}) as { archived?: unknown };
  if (archived !== undefined && typeof archived !== 'boolean') {
    res.status(400).json({ error: 'archived must be a boolean' });
    return;
  }
  const shouldArchive = archived !== false;

  const clip = db.prepare('SELECT id, file_path, status FROM clips WHERE id=?').get(req.params.id) as
    | { id: string; file_path: string; status: string }
    | undefined;
  if (!clip) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  if (shouldArchive) {
    const check = resolveSafeClipFilePath(clip.file_path);
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }

    let dest = check.realPath;
    if (!isSameOrInsideDirPath(ARCHIVE_DIR, check.realPath)) {
      if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const parsed = path.parse(check.realPath);
      dest = path.join(ARCHIVE_DIR, parsed.base);
      if (fs.existsSync(dest)) {
        dest = path.join(ARCHIVE_DIR, `${parsed.name}_${Date.now()}${parsed.ext}`);
      }
      if (!isPathInsideMediaDirs(dest)) {
        res.status(403).json({ error: 'Destination path is outside allowed media directories' });
        return;
      }
      moveFileSync(check.realPath, dest);
    }

    db.prepare(`UPDATE clips SET status='ARCHIVED', file_path=? WHERE id=?`).run(dest, clip.id);
    updateClipArchived(clip.id, true);
    logAuditEvent('clipper', 'clip.archive', clip.id, getClientIp(req), { archived: true, filePath: dest });
    res.json({ ok: true, archived: true, archivedTo: dest, filePath: dest });
    return;
  }

  let nextPath = clip.file_path;
  if (clip.file_path && fs.existsSync(clip.file_path)) {
    const check = resolveSafeClipFilePath(clip.file_path);
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }
    if (isSameOrInsideDirPath(ARCHIVE_DIR, check.realPath)) {
      if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
      const parsed = path.parse(check.realPath);
      let dest = path.join(CLIPS_DIR, parsed.base);
      if (fs.existsSync(dest)) {
        dest = path.join(CLIPS_DIR, `${parsed.name}_${Date.now()}${parsed.ext}`);
      }
      if (!isPathInsideMediaDirs(dest)) {
        res.status(403).json({ error: 'Destination path is outside allowed media directories' });
        return;
      }
      moveFileSync(check.realPath, dest);
      nextPath = dest;
    } else {
      nextPath = check.realPath;
    }
  }

  db.prepare(`UPDATE clips SET status='READY', file_path=? WHERE id=?`).run(nextPath, clip.id);
  updateClipArchived(clip.id, false);
  logAuditEvent('clipper', 'clip.unarchive', clip.id, getClientIp(req), { archived: false, filePath: nextPath });
  res.json({ ok: true, archived: false, restoredTo: nextPath, filePath: nextPath });
});

// ── SSE progress stream ───────────────────────────────────────────────────
app.get('/api/clipper/jobs/:id/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = () => {
    const job = db.prepare('SELECT status, error FROM ingest_jobs WHERE id=?').get(req.params.id) as
      { status: string; error: string | null } | undefined;
    if (!job) { res.write(`data: {"error":"not_found"}\n\n`); res.end(); return; }
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    if (job.status === 'DONE' || job.status === 'ERROR') res.end();
  };

  send();
  const iv = setInterval(send, 1500);
  req.on('close', () => clearInterval(iv));
});

// ── Storage Disk Auto-Discovery API ────────────────────────────────────────
app.get('/api/storage/info', (_req, res) => {
  res.json(getStorageInfo());
});

// ── Live Stream Chat Explosion Clipper API ────────────────────────────────
app.get('/api/live/status', (_req, res) => {
  res.json({
    ...liveManager.getStatus(),
    storage: getStorageInfo(),
  });
});

app.get('/api/live/preview-frame', async (_req, res) => {
  const buf = await liveManager.getPreviewSnapshot();
  if (!buf) {
    res.status(404).send('No frame buffered yet');
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(buf);
});

app.get('/api/live/preview-facecam', async (_req, res) => {
  const facecam = await liveManager.getDetectedFacecam();
  res.json({ ok: true, facecam });
});

app.post('/api/live/start', async (req, res) => {
  const {
    platform,
    channelOrUrl,
    vertical,
    layout,
    facecamPosition,
    captionStyle,
    watermarkText,
    hookTitleText,
    audioNormalize,
    triggerKeywords,
    spikeMultiplier,
    minSpikeThreshold,
    saveRecording,
  } = (req.body ?? {}) as {
    platform?: LivePlatform;
    channelOrUrl?: string;
    vertical?: boolean;
    layout?: ClipLayout;
    facecamPosition?: FacecamPosition;
    captionStyle?: CaptionStyle;
    watermarkText?: string;
    hookTitleText?: string;
    audioNormalize?: boolean;
    triggerKeywords?: string[] | string;
    spikeMultiplier?: number;
    minSpikeThreshold?: number;
    saveRecording?: boolean;
  };

  if (!platform || !channelOrUrl || typeof channelOrUrl !== 'string' || !channelOrUrl.trim()) {
    res.status(400).json({ error: 'platform ("twitch", "youtube", or "kick") and channelOrUrl are required' });
    return;
  }
  if (!VALID_LIVE_PLATFORMS.has(platform)) {
    res.status(400).json({ error: 'platform must be one of: twitch, youtube, kick' });
    return;
  }
  if (layout !== undefined && !VALID_CLIP_LAYOUTS.has(layout)) {
    res.status(400).json({ error: 'Invalid layout' });
    return;
  }
  if (facecamPosition !== undefined && !VALID_FACECAM_POSITIONS.has(facecamPosition)) {
    res.status(400).json({ error: 'Invalid facecamPosition' });
    return;
  }
  if (captionStyle !== undefined && !VALID_CAPTION_STYLES.has(captionStyle)) {
    res.status(400).json({ error: 'Invalid captionStyle' });
    return;
  }

  let parsedKeywords: string[] | undefined;
  if (Array.isArray(triggerKeywords)) {
    parsedKeywords = triggerKeywords
      .filter((k): k is string => typeof k === 'string')
      .map((k) => k.trim())
      .filter(Boolean);
  } else if (typeof triggerKeywords === 'string') {
    parsedKeywords = triggerKeywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
  }

  try {
    await liveManager.startSession({
      platform,
      channelOrUrl: channelOrUrl.trim(),
      vertical: vertical ?? true,
      layout: layout ?? (vertical === false ? 'landscape' : 'split'),
      facecamPosition: facecamPosition ?? 'auto',
      captionStyle: captionStyle ?? 'none',
      watermarkText: typeof watermarkText === 'string' ? watermarkText : '',
      hookTitleText: typeof hookTitleText === 'string' ? hookTitleText : '',
      audioNormalize: Boolean(audioNormalize),
      triggerKeywords: parsedKeywords,
      spikeMultiplier: spikeMultiplier ?? 2.5,
      minSpikeThreshold: minSpikeThreshold ?? 4.0,
      saveRecording: Boolean(saveRecording),
    });
    res.json({ ok: true, message: `Live clipping active for ${platform}: ${channelOrUrl}` });
  } catch (err) {
    handleErrorStatus(res, err);
  }
});

app.post('/api/live/stop', async (_req, res) => {
  const result = await liveManager.stopSession();
  res.json({ ok: true, message: 'Live monitoring stopped', ...result });
});

app.post('/api/live/save-recording', async (_req, res) => {
  try {
    const filePath = await liveManager.saveCurrentRecording();
    if (!filePath) {
      res.status(400).json({ error: 'No buffered segments available yet to save' });
      return;
    }
    res.json({ ok: true, filePath });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** SSE stream for real-time live chat preview, explosion markers & quota alerts */
app.get('/api/live/chat/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const status = liveManager.getStatus();
  res.write(`data: ${JSON.stringify({ type: 'history', messages: status.recentChat })}\n\n`);

  const onChat = (msg: any) => {
    res.write(`data: ${JSON.stringify({ type: 'chat', message: msg })}\n\n`);
  };
  const onExplosion = (evt: any) => {
    res.write(`data: ${JSON.stringify({ type: 'explosion', event: evt })}\n\n`);
  };
  const onQuotaReached = (info: any) => {
    res.write(`data: ${JSON.stringify({ type: 'quota_reached', ...info })}\n\n`);
  };

  liveManager.on('chat', onChat);
  liveManager.on('explosion', onExplosion);
  liveManager.on('quota_reached', onQuotaReached);

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    liveManager.off('chat', onChat);
    liveManager.off('explosion', onExplosion);
    liveManager.off('quota_reached', onQuotaReached);
  });
});

liveManager.on('explosion', (evt) => {
  void dispatchOutboundWebhooks('live.explosion', evt);
});

liveManager.on('clip', (clipData) => {
  void dispatchOutboundWebhooks('clip.ready', {
    source: 'live.explosion',
    clip: clipData,
  });
});

app.post('/api/live/clip-now', async (req, res) => {
  const { durationSec } = (req.body ?? {}) as { durationSec?: number };
  try {
    const clip = await liveManager.manualClip(durationSec ?? 20);
    void dispatchOutboundWebhooks('clip.ready', { source: 'live.manual', clip });
    res.json({ ok: true, clip });
  } catch (err) {
    handleErrorStatus(res, err);
  }
});

// ── Saved Editing Presets API ─────────────────────────────────────────────
app.get('/api/presets', (_req, res) => {
  res.json({ ok: true, presets: listPresets() });
});

app.post('/api/presets', (req, res) => {
  const {
    name,
    description,
    layout,
    facecamPosition,
    captionStyle,
    silenceCut,
    audioNormalize,
    musicTrack,
    musicVolume,
    hookTitle,
    watermarkText,
  } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const cleanName = name.trim();
  if (cleanName.length > 64) {
    res.status(400).json({ error: 'name must be 64 characters or fewer' });
    return;
  }

  if (description !== undefined && typeof description !== 'string') {
    res.status(400).json({ error: 'description must be a string' });
    return;
  }
  if (layout !== undefined && (typeof layout !== 'string' || !VALID_CLIP_LAYOUTS.has(layout as ClipLayout))) {
    res.status(400).json({ error: 'Invalid layout' });
    return;
  }
  if (
    facecamPosition !== undefined &&
    (typeof facecamPosition !== 'string' || !VALID_FACECAM_POSITIONS.has(facecamPosition as FacecamPosition))
  ) {
    res.status(400).json({ error: 'Invalid facecamPosition' });
    return;
  }
  if (
    captionStyle !== undefined &&
    (typeof captionStyle !== 'string' || !VALID_CAPTION_STYLES.has(captionStyle as CaptionStyle))
  ) {
    res.status(400).json({ error: 'Invalid captionStyle' });
    return;
  }

  let cleanMusicTrack = '';
  if (musicTrack !== undefined) {
    if (typeof musicTrack !== 'string') {
      res.status(400).json({ error: 'musicTrack must be a string' });
      return;
    }
    const trimmedTrack = musicTrack.trim();
    if (trimmedTrack && trimmedTrack !== 'none') {
      try {
        resolveMusicTrackPath(trimmedTrack);
        cleanMusicTrack = trimmedTrack;
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? 'Invalid musicTrack' });
        return;
      }
    }
  }

  let parsedVolume = 0.15;
  if (musicVolume !== undefined) {
    parsedVolume = Number(musicVolume);
    if (!Number.isFinite(parsedVolume) || parsedVolume < 0 || parsedVolume > 1) {
      res.status(400).json({ error: 'musicVolume must be a finite number between 0 and 1' });
      return;
    }
  }

  if (hookTitle !== undefined && typeof hookTitle !== 'string') {
    res.status(400).json({ error: 'hookTitle must be a string' });
    return;
  }
  const cleanHookTitle = typeof hookTitle === 'string' ? hookTitle.trim() : '';
  if (cleanHookTitle.length > 80) {
    res.status(400).json({ error: 'hookTitle must be 80 characters or fewer' });
    return;
  }

  if (watermarkText !== undefined && typeof watermarkText !== 'string') {
    res.status(400).json({ error: 'watermarkText must be a string' });
    return;
  }
  const cleanWatermarkText = typeof watermarkText === 'string' ? watermarkText.trim() : '';
  if (cleanWatermarkText.length > 60) {
    res.status(400).json({ error: 'watermarkText must be 60 characters or fewer' });
    return;
  }

  try {
    const preset = createPreset({
      name: cleanName,
      description: typeof description === 'string' ? description.trim().slice(0, 300) : '',
      layout: (layout as string | undefined) ?? 'split',
      facecamPosition: (facecamPosition as string | undefined) ?? 'auto',
      captionStyle: (captionStyle as string | undefined) ?? 'none',
      silenceCut: Boolean(silenceCut),
      audioNormalize: Boolean(audioNormalize),
      musicTrack: cleanMusicTrack,
      musicVolume: parsedVolume,
      hookTitle: cleanHookTitle,
      watermarkText: cleanWatermarkText,
    });

    logAuditEvent('studio', 'preset.create', preset.id, getClientIp(req), { name: preset.name });
    res.status(201).json({ ok: true, preset });
  } catch (err: any) {
    const msg = String(err?.message ?? '');
    if (msg.includes('UNIQUE constraint failed') || err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: `A preset named "${cleanName}" already exists` });
      return;
    }
    res.status(400).json({ error: msg || 'Failed to create preset' });
  }
});

app.delete('/api/presets/:id', (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const existing = getPresetById(id);
  if (!existing) {
    res.status(404).json({ error: 'Preset not found' });
    return;
  }
  if (existing.is_builtin === 1) {
    res.status(400).json({ error: 'Built-in presets cannot be deleted' });
    return;
  }
  deletePreset(id);
  logAuditEvent('studio', 'preset.delete', id, getClientIp(req), { name: existing.name });
  res.json({ ok: true });
});

// ── After-Live / Manual Stream & Video Studio API ──────────────────────────
app.get('/api/studio/local-videos', (_req, res) => {
  res.json({ ok: true, recordingsDir: RECORDINGS_DIR, videos: listLocalVideos() });
});

app.get('/api/studio/music', async (_req, res) => {
  try {
    const tracks = listMusicTracks();
    const tracksWithDuration = await Promise.all(
      tracks.map(async (t) => {
        let durationSec = 0;
        try {
          durationSec = await probeDuration(t.path);
        } catch {}
        return { ...t, durationSec: Number(durationSec.toFixed(2)) };
      }),
    );
    res.json({ ok: true, musicDir: MUSIC_DIR, tracks: tracksWithDuration });
  } catch (err) {
    handleErrorStatus(res, err);
  }
});

app.post('/api/studio/music/upload', parseMusicUploadBody, (req, res) => {
  let rawFilename = '';
  let audioBuffer: Buffer | null = null;

  if (Buffer.isBuffer(req.body)) {
    rawFilename = String(req.headers['x-filename'] ?? '').trim();
    audioBuffer = req.body;
  } else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const { filename, base64Data } = req.body as { filename?: unknown; base64Data?: unknown };
    if (typeof filename !== 'string' || typeof base64Data !== 'string') {
      res.status(400).json({ error: 'filename and base64Data strings are required' });
      return;
    }
    rawFilename = filename.trim();
    const stripped = base64Data.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
    if (!stripped || !/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) {
      res.status(400).json({ error: 'Invalid base64Data payload' });
      return;
    }
    audioBuffer = Buffer.from(stripped, 'base64');
  } else {
    res.status(400).json({ error: 'Provide JSON { filename, base64Data } or raw audio with x-filename header' });
    return;
  }

  if (
    !rawFilename ||
    rawFilename.includes('/') ||
    rawFilename.includes('\\') ||
    rawFilename.includes('..') ||
    rawFilename.includes('\0')
  ) {
    res.status(400).json({ error: 'Invalid audio filename' });
    return;
  }

  const baseName = path.basename(rawFilename);
  if (
    baseName !== rawFilename ||
    baseName.startsWith('.') ||
    !MUSIC_UPLOAD_FILENAME_RE.test(baseName)
  ) {
    res.status(400).json({
      error: 'Filename must be 1-80 safe characters ending in .mp3, .wav, .m4a, .aac, or .ogg',
    });
    return;
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    res.status(400).json({ error: 'Uploaded audio payload is empty' });
    return;
  }
  if (audioBuffer.length > MAX_AUDIO_UPLOAD_BYTES) {
    res.status(413).json({ error: 'Audio upload exceeds maximum allowed size of 15 MiB' });
    return;
  }

  const ext = path.extname(baseName).toLowerCase();
  if (!detectAudioMagicBytes(audioBuffer, ext)) {
    res.status(400).json({ error: `Invalid or unrecognized ${ext} audio file signature` });
    return;
  }

  if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
  const dest = path.resolve(MUSIC_DIR, baseName);
  if (!isPathInsideMediaDirs(dest)) {
    res.status(403).json({ error: 'Destination path is outside allowed media directory' });
    return;
  }

  fs.writeFileSync(dest, audioBuffer);
  const stat = fs.statSync(dest);
  const track = {
    name: baseName,
    title: path.parse(baseName).name,
    path: dest,
    sizeBytes: stat.size,
    ext,
    modifiedAt: stat.mtime.toISOString(),
  };

  logAuditEvent('studio', 'music.upload', baseName, getClientIp(req), {
    sizeBytes: stat.size,
    ext,
  });

  res.status(201).json({ ok: true, track });
});

app.delete('/api/studio/music/:name', (req, res) => {
  const rawName = String(req.params.name ?? '').trim();
  if (
    !rawName ||
    rawName.includes('/') ||
    rawName.includes('\\') ||
    rawName.includes('..') ||
    rawName.includes('\0') ||
    path.basename(rawName) !== rawName
  ) {
    res.status(400).json({ error: 'Invalid music track filename' });
    return;
  }

  let resolvedPath: string | null = null;
  try {
    resolvedPath = resolveMusicTrackPath(rawName);
  } catch (err: any) {
    const msg = String(err?.message ?? 'Invalid music track');
    if (msg.startsWith('Music track not found')) {
      res.status(404).json({ error: msg });
      return;
    }
    res.status(400).json({ error: msg });
    return;
  }

  if (!resolvedPath || !isPathInsideMediaDirs(resolvedPath) || !fs.existsSync(resolvedPath)) {
    res.status(404).json({ error: `Music track not found: ${rawName}` });
    return;
  }

  fs.unlinkSync(resolvedPath);
  logAuditEvent('studio', 'music.delete', rawName, getClientIp(req));
  res.json({ ok: true });
});

app.get('/api/studio/past-streams', async (req, res) => {
  const platform = String(req.query.platform ?? 'twitch') as 'twitch' | 'kick' | 'youtube';
  const channel = String(req.query.channel ?? '').trim();
  if (!channel) {
    res.status(400).json({ error: 'channel query parameter is required' });
    return;
  }
  try {
    const streams = await listPastStreams(platform, channel);
    res.json({ ok: true, streams });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/studio/probe', async (req, res) => {
  const { source, streamUrl, title } = (req.body ?? {}) as {
    source?: unknown; streamUrl?: unknown; title?: unknown;
  };
  const cleanSource = typeof source === 'string' ? source.trim() : '';
  const cleanStreamUrl = typeof streamUrl === 'string' ? streamUrl.trim() : undefined;
  const cleanTitle = typeof title === 'string' ? title : undefined;
  if (!cleanSource) {
    res.status(400).json({ error: 'source is required' });
    return;
  }
  try {
    const isRemote = /^https?:\/\//i.test(cleanSource);
    let safeLocalDir: string | null = null;

    if (isRemote) {
      await assertSafeRemoteProxyUrl(cleanSource);
    } else {
      const localCheck = validateLocalVideoFilePath(cleanSource, false);
      if (!localCheck.ok) {
        res.status(localCheck.status).json({ error: localCheck.error });
        return;
      }
      safeLocalDir = localCheck.dir;
    }

    if (cleanStreamUrl && /^https?:\/\//i.test(cleanStreamUrl)) {
      await assertSafeRemoteProxyUrl(cleanStreamUrl);
    }

    const media = await probeMediaSource(cleanSource, cleanStreamUrl, cleanTitle);
    if (
      media.sourceType === 'local' &&
      safeLocalDir &&
      !isSystemOrRootDirectory(safeLocalDir) &&
      STUDIO_VIDEO_EXT_RE.test(media.source) &&
      fs.existsSync(media.source) &&
      fs.statSync(media.source).isFile()
    ) {
      registerAllowedMediaDir(safeLocalDir);
    }
    res.json({ ok: true, media });
  } catch (err: any) {
    if (err instanceof ProxyUrlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err?.message ?? 'Probe failed' });
  }
});

app.post('/api/studio/download-vod', async (req, res) => {
  const { url, title } = (req.body ?? {}) as { url?: unknown; title?: unknown };
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    res.status(400).json({ error: 'Valid http/https url is required' });
    return;
  }
  const cleanUrl = url.trim();
  try {
    await assertSafeRemoteProxyUrl(cleanUrl);
    const job = startVodDownload(cleanUrl, typeof title === 'string' ? title : undefined);
    res.json({ ok: true, job });
  } catch (err: any) {
    if (err instanceof ProxyUrlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err?.message ?? 'Failed to start VOD download' });
  }
});

app.get('/api/studio/downloads/:id', (req, res) => {
  const job = vodDownloads.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Download job not found' });
    return;
  }
  res.json({ ok: true, job });
});

app.post('/api/studio/browse-file', (_req, res) => {
  if (process.platform !== 'win32') {
    res.status(400).json({ error: 'Native file dialog is only supported on Windows desktop host' });
    return;
  }
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$d = New-Object System.Windows.Forms.OpenFileDialog;',
    "$d.Filter = 'Video Files (*.mp4;*.mkv;*.mov;*.webm;*.ts;*.flv;*.avi)|*.mp4;*.mkv;*.mov;*.webm;*.ts;*.flv;*.avi|All Files (*.*)|*.*';",
    '$d.Title = "Select a recorded stream or video for Clipper Studio";',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
  ].join(' ');

  const proc = spawn('powershell', ['-NoProfile', '-STA', '-Command', psScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let responded = false;
  proc.stdout.on('data', (d) => (out += d.toString()));
  proc.on('error', (err) => {
    if (responded) return;
    responded = true;
    res.status(500).json({ error: err.message });
  });
  proc.on('close', () => {
    if (responded) return;
    responded = true;
    const chosen = out.trim();
    if (chosen) {
      const check = validateLocalVideoFilePath(chosen, false);
      if (check.ok) {
        registerAllowedMediaDir(check.dir);
      }
    }
    res.json({ ok: Boolean(chosen), path: chosen || null });
  });
});

/** HTTP 206 Byte-Range local video streaming for smooth browser timeline scrubbing */
app.get('/api/studio/stream', (req, res) => {
  const rawPath = String(req.query.path ?? '').trim();
  if (!rawPath) {
    res.status(400).send('path query parameter is required');
    return;
  }

  const filePath = path.resolve(rawPath);
  if (!isPathInsideMediaDirs(filePath)) {
    res.status(403).send('Access denied: path outside allowed media directories');
    return;
  }
  if (!STUDIO_VIDEO_EXT_RE.test(filePath)) {
    res.status(403).send('Unsupported file type');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.status(404).send('File not found');
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === '.webm'
      ? 'video/webm'
      : ext === '.mkv'
        ? 'video/x-matroska'
        : ext === '.mov'
          ? 'video/quicktime'
          : 'video/mp4';
  const range = req.headers.range;

  if (range) {
    if (fileSize === 0) {
      res.setHeader('Content-Range', 'bytes */0');
      res.status(416).send('Range Not Satisfiable');
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (!match) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).send('Range Not Satisfiable');
      return;
    }

    const [, startStr, endStr] = match;
    if (!startStr && !endStr) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).send('Range Not Satisfiable');
      return;
    }

    let start: number;
    let end: number;
    if (!startStr && endStr) {
      const suffixLen = Number.parseInt(endStr, 10);
      if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        res.status(416).send('Range Not Satisfiable');
        return;
      }
      start = Math.max(0, fileSize - suffixLen);
      end = fileSize - 1;
    } else {
      start = Number.parseInt(startStr!, 10);
      end = endStr ? Math.min(fileSize - 1, Number.parseInt(endStr, 10)) : fileSize - 1;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= fileSize || end < start) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).send('Range Not Satisfiable');
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': mime,
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

/** HLS CORS proxy so hls.js can play Twitch/Kick VOD .m3u8 streams in the browser */
app.get('/api/studio/hls-proxy', async (req, res) => {
  const targetUrl = String(req.query.url ?? '').trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    res.status(400).send('Invalid URL');
    return;
  }
  try {
    const { response: upstream, finalUrl } = await safeProxyFetch(
      targetUrl,
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
      3,
      HLS_PROXY_MAX_BYTES,
    );
    if (!upstream.ok) {
      res.status(upstream.status).send(`Upstream error ${upstream.status}`);
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist =
      finalUrl.includes('.m3u8') ||
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegurl');

    if (isPlaylist) {
      const text = await readLimitedText(upstream, HLS_PROXY_MAX_BYTES);
      const base = new URL(finalUrl);
      const rewritten = text
        .split(/\r?\n/)
        .map((line) => {
          const t = line.trim();
          if (!t) return line;
          if (t.startsWith('#')) {
            return line.replace(/URI="([^"]+)"/g, (m, uri) => {
              try {
                const absUrl = new URL(uri, base);
                if (absUrl.protocol !== 'http:' && absUrl.protocol !== 'https:') return m;
                return `URI="/api/studio/hls-proxy?url=${encodeURIComponent(absUrl.toString())}"`;
              } catch {
                return m;
              }
            });
          }
          try {
            const absUrl = new URL(t, base);
            if (absUrl.protocol !== 'http:' && absUrl.protocol !== 'https:') return '';
            return `/api/studio/hls-proxy?url=${encodeURIComponent(absUrl.toString())}`;
          } catch {
            return '';
          }
        })
        .join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(rewritten);
      return;
    }

    res.setHeader('Content-Type', contentType || 'video/mp2t');
    if (upstream.body) {
      const stream = Readable.fromWeb(upstream.body as any);
      pipeWithByteLimit(stream, res, HLS_PROXY_MAX_BYTES);
    } else {
      res.end();
    }
  } catch (err: any) {
    if (err instanceof ProxyUrlError) {
      res.status(err.statusCode).send(err.message);
      return;
    }
    res.status(502).send(err.message);
  }
});

/** Range-capable proxy for direct remote progressive MP4 streams */
app.get('/api/studio/media-proxy', async (req, res) => {
  const targetUrl = String(req.query.url ?? '').trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    res.status(400).send('Invalid URL');
    return;
  }
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const { response: upstream } = await safeProxyFetch(targetUrl, headers, 3, MEDIA_PROXY_MAX_BYTES);
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (upstream.body) {
      const stream = Readable.fromWeb(upstream.body as any);
      pipeWithByteLimit(stream, res, MEDIA_PROXY_MAX_BYTES);
    } else {
      res.end();
    }
  } catch (err: any) {
    if (err instanceof ProxyUrlError) {
      res.status(err.statusCode).send(err.message);
      return;
    }
    res.status(502).send(err.message);
  }
});

async function validateStudioSourceAndStream(
  rawSource: string,
  rawStreamUrl?: string,
): Promise<string> {
  const cleanSource = rawSource.trim();
  if (/^https?:\/\//i.test(cleanSource)) {
    await assertSafeRemoteProxyUrl(cleanSource);
  } else {
    const localCheck = validateLocalVideoFilePath(cleanSource, false);
    if (!localCheck.ok) {
      throw new ProxyUrlError(localCheck.status, localCheck.error);
    }
  }
  if (rawStreamUrl && /^https?:\/\//i.test(rawStreamUrl.trim())) {
    await assertSafeRemoteProxyUrl(rawStreamUrl.trim());
  }
  return cleanSource;
}

app.post('/api/studio/detect-facecam', async (req, res) => {
  const { source, streamUrl, timestampSec } = (req.body ?? {}) as {
    source?: unknown; streamUrl?: unknown; timestampSec?: unknown;
  };
  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ error: 'source is required' });
    return;
  }
  const cleanStreamUrl = typeof streamUrl === 'string' ? streamUrl.trim() : undefined;
  try {
    const cleanSource = await validateStudioSourceAndStream(source, cleanStreamUrl);
    const mediaTarget = cleanStreamUrl && cleanStreamUrl.includes('.m3u8') ? cleanStreamUrl : cleanSource;
    const result = await detectFacecamAtTimestamp(mediaTarget, Number(timestampSec ?? 0));
    res.json({ ok: true, ...result });
  } catch (err: any) {
    if (err instanceof ProxyUrlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err?.message ?? 'Facecam detection failed' });
  }
});

app.post('/api/studio/audio-peaks', async (req, res) => {
  const { source, streamUrl, clipDurationSec } = (req.body ?? {}) as {
    source?: unknown;
    streamUrl?: unknown;
    clipDurationSec?: unknown;
  };
  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ error: 'source file path or URL is required' });
    return;
  }
  const cleanStreamUrl = typeof streamUrl === 'string' ? streamUrl.trim() : undefined;
  try {
    const cleanSource = await validateStudioSourceAndStream(source, cleanStreamUrl);
    const scan = await scanStudioAudioPeaks(cleanSource, cleanStreamUrl, Number(clipDurationSec ?? 25));
    res.json({ ok: true, ...scan });
  } catch (err) {
    if (err instanceof ProxyUrlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleErrorStatus(res, err);
  }
});

app.post('/api/studio/clip', async (req, res) => {
  const {
    source,
    startSec,
    endSec,
    title,
    layout,
    facecamPosition,
    captionStyle,
    watermarkText,
    hookTitleText,
    audioNormalize,
    silenceCut,
    trimSilence,
    musicTrack,
    musicPath,
    musicVolume,
    audioDeltaDb,
    sourcePlatform,
    streamUrl,
  } = (req.body ?? {}) as {
    source?: unknown;
    startSec?: unknown;
    endSec?: unknown;
    title?: unknown;
    layout?: ClipLayout;
    facecamPosition?: FacecamPosition;
    captionStyle?: CaptionStyle;
    watermarkText?: unknown;
    hookTitleText?: unknown;
    audioNormalize?: unknown;
    silenceCut?: unknown;
    trimSilence?: unknown;
    musicTrack?: unknown;
    musicPath?: unknown;
    musicVolume?: unknown;
    audioDeltaDb?: unknown;
    sourcePlatform?: unknown;
    streamUrl?: unknown;
  };

  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ error: 'source file path or URL is required' });
    return;
  }
  if (layout !== undefined && !VALID_CLIP_LAYOUTS.has(layout)) {
    res.status(400).json({ error: 'Invalid layout' });
    return;
  }
  if (facecamPosition !== undefined && !VALID_FACECAM_POSITIONS.has(facecamPosition)) {
    res.status(400).json({ error: 'Invalid facecamPosition' });
    return;
  }
  if (captionStyle !== undefined && !VALID_CAPTION_STYLES.has(captionStyle)) {
    res.status(400).json({ error: 'Invalid captionStyle' });
    return;
  }

  const cleanStreamUrl = typeof streamUrl === 'string' ? streamUrl.trim() : undefined;
  const resolvedSilenceCut = silenceCut ?? trimSilence;
  const resolvedMusicTrack =
    typeof musicTrack === 'string'
      ? musicTrack
      : (typeof musicPath === 'string' ? musicPath : undefined);

  try {
    const cleanSource = await validateStudioSourceAndStream(source, cleanStreamUrl);
    const clip = await cutManualClip({
      source: cleanSource,
      startSec: Number(startSec ?? 0),
      endSec: Number(endSec ?? 20),
      title: typeof title === 'string' ? title : undefined,
      layout: layout ?? 'split',
      facecamPosition: facecamPosition ?? 'auto',
      captionStyle: captionStyle ?? 'none',
      watermarkText: typeof watermarkText === 'string' ? watermarkText : '',
      hookTitleText: typeof hookTitleText === 'string' ? hookTitleText : undefined,
      audioNormalize: Boolean(audioNormalize),
      silenceCut: Boolean(resolvedSilenceCut),
      musicTrack: resolvedMusicTrack,
      musicVolume: musicVolume !== undefined ? Number(musicVolume) : undefined,
      audioDeltaDb: audioDeltaDb !== undefined ? Number(audioDeltaDb) : undefined,
      sourcePlatform: typeof sourcePlatform === 'string' ? sourcePlatform : undefined,
      streamUrl: cleanStreamUrl,
    });
    void dispatchOutboundWebhooks('clip.ready', { source: 'studio.manual', clip });
    res.json({ ok: true, clip });
  } catch (err) {
    if (err instanceof ProxyUrlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleErrorStatus(res, err);
  }
});

app.post('/api/studio/auto-clip-batch', async (req, res) => {
  const {
    source,
    streamUrl,
    clipDurationSec,
    maxClips,
    count,
    limit,
    titlePrefix,
    layout,
    facecamPosition,
    captionStyle,
    watermarkText,
    hookTitleText,
    audioNormalize,
    silenceCut,
    trimSilence,
    musicTrack,
    musicPath,
    musicVolume,
    sourcePlatform,
  } = (req.body ?? {}) as {
    source?: unknown;
    streamUrl?: unknown;
    clipDurationSec?: unknown;
    maxClips?: unknown;
    count?: unknown;
    limit?: unknown;
    titlePrefix?: unknown;
    layout?: ClipLayout;
    facecamPosition?: FacecamPosition;
    captionStyle?: CaptionStyle;
    watermarkText?: unknown;
    hookTitleText?: unknown;
    audioNormalize?: unknown;
    silenceCut?: unknown;
    trimSilence?: unknown;
    musicTrack?: unknown;
    musicPath?: unknown;
    musicVolume?: unknown;
    sourcePlatform?: unknown;
  };

  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ error: 'source file path or URL is required' });
    return;
  }
  if (layout !== undefined && !VALID_CLIP_LAYOUTS.has(layout)) {
    res.status(400).json({ error: 'Invalid layout' });
    return;
  }
  if (facecamPosition !== undefined && !VALID_FACECAM_POSITIONS.has(facecamPosition)) {
    res.status(400).json({ error: 'Invalid facecamPosition' });
    return;
  }
  if (captionStyle !== undefined && !VALID_CAPTION_STYLES.has(captionStyle)) {
    res.status(400).json({ error: 'Invalid captionStyle' });
    return;
  }

  const cleanStreamUrl = typeof streamUrl === 'string' ? streamUrl.trim() : undefined;
  const resolvedMaxClipsRaw = maxClips ?? count ?? limit;
  const resolvedSilenceCut = silenceCut ?? trimSilence;
  const resolvedMusicTrack =
    typeof musicTrack === 'string'
      ? musicTrack
      : (typeof musicPath === 'string' ? musicPath : undefined);

  try {
    const cleanSource = await validateStudioSourceAndStream(source, cleanStreamUrl);
    const result = await autoClipTopMoments({
      source: cleanSource,
      streamUrl: cleanStreamUrl,
      clipDurationSec: clipDurationSec !== undefined ? Number(clipDurationSec) : undefined,
      maxClips: resolvedMaxClipsRaw !== undefined ? Number(resolvedMaxClipsRaw) : undefined,
      titlePrefix: typeof titlePrefix === 'string' ? titlePrefix : undefined,
      layout: layout ?? 'split',
      facecamPosition: facecamPosition ?? 'auto',
      captionStyle: captionStyle ?? 'none',
      watermarkText: typeof watermarkText === 'string' ? watermarkText : undefined,
      hookTitleText: typeof hookTitleText === 'string' ? hookTitleText : undefined,
      audioNormalize: Boolean(audioNormalize),
      silenceCut: Boolean(resolvedSilenceCut),
      musicTrack: resolvedMusicTrack,
      musicVolume: musicVolume !== undefined ? Number(musicVolume) : undefined,
      sourcePlatform: typeof sourcePlatform === 'string' ? sourcePlatform : undefined,
    });
    for (const clip of result.clips) {
      void dispatchOutboundWebhooks('clip.ready', { source: 'studio.auto_batch', clip });
    }
    void dispatchOutboundWebhooks('job.completed', {
      source: 'studio.auto_batch',
      clipsCount: result.clips.length,
      clipIds: result.clips.map((c) => c.id),
    });
    res.json({ ok: true, clipIds: result.clips.map(c => c.id), ...result });
  } catch (err) {
    if (err instanceof ProxyUrlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleErrorStatus(res, err);
  }
});

app.post('/api/studio/compile-montage', async (req, res) => {
  const { clipIds, title, musicTrack, musicPath, musicVolume, audioNormalize } = (req.body ?? {}) as {
    clipIds?: unknown;
    title?: unknown;
    musicTrack?: unknown;
    musicPath?: unknown;
    musicVolume?: unknown;
    audioNormalize?: unknown;
  };

  if (!Array.isArray(clipIds) || clipIds.length < 2) {
    res.status(400).json({ error: 'clipIds array with at least 2 clip IDs is required' });
    return;
  }

  const resolvedMusicTrack =
    typeof musicTrack === 'string'
      ? musicTrack
      : (typeof musicPath === 'string' ? musicPath : undefined);

  try {
    assertEntitlement(undefined, true);
    const clip = await compileMontageReel(
      clipIds as string[],
      typeof title === 'string' ? title : undefined,
      resolvedMusicTrack,
      musicVolume !== undefined ? Number(musicVolume) : undefined,
      Boolean(audioNormalize),
    );
    void dispatchOutboundWebhooks('clip.ready', { source: 'studio.montage', clip });
    res.json({ ok: true, id: clip.id, url: `/api/studio/stream?path=${encodeURIComponent(clip.filePath)}`, clip });
  } catch (err) {
    handleErrorStatus(res, err);
  }
});

// ── Scheduled Auto-Clip Jobs ──────────────────────────────────────────────
const scheduledCronTasks = new Map<string, cron.ScheduledTask>();
const scheduledJobInFlight = new Set<string>();

function stopScheduledCronTask(id: string): void {
  const existing = scheduledCronTasks.get(id);
  if (existing) {
    existing.stop();
    scheduledCronTasks.delete(id);
  }
}

function registerScheduledCronTask(job: ScheduledJobRecord): void {
  stopScheduledCronTask(job.id);
  if (job.enabled !== 1 || !cron.validate(job.cron_expr)) return;

  const task = cron.schedule(job.cron_expr, () => {
    if (scheduledJobInFlight.has(job.id)) return;
    scheduledJobInFlight.add(job.id);
    void (async () => {
      try {
        const latest = getScheduledJobById(job.id);
        if (!latest || latest.enabled !== 1) return;
        const result = await autoClipTopMoments({
          source: latest.video_path,
          maxClips: latest.max_clips,
          layout: VALID_CLIP_LAYOUTS.has(latest.layout as ClipLayout)
            ? (latest.layout as ClipLayout)
            : 'split',
          captionStyle: VALID_CAPTION_STYLES.has(latest.caption_style as CaptionStyle)
            ? (latest.caption_style as CaptionStyle)
            : 'none',
        });
        updateScheduledJobLastRun(latest.id);
        for (const clip of result.clips) {
          void dispatchOutboundWebhooks('clip.ready', {
            source: 'scheduled.autoclip',
            jobId: latest.id,
            clip,
          });
        }
        void dispatchOutboundWebhooks('job.completed', {
          source: 'scheduled.autoclip',
          jobId: latest.id,
          clipsCount: result.clips.length,
        });
      } catch (err) {
        console.error(`[scheduled-jobs] Job ${job.id} failed:`, err);
      } finally {
        scheduledJobInFlight.delete(job.id);
      }
    })();
  });
  scheduledCronTasks.set(job.id, task);
}

app.get('/api/studio/scheduled-jobs', (_req, res) => {
  res.json({ ok: true, jobs: listScheduledJobs() });
});

app.post('/api/studio/schedule-autoclip', async (req, res) => {
  const { videoPath, source, cronExpr, cron: cronAlias, maxClips, count, limit, layout, captionStyle } = (req.body ?? {}) as {
    videoPath?: unknown;
    source?: unknown;
    cronExpr?: unknown;
    cron?: unknown;
    maxClips?: unknown;
    count?: unknown;
    limit?: unknown;
    layout?: unknown;
    captionStyle?: unknown;
  };

  const rawSource = typeof videoPath === 'string' ? videoPath.trim() : (typeof source === 'string' ? source.trim() : '');
  const rawCron = typeof cronExpr === 'string' ? cronExpr.trim() : (typeof cronAlias === 'string' ? cronAlias.trim() : '');

  if (!rawSource) {
    res.status(400).json({ error: 'videoPath (or source) is required' });
    return;
  }
  if (!rawCron || !cron.validate(rawCron)) {
    res.status(400).json({ error: 'Valid cronExpr is required' });
    return;
  }
  if (layout !== undefined && (typeof layout !== 'string' || !VALID_CLIP_LAYOUTS.has(layout as ClipLayout))) {
    res.status(400).json({ error: 'Invalid layout' });
    return;
  }
  if (captionStyle !== undefined && (typeof captionStyle !== 'string' || !VALID_CAPTION_STYLES.has(captionStyle as CaptionStyle))) {
    res.status(400).json({ error: 'Invalid captionStyle' });
    return;
  }

  const rawMax = maxClips ?? count ?? limit;
  const parsedMax = rawMax !== undefined ? Number(rawMax) : 3;
  if (!Number.isFinite(parsedMax) || parsedMax < 1 || parsedMax > 5) {
    res.status(400).json({ error: 'maxClips must be between 1 and 5' });
    return;
  }

  let validatedPath = rawSource;
  if (/^https?:\/\//i.test(rawSource)) {
    try {
      await assertSafeRemoteProxyUrl(rawSource);
    } catch (err: any) {
      if (err instanceof ProxyUrlError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err?.message ?? 'Invalid remote URL' });
      return;
    }
  } else {
    const localCheck = validateLocalVideoFilePath(rawSource, true);
    if (!localCheck.ok) {
      res.status(localCheck.status).json({ error: localCheck.error });
      return;
    }
    validatedPath = localCheck.resolved;
  }

  const job = createScheduledJob({
    videoPath: validatedPath,
    cronExpr: rawCron,
    maxClips: Math.trunc(parsedMax),
    layout: typeof layout === 'string' ? layout : 'split',
    captionStyle: typeof captionStyle === 'string' ? captionStyle : 'none',
    enabled: true,
  });
  registerScheduledCronTask(job);
  logAuditEvent('studio', 'scheduled_job.create', job.id, getClientIp(req), { cronExpr: job.cron_expr });
  res.status(201).json({ ok: true, job });
});

app.post('/api/studio/scheduled-jobs/:id/toggle', (req, res) => {
  const { enabled } = (req.body ?? {}) as { enabled?: unknown };
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean when provided' });
    return;
  }
  const updated = toggleScheduledJob(req.params.id, typeof enabled === 'boolean' ? enabled : undefined);
  if (!updated) {
    res.status(404).json({ error: 'Scheduled job not found' });
    return;
  }
  if (updated.enabled === 1) {
    registerScheduledCronTask(updated);
  } else {
    stopScheduledCronTask(updated.id);
  }
  res.json({ ok: true, job: updated });
});

app.delete('/api/studio/scheduled-jobs/:id', (req, res) => {
  stopScheduledCronTask(req.params.id);
  const deleted = deleteScheduledJob(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Scheduled job not found' });
    return;
  }
  logAuditEvent('studio', 'scheduled_job.delete', req.params.id, getClientIp(req));
  res.json({ ok: true });
});

// ── Upgrade Link ──────────────────────────────────────────────────────────
/** Returns the Kelviq payment link (or dynamic checkout session URL) for Pro / Ultra */
app.get('/api/licensing/upgrade-link', async (req, res) => {
  const planId = String(req.query.plan ?? '').trim().toLowerCase();
  if ((planId !== 'pro' && planId !== 'ultra') || !planExists(planId)) {
    res.status(400).json({ error: 'plan query param must be "pro" or "ultra"' });
    return;
  }
  const plan = getPlanById(planId);
  let url = (plan.kelviq_payment_link ?? '').trim();
  if (!url) {
    try {
      url = await resolveCheckoutUrl(planId);
    } catch (err: any) {
      res.status(404).json({
        error: err?.message ?? 'No payment link configured for this plan. Set it in the Admin Dashboard.',
      });
      return;
    }
  }
  res.json({ ok: true, plan: plan.id, name: plan.name, price: plan.price_usd, url });
});

// ── System Version & Git Update Status ────────────────────────────────────
app.get('/api/system/version', async (req, res) => {
  let pkgName = '@clipper/clipper-service';
  let pkgVersion = '0.0.1';
  for (const candidate of [
    path.resolve('apps/clipper-service/package.json'),
    path.resolve('package.json'),
  ]) {
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (parsed.name) pkgName = parsed.name;
        if (parsed.version) pkgVersion = parsed.version;
        break;
      } catch {}
    }
  }

  let gitRepo = false;
  let branch = '';
  let commit = '';
  let shortCommit = '';
  let dirty = false;
  let checkError: string | undefined;
  let remote:
    | { updateAvailable: boolean; ahead: number; behind: number; remoteCommit: string }
    | undefined;

  const runGit = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      cwd: process.cwd(),
      timeout: 8000,
    });
    return stdout.trim();
  };

  try {
    const inside = await runGit(['rev-parse', '--is-inside-work-tree']);
    gitRepo = inside === 'true';
    if (gitRepo) {
      branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
      commit = await runGit(['rev-parse', 'HEAD']);
      shortCommit = await runGit(['rev-parse', '--short', 'HEAD']);
      const statusOut = await runGit(['status', '--porcelain']);
      dirty = statusOut.length > 0;

      const checkRemote = req.query.checkRemote === '1' || req.query.checkRemote === 'true';
      if (checkRemote) {
        try {
          await runGit(['fetch', '--quiet']);
          let upstream = '';
          try {
            upstream = await runGit(['rev-parse', '--abbrev-ref', '@{u}']);
          } catch {
            upstream = branch && branch !== 'HEAD' ? `origin/${branch}` : '';
          }
          if (upstream) {
            const remoteCommit = await runGit(['rev-parse', upstream]);
            const counts = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
            const [aheadStr, behindStr] = counts.split(/\s+/);
            const ahead = Number.parseInt(aheadStr ?? '0', 10) || 0;
            const behind = Number.parseInt(behindStr ?? '0', 10) || 0;
            remote = {
              updateAvailable: behind > 0,
              ahead,
              behind,
              remoteCommit,
            };
          }
        } catch (err: any) {
          checkError = err?.message ?? 'Remote check failed';
        }
      }
    }
  } catch (err: any) {
    checkError = err?.message ?? 'Git unavailable';
  }

  res.json({
    ok: true,
    name: pkgName,
    version: pkgVersion,
    gitRepo,
    branch,
    commit,
    shortCommit,
    dirty,
    ...(checkError ? { checkError } : {}),
    ...(remote ? { remote } : {}),
  });
});

// ── System Diagnostics (Binaries, Storage, DB Counts & Security Posture) ──
async function probeBinaryStatus(
  bin: string,
  args: string[],
): Promise<{ available: boolean; version: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 3000 });
    const firstLine = (stdout || stderr || '').split(/\r?\n/)[0]?.trim() ?? '';
    return { available: true, version: firstLine.slice(0, 120) };
  } catch (err: any) {
    return {
      available: false,
      version: '',
      error: err?.code === 'ENOENT' ? 'Not found in PATH' : String(err?.message ?? 'Check failed').slice(0, 160),
    };
  }
}

app.get('/api/system/diagnostics', async (_req, res) => {
  const ffmpegBin = process.env.FFMPEG_BIN_PATH ?? 'ffmpeg';
  const ffprobeBin = process.env.FFPROBE_BIN_PATH ?? 'ffprobe';
  const ytdlpBin = process.env.YTDLP_BIN_PATH ?? 'yt-dlp';
  const streamlinkBin = process.env.STREAMLINK_BIN_PATH ?? 'streamlink';
  const pythonBin = process.env.PYTHON_BIN_PATH ?? 'python';

  const [ffmpeg, ffprobe, ytDlp, streamlink, python, opencv] = await Promise.all([
    probeBinaryStatus(ffmpegBin, ['-version']),
    probeBinaryStatus(ffprobeBin, ['-version']),
    probeBinaryStatus(ytdlpBin, ['--version']),
    probeBinaryStatus(streamlinkBin, ['--version']),
    probeBinaryStatus(pythonBin, ['--version']),
    probeBinaryStatus(pythonBin, ['-c', 'import cv2; print(cv2.__version__)']),
  ]);

  const countTable = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
    return Number(row?.cnt ?? 0);
  };

  const activeApiKeyCount = Number(
    (db.prepare('SELECT COUNT(*) AS cnt FROM api_keys WHERE active = 1').get() as { cnt: number })?.cnt ?? 0,
  );
  const kelviqWebhookSecret = (
    getSetting('kelviq_webhook_secret') ||
    process.env.KELVIQ_WEBHOOK_SECRET ||
    ''
  ).trim();

  res.json({
    ok: true,
    binaries: {
      ffmpeg,
      ffprobe,
      ytDlp,
      streamlink,
      python,
      opencv,
    },
    storage: getStorageInfo(),
    counts: {
      clips: countTable('clips'),
      ingest_jobs: countTable('ingest_jobs'),
      clip_presets: countTable('clip_presets'),
      scheduled_jobs: countTable('scheduled_jobs'),
      outbound_webhooks: countTable('outbound_webhooks'),
    },
    security: {
      usingDefaultPassword: isUsingDefaultAdminPassword(),
      kelviqWebhookSecretConfigured: Boolean(kelviqWebhookSecret),
      requireApiKey: process.env.REQUIRE_API_KEY === 'true',
      apiKeyCount: activeApiKeyCount,
    },
    ts: new Date().toISOString(),
  });
});

// ── Notification Service Proxy Routes (respects connect-src 'self') ───────
const getNotificationServiceBaseUrl = (): string =>
  (process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:4003').replace(/\/+$/, '');

app.get('/api/notifications/log', async (req, res) => {
  try {
    const qs = req.query.limit !== undefined ? `?limit=${encodeURIComponent(String(req.query.limit))}` : '';
    const upstream = await fetch(`${getNotificationServiceBaseUrl()}/api/notifications/log${qs}`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: `Notification service unreachable: ${err?.message ?? 'connection failed'}` });
  }
});

app.post('/api/notifications/test', async (_req, res) => {
  try {
    const upstream = await fetch(`${getNotificationServiceBaseUrl()}/api/notifications/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: `Notification service unreachable: ${err?.message ?? 'connection failed'}` });
  }
});

// ── Extended Analytics Summary ────────────────────────────────────────────
app.get('/api/analytics/summary', (_req, res) => {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS totalClips,
      COALESCE(SUM(duration_sec), 0) AS totalDurationSec,
      COALESCE(SUM(file_size_bytes), 0) AS storageUsedBytes,
      COALESCE(AVG(NULLIF(virality_score, 0)), 0) AS avgViralityScore
    FROM clips
  `).get() as { totalClips: number; totalDurationSec: number; storageUsedBytes: number; avgViralityScore: number };

  const clipsThisMonth = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM clips
    WHERE created_at >= strftime('%Y-%m-01','now')
  `).get() as { cnt: number }).cnt;

  const topPlatforms = db.prepare(`
    SELECT source_platform AS platform, COUNT(*) AS count
    FROM clips GROUP BY source_platform ORDER BY count DESC LIMIT 5
  `).all() as Array<{ platform: string; count: number }>;

  const clipsPerDay = db.prepare(`
    SELECT date(created_at) AS date, COUNT(*) AS count
    FROM clips
    WHERE created_at >= date('now', '-13 days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all() as Array<{ date: string; count: number }>;

  res.json({
    ok: true,
    totalClips: Number(totals.totalClips),
    totalDurationSec: Number(totals.totalDurationSec),
    storageUsedBytes: Number(totals.storageUsedBytes),
    avgViralityScore: Math.round(Number(totals.avgViralityScore)),
    clipsThisMonth: Number(clipsThisMonth),
    topPlatforms,
    clipsPerDay,
  });
});

// ── Clip Tags, Notes, Favourites & Batch Delete ───────────────────────────
app.post('/api/clipper/clips/:id/tags', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  const { tags } = (req.body ?? {}) as { tags?: unknown };
  if (!Array.isArray(tags)) { res.status(400).json({ error: 'tags must be an array' }); return; }
  if (tags.length > 10) { res.status(400).json({ error: 'Maximum 10 tags allowed' }); return; }
  const cleaned: string[] = [];
  for (const t of tags) {
    if (typeof t !== 'string') { res.status(400).json({ error: 'Each tag must be a string' }); return; }
    const tag = t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!tag || tag.length > 32) { res.status(400).json({ error: `Tag "${t}" is invalid or too long` }); return; }
    cleaned.push(tag);
  }
  updateClipTags(clipId, cleaned);
  res.json({ ok: true, tags: cleaned });
});

app.patch('/api/clipper/clips/:id/notes', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  const { notes } = (req.body ?? {}) as { notes?: unknown };
  if (typeof notes !== 'string') { res.status(400).json({ error: 'notes must be a string' }); return; }
  if (notes.length > 2000) { res.status(400).json({ error: 'Notes must be 2000 chars or fewer' }); return; }
  updateClipNotes(clipId, notes);
  res.json({ ok: true });
});

app.post('/api/clipper/clips/:id/favourite', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) { res.status(404).json({ error: 'Clip not found' }); return; }
  const isFavourite = toggleClipFavourite(clipId);
  res.json({ ok: true, isFavourite });
});

app.delete('/api/clipper/clips', (req, res) => {
  if (!hasClipDeleteAuthorization(req, res)) {
    res.status(403).json({
      error: 'Forbidden: batch clip deletion requires X-Clipper-CSRF: 1, an admin session, or a valid API key',
    });
    return;
  }

  const { ids } = (req.body ?? {}) as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids must be a non-empty array' });
    return;
  }
  if (ids.length > 50) {
    res.status(400).json({ error: 'Cannot delete more than 50 clips at once' });
    return;
  }
  const errors: string[] = [];
  let deleted = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim()) {
      errors.push('invalid clip id');
      continue;
    }
    const clip = db.prepare('SELECT file_path, thumbnail_path FROM clips WHERE id=?').get(id) as
      | { file_path?: string; thumbnail_path?: string }
      | undefined;
    if (!clip) { errors.push(`${id}: not found`); continue; }
    try {
      safeUnlinkMediaFile(clip.file_path);
      safeUnlinkMediaFile(clip.thumbnail_path);
      if (deleteClipCascade(id)) {
        deleted += 1;
      } else {
        errors.push(`${id}: delete failed`);
      }
    } catch (e: any) {
      errors.push(`${id}: ${e?.message ?? 'delete failed'}`);
    }
  }
  logAuditEvent('clipper', 'clips.batch_delete', `${deleted} clip(s)`, getClientIp(req), {
    requestedCount: ids.length,
    deleted,
    errorsCount: errors.length,
  });
  res.json({ ok: true, deleted, errors });
});

app.delete('/api/clipper/clips/:id', (req, res) => {
  if (!hasClipDeleteAuthorization(req, res)) {
    res.status(403).json({
      error: 'Forbidden: clip deletion requires X-Clipper-CSRF: 1, an admin session, or a valid API key',
    });
    return;
  }

  const clipId = String(req.params.id ?? '').trim();
  const clip = db.prepare('SELECT id, file_path, thumbnail_path FROM clips WHERE id=?').get(clipId) as
    | { id: string; file_path?: string; thumbnail_path?: string }
    | undefined;
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  safeUnlinkMediaFile(clip.file_path);
  safeUnlinkMediaFile(clip.thumbnail_path);
  const deleted = deleteClipCascade(clip.id);
  logAuditEvent('clipper', 'clip.delete', clip.id, getClientIp(req), { deleted });
  res.json({ ok: true, deleted });
});

// ── Collections API (/api/clipper/collections*) ───────────────────────────
app.get('/api/clipper/collections', (_req, res) => {
  res.json({ ok: true, collections: listCollections() });
});

app.post('/api/clipper/collections', (req, res) => {
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { name, description, color } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
    res.status(400).json({ error: 'name must be 1 to 80 characters' });
    return;
  }
  if (description !== undefined && (typeof description !== 'string' || description.trim().length > 300)) {
    res.status(400).json({ error: 'description must be a string of 300 characters or fewer' });
    return;
  }
  if (color !== undefined && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color.trim()))) {
    res.status(400).json({ error: 'color must be a 6-digit hex color like #6366f1' });
    return;
  }

  const collection = createCollection({
    name: name.trim(),
    description: typeof description === 'string' ? description.trim() : '',
    color: typeof color === 'string' ? color.trim() : '#6366f1',
  });
  logAuditEvent('clipper', 'collection.create', collection.id, getClientIp(req), { name: collection.name });
  res.status(201).json({ ok: true, collection });
});

app.put('/api/clipper/collections/:id', (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!getCollectionById(id)) {
    res.status(404).json({ error: 'Collection not found' });
    return;
  }
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { name, description, color } = req.body;
  const patch: { name?: string; description?: string; color?: string } = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
      res.status(400).json({ error: 'name must be 1 to 80 characters' });
      return;
    }
    patch.name = name.trim();
  }
  if (description !== undefined) {
    if (typeof description !== 'string' || description.trim().length > 300) {
      res.status(400).json({ error: 'description must be a string of 300 characters or fewer' });
      return;
    }
    patch.description = description.trim();
  }
  if (color !== undefined) {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color.trim())) {
      res.status(400).json({ error: 'color must be a 6-digit hex color like #6366f1' });
      return;
    }
    patch.color = color.trim();
  }

  updateCollection(id, patch);
  const collection = getCollectionById(id)!;
  logAuditEvent('clipper', 'collection.update', id, getClientIp(req), patch);
  res.json({ ok: true, collection });
});

app.delete('/api/clipper/collections/:id', (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const deleted = deleteCollection(id);
  if (!deleted) {
    res.status(404).json({ error: 'Collection not found' });
    return;
  }
  logAuditEvent('clipper', 'collection.delete', id, getClientIp(req));
  res.json({ ok: true });
});

app.get('/api/clipper/collections/:id/clips', (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const collection = getCollectionById(id);
  if (!collection) {
    res.status(404).json({ error: 'Collection not found' });
    return;
  }
  const clips = listCollectionClipDetails(id);
  res.json({ ok: true, collection, clips });
});

app.post('/api/clipper/collections/:id/clips', (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!getCollectionById(id)) {
    res.status(404).json({ error: 'Collection not found' });
    return;
  }
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { clipId, position } = req.body;
  if (typeof clipId !== 'string' || !clipId.trim()) {
    res.status(400).json({ error: 'clipId is required' });
    return;
  }
  const cleanClipId = clipId.trim();
  if (!clipExists(cleanClipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  let pos = 0;
  if (position !== undefined) {
    const parsedPos = Number(position);
    if (!Number.isFinite(parsedPos) || parsedPos < 0) {
      res.status(400).json({ error: 'position must be a non-negative finite number' });
      return;
    }
    pos = Math.trunc(parsedPos);
  }

  addClipToCollection(id, cleanClipId, pos);
  logAuditEvent('clipper', 'collection.add_clip', id, getClientIp(req), { clipId: cleanClipId, position: pos });
  res.json({ ok: true, collectionId: id, clipId: cleanClipId, position: pos });
});

app.delete('/api/clipper/collections/:id/clips/:clipId', (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const clipId = String(req.params.clipId ?? '').trim();
  if (!getCollectionById(id)) {
    res.status(404).json({ error: 'Collection not found' });
    return;
  }
  const removed = removeClipFromCollection(id, clipId);
  if (!removed) {
    res.status(404).json({ error: 'Clip not found in collection' });
    return;
  }
  logAuditEvent('clipper', 'collection.remove_clip', id, getClientIp(req), { clipId });
  res.json({ ok: true });
});

app.get('/api/clipper/clips/:id/collections', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  res.json({ ok: true, collections: getClipCollections(clipId) });
});

// ── Clip Ratings, Chapters, Comments, A/B Testing & Share Links ───────────
app.post('/api/clipper/clips/:id/rate', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { rating } = req.body;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
    return;
  }
  rateClip(clipId, rating);
  logAuditEvent('clipper', 'clip.rate', clipId, getClientIp(req), { rating });
  res.json({ ok: true, rating });
});

app.get('/api/clipper/clips/:id/chapters', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  res.json({ ok: true, chapters: listChapters(clipId) });
});

app.post('/api/clipper/clips/:id/chapters', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { title, startSec } = req.body;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) {
    res.status(400).json({ error: 'title must be 1 to 120 characters' });
    return;
  }
  const parsedStart = typeof startSec === 'number'
    ? startSec
    : (typeof startSec === 'string' && startSec.trim() !== '' ? Number(startSec) : NaN);
  if (!Number.isFinite(parsedStart) || parsedStart < 0) {
    res.status(400).json({ error: 'startSec must be a finite number >= 0' });
    return;
  }

  const chapter = addChapter(clipId, title.trim(), parsedStart);
  logAuditEvent('clipper', 'clip.chapter_add', clipId, getClientIp(req), {
    chapterId: chapter.id,
    startSec: chapter.start_sec,
  });
  res.status(201).json({ ok: true, chapter });
});

app.delete('/api/clipper/clips/:id/chapters/:chapterId', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  const chapterId = String(req.params.chapterId ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  const deleted = deleteChapter(chapterId, clipId);
  if (!deleted) {
    res.status(404).json({ error: 'Chapter not found' });
    return;
  }
  logAuditEvent('clipper', 'clip.chapter_delete', clipId, getClientIp(req), { chapterId });
  res.json({ ok: true });
});

app.get('/api/clipper/clips/:id/comments', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  res.json({ ok: true, comments: listComments(clipId) });
});

app.post('/api/clipper/clips/:id/comments', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { body, author, timestampSec } = req.body;
  if (typeof body !== 'string' || !body.trim() || body.trim().length > 1000) {
    res.status(400).json({ error: 'body must be 1 to 1000 characters' });
    return;
  }
  let cleanAuthor = 'admin';
  if (author !== undefined && author !== null) {
    if (typeof author !== 'string' || author.trim().length > 50) {
      res.status(400).json({ error: 'author must be a string of 50 characters or fewer' });
      return;
    }
    if (author.trim()) cleanAuthor = author.trim();
  }
  let cleanTs: number | null = null;
  if (timestampSec !== undefined && timestampSec !== null) {
    const parsedTs = typeof timestampSec === 'number'
      ? timestampSec
      : (typeof timestampSec === 'string' && timestampSec.trim() !== '' ? Number(timestampSec) : NaN);
    if (!Number.isFinite(parsedTs) || parsedTs < 0) {
      res.status(400).json({ error: 'timestampSec must be a finite number >= 0' });
      return;
    }
    cleanTs = parsedTs;
  }

  const comment = addComment(clipId, body.trim(), cleanAuthor, cleanTs);
  logAuditEvent('clipper', 'clip.comment_add', clipId, getClientIp(req), { commentId: comment.id });
  res.status(201).json({ ok: true, comment });
});

app.post('/api/clipper/clips/:id/comments/:commentId/resolve', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  const commentId = String(req.params.commentId ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  const existing = getCommentById(commentId);
  if (!existing || existing.clip_id !== clipId) {
    res.status(404).json({ error: 'Comment not found for this clip' });
    return;
  }
  if (req.body !== undefined && !isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { resolved } = (req.body ?? {}) as { resolved?: unknown };
  if (resolved !== undefined && typeof resolved !== 'boolean') {
    res.status(400).json({ error: 'resolved must be a boolean when provided' });
    return;
  }

  const comment = toggleCommentResolved(commentId, typeof resolved === 'boolean' ? resolved : undefined);
  logAuditEvent('clipper', 'clip.comment_resolve', clipId, getClientIp(req), {
    commentId,
    resolved: comment?.resolved ?? 0,
  });
  res.json({ ok: true, comment });
});

app.delete('/api/clipper/clips/:id/comments/:commentId', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  const commentId = String(req.params.commentId ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  const existing = getCommentById(commentId);
  if (!existing || existing.clip_id !== clipId) {
    res.status(404).json({ error: 'Comment not found for this clip' });
    return;
  }
  deleteComment(commentId);
  logAuditEvent('clipper', 'clip.comment_delete', clipId, getClientIp(req), { commentId });
  res.json({ ok: true });
});

app.get('/api/clipper/clips/:id/ab-test', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  const experiment = getAbExperiment(clipId);
  if (!experiment) {
    res.status(404).json({ error: 'No A/B experiment found for this clip' });
    return;
  }
  const stats = computeAbWinner(experiment);
  res.json({
    ok: true,
    experiment,
    ...stats,
    activeVariant: getActiveVariant(clipId),
  });
});

app.post('/api/clipper/clips/:id/ab-test', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { variantATitle, variantBTitle } = req.body;
  if (typeof variantATitle !== 'string' || !variantATitle.trim() || variantATitle.trim().length > 140) {
    res.status(400).json({ error: 'variantATitle must be 1 to 140 characters' });
    return;
  }
  if (typeof variantBTitle !== 'string' || !variantBTitle.trim() || variantBTitle.trim().length > 140) {
    res.status(400).json({ error: 'variantBTitle must be 1 to 140 characters' });
    return;
  }

  const experiment = createAbExperiment({
    clipId,
    variantATitle: variantATitle.trim(),
    variantBTitle: variantBTitle.trim(),
  });
  logAuditEvent('clipper', 'clip.ab_create', clipId, getClientIp(req), { experimentId: experiment.id });
  res.status(201).json({ ok: true, experiment });
});

app.post('/api/clipper/clips/:id/ab-test/event', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { variant, type } = req.body;
  if (variant !== 'a' && variant !== 'b') {
    res.status(400).json({ error: 'variant must be "a" or "b"' });
    return;
  }
  if (type !== 'view' && type !== 'click') {
    res.status(400).json({ error: 'type must be "view" or "click"' });
    return;
  }
  if (!getAbExperiment(clipId)) {
    res.status(404).json({ error: 'No A/B experiment found for this clip' });
    return;
  }

  if (type === 'view') {
    recordAbView(clipId, variant);
  } else {
    recordAbClick(clipId, variant);
  }

  const experiment = getAbExperiment(clipId)!;
  const stats = computeAbWinner(experiment);
  logAuditEvent('clipper', 'clip.ab_event', clipId, getClientIp(req), { variant, type });
  res.json({
    ok: true,
    experiment,
    ...stats,
    activeVariant: getActiveVariant(clipId),
  });
});

app.get('/api/clipper/clips/:id/shares', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  res.json({ ok: true, shares: listClipShares(clipId) });
});

app.post('/api/clipper/clips/:id/shares', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  if (req.body !== undefined && !isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { expiresInHours, maxViews, password } = (req.body ?? {}) as {
    expiresInHours?: unknown;
    maxViews?: unknown;
    password?: unknown;
  };

  let parsedExpiresInHours: number | undefined;
  if (expiresInHours !== undefined && expiresInHours !== null) {
    const n = typeof expiresInHours === 'number'
      ? expiresInHours
      : (typeof expiresInHours === 'string' && expiresInHours.trim() ? Number(expiresInHours) : NaN);
    if (!Number.isFinite(n) || n < 0.1 || n > 8760) {
      res.status(400).json({ error: 'expiresInHours must be between 0.1 and 8760' });
      return;
    }
    parsedExpiresInHours = n;
  }

  let parsedMaxViews: number | undefined;
  if (maxViews !== undefined && maxViews !== null) {
    const n = typeof maxViews === 'number'
      ? maxViews
      : (typeof maxViews === 'string' && maxViews.trim() ? Number(maxViews) : NaN);
    if (!Number.isFinite(n) || n < 1 || n > 100_000) {
      res.status(400).json({ error: 'maxViews must be between 1 and 100000' });
      return;
    }
    parsedMaxViews = Math.trunc(n);
  }

  let cleanPassword: string | undefined;
  if (password !== undefined && password !== null) {
    if (typeof password !== 'string' || password.length > 128) {
      res.status(400).json({ error: 'password must be a string of 128 characters or fewer' });
      return;
    }
    if (password.length > 0) cleanPassword = password;
  }

  const created = createClipShare({
    clipId,
    expiresInHours: parsedExpiresInHours,
    maxViews: parsedMaxViews,
    password: cleanPassword,
  });
  const { password_hash, ...safeShare } = created;
  const share = { ...safeShare, has_password: password_hash ? 1 : 0 };

  logAuditEvent('clipper', 'clip.share_create', clipId, getClientIp(req), {
    tokenPrefix: share.token.slice(0, 8),
    hasPassword: Boolean(share.has_password),
    expiresAt: share.expires_at,
    maxViews: share.max_views,
  });
  res.status(201).json({ ok: true, share });
});

app.delete('/api/clipper/clips/:id/shares/:token', (req, res) => {
  const clipId = String(req.params.id ?? '').trim();
  const token = String(req.params.token ?? '').trim();
  if (!clipExists(clipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  const existing = getClipShare(token);
  if (!existing || existing.clip_id !== clipId) {
    res.status(404).json({ error: 'Share link not found' });
    return;
  }
  deleteClipShare(token);
  logAuditEvent('clipper', 'clip.share_delete', clipId, getClientIp(req), {
    tokenPrefix: token.slice(0, 8),
  });
  res.json({ ok: true });
});

// ── Public Share Access Routes (NOT under /api/clipper) ───────────────────
app.get('/api/share/:token', (req, res) => {
  const token = String(req.params.token ?? '').trim();
  const share = getClipShare(token);
  if (!share) {
    res.status(404).json({ error: 'Share not found' });
    return;
  }

  const rawGrant = req.query.grant !== undefined ? String(req.query.grant) : undefined;
  if (rawGrant !== undefined) {
    if (!verifyShareStreamGrant(token, rawGrant)) {
      res.status(401).json({
        error: 'Invalid or expired stream grant',
        passwordRequired: Boolean(share.password_hash),
      });
      return;
    }
    if (share.expires_at !== null && share.expires_at !== undefined) {
      if (Math.floor(Date.now() / 1000) > share.expires_at) {
        res.status(403).json({ error: 'Share link has expired' });
        return;
      }
    }
  } else if (share.password_hash) {
    res.status(401).json({ error: 'Password required', passwordRequired: true });
    return;
  } else {
    const access = validateClipShareAccess(token);
    if (!access.valid) {
      res.status(access.reason === 'Share not found' ? 404 : 403).json({
        error: access.reason ?? 'Share access denied',
      });
      return;
    }
  }

  const clip = db.prepare('SELECT id, title, file_path FROM clips WHERE id = ?').get(share.clip_id) as
    | { id: string; title: string; file_path: string }
    | undefined;
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  const check = resolveSafeClipFilePath(clip.file_path);
  if (!check.ok) {
    res.status(check.status).json({ error: check.error });
    return;
  }

  if (req.query.download === '1') {
    const safeName = (clip.title || clip.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || clip.id;
    res.download(check.realPath, `${safeName}${path.extname(check.realPath) || '.mp4'}`);
  } else {
    res.sendFile(check.realPath);
  }
});

app.post('/api/share/:token/access', (req, res) => {
  const token = String(req.params.token ?? '').trim();
  if (req.body !== undefined && !isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { password } = (req.body ?? {}) as { password?: unknown };
  if (password !== undefined && typeof password !== 'string') {
    res.status(400).json({ error: 'password must be a string' });
    return;
  }

  const access = validateClipShareAccess(token, typeof password === 'string' ? password : undefined);
  if (!access.valid || !access.clipId) {
    const reason = access.reason ?? 'Access denied';
    if (reason === 'Share not found') {
      res.status(404).json({ error: reason });
      return;
    }
    if (reason === 'Password required' || reason === 'Incorrect password') {
      res.status(401).json({ error: reason, passwordRequired: true });
      return;
    }
    res.status(403).json({ error: reason });
    return;
  }

  const clip = db.prepare(`
    SELECT id, title, description, duration_sec, virality_score, layout,
           source_platform, social_title, social_hashtags, aspect_ratio, created_at
    FROM clips WHERE id = ?
  `).get(access.clipId) as
    | {
        id: string;
        title: string;
        description: string;
        duration_sec: number;
        virality_score: number;
        layout: string;
        source_platform: string;
        social_title: string;
        social_hashtags: string;
        aspect_ratio: string;
        created_at: string;
      }
    | undefined;
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  const exp = getAbExperiment(clip.id);
  const activeAbTitle = exp
    ? (getActiveVariant(clip.id) === 'b' ? exp.variant_b_title : exp.variant_a_title)
    : (clip.social_title || clip.title);

  const sig = createShareStreamGrant(token);
  const safeMetadata = {
    ...clip,
    rating: getClipRating(clip.id),
  };

  res.json({
    ok: true,
    clip: safeMetadata,
    title: activeAbTitle,
    streamUrl: `/api/share/${encodeURIComponent(token)}?grant=${encodeURIComponent(sig)}`,
  });
});

// ── Social Upload Queue API (/api/studio/upload-queue*) ───────────────────
app.get('/api/studio/upload-queue', (_req, res) => {
  res.json({ ok: true, items: listUploadQueue(), stats: getUploadQueueStats() });
});

app.post('/api/studio/upload-queue', (req, res) => {
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { clipId, platform, title, description, tags, scheduledFor } = req.body;
  if (typeof clipId !== 'string' || !clipId.trim()) {
    res.status(400).json({ error: 'clipId is required' });
    return;
  }
  const cleanClipId = clipId.trim();
  if (!clipExists(cleanClipId)) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  if (typeof platform !== 'string' || !VALID_SOCIAL_PLATFORMS.has(platform as SocialPlatform)) {
    res.status(400).json({
      error: 'platform must be one of: youtube, tiktok, instagram, twitter, twitch_clips',
    });
    return;
  }
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 140) {
    res.status(400).json({ error: 'title must be 1 to 140 characters' });
    return;
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > 5000)) {
    res.status(400).json({ error: 'description must be a string of 5000 characters or fewer' });
    return;
  }
  if (tags !== undefined && (typeof tags !== 'string' || tags.length > 500)) {
    res.status(400).json({ error: 'tags must be a string of 500 characters or fewer' });
    return;
  }
  let cleanScheduledFor: number | null = null;
  if (scheduledFor !== undefined && scheduledFor !== null) {
    const n = typeof scheduledFor === 'number'
      ? scheduledFor
      : (typeof scheduledFor === 'string' && scheduledFor.trim() ? Number(scheduledFor) : NaN);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: 'scheduledFor must be a non-negative unix timestamp' });
      return;
    }
    cleanScheduledFor = Math.trunc(n);
  }

  const item = addToUploadQueue({
    clipId: cleanClipId,
    platform: platform as SocialPlatform,
    title: title.trim(),
    description: typeof description === 'string' ? description : '',
    tags: typeof tags === 'string' ? tags : '',
    scheduledFor: cleanScheduledFor,
  });
  logAuditEvent('studio', 'upload_queue.add', item.id, getClientIp(req), {
    clipId: cleanClipId,
    platform,
  });
  res.status(201).json({ ok: true, item });
});

app.patch('/api/studio/upload-queue/:id', (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { status, errorMsg } = req.body;
  if (typeof status !== 'string' || !VALID_UPLOAD_STATUSES.has(status as UploadStatus)) {
    res.status(400).json({ error: 'status must be one of: queued, in_progress, done, failed' });
    return;
  }
  if (errorMsg !== undefined && errorMsg !== null && (typeof errorMsg !== 'string' || errorMsg.length > 1000)) {
    res.status(400).json({ error: 'errorMsg must be a string of 1000 characters or fewer' });
    return;
  }

  const updated = updateUploadStatus(
    id,
    status as UploadStatus,
    typeof errorMsg === 'string' ? errorMsg : undefined,
  );
  if (!updated) {
    res.status(404).json({ error: 'Upload queue item not found' });
    return;
  }
  const item = getUploadQueueItem(id);
  logAuditEvent('studio', 'upload_queue.update', id, getClientIp(req), { status });
  res.json({ ok: true, item });
});

app.delete('/api/studio/upload-queue/:id', (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const deleted = deleteFromUploadQueue(id);
  if (!deleted) {
    res.status(404).json({ error: 'Upload queue item not found' });
    return;
  }
  logAuditEvent('studio', 'upload_queue.delete', id, getClientIp(req));
  res.json({ ok: true });
});

// ── Stream Health Snapshots API (/api/studio/snapshots*) ──────────────────
app.post('/api/studio/snapshots', (req, res) => {
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { sessionId, velocity, viewerCount, peakDb, clipCount } = req.body;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.trim().length > 128) {
    res.status(400).json({ error: 'sessionId must be 1 to 128 characters' });
    return;
  }
  const parsedVelocity = typeof velocity === 'number'
    ? velocity
    : (typeof velocity === 'string' && velocity.trim() ? Number(velocity) : NaN);
  if (!Number.isFinite(parsedVelocity) || parsedVelocity < 0) {
    res.status(400).json({ error: 'velocity must be a finite number >= 0' });
    return;
  }

  let parsedViewerCount: number | undefined;
  if (viewerCount !== undefined && viewerCount !== null) {
    const n = typeof viewerCount === 'number' ? viewerCount : Number(viewerCount);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: 'viewerCount must be a finite number >= 0' });
      return;
    }
    parsedViewerCount = Math.trunc(n);
  }

  let parsedPeakDb: number | undefined;
  if (peakDb !== undefined && peakDb !== null) {
    const n = typeof peakDb === 'number' ? peakDb : Number(peakDb);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: 'peakDb must be a finite number' });
      return;
    }
    parsedPeakDb = n;
  }

  let parsedClipCount: number | undefined;
  if (clipCount !== undefined && clipCount !== null) {
    const n = typeof clipCount === 'number' ? clipCount : Number(clipCount);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: 'clipCount must be a finite number >= 0' });
      return;
    }
    parsedClipCount = Math.trunc(n);
  }

  const cleanSessionId = sessionId.trim();
  const id = insertStreamSnapshot({
    sessionId: cleanSessionId,
    velocity: parsedVelocity,
    viewerCount: parsedViewerCount,
    peakDb: parsedPeakDb,
    clipCount: parsedClipCount,
  });
  logAuditEvent('studio', 'snapshot.create', cleanSessionId, getClientIp(req), { id, velocity: parsedVelocity });
  res.status(201).json({ ok: true, id });
});

app.get('/api/studio/snapshots/sessions', requireAdminAuth, (_req, res) => {
  res.json({ ok: true, sessions: listStreamSnapshotSessions() });
});

app.get('/api/studio/snapshots/:sessionId', requireAdminAuth, (req, res) => {
  const sessionId = String(req.params.sessionId ?? '').trim();
  const snapshots = listStreamSnapshots(sessionId);
  const health = scoreStreamHealth(snapshots);
  res.json({ ok: true, sessionId, snapshots, health });
});

app.delete('/api/studio/snapshots', requireAdminAuth, (req, res) => {
  const rawKeepDays = req.query.keepDays !== undefined ? Number(req.query.keepDays) : 30;
  if (req.query.keepDays !== undefined && (!Number.isFinite(rawKeepDays) || rawKeepDays < 1 || rawKeepDays > 365)) {
    res.status(400).json({ error: 'keepDays must be between 1 and 365' });
    return;
  }
  const keepDays = Math.min(365, Math.max(1, Math.trunc(rawKeepDays)));
  const pruned = pruneOldSnapshots(keepDays);
  logAuditEvent('admin', 'snapshots.prune', 'stream_snapshots', getClientIp(req), { keepDays, pruned });
  res.json({ ok: true, pruned });
});

// ── Admin Security Self-Audit Scan (Admin Protected) ──────────────────────
app.get('/api/admin/security-scan', requireAdminAuth, (_req, res) => {
  type ScanStatus = 'pass' | 'warn' | 'fail';
  interface SecurityCheck {
    id: string;
    label: string;
    status: ScanStatus;
    detail: string;
  }

  const defaultAdminPw = isUsingDefaultAdminPassword();
  const kelviqSecret = (
    getSetting('kelviq_webhook_secret') ||
    process.env.KELVIQ_WEBHOOK_SECRET ||
    ''
  ).trim();
  const allowUnsignedWebhooks = process.env.KELVIQ_ALLOW_UNSIGNED_WEBHOOKS === 'true';
  const normalizedHost = HOST.trim().toLowerCase();
  const isLoopbackBind =
    normalizedHost === '127.0.0.1' ||
    normalizedHost === 'localhost' ||
    normalizedHost === '::1' ||
    normalizedHost === '[::1]';
  const requireApiKey = process.env.REQUIRE_API_KEY === 'true';
  const activeApiKeyCount = Number(
    (db.prepare('SELECT COUNT(*) AS cnt FROM api_keys WHERE active = 1').get() as { cnt: number })?.cnt ?? 0,
  );
  const unprotectedShareCount = Number(
    (
      db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM clip_shares
        WHERE (password_hash IS NULL OR password_hash = '')
          AND expires_at IS NULL
          AND (max_views IS NULL OR view_count < max_views)
      `).get() as { cnt: number }
    )?.cnt ?? 0,
  );

  const checks: SecurityCheck[] = [
    {
      id: 'custom_admin_password',
      label: 'Custom Admin Password',
      status: defaultAdminPw ? 'fail' : 'pass',
      detail: defaultAdminPw
        ? 'Default admin password ("admin123") is active — rotate it immediately in Admin Settings.'
        : 'Custom administrator password hash is configured.',
    },
    {
      id: 'kelviq_webhook_hmac',
      label: 'Kelviq Webhook HMAC Verification',
      status: allowUnsignedWebhooks ? 'fail' : kelviqSecret ? 'pass' : 'warn',
      detail: allowUnsignedWebhooks
        ? 'KELVIQ_ALLOW_UNSIGNED_WEBHOOKS=true allows unverified webhook payloads.'
        : kelviqSecret
          ? 'Webhook HMAC secret configured and unsigned payloads rejected.'
          : 'Unsigned webhooks are blocked (403), but KELVIQ_WEBHOOK_SECRET is not configured.',
    },
    {
      id: 'loopback_bind',
      label: 'Loopback Network Binding',
      status: isLoopbackBind ? 'pass' : 'warn',
      detail: isLoopbackBind
        ? `Service bound strictly to loopback interface (${HOST}).`
        : `Service bound to non-loopback address (${HOST}); verify firewall or bind to 127.0.0.1.`,
    },
    {
      id: 'api_key_protection',
      label: 'API Key Enforcement',
      status: requireApiKey && activeApiKeyCount > 0 ? 'pass' : 'warn',
      detail: requireApiKey
        ? activeApiKeyCount > 0
          ? `REQUIRE_API_KEY=true with ${activeApiKeyCount} active csk_* key(s).`
          : 'REQUIRE_API_KEY=true, but no active csk_* API keys are provisioned.'
        : `REQUIRE_API_KEY is disabled (${activeApiKeyCount} active key(s) provisioned; Bearer tokens still validated when supplied).`,
    },
    {
      id: 'rate_limiter_active',
      label: 'Tiered API Rate Limiter',
      status: 'pass',
      detail: 'Active across /api/* (auth: 20/min, mutations: 60/min, reads: 240/min).',
    },
    {
      id: 'csrf_origin_guard',
      label: 'CSRF Origin & Referer Guard',
      status: 'pass',
      detail: 'Mutating /api/* requests enforce local Origin/Referer verification and SameSite=Strict cookies.',
    },
    {
      id: 'csp_frame_ancestors_none',
      label: 'CSP & Frame-Ancestors Policy',
      status: 'pass',
      detail: "Content-Security-Policy frame-ancestors 'none', X-Frame-Options: DENY, and nosniff active.",
    },
    {
      id: 'expiring_share_links',
      label: 'Share Link Expiration & Passwords',
      status: unprotectedShareCount === 0 ? 'pass' : 'warn',
      detail:
        unprotectedShareCount === 0
          ? 'All active share links have password protection or expiration.'
          : `${unprotectedShareCount} active share link(s) have neither a password nor an expiration.`,
    },
  ];

  const earnedPoints = checks.reduce(
    (sum, c) => sum + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0),
    0,
  );
  const score = Math.round((earnedPoints / checks.length) * 100);

  res.json({
    ok: true,
    score,
    checks,
    checkedAt: new Date().toISOString(),
  });
});

// ── Admin API Keys, Kelviq Event Log & Audit Log (Admin Protected) ────────
app.post('/api/admin/api-keys', requireAdminAuth, (req, res) => {
  const { label } = (req.body ?? {}) as { label?: unknown };
  if (typeof label !== 'string' || !label.trim()) {
    res.status(400).json({ error: 'label is required' });
    return;
  }
  const created = createApiKey(label.trim());
  logAuditEvent('admin', 'api_key.create', created.id, getClientIp(req), {
    label: created.label,
    maskedKey: created.maskedKey,
  });
  res.status(201).json({
    ok: true,
    id: created.id,
    key: created.key,
    maskedKey: created.maskedKey,
    label: created.label,
  });
});

app.get('/api/admin/api-keys', requireAdminAuth, (_req, res) => {
  res.json({ ok: true, keys: listApiKeys() });
});

app.delete('/api/admin/api-keys/:id', requireAdminAuth, (req, res) => {
  const idOrKey = String(req.params.id ?? '').trim();
  const revoked = revokeApiKey(idOrKey);
  logAuditEvent('admin', 'api_key.revoke', idOrKey, getClientIp(req), { revoked });
  res.json({ ok: true, revoked });
});

app.get('/api/admin/event-log', requireAdminAuth, (req, res) => {
  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 50;
  const rows = db.prepare(
    `SELECT id, event_type, customer_email, license_key, plan_identifier, amount, raw_json, received_at
     FROM kelviq_events ORDER BY received_at DESC LIMIT ?`
  ).all(limit) as Array<Record<string, unknown>>;
  const parsed = rows.map((r) => {
    let json: unknown = r.raw_json;
    try {
      json = redactLicenseKeysInObject(JSON.parse(r.raw_json as string));
    } catch {}
    const lk = String(r.license_key ?? '');
    return {
      ...r,
      license_key: lk ? maskLicenseKeyValue(lk) : '',
      raw_json: json,
    };
  });
  res.json({ ok: true, events: parsed, count: parsed.length });
});

app.get('/api/admin/audit-log', requireAdminAuth, (req, res) => {
  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 50;
  const logs = listAuditLogs(limit);
  res.json({ ok: true, logs, count: logs.length });
});

// ── Admin Signed Outbound Webhooks CRUD & Test (Admin Protected) ──────────
app.get('/api/admin/webhooks', requireAdminAuth, (_req, res) => {
  res.json({ ok: true, webhooks: listOutboundWebhooks() });
});

app.post('/api/admin/webhooks', requireAdminAuth, async (req, res) => {
  const { name, url, events } = (req.body ?? {}) as {
    name?: unknown;
    url?: unknown;
    events?: unknown;
  };

  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const cleanName = name.trim();
  if (cleanName.length > 80) {
    res.status(400).json({ error: 'name must be 80 characters or fewer' });
    return;
  }

  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ error: 'HTTPS webhook url is required' });
    return;
  }
  const cleanUrl = url.trim();
  try {
    await assertSafeRemoteUrl(cleanUrl, { requireHttps: true });
  } catch (err: any) {
    if (err instanceof ProxyUrlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err?.message ?? 'Invalid webhook URL' });
    return;
  }

  let parsedEvents: string[] = ['clip.ready'];
  if (events !== undefined) {
    const rawList = Array.isArray(events)
      ? events
      : typeof events === 'string'
        ? events.split(',')
        : null;
    if (!rawList) {
      res.status(400).json({ error: 'events must be an array or comma-separated string' });
      return;
    }
    const cleanList: string[] = [];
    for (const item of rawList) {
      if (typeof item !== 'string') {
        res.status(400).json({ error: 'Each event must be a string' });
        return;
      }
      const ev = item.trim();
      if (!ev) continue;
      if (!VALID_WEBHOOK_EVENTS.has(ev)) {
        res.status(400).json({
          error: `Unsupported webhook event "${ev}". Allowed: clip.ready, live.explosion, job.completed`,
        });
        return;
      }
      if (!cleanList.includes(ev)) cleanList.push(ev);
    }
    if (cleanList.length === 0) {
      res.status(400).json({ error: 'At least one valid webhook event is required' });
      return;
    }
    parsedEvents = cleanList;
  }

  const { secret, ...webhook } = createOutboundWebhook({
    name: cleanName,
    url: cleanUrl,
    events: parsedEvents,
  });

  logAuditEvent('admin', 'webhook.create', webhook.id, getClientIp(req), {
    name: webhook.name,
    url: webhook.url,
    events: webhook.events,
  });

  res.status(201).json({ ok: true, secret, webhook });
});

app.post('/api/admin/webhooks/:id/toggle', requireAdminAuth, (req, res) => {
  const { enabled } = (req.body ?? {}) as { enabled?: unknown };
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean when provided' });
    return;
  }
  const id = String(req.params.id ?? '').trim();
  const updated = toggleOutboundWebhook(id, typeof enabled === 'boolean' ? enabled : undefined);
  if (!updated) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  logAuditEvent('admin', 'webhook.toggle', updated.id, getClientIp(req), { enabled: updated.enabled });
  res.json({ ok: true, webhook: updated });
});

app.post('/api/admin/webhooks/:id/test', requireAdminAuth, async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const target = getOutboundWebhookDispatchTarget(id);
  if (!target) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }

  const result = await dispatchOutboundWebhookSingle(target, 'webhook.test', {
    webhookId: target.id,
    name: target.name,
    test: true,
    sentAt: new Date().toISOString(),
  });

  logAuditEvent('admin', 'webhook.test', target.id, getClientIp(req), {
    ok: result.ok,
    status: result.status,
  });

  res.json({
    ok: result.ok,
    status: result.status,
    error: result.error,
  });
});

app.delete('/api/admin/webhooks/:id', requireAdminAuth, (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const deleted = deleteOutboundWebhook(id);
  if (!deleted) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  logAuditEvent('admin', 'webhook.delete', id, getClientIp(req));
  res.json({ ok: true });
});

// ── SaaS Billing, Kelviq Licensing, Watchlist & Admin Routes ──────────────
registerSaasAndAdminRoutes(app, async (entry) => {
  const ent = getActiveEntitlement();
  if (!ent.plan.allow_watchlist) return;
  if (liveManager.getStatus().active) return;

  console.log(`[watchlist] 🔴 ${entry.platform}: ${entry.channel} is LIVE! Auto-attaching live monitor...`);
  await liveManager.startSession({
    platform: entry.platform,
    channelOrUrl: entry.channel,
    vertical: entry.layout !== 'landscape',
    layout: entry.layout,
    facecamPosition: entry.facecam_position,
    captionStyle: entry.caption_style,
  });
});

// Load & register persisted enabled scheduled auto-clip jobs on boot
for (const job of listScheduledJobs()) {
  if (job.enabled === 1) {
    registerScheduledCronTask(job);
  }
}

// Poll watchlist every 60s when Ultra watchlist is active (guarded against overlap)
let watchlistPollInFlight = false;
cron.schedule('* * * * *', () => {
  if (watchlistPollInFlight) return;
  const ent = getActiveEntitlement();
  if (!ent.plan.allow_watchlist) return;
  watchlistPollInFlight = true;
  void pollWatchlistStatuses(async (entry) => {
    if (liveManager.getStatus().active) return;
    await liveManager.startSession({
      platform: entry.platform,
      channelOrUrl: entry.channel,
      vertical: entry.layout !== 'landscape',
      layout: entry.layout,
      facecamPosition: entry.facecam_position,
      captionStyle: entry.caption_style,
    });
  })
    .catch(() => {})
    .finally(() => {
      watchlistPollInFlight = false;
    });
});

// ── Cron: archive old 01_inbox/ source files after RETENTION days ─────────
cron.schedule('0 3 * * *', () => {
  console.log(`[cleanup] Archiving inbox files done >${RETENTION}d ago…`);
  const cutoff = new Date(Date.now() - RETENTION * 86400_000).toISOString();
  const done = db.prepare(
    `SELECT id, source_path FROM ingest_jobs WHERE status='DONE' AND updated_at < ?`
  ).all(cutoff) as Array<{ id: string; source_path: string | null }>;

  for (const j of done) {
    if (j.source_path && fs.existsSync(j.source_path) && isPathInsideMediaDirs(j.source_path)) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const parsed = path.parse(j.source_path);
      let dest = path.join(ARCHIVE_DIR, parsed.base);
      if (fs.existsSync(dest)) {
        dest = path.join(ARCHIVE_DIR, `${parsed.name}_${Date.now()}${parsed.ext}`);
      }
      moveFileSync(j.source_path, dest);
      console.log(`[cleanup] Archived: ${j.source_path} → ${dest}`);
    }
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[clipper-service] 🎬 listening on http://${HOST}:${PORT}`);
  console.log(`  Drop videos in:  ${INBOX}`);
  console.log(`  Clips saved to:  ${CLIPS_DIR}`);
  console.log(`  Live Clipper:    POST /api/live/start { platform, channelOrUrl }`);
});
