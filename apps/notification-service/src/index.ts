import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '@clipper/db-utils';
import { DISCORD_MAX_BYTES, TELEGRAM_MAX_BYTES } from '@clipper/shared-types';

const app = express();
app.use(express.json());

const PORT = Number(process.env.NOTIFICATION_PORT ?? 4003);
const DATA_DIR = process.env.DATA_DIR ?? './data';
const DISCORD_GENERAL = process.env.DISCORD_WEBHOOK_GENERAL ?? '';
const DISCORD_ALERTS = process.env.DISCORD_WEBHOOK_ALERTS ?? '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
const ATTACH_VIDEO = process.env.NOTIFY_ATTACH_VIDEO_PREVIEW === 'true';

// ── Gotcha #5: WAL mode via shared helper ─────────────────────────────────
const db = openDb(path.join(DATA_DIR, 'notifications.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS notification_log (
    id         TEXT PRIMARY KEY,
    channel    TEXT NOT NULL,
    payload    TEXT NOT NULL,
    sent_at    TEXT,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);

// ── Gotcha #3 / file-size guard before attaching to Discord / Telegram ────
function shouldAttachFile(filePath: string, maxBytes: number): boolean {
  if (!ATTACH_VIDEO || !filePath) return false;
  try {
    return fs.statSync(filePath).size <= maxBytes;
  } catch {
    return false;
  }
}

async function sendDiscord(
  webhookUrl: string,
  content: string,
  videoPath?: string,
): Promise<void> {
  if (!webhookUrl) return;

  const attach = videoPath && shouldAttachFile(videoPath, DISCORD_MAX_BYTES);
  if (attach) {
    // Multipart: attach MP4 (≤20 MiB)
    const { default: FormData } = await import('form-data');
    const form = new FormData();
    form.append('content', content.slice(0, 2000));
    form.append('file', fs.createReadStream(videoPath!), path.basename(videoPath!));
    await fetch(webhookUrl, { method: 'POST', body: form as unknown as BodyInit });
  } else {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
    });
  }
}

async function sendTelegram(text: string, videoPath?: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const base = `https://api.telegram.org/bot${TG_TOKEN}`;

  const attach = videoPath && shouldAttachFile(videoPath, TELEGRAM_MAX_BYTES);
  if (attach) {
    const { default: FormData } = await import('form-data');
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('caption', text.slice(0, 1024));
    form.append('video', fs.createReadStream(videoPath!), path.basename(videoPath!));
    await fetch(`${base}/sendVideo`, { method: 'POST', body: form as unknown as BodyInit });
  } else {
    await fetch(`${base}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: text.slice(0, 4096) }),
    });
  }
}

// ── API ───────────────────────────────────────────────────────────────────
app.get('/api/notifications/health', (_req, res) => res.json({ ok: true }));

app.post('/api/notifications/test', async (_req, res) => {
  const msg = `✅ Clipper Studio notification test — ${new Date().toISOString()}`;
  await sendDiscord(DISCORD_GENERAL, msg);
  await sendTelegram(msg);
  res.json({ ok: true });
});

app.post('/api/notifications/clip-ready', async (req, res) => {
  const { clipTitle, platform, filePath } = req.body as {
    clipTitle: string;
    platform: string;
    filePath?: string;
  };
  const msg = `🎬 Clip ready: *${clipTitle}* → ${platform}`;
  await sendDiscord(DISCORD_GENERAL, msg, filePath);
  await sendTelegram(msg, filePath);
  res.json({ ok: true });
});

app.post('/api/notifications/alert', async (req, res) => {
  const { message } = req.body as { message: string };
  const truncated = `🚨 ${message}`.slice(0, 800);
  await sendDiscord(DISCORD_ALERTS, truncated);
  await sendTelegram(truncated);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[notification-service] listening on :${PORT}`);
});
