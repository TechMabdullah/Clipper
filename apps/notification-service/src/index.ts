/**
 * notification-service — local desktop alerts only.
 *
 * Sends Discord webhook + Telegram message when a clip is ready.
 * No approval flow, no cloud round-trips, no Cloudflare Tunnel needed.
 * Everything stays on your machine.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '@clipper/db-utils';

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const PORT = Number(process.env.NOTIFICATION_PORT ?? 4003);
const DATA_DIR = process.env.DATA_DIR ?? './data';
const DISCORD_GENERAL  = process.env.DISCORD_WEBHOOK_GENERAL ?? '';
const DISCORD_ALERTS   = process.env.DISCORD_WEBHOOK_ALERTS ?? '';
const TG_TOKEN         = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TG_CHAT_ID       = process.env.TELEGRAM_CHAT_ID ?? '';
const ATTACH_VIDEO     = process.env.NOTIFY_ATTACH_VIDEO_PREVIEW === 'true';
const DISCORD_MAX      = 20 * 1024 * 1024;   // 20 MiB
const TELEGRAM_MAX     = 50 * 1024 * 1024;   // 50 MB

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

// ── Helpers ───────────────────────────────────────────────────────────────
function canAttach(filePath: string | undefined, maxBytes: number): boolean {
  if (!ATTACH_VIDEO || !filePath) return false;
  try { return fs.statSync(filePath).size <= maxBytes; } catch { return false; }
}

async function sendDiscord(webhookUrl: string, content: string, filePath?: string): Promise<void> {
  if (!webhookUrl) return;
  const attach = canAttach(filePath, DISCORD_MAX);
  if (attach && filePath) {
    // Multipart with video attachment
    const { FormData, File } = await import('node:buffer').then(() => globalThis);
    const form = new (globalThis.FormData ?? FormData)();
    form.append('content', content.slice(0, 2000));
    const fileData = fs.readFileSync(filePath);
    form.append('file', new Blob([fileData], { type: 'video/mp4' }), path.basename(filePath));
    await fetch(webhookUrl, { method: 'POST', body: form });
  } else {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
    });
  }
  logNotification('discord', content);
}

async function sendTelegram(text: string, filePath?: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const base = `https://api.telegram.org/bot${TG_TOKEN}`;
  const attach = canAttach(filePath, TELEGRAM_MAX);
  if (attach && filePath) {
    const fileData = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('caption', text.slice(0, 1024));
    form.append('video', new Blob([fileData], { type: 'video/mp4' }), path.basename(filePath));
    await fetch(`${base}/sendVideo`, { method: 'POST', body: form });
  } else {
    await fetch(`${base}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: text.slice(0, 4096) }),
    });
  }
  logNotification('telegram', text);
}

function logNotification(channel: string, message: string): void {
  db.prepare(`INSERT INTO notification_log (id, channel, message, sent_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .run(crypto.randomUUID(), channel, message.slice(0, 1000));
}

// ── API ───────────────────────────────────────────────────────────────────
app.get('/api/notifications/health', (_req, res) => res.json({ ok: true }));

/** POST /api/notifications/clip-ready — called by clipper-service after render */
app.post('/api/notifications/clip-ready', async (req, res) => {
  const { clipTitle, filePath, fileSizeMb } = req.body as {
    clipTitle: string; filePath?: string; fileSizeMb?: string;
  };
  const size = fileSizeMb ? ` (${fileSizeMb} MB)` : '';
  const msg = `🎬 Clip ready: **${clipTitle}**${size}\nSaved to: ${filePath ?? 'unknown'}`;
  await sendDiscord(DISCORD_GENERAL, msg, filePath);
  await sendTelegram(msg.replace(/\*\*/g, ''), filePath);
  res.json({ ok: true });
});

/** POST /api/notifications/alert — error/warning alerts */
app.post('/api/notifications/alert', async (req, res) => {
  const { message } = req.body as { message: string };
  const msg = `🚨 ${message}`.slice(0, 800);
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

app.get('/api/notifications/log', (_req, res) => {
  const rows = db.prepare('SELECT * FROM notification_log ORDER BY created_at DESC LIMIT 50').all();
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`[notification-service] listening on :${PORT} — Discord+Telegram alerts only`);
});
