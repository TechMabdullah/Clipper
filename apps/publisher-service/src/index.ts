import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import cron from 'node-cron';
import { openDb } from '@clipper/db-utils';
import { PLATFORM_CONSTRAINTS, META_MAX_BYTES, type Platform } from '@clipper/shared-types';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PUBLISHER_PORT ?? 4002);
const DATA_DIR = process.env.DATA_DIR ?? './data';

// ── Gotcha #5: WAL mode via shared helper ─────────────────────────────────
const db = openDb(path.join(DATA_DIR, 'publisher.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id            TEXT PRIMARY KEY,
    platform      TEXT NOT NULL,
    account_label TEXT NOT NULL DEFAULT 'default',
    access_token  BLOB NOT NULL,   -- AES-256-GCM encrypted
    refresh_token BLOB,
    expires_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS publish_queue (
    id           TEXT PRIMARY KEY,
    clip_id      TEXT NOT NULL,
    platform     TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING',
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS oauth_state_nonces (
    state      TEXT PRIMARY KEY,
    platform   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);

// ── Gotcha #3: pre-flight file size check before any upload ───────────────
function assertFileSizeOk(filePath: string, platform: Platform): void {
  const { size } = fs.statSync(filePath);
  const max = PLATFORM_CONSTRAINTS[platform].maxBytes;
  if (size > max) {
    throw new Error(
      `[publisher] ${platform} upload aborted: file ${(size / 1e6).toFixed(1)} MB exceeds ` +
      `${(max / 1e6).toFixed(1)} MB limit. Re-encode at lower bitrate.`,
    );
  }
}

// ── API ───────────────────────────────────────────────────────────────────
app.get('/api/publisher/health', (_req, res) => res.json({ ok: true }));

// OAuth callback stubs (state nonce verified, then token exchanged)
for (const platform of ['youtube', 'meta', 'tiktok'] as const) {
  app.get(`/api/publisher/auth/${platform}/callback`, (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const nonce = db
      .prepare('SELECT * FROM oauth_state_nonces WHERE state = ?')
      .get(state);
    if (!nonce) {
      res.status(400).json({ error: 'Invalid or expired OAuth state' });
      return;
    }
    db.prepare('DELETE FROM oauth_state_nonces WHERE state = ?').run(state);
    // TODO: exchange `code` for tokens, encrypt, store in oauth_tokens
    res.json({ ok: true, platform, message: 'Token exchange stub — implement per platform' });
  });
}

// ── Gotcha #1 (YouTube private) / #2 (TikTok self-only): publish queue ───
// Runs every minute on local node-cron (NOT Vercel cron — Vercel Hobby = daily only)
cron.schedule('* * * * *', () => {
  const due = db
    .prepare(
      `SELECT * FROM publish_queue
       WHERE status = 'PENDING' AND scheduled_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ORDER BY scheduled_at ASC LIMIT 5`,
    )
    .all() as Array<{ id: string; clip_id: string; platform: Platform }>;

  for (const item of due) {
    console.log(`[publisher] Dispatching clip ${item.clip_id} → ${item.platform}`);
    // TODO: resolve clip file path, assertFileSizeOk(), call platform uploader
  }
});

app.listen(PORT, () => {
  console.log(`[publisher-service] listening on :${PORT}`);
});
