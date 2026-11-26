/**
 * notification-service — local desktop alerts only.
 *
 * Sends Discord webhook + Telegram message when a clip is ready.
 * No approval flow, no cloud round-trips, no Cloudflare Tunnel needed.
 * Everything stays on your machine.
 */
import express from 'express';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { openDb } from '@clipper/db-utils';

const app = express();
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

app.use(express.json({ limit: '64kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && LOCAL_ORIGIN_RE.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

app.use('/api', (req, res, next) => {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
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

const PORT = Number(process.env.NOTIFICATION_PORT ?? 4003);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ?? './data';
const DISCORD_GENERAL  = process.env.DISCORD_WEBHOOK_GENERAL ?? '';
const DISCORD_ALERTS   = process.env.DISCORD_WEBHOOK_ALERTS ?? '';
const TG_TOKEN         = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TG_CHAT_ID       = process.env.TELEGRAM_CHAT_ID ?? '';
const ATTACH_VIDEO     = process.env.NOTIFY_ATTACH_VIDEO_PREVIEW === 'true';
const DISCORD_MAX      = 20 * 1024 * 1024;   // 20 MiB
const TELEGRAM_MAX     = 50 * 1024 * 1024;   // 50 MB
const VIDEO_EXT_RE     = /\.(mp4|mov|webm|mkv)$/i;

const db = openDb(path.join(DATA_DIR, 'notifications.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS notification_log (
    id         TEXT PRIMARY KEY,
    channel    TEXT NOT NULL,
    message    TEXT NOT NULL,
    sent_at    TEXT,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

// ── SSRF & Input Helpers ──────────────────────────────────────────────────
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIpAddress(rawIp: string): boolean {
  let ip = rawIp.trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
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
        return isBlockedIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }
  }

  if (ip.startsWith('::') && !ip.startsWith('::ffff:')) {
    const maybeV4 = ip.slice(2);
    if (net.isIPv4(maybeV4)) return isBlockedIpv4(maybeV4);
  }

  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') {
      return true;
    }
    const firstHextet = ip.split(':')[0] ?? '';
    const val = Number.parseInt(firstHextet || '0', 16);
    if ((val & 0xfe00) === 0xfc00) return true;
    if ((val & 0xffc0) === 0xfe80) return true;
    if ((val & 0xff00) === 0xff00) return true;
    return false;
  }
  return false;
}

async function assertSafeWebhookUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid webhook URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use https: protocol');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Webhook URL must not contain credentials');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Webhook hostname cannot target local or internal hosts');
  }
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (net.isIP(unbracketed)) {
    if (isBlockedIpAddress(unbracketed)) {
      throw new Error('Webhook IP cannot target private or loopback networks');
    }
    return parsed;
  }
  const records = await dns.promises.lookup(unbracketed, { all: true });
  if (!records || records.length === 0) {
    throw new Error('Webhook hostname did not resolve');
  }
  for (const rec of records) {
    if (isBlockedIpAddress(rec.address)) {
      throw new Error('Webhook hostname resolves to blocked private or loopback IP');
    }
  }
  return parsed;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function isSameOrInsideDir(baseDir: string, candidatePath: string): boolean {
  const normBase = process.platform === 'win32' ? path.resolve(baseDir).toLowerCase() : path.resolve(baseDir);
  const normCandidate = process.platform === 'win32' ? path.resolve(candidatePath).toLowerCase() : path.resolve(candidatePath);
  const rel = path.relative(normBase, normCandidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function isBlockedSystemOrRootPath(realFilePath: string): boolean {
  const dirPath = path.dirname(realFilePath);
  if (path.parse(realFilePath).root === realFilePath || path.parse(dirPath).root === dirPath) {
    return true;
  }

  const norm = process.platform === 'win32' ? realFilePath.toLowerCase() : realFilePath;
  const blockedPrefixes: string[] = [];
  if (process.platform === 'win32') {
    const winDir = (process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows').toLowerCase();
    const programFiles = (process.env.ProgramFiles || 'C:\\Program Files').toLowerCase();
    const programFilesX86 = (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase();
    blockedPrefixes.push(
      winDir,
      programFiles,
      programFilesX86,
      'c:\\windows',
      'c:\\program files',
      'c:\\program files (x86)',
    );
  } else {
    blockedPrefixes.push('/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/root');
  }

  for (const prefix of blockedPrefixes) {
    if (isSameOrInsideDir(prefix, norm)) {
      return true;
    }
  }
  return false;
}

function resolveSafeAttachPath(filePath: string | undefined, maxBytes: number): string | null {
  if (!ATTACH_VIDEO || !filePath || filePath.includes('\0')) return null;
  const resolved = path.resolve(filePath);
  if (!VIDEO_EXT_RE.test(resolved)) return null;
  try {
    const realFile = fs.realpathSync(resolved);
    if (!VIDEO_EXT_RE.test(realFile)) return null;
    if (isBlockedSystemOrRootPath(realFile)) return null;

    const mediaRootEnv = (process.env.MEDIA_ROOT_DIR ?? '').trim();
    if (mediaRootEnv) {
      const resolvedMediaRoot = path.resolve(mediaRootEnv);
      const realMediaRoot = fs.realpathSync(resolvedMediaRoot);
      if (!isSameOrInsideDir(resolvedMediaRoot, resolved) || !isSameOrInsideDir(realMediaRoot, realFile)) {
        return null;
      }
    }

    const stat = fs.statSync(realFile);
    return stat.isFile() && stat.size > 0 && stat.size <= maxBytes ? realFile : null;
  } catch {
    return null;
  }
}

function canAttach(filePath: string | undefined, maxBytes: number): boolean {
  return resolveSafeAttachPath(filePath, maxBytes) !== null;
}

async function sendDiscord(webhookUrl: string, content: string, filePath?: string): Promise<void> {
  if (!webhookUrl || !webhookUrl.trim()) return;
  try {
    const safeUrl = await assertSafeWebhookUrl(webhookUrl);
    const safeFile = canAttach(filePath, DISCORD_MAX) ? resolveSafeAttachPath(filePath, DISCORD_MAX) : null;
    let response: globalThis.Response;
    if (safeFile) {
      const form = new FormData();
      form.append('content', content.slice(0, 2000));
      const fileData = fs.readFileSync(safeFile);
      form.append('file', new Blob([fileData], { type: 'video/mp4' }), path.basename(safeFile));
      response = await fetch(safeUrl.toString(), {
        method: 'POST',
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      response = await fetch(safeUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.slice(0, 2000) }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (!response.ok) {
      throw new Error(`Discord webhook responded with HTTP ${response.status}`);
    }
    logNotification('discord', content);
  } catch (err: any) {
    logNotification('discord', content, err?.message ?? 'Discord dispatch failed');
  }
}

async function sendTelegram(text: string, filePath?: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const base = `https://api.telegram.org/bot${encodeURIComponent(TG_TOKEN)}`;
  try {
    const safeFile = canAttach(filePath, TELEGRAM_MAX) ? resolveSafeAttachPath(filePath, TELEGRAM_MAX) : null;
    let response: globalThis.Response;
    if (safeFile) {
      const fileData = fs.readFileSync(safeFile);
      const form = new FormData();
      form.append('chat_id', TG_CHAT_ID);
      form.append('caption', text.slice(0, 1024));
      form.append('video', new Blob([fileData], { type: 'video/mp4' }), path.basename(safeFile));
      response = await fetch(`${base}/sendVideo`, {
        method: 'POST',
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      response = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text: text.slice(0, 4096) }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (!response.ok) {
      throw new Error(`Telegram API responded with HTTP ${response.status}`);
    }
    logNotification('telegram', text);
  } catch (err: any) {
    logNotification('telegram', text, err?.message ?? 'Telegram dispatch failed');
  }
}

function logNotification(channel: string, message: string, error?: string): void {
  db.prepare(`
    INSERT INTO notification_log (id, channel, message, sent_at, error)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    channel,
    message.slice(0, 1000),
    error ? null : new Date().toISOString(),
    error ? String(error).slice(0, 500) : null,
  );
}

// ── API ───────────────────────────────────────────────────────────────────
app.get('/api/notifications/health', (_req, res) => res.json({ ok: true }));

/** POST /api/notifications/clip-ready — called by clipper-service after render */
app.post('/api/notifications/clip-ready', async (req, res) => {
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { clipTitle, filePath, fileSizeMb } = req.body;
  if (typeof clipTitle !== 'string' || !clipTitle.trim() || clipTitle.trim().length > 300) {
    res.status(400).json({ error: 'clipTitle must be a non-empty string (<= 300 chars)' });
    return;
  }
  if (filePath !== undefined && (typeof filePath !== 'string' || filePath.length > 1000)) {
    res.status(400).json({ error: 'filePath must be a string (<= 1000 chars)' });
    return;
  }
  let sizeLabel = '';
  if (typeof fileSizeMb === 'string' && fileSizeMb.trim()) {
    sizeLabel = ` (${fileSizeMb.trim().slice(0, 32)} MB)`;
  } else if (typeof fileSizeMb === 'number' && Number.isFinite(fileSizeMb) && fileSizeMb >= 0) {
    sizeLabel = ` (${fileSizeMb.toFixed(1)} MB)`;
  }

  const cleanTitle = clipTitle.trim();
  const cleanFilePath = typeof filePath === 'string' ? filePath.trim() : undefined;
  const msg = `🎬 Clip ready: **${cleanTitle}**${sizeLabel}\nSaved to: ${cleanFilePath || 'unknown'}`;
  await sendDiscord(DISCORD_GENERAL, msg, cleanFilePath);
  await sendTelegram(msg.replace(/\*\*/g, ''), cleanFilePath);
  res.json({ ok: true });
});

/** POST /api/notifications/alert — error/warning alerts */
app.post('/api/notifications/alert', async (req, res) => {
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const { message } = req.body;
  if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000) {
    res.status(400).json({ error: 'message must be a non-empty string (<= 2000 chars)' });
    return;
  }
  const msg = `🚨 ${message.trim()}`.slice(0, 800);
  await sendDiscord(DISCORD_ALERTS || DISCORD_GENERAL, msg);
  await sendTelegram(msg);
  res.json({ ok: true });
});

/** POST /api/notifications/test — verify both channels work */
app.post('/api/notifications/test', async (_req, res) => {
  const msg = `✅ Clipper Studio notification test — ${new Date().toISOString()}`;
  await sendDiscord(DISCORD_GENERAL, msg);
  await sendTelegram(msg);
  res.json({ ok: true });
});

app.get('/api/notifications/log', (req, res) => {
  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 50;
  const rows = db.prepare('SELECT * FROM notification_log ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.listen(PORT, HOST, () => {
  console.log(`[notification-service] listening on http://${HOST}:${PORT} — Discord+Telegram alerts only`);
});
