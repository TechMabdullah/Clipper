import express from 'express';
import path from 'node:path';
import cron from 'node-cron';
import { openDb } from '@clipper/db-utils';

const app = express();
app.use(express.json());

const PORT = Number(process.env.CLIPPER_PORT ?? 4001);
const DATA_DIR = process.env.DATA_DIR ?? './data';

// ── Gotcha #5: open DB with WAL mode via shared helper ───────────────────
const db = openDb(path.join(DATA_DIR, 'clipper.sqlite'));

// ── Schema: ingest_jobs ───────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ingest_jobs (
    id          TEXT PRIMARY KEY,
    source_url  TEXT,
    source_path TEXT,
    status      TEXT NOT NULL DEFAULT 'PENDING',
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS clips (
    id                  TEXT PRIMARY KEY,
    job_id              TEXT NOT NULL REFERENCES ingest_jobs(id),
    title               TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    start_sec           REAL NOT NULL,
    end_sec             REAL NOT NULL,
    file_path           TEXT NOT NULL,
    file_size_bytes     INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'RENDERED',
    platform            TEXT NOT NULL,
    scheduled_at        TEXT,
    published_at        TEXT,
    platform_video_id   TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);

// ── API ───────────────────────────────────────────────────────────────────
app.get('/api/clipper/health', (_req, res) => res.json({ ok: true }));

app.get('/api/clipper/jobs', (_req, res) => {
  const jobs = db.prepare('SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT 50').all();
  res.json(jobs);
});

app.post('/api/clipper/jobs', (req, res) => {
  const { sourceUrl, sourceFilePath } = req.body as {
    sourceUrl?: string;
    sourceFilePath?: string;
  };
  if (!sourceUrl && !sourceFilePath) {
    res.status(400).json({ error: 'sourceUrl or sourceFilePath required' });
    return;
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO ingest_jobs (id, source_url, source_path) VALUES (?, ?, ?)`,
  ).run(id, sourceUrl ?? null, sourceFilePath ?? null);

  res.status(202).json({ id, status: 'PENDING' });
  // TODO: enqueue download/transcribe/clip pipeline
});

// ── Gotcha #5: Cron — daily HDD cleanup at 03:00 local ───────────────────
cron.schedule('0 3 * * *', () => {
  const retentionDays = Number(process.env.HDD_RETENTION_DAYS ?? 7);
  console.log(`[clipper-service] Running HDD cleanup (>${retentionDays}d published clips)…`);
  // TODO: query published clips older than retentionDays, delete source files
});

app.listen(PORT, () => {
  console.log(`[clipper-service] listening on :${PORT}`);
});
