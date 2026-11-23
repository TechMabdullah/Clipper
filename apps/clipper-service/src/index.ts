import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import cron from 'node-cron';
import chokidar from 'chokidar';
import { db } from './db.js';
import { enqueue } from './pipeline.js';
import { liveManager } from './live/live-manager.js';

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const PORT        = Number(process.env.CLIPPER_PORT ?? 4001);
const MEDIA_ROOT  = process.env.MEDIA_ROOT_DIR ?? 'D:/ClipperMedia';
const INBOX       = path.join(MEDIA_ROOT, '01_inbox');
const CLIPS_DIR   = path.join(MEDIA_ROOT, '03_clips');
const ARCHIVE_DIR = path.join(MEDIA_ROOT, '04_archive');
const RETENTION   = Number(process.env.HDD_RETENTION_DAYS ?? 30);

// ── Serve Local Web Dashboard ─────────────────────────────────────────────
const publicDir = path.resolve('apps/clipper-service/src/public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
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
app.post('/api/clipper/jobs', (req, res) => {
  const { sourceUrl, sourceFilePath } = req.body as {
    sourceUrl?: string; sourceFilePath?: string;
  };
  if (!sourceUrl && !sourceFilePath) {
    res.status(400).json({ error: 'sourceUrl or sourceFilePath required' });
    return;
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO ingest_jobs (id, source_url, source_path) VALUES (?, ?, ?)`)
    .run(id, sourceUrl ?? null, sourceFilePath ?? null);
  enqueue(id);
  res.status(202).json({ id, status: 'PENDING' });
});

// ── Clips ─────────────────────────────────────────────────────────────────
app.get('/api/clipper/clips', (_req, res) => {
  res.json(db.prepare('SELECT * FROM clips ORDER BY created_at DESC LIMIT 200').all());
});

app.get('/api/clipper/clips/:id', (req, res) => {
  const clip = db.prepare('SELECT * FROM clips WHERE id=?').get(req.params.id);
  if (!clip) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(clip);
});

/** Serve the MP4 file for download/preview */
app.get('/api/clipper/clips/:id/file', (req, res) => {
  const clip = db.prepare('SELECT file_path FROM clips WHERE id=?').get(req.params.id) as
    { file_path: string } | undefined;
  if (!clip || !fs.existsSync(clip.file_path)) {
    res.status(404).json({ error: 'File not found' }); return;
  }
  res.download(clip.file_path);
});

/** Archive a clip (move to 04_archive/) */
app.post('/api/clipper/clips/:id/archive', (req, res) => {
  const clip = db.prepare('SELECT * FROM clips WHERE id=?').get(req.params.id) as
    { id: string; file_path: string } | undefined;
  if (!clip) { res.status(404).json({ error: 'Not found' }); return; }
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const dest = path.join(ARCHIVE_DIR, path.basename(clip.file_path));
  fs.renameSync(clip.file_path, dest);
  db.prepare(`UPDATE clips SET status='ARCHIVED', file_path=? WHERE id=?`).run(dest, clip.id);
  res.json({ ok: true, archivedTo: dest });
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

// ── Live Stream Chat Explosion Clipper API ────────────────────────────────
app.get('/api/live/status', (_req, res) => {
  res.json(liveManager.getStatus());
});

app.post('/api/live/start', async (req, res) => {
  const { platform, channelOrUrl, vertical, layout, facecamPosition, spikeMultiplier, minSpikeThreshold } = req.body as {
    platform: 'twitch' | 'youtube';
    channelOrUrl: string;
    vertical?: boolean;
    layout?: 'split' | 'crop' | 'blur' | 'landscape';
    facecamPosition?: 'auto' | 'bottom-left' | 'top-left' | 'bottom-right' | 'top-right';
    spikeMultiplier?: number;
    minSpikeThreshold?: number;
  };

  if (!platform || !channelOrUrl) {
    res.status(400).json({ error: 'platform ("twitch" or "youtube") and channelOrUrl are required' });
    return;
  }

  try {
    await liveManager.startSession({
      platform,
      channelOrUrl,
      vertical: vertical ?? true,
      layout: layout ?? (vertical === false ? 'landscape' : 'split'),
      facecamPosition: facecamPosition ?? 'auto',
      spikeMultiplier: spikeMultiplier ?? 2.5,
      minSpikeThreshold: minSpikeThreshold ?? 4.0,
    });
    res.json({ ok: true, message: `Live clipping active for ${platform}: ${channelOrUrl}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/live/stop', async (_req, res) => {
  await liveManager.stopSession();
  res.json({ ok: true, message: 'Live monitoring stopped' });
});

app.post('/api/live/clip-now', async (req, res) => {
  const { durationSec } = req.body as { durationSec?: number };
  try {
    const clip = await liveManager.manualClip(durationSec ?? 20);
    res.json({ ok: true, clip });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Cron: archive old 01_inbox/ source files after RETENTION days ─────────
cron.schedule('0 3 * * *', () => {
  console.log(`[cleanup] Archiving inbox files done >${RETENTION}d ago…`);
  const cutoff = new Date(Date.now() - RETENTION * 86400_000).toISOString();
  const done = db.prepare(
    `SELECT id, source_path FROM ingest_jobs WHERE status='DONE' AND updated_at < ?`
  ).all(cutoff) as Array<{ id: string; source_path: string | null }>;

  for (const j of done) {
    if (j.source_path && fs.existsSync(j.source_path)) {
      const dest = path.join(ARCHIVE_DIR, path.basename(j.source_path));
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      fs.renameSync(j.source_path, dest);
      console.log(`[cleanup] Archived: ${j.source_path} → ${dest}`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`[clipper-service] 🎬 listening on :${PORT}`);
  console.log(`  Drop videos in:  ${INBOX}`);
  console.log(`  Clips saved to:  ${CLIPS_DIR}`);
  console.log(`  Live Clipper:    POST /api/live/start { platform, channelOrUrl }`);
});
