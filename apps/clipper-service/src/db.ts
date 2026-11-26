import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, withTransaction, type Db } from '@clipper/db-utils';

const DATA_DIR = process.env.DATA_DIR ?? './data';
export const db: Db = openDb(path.join(DATA_DIR, 'clipper.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS ingest_jobs (
    id          TEXT PRIMARY KEY,
    source_url  TEXT,
    source_path TEXT,
    status      TEXT NOT NULL DEFAULT 'PENDING',
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS clips (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES ingest_jobs(id),
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    start_sec       REAL NOT NULL,
    end_sec         REAL NOT NULL,
    duration_sec    REAL NOT NULL DEFAULT 0,
    file_path       TEXT NOT NULL DEFAULT '',
    file_size_bytes INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'READY',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS plans (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    tagline                 TEXT NOT NULL DEFAULT '',
    price_usd               REAL NOT NULL DEFAULT 0,
    billing_period          TEXT NOT NULL DEFAULT 'MONTHLY',
    daily_clip_limit        INTEGER NOT NULL DEFAULT 3,
    max_resolution          INTEGER NOT NULL DEFAULT 720,
    watermark_enabled       INTEGER NOT NULL DEFAULT 1,
    allow_auto_captions     INTEGER NOT NULL DEFAULT 0,
    allow_audio_peak        INTEGER NOT NULL DEFAULT 0,
    allow_virality_ai       INTEGER NOT NULL DEFAULT 0,
    allow_watchlist         INTEGER NOT NULL DEFAULT 0,
    allow_custom_branding   INTEGER NOT NULL DEFAULT 0,
    kelviq_payment_link     TEXT NOT NULL DEFAULT '',
    kelviq_plan_identifier  TEXT NOT NULL DEFAULT '',
    updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS active_license (
    id                TEXT PRIMARY KEY DEFAULT 'current',
    license_key       TEXT NOT NULL DEFAULT '',
    instance_id       TEXT NOT NULL DEFAULT '',
    plan_id           TEXT NOT NULL DEFAULT 'free',
    provider          TEXT NOT NULL DEFAULT 'free',
    customer_email    TEXT NOT NULL DEFAULT '',
    customer_name     TEXT NOT NULL DEFAULT '',
    expires_on        TEXT NOT NULL DEFAULT '',
    last_validated_at TEXT NOT NULL DEFAULT '',
    activated_at      TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS local_licenses (
    license_key     TEXT PRIMARY KEY,
    plan_id         TEXT NOT NULL DEFAULT 'pro',
    customer_email  TEXT NOT NULL DEFAULT '',
    note            TEXT NOT NULL DEFAULT '',
    active          INTEGER NOT NULL DEFAULT 1,
    expires_on      TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS kelviq_events (
    id               TEXT PRIMARY KEY,
    event_type       TEXT NOT NULL,
    customer_email   TEXT NOT NULL DEFAULT '',
    license_key      TEXT NOT NULL DEFAULT '',
    plan_identifier  TEXT NOT NULL DEFAULT '',
    amount           TEXT NOT NULL DEFAULT '',
    raw_json         TEXT NOT NULL DEFAULT '{}',
    received_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS stream_watchlist (
    id                TEXT PRIMARY KEY,
    platform          TEXT NOT NULL,
    channel           TEXT NOT NULL,
    layout            TEXT NOT NULL DEFAULT 'split',
    facecam_position  TEXT NOT NULL DEFAULT 'auto',
    caption_style     TEXT NOT NULL DEFAULT 'none',
    auto_clip         INTEGER NOT NULL DEFAULT 0,
    enabled           INTEGER NOT NULL DEFAULT 1,
    is_currently_live INTEGER NOT NULL DEFAULT 0,
    last_checked_at   TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  INSERT OR IGNORE INTO ingest_jobs (id, source_url, status)
  VALUES ('default', 'system', 'DONE');

  INSERT OR IGNORE INTO active_license (id, plan_id, provider)
  VALUES ('current', 'free', 'free');
`);

// Safely migrate additional analytics columns onto existing `clips` table
const clipColumns = db.prepare('PRAGMA table_info(clips)').all() as Array<{ name: string }>;
const colNames = new Set(clipColumns.map(c => c.name));
const migrations: Array<[string, string]> = [
  ['virality_score', 'REAL NOT NULL DEFAULT 0'],
  ['virality_reason', "TEXT NOT NULL DEFAULT ''"],
  ['captions_style', "TEXT NOT NULL DEFAULT 'none'"],
  ['layout', "TEXT NOT NULL DEFAULT 'split'"],
  ['source_platform', "TEXT NOT NULL DEFAULT 'local'"],
  ['thumbnail_path', "TEXT NOT NULL DEFAULT ''"],
  ['social_title', "TEXT NOT NULL DEFAULT ''"],
  ['social_hashtags', "TEXT NOT NULL DEFAULT ''"],
  ['aspect_ratio', "TEXT NOT NULL DEFAULT '9:16'"],
  ['audio_normalized', 'INTEGER NOT NULL DEFAULT 0'],
  ['tags', "TEXT NOT NULL DEFAULT ''"],
  ['notes', "TEXT NOT NULL DEFAULT ''"],
  ['is_favourite', 'INTEGER NOT NULL DEFAULT 0'],
];
for (const [col, def] of migrations) {
  if (!colNames.has(col)) {
    db.exec(`ALTER TABLE clips ADD COLUMN ${col} ${def}`);
  }
}

// Seed default Free, Pro, Ultra plans (editable inside Admin Dashboard)
const upsertDefaultPlan = db.prepare(`
  INSERT OR IGNORE INTO plans (
    id, name, tagline, price_usd, billing_period, daily_clip_limit, max_resolution,
    watermark_enabled, allow_auto_captions, allow_audio_peak, allow_virality_ai,
    allow_watchlist, allow_custom_branding, kelviq_payment_link, kelviq_plan_identifier
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

upsertDefaultPlan.run(
  'free',
  'Free Starter',
  'Try live chat velocity & manual stream clipping',
  0,
  'MONTHLY',
  3,
  720,
  1,
  0,
  0,
  0,
  0,
  0,
  '',
  'free'
);

upsertDefaultPlan.run(
  'pro',
  'Pro Creator',
  'Unlimited 1080p60 clipping, Auto Kinetic Captions & Audio Peak Scanner',
  12,
  'MONTHLY',
  -1,
  1080,
  0,
  1,
  1,
  1,
  0,
  0,
  process.env.KELVIQ_PRO_PAYMENT_LINK ?? '',
  process.env.KELVIQ_PRO_PLAN_ID ?? 'pro'
);

upsertDefaultPlan.run(
  'ultra',
  'Ultra Studio',
  'Full AI SaaS suite: Multi-Stream Watchlist, Custom Branding & Priority Power',
  29,
  'MONTHLY',
  -1,
  1080,
  0,
  1,
  1,
  1,
  1,
  1,
  process.env.KELVIQ_ULTRA_PAYMENT_LINK ?? '',
  process.env.KELVIQ_ULTRA_PLAN_ID ?? 'ultra'
);

// Backfill empty payment links when env vars are populated after initial seeding
const envProPaymentLink = (process.env.KELVIQ_PRO_PAYMENT_LINK ?? '').trim();
if (envProPaymentLink) {
  db.prepare(`
    UPDATE plans
    SET kelviq_payment_link = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = 'pro' AND (kelviq_payment_link IS NULL OR TRIM(kelviq_payment_link) = '')
  `).run(envProPaymentLink);
}
const envUltraPaymentLink = (process.env.KELVIQ_ULTRA_PAYMENT_LINK ?? '').trim();
if (envUltraPaymentLink) {
  db.prepare(`
    UPDATE plans
    SET kelviq_payment_link = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = 'ultra' AND (kelviq_payment_link IS NULL OR TRIM(kelviq_payment_link) = '')
  `).run(envUltraPaymentLink);
}

// Password & Settings Utilities
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const hashBuffer = crypto.scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  if (hashBuffer.length !== keyBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, keyBuffer);
}

export function getSetting(key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(key, value);
}

/**
 * Generates and persists a fresh admin session signing secret so any
 * previously issued admin session cookies are immediately invalidated.
 */
export function rotateSessionSecret(): string {
  const nextSecret = crypto.randomBytes(32).toString('hex');
  setSetting('admin_session_secret', nextSecret);
  return nextSecret;
}

// Seed initial app settings from env if unset
function seedSettingIfMissing(key: string, value: string): void {
  const existing = db.prepare('SELECT key FROM app_settings WHERE key=?').get(key);
  if (!existing) setSetting(key, value);
}

seedSettingIfMissing('admin_password_hash', hashPassword(process.env.ADMIN_PASSWORD ?? 'admin123'));
seedSettingIfMissing('admin_session_secret', crypto.randomBytes(32).toString('hex'));
seedSettingIfMissing('kelviq_access_token', process.env.KELVIQ_API_KEY ?? '');
seedSettingIfMissing('kelviq_environment', process.env.KELVIQ_ENV ?? 'production');
seedSettingIfMissing('kelviq_webhook_secret', process.env.KELVIQ_WEBHOOK_SECRET ?? '');
seedSettingIfMissing('kelviq_portal_url', process.env.KELVIQ_PORTAL_URL ?? '');
seedSettingIfMissing('default_watermark_text', 'Clipper Studio');

export interface InsertClipParams {
  id?: string;
  jobId?: string;
  title: string;
  description?: string;
  startSec?: number;
  endSec?: number;
  durationSec?: number;
  filePath: string;
  fileSizeBytes?: number;
  status?: string;
  viralityScore?: number;
  viralityReason?: string;
  captionsStyle?: string;
  layout?: string;
  sourcePlatform?: string;
  thumbnailPath?: string;
  socialTitle?: string;
  socialHashtags?: string;
  aspectRatio?: string;
  audioNormalized?: boolean | number;
  tags?: string[] | string;
  notes?: string;
  isFavourite?: boolean | number;
  is_favourite?: boolean | number;
}

/**
 * Safely inserts a clip into SQLite, guaranteeing that the parent
 * ingest_jobs row exists first to prevent FOREIGN KEY constraint violations.
 */
export function insertClip(params: InsertClipParams): string {
  const clipId = params.id ?? crypto.randomUUID();
  const jobId = params.jobId ?? 'default';

  db.prepare(`
    INSERT OR IGNORE INTO ingest_jobs (id, source_url, status)
    VALUES (?, ?, 'DONE')
  `).run(jobId, 'system');

  const startSec = params.startSec ?? 0;
  const duration = params.durationSec ?? Math.max(0, (params.endSec ?? 0) - startSec);
  const endSec = params.endSec ?? (startSec + duration);
  const aspectRatio = params.aspectRatio ?? (params.layout === 'landscape' ? '16:9' : '9:16');
  const tagsStr = Array.isArray(params.tags)
    ? params.tags.join(',')
    : (params.tags ?? '');
  const isFav = params.isFavourite ?? params.is_favourite ? 1 : 0;

  db.prepare(`
    INSERT INTO clips (
      id, job_id, title, description, start_sec, end_sec, duration_sec,
      file_path, file_size_bytes, status, virality_score, virality_reason,
      captions_style, layout, source_platform,
      thumbnail_path, social_title, social_hashtags, aspect_ratio, audio_normalized,
      tags, notes, is_favourite
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clipId,
    jobId,
    params.title,
    params.description ?? '',
    startSec,
    endSec,
    duration,
    params.filePath,
    params.fileSizeBytes ?? 0,
    params.status ?? 'READY',
    params.viralityScore ?? 0,
    params.viralityReason ?? '',
    params.captionsStyle ?? 'none',
    params.layout ?? 'split',
    params.sourcePlatform ?? 'local',
    params.thumbnailPath ?? '',
    params.socialTitle ?? '',
    params.socialHashtags ?? '',
    aspectRatio,
    params.audioNormalized ? 1 : 0,
    tagsStr,
    params.notes ?? '',
    isFav
  );

  return clipId;
}

export function clipExists(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const row = db.prepare('SELECT 1 AS found FROM clips WHERE id = ?').get(id) as
    | { found: number }
    | undefined;
  return Boolean(row?.found);
}

export function updateClipSocialMetadata(
  id: string,
  socialTitle: string,
  socialHashtags: string,
): boolean {
  const res = db.prepare(`
    UPDATE clips
    SET social_title = ?, social_hashtags = ?
    WHERE id = ?
  `).run(socialTitle, socialHashtags, id);
  return Number(res.changes) > 0;
}

export function updateClipThumbnail(id: string, thumbnailPath: string): boolean {
  const res = db.prepare(`
    UPDATE clips
    SET thumbnail_path = ?
    WHERE id = ?
  `).run(thumbnailPath, id);
  return Number(res.changes) > 0;
}

// ── API Keys, Audit Logs & Scheduled Jobs tables ──────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    key          TEXT NOT NULL DEFAULT '',
    key_hash     TEXT NOT NULL DEFAULT '',
    key_prefix   TEXT NOT NULL DEFAULT '',
    last4        TEXT NOT NULL DEFAULT '',
    label        TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at TEXT NOT NULL DEFAULT '',
    active       INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id         TEXT PRIMARY KEY,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    details    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id            TEXT PRIMARY KEY,
    video_path    TEXT NOT NULL DEFAULT '',
    cron_expr     TEXT NOT NULL DEFAULT '',
    max_clips     INTEGER NOT NULL DEFAULT 5,
    layout        TEXT NOT NULL DEFAULT 'split',
    caption_style TEXT NOT NULL DEFAULT 'none',
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_run_at   TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Safely migrate legacy `api_keys` schema (where `key` was PRIMARY KEY) to hashed storage
(() => {
  const cols = db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string; pk: number }>;
  const colNames = new Set(cols.map((c) => c.name));
  const needsRebuild = !colNames.has('id') || cols.some((c) => c.name === 'key' && c.pk === 1);

  if (needsRebuild) {
    const existingRows = db.prepare('SELECT * FROM api_keys').all() as Array<Record<string, unknown>>;
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE api_keys_migrated (
          id           TEXT PRIMARY KEY,
          key          TEXT NOT NULL DEFAULT '',
          key_hash     TEXT NOT NULL DEFAULT '',
          key_prefix   TEXT NOT NULL DEFAULT '',
          last4        TEXT NOT NULL DEFAULT '',
          label        TEXT NOT NULL DEFAULT '',
          created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_used_at TEXT NOT NULL DEFAULT '',
          active       INTEGER NOT NULL DEFAULT 1
        )
      `);
      const insertMigrated = db.prepare(`
        INSERT INTO api_keys_migrated (
          id, key, key_hash, key_prefix, last4, label, created_at, last_used_at, active
        ) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of existingRows) {
        const rawKey = String(row.key ?? '');
        const existingHash = String(row.key_hash ?? '');
        const keyHash = existingHash || (rawKey ? hashApiKey(rawKey) : '');
        const keyPrefix = String(row.key_prefix ?? '') || (rawKey.startsWith('csk_') ? 'csk_' : rawKey.slice(0, 4));
        const last4 = String(row.last4 ?? '') || (rawKey ? rawKey.slice(-4) : '');
        insertMigrated.run(
          row.id ? String(row.id) : crypto.randomUUID(),
          keyHash,
          keyPrefix,
          last4,
          String(row.label ?? ''),
          String(row.created_at ?? '') || new Date().toISOString(),
          String(row.last_used_at ?? ''),
          row.active !== undefined ? Number(row.active) : 1,
        );
      }
      db.exec('DROP TABLE api_keys; ALTER TABLE api_keys_migrated RENAME TO api_keys;');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } else {
    const apiKeyMigrations: Array<[string, string]> = [
      ['key', "TEXT NOT NULL DEFAULT ''"],
      ['key_hash', "TEXT NOT NULL DEFAULT ''"],
      ['key_prefix', "TEXT NOT NULL DEFAULT ''"],
      ['last4', "TEXT NOT NULL DEFAULT ''"],
      ['label', "TEXT NOT NULL DEFAULT ''"],
      ['created_at', "TEXT NOT NULL DEFAULT ''"],
      ['last_used_at', "TEXT NOT NULL DEFAULT ''"],
      ['active', 'INTEGER NOT NULL DEFAULT 1'],
    ];
    for (const [col, def] of apiKeyMigrations) {
      if (!colNames.has(col)) {
        db.exec(`ALTER TABLE api_keys ADD COLUMN ${col} ${def}`);
      }
    }

    const legacyRows = db.prepare(
      `SELECT rowid AS _rowid, id, key, key_hash, key_prefix, last4 FROM api_keys WHERE (key IS NOT NULL AND key != '') OR id IS NULL OR id = ''`
    ).all() as Array<{ _rowid: number; id: string | null; key: string | null; key_hash: string; key_prefix: string; last4: string }>;

    if (legacyRows.length > 0) {
      const updateRow = db.prepare(`
        UPDATE api_keys SET id = ?, key = '', key_hash = ?, key_prefix = ?, last4 = ? WHERE rowid = ?
      `);
      for (const row of legacyRows) {
        const rawKey = String(row.key ?? '');
        const id = row.id && row.id.trim() ? row.id : crypto.randomUUID();
        const keyHash = row.key_hash || (rawKey ? hashApiKey(rawKey) : '');
        const keyPrefix = row.key_prefix || (rawKey.startsWith('csk_') ? 'csk_' : rawKey.slice(0, 4));
        const last4 = row.last4 || (rawKey ? rawKey.slice(-4) : '');
        updateRow.run(id, keyHash, keyPrefix, last4, row._rowid);
      }
    }
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)');
})();

// Safely migrate additional columns onto `scheduled_jobs`
(() => {
  const schedCols = db.prepare('PRAGMA table_info(scheduled_jobs)').all() as Array<{ name: string }>;
  const schedNames = new Set(schedCols.map((c) => c.name));
  const schedMigrations: Array<[string, string]> = [
    ['layout', "TEXT NOT NULL DEFAULT 'split'"],
    ['caption_style', "TEXT NOT NULL DEFAULT 'none'"],
  ];
  for (const [col, def] of schedMigrations) {
    if (!schedNames.has(col)) {
      db.exec(`ALTER TABLE scheduled_jobs ADD COLUMN ${col} ${def}`);
    }
  }
})();

export interface CreatedApiKey {
  id: string;
  key: string;
  maskedKey: string;
  label: string;
}

export interface ApiKeySummary {
  id: string;
  label: string;
  key_prefix: string;
  last4: string;
  maskedKey: string;
  created_at: string;
  last_used_at: string;
  active: number;
}

export function createApiKey(label: string): CreatedApiKey {
  const id = crypto.randomUUID();
  const keyPrefix = 'csk_';
  const key = `${keyPrefix}${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = hashApiKey(key);
  const last4 = key.slice(-4);
  const cleanLabel = label.trim().slice(0, 128);

  db.prepare(`
    INSERT INTO api_keys (id, key, key_hash, key_prefix, last4, label, active)
    VALUES (?, '', ?, ?, ?, ?, 1)
  `).run(id, keyHash, keyPrefix, last4, cleanLabel);

  return {
    id,
    key,
    maskedKey: `${keyPrefix}***${last4}`,
    label: cleanLabel,
  };
}

export function validateApiKey(rawKey: string): boolean {
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith('csk_')) return false;
  const keyHash = hashApiKey(rawKey);
  const hashedRow = db.prepare(
    `SELECT id, key_hash FROM api_keys WHERE key_hash = ? AND active = 1`
  ).get(keyHash) as { id: string; key_hash: string } | undefined;

  if (hashedRow && timingSafeEqualStrings(hashedRow.key_hash, keyHash)) {
    db.prepare(`UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(hashedRow.id);
    return true;
  }

  // Fallback constant-time check for any un-migrated legacy plaintext row
  const legacyRows = db.prepare(
    `SELECT id, key FROM api_keys WHERE key != '' AND active = 1`
  ).all() as Array<{ id: string; key: string }>;
  for (const row of legacyRows) {
    if (timingSafeEqualStrings(rawKey, row.key)) {
      db.prepare(`UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(row.id);
      return true;
    }
  }
  return false;
}

export function listApiKeys(): ApiKeySummary[] {
  const rows = db.prepare(`
    SELECT id, label, key_prefix, last4, created_at, last_used_at, active
    FROM api_keys
    ORDER BY created_at DESC
  `).all() as Array<{
    id: string;
    label: string;
    key_prefix: string;
    last4: string;
    created_at: string;
    last_used_at: string;
    active: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    key_prefix: row.key_prefix || 'csk_',
    last4: row.last4,
    maskedKey: `${row.key_prefix || 'csk_'}***${row.last4}`,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    active: row.active,
  }));
}

export function revokeApiKey(idOrKey: string): boolean {
  const clean = typeof idOrKey === 'string' ? idOrKey.trim() : '';
  if (!clean) return false;
  const keyHash = hashApiKey(clean);
  const res = db.prepare(`
    UPDATE api_keys SET active = 0 WHERE id = ? OR (key_hash != '' AND key_hash = ?)
  `).run(clean, keyHash);
  return Number(res.changes) > 0;
}

export interface AuditLogRecord {
  id: string;
  actor: string;
  action: string;
  target: string;
  ip: string;
  details: string;
  created_at: string;
}

export function logAuditEvent(
  actor: string,
  action: string,
  target = '',
  ip = '',
  details: string | Record<string, unknown> = '',
): string {
  const id = crypto.randomUUID();
  const detailsStr = typeof details === 'string' ? details : JSON.stringify(details);
  db.prepare(`
    INSERT INTO audit_logs (id, actor, action, target, ip, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(actor || 'system').slice(0, 128),
    String(action || 'unknown').slice(0, 128),
    String(target ?? '').slice(0, 512),
    String(ip ?? '').slice(0, 128),
    detailsStr.slice(0, 4000),
  );
  return id;
}

export function listAuditLogs(limit = 50): AuditLogRecord[] {
  const safeLimit = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 50));
  return db.prepare(`
    SELECT id, actor, action, target, ip, details, created_at
    FROM audit_logs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(safeLimit) as unknown as AuditLogRecord[];
}

export interface ScheduledJobRecord {
  id: string;
  video_path: string;
  cron_expr: string;
  max_clips: number;
  layout: string;
  caption_style: string;
  enabled: number;
  last_run_at: string;
  created_at: string;
}

export interface CreateScheduledJobInput {
  id?: string;
  videoPath: string;
  cronExpr: string;
  maxClips?: number;
  layout?: string;
  captionStyle?: string;
  enabled?: boolean;
}

export function listScheduledJobs(): ScheduledJobRecord[] {
  return db.prepare(`
    SELECT id, video_path, cron_expr, max_clips, layout, caption_style, enabled, last_run_at, created_at
    FROM scheduled_jobs
    ORDER BY created_at DESC
  `).all() as unknown as ScheduledJobRecord[];
}

export function getScheduledJobById(id: string): ScheduledJobRecord | undefined {
  return db.prepare(`
    SELECT id, video_path, cron_expr, max_clips, layout, caption_style, enabled, last_run_at, created_at
    FROM scheduled_jobs
    WHERE id = ?
  `).get(id) as ScheduledJobRecord | undefined;
}

export function createScheduledJob(input: CreateScheduledJobInput): ScheduledJobRecord {
  const id = input.id ?? crypto.randomUUID();
  const maxClips = Math.min(5, Math.max(1, Math.trunc(Number(input.maxClips ?? 3) || 3)));
  const layout = input.layout || 'split';
  const captionStyle = input.captionStyle || 'none';
  const enabled = input.enabled === false ? 0 : 1;

  db.prepare(`
    INSERT INTO scheduled_jobs (id, video_path, cron_expr, max_clips, layout, caption_style, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.videoPath, input.cronExpr, maxClips, layout, captionStyle, enabled);

  return getScheduledJobById(id)!;
}

export function toggleScheduledJob(id: string, enabled?: boolean): ScheduledJobRecord | null {
  const existing = getScheduledJobById(id);
  if (!existing) return null;
  const nextEnabled = enabled === undefined ? (existing.enabled === 1 ? 0 : 1) : (enabled ? 1 : 0);
  db.prepare(`UPDATE scheduled_jobs SET enabled = ? WHERE id = ?`).run(nextEnabled, id);
  return getScheduledJobById(id) ?? null;
}

export function deleteScheduledJob(id: string): boolean {
  const res = db.prepare(`DELETE FROM scheduled_jobs WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}

export function updateScheduledJobLastRun(id: string): boolean {
  const res = db.prepare(`
    UPDATE scheduled_jobs
    SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(id);
  return Number(res.changes) > 0;
}

export function updateClipTags(id: string, tags: string[]): boolean {
  const res = db.prepare(`UPDATE clips SET tags = ? WHERE id = ?`).run(tags.join(','), id);
  return Number(res.changes) > 0;
}

export function updateClipNotes(id: string, notes: string): boolean {
  const res = db.prepare(`UPDATE clips SET notes = ? WHERE id = ?`).run(notes, id);
  return Number(res.changes) > 0;
}

export function toggleClipFavourite(id: string): boolean {
  const row = db.prepare(`SELECT is_favourite FROM clips WHERE id=?`).get(id) as { is_favourite: number } | undefined;
  if (!row) return false;
  const next = row.is_favourite === 1 ? 0 : 1;
  db.prepare(`UPDATE clips SET is_favourite=? WHERE id=?`).run(next, id);
  return next === 1;
}

export function getDailyClipCount(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM clips WHERE date(created_at) = date('now')
  `).get() as { cnt: number };
  return Number(row?.cnt ?? 0);
}

export function getDashboardAnalytics() {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS totalClips,
      COALESCE(SUM(file_size_bytes), 0) AS totalBytes,
      COALESCE(SUM(duration_sec), 0) AS totalDurationSec,
      COALESCE(AVG(NULLIF(virality_score, 0)), 0) AS avgVirality
    FROM clips
  `).get() as {
    totalClips: number;
    totalBytes: number;
    totalDurationSec: number;
    avgVirality: number;
  };

  const dailySeries = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS count
    FROM clips
    WHERE created_at >= date('now', '-6 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all() as Array<{ day: string; count: number }>;

  const topClips = db.prepare(`
    SELECT id, title, virality_score, virality_reason, duration_sec, layout, created_at
    FROM clips
    ORDER BY virality_score DESC, created_at DESC
    LIMIT 5
  `).all();

  return {
    totalClips: Number(totals?.totalClips ?? 0),
    totalBytes: Number(totals?.totalBytes ?? 0),
    totalDurationSec: Number(totals?.totalDurationSec ?? 0),
    avgVirality: Math.round(Number(totals?.avgVirality ?? 0)),
    dailyClipCount: getDailyClipCount(),
    dailySeries,
    topClips,
  };
}

// ── Saved Editing Presets (clip_presets) ───────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS clip_presets (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    description      TEXT NOT NULL DEFAULT '',
    layout           TEXT NOT NULL DEFAULT 'split',
    facecam_position TEXT NOT NULL DEFAULT 'auto',
    caption_style    TEXT NOT NULL DEFAULT 'none',
    silence_cut      INTEGER NOT NULL DEFAULT 0,
    audio_normalize  INTEGER NOT NULL DEFAULT 0,
    music_track      TEXT NOT NULL DEFAULT '',
    music_volume     REAL NOT NULL DEFAULT 0.15,
    hook_title       TEXT NOT NULL DEFAULT '',
    watermark_text   TEXT NOT NULL DEFAULT '',
    is_builtin       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

const seedBuiltinPreset = db.prepare(`
  INSERT OR IGNORE INTO clip_presets (
    id, name, description, layout, facecam_position, caption_style,
    silence_cut, audio_normalize, music_track, music_volume,
    hook_title, watermark_text, is_builtin
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

seedBuiltinPreset.run(
  'builtin-viral-split',
  'Viral Split + Hormozi',
  '9:16 facecam split with Hormozi captions, dead-air silence cut & -14 LUFS voice normalization',
  'split',
  'auto',
  'hormozi',
  1,
  1,
  '',
  0.12,
  '',
  '',
);

seedBuiltinPreset.run(
  'builtin-clean-4x5',
  'IG 4:5 Clean Captions',
  'Instagram 4:5 portrait layout with minimal captions & normalized audio',
  'portrait-4x5',
  'auto',
  'minimal',
  0,
  1,
  '',
  0.15,
  '',
  '',
);

seedBuiltinPreset.run(
  'builtin-podcast-1x1',
  'Square Reaction + Broadcast',
  '1:1 square layout with neon captions, silence trim & broadcast voice clarity',
  'square',
  'auto',
  'neon',
  1,
  1,
  '',
  0.10,
  '',
  '',
);

export interface PresetRecord {
  id: string;
  name: string;
  description: string;
  layout: string;
  facecam_position: string;
  caption_style: string;
  silence_cut: number;
  audio_normalize: number;
  music_track: string;
  music_volume: number;
  hook_title: string;
  watermark_text: string;
  is_builtin: number;
  created_at: string;
}

export interface CreatePresetInput {
  id?: string;
  name: string;
  description?: string;
  layout?: string;
  facecamPosition?: string;
  captionStyle?: string;
  silenceCut?: boolean | number;
  audioNormalize?: boolean | number;
  musicTrack?: string;
  musicVolume?: number;
  hookTitle?: string;
  watermarkText?: string;
}

const PRESET_COLUMNS = `
  id, name, description, layout, facecam_position, caption_style,
  silence_cut, audio_normalize, music_track, music_volume,
  hook_title, watermark_text, is_builtin, created_at
`;

/** Lists all saved editing presets (built-in presets first, then user presets). */
export function listPresets(): PresetRecord[] {
  return db.prepare(`
    SELECT ${PRESET_COLUMNS}
    FROM clip_presets
    ORDER BY is_builtin DESC, created_at ASC
  `).all() as unknown as PresetRecord[];
}

/** Fetches a single editing preset by ID. */
export function getPresetById(id: string): PresetRecord | undefined {
  if (!id || typeof id !== 'string') return undefined;
  return db.prepare(`
    SELECT ${PRESET_COLUMNS}
    FROM clip_presets
    WHERE id = ?
  `).get(id) as PresetRecord | undefined;
}

/** Creates a custom user editing preset in SQLite. */
export function createPreset(input: CreatePresetInput): PresetRecord {
  const id = input.id ?? crypto.randomUUID();
  const cleanName = input.name.trim();
  const rawVol = Number(input.musicVolume ?? 0.15);
  const musicVolume = Number.isFinite(rawVol) ? Math.min(1, Math.max(0, rawVol)) : 0.15;

  db.prepare(`
    INSERT INTO clip_presets (
      id, name, description, layout, facecam_position, caption_style,
      silence_cut, audio_normalize, music_track, music_volume,
      hook_title, watermark_text, is_builtin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    cleanName,
    (input.description ?? '').trim(),
    input.layout || 'split',
    input.facecamPosition || 'auto',
    input.captionStyle || 'none',
    input.silenceCut ? 1 : 0,
    input.audioNormalize ? 1 : 0,
    (input.musicTrack ?? '').trim(),
    musicVolume,
    (input.hookTitle ?? '').trim(),
    (input.watermarkText ?? '').trim(),
  );

  return getPresetById(id)!;
}

/** Deletes a user-created preset (`is_builtin = 0` prevents deleting built-in presets). */
export function deletePreset(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const res = db.prepare(`DELETE FROM clip_presets WHERE id = ? AND is_builtin = 0`).run(id);
  return Number(res.changes) > 0;
}

// ── Signed Outbound Webhooks (outbound_webhooks) ───────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS outbound_webhooks (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    url               TEXT NOT NULL,
    events            TEXT NOT NULL DEFAULT 'clip.ready',
    secret            TEXT NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    last_status       INTEGER,
    last_error        TEXT NOT NULL DEFAULT '',
    last_triggered_at TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

export interface OutboundWebhookRecord {
  id: string;
  name: string;
  url: string;
  events: string;
  secretPreview: string;
  enabled: number;
  last_status: number | null;
  last_error: string;
  last_triggered_at: string;
  created_at: string;
}

export interface OutboundWebhookDispatchTarget extends OutboundWebhookRecord {
  secret: string;
}

export interface CreateOutboundWebhookInput {
  id?: string;
  name: string;
  url: string;
  events?: string | string[];
}

export interface CreatedOutboundWebhook extends OutboundWebhookRecord {
  secret: string;
}

interface RawOutboundWebhookRow {
  id: string;
  name: string;
  url: string;
  events: string;
  secret: string;
  enabled: number;
  last_status: number | null;
  last_error: string;
  last_triggered_at: string;
  created_at: string;
}

function maskWebhookSecret(secret: string): string {
  const clean = String(secret ?? '').trim();
  const last4 = clean.slice(-4);
  return `whsec_***${last4}`;
}

function toMaskedWebhookRecord(row: RawOutboundWebhookRow): OutboundWebhookRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events,
    secretPreview: maskWebhookSecret(row.secret),
    enabled: row.enabled,
    last_status: row.last_status ?? null,
    last_error: row.last_error,
    last_triggered_at: row.last_triggered_at,
    created_at: row.created_at,
  };
}

function toDispatchTarget(row: RawOutboundWebhookRow): OutboundWebhookDispatchTarget {
  return {
    ...toMaskedWebhookRecord(row),
    secret: row.secret,
  };
}

/** Creates an outbound webhook subscription with a fresh `whsec_<48 hex>` signing secret. */
export function createOutboundWebhook(input: CreateOutboundWebhookInput): CreatedOutboundWebhook {
  const id = input.id ?? crypto.randomUUID();
  const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  const rawEvents = Array.isArray(input.events)
    ? input.events
    : String(input.events ?? 'clip.ready').split(',');
  const normalizedEvents = Array.from(
    new Set(rawEvents.map((e) => String(e).trim()).filter(Boolean)),
  );
  const eventsStr = normalizedEvents.length > 0 ? normalizedEvents.join(',') : 'clip.ready';

  db.prepare(`
    INSERT INTO outbound_webhooks (id, name, url, events, secret, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, input.name.trim(), input.url.trim(), eventsStr, secret);

  const masked = getOutboundWebhookById(id)!;
  return {
    ...masked,
    secret,
  };
}

/** Lists all configured outbound webhooks with masked secrets (`secretPreview`). */
export function listOutboundWebhooks(): OutboundWebhookRecord[] {
  const rows = db.prepare(`
    SELECT id, name, url, events, secret, enabled, last_status, last_error, last_triggered_at, created_at
    FROM outbound_webhooks
    ORDER BY created_at DESC
  `).all() as unknown as RawOutboundWebhookRow[];
  return rows.map(toMaskedWebhookRecord);
}

/** Fetches a single outbound webhook summary (with masked secret) by ID. */
export function getOutboundWebhookById(id: string): OutboundWebhookRecord | undefined {
  if (!id || typeof id !== 'string') return undefined;
  const row = db.prepare(`
    SELECT id, name, url, events, secret, enabled, last_status, last_error, last_triggered_at, created_at
    FROM outbound_webhooks
    WHERE id = ?
  `).get(id) as RawOutboundWebhookRow | undefined;
  return row ? toMaskedWebhookRecord(row) : undefined;
}

/** Fetches a single outbound webhook with signing secret for internal dispatch only. */
export function getOutboundWebhookDispatchTarget(id: string): OutboundWebhookDispatchTarget | undefined {
  if (!id || typeof id !== 'string') return undefined;
  const row = db.prepare(`
    SELECT id, name, url, events, secret, enabled, last_status, last_error, last_triggered_at, created_at
    FROM outbound_webhooks
    WHERE id = ?
  `).get(id) as RawOutboundWebhookRow | undefined;
  return row ? toDispatchTarget(row) : undefined;
}

/** Toggles or explicitly sets the `enabled` status of an outbound webhook. */
export function toggleOutboundWebhook(id: string, enabled?: boolean): OutboundWebhookRecord | null {
  const existing = getOutboundWebhookById(id);
  if (!existing) return null;
  const nextEnabled = enabled === undefined ? (existing.enabled === 1 ? 0 : 1) : (enabled ? 1 : 0);
  db.prepare(`UPDATE outbound_webhooks SET enabled = ? WHERE id = ?`).run(nextEnabled, id);
  return getOutboundWebhookById(id) ?? null;
}

/** Deletes an outbound webhook by ID. */
export function deleteOutboundWebhook(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const res = db.prepare(`DELETE FROM outbound_webhooks WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}

/** Returns enabled outbound webhooks subscribed to `eventType` (including signing secrets for dispatch). */
export function getEnabledOutboundWebhooksForEvent(eventType: string): OutboundWebhookDispatchTarget[] {
  const targetEvent = String(eventType ?? '').trim();
  if (!targetEvent) return [];
  const rows = db.prepare(`
    SELECT id, name, url, events, secret, enabled, last_status, last_error, last_triggered_at, created_at
    FROM outbound_webhooks
    WHERE enabled = 1
  `).all() as unknown as RawOutboundWebhookRow[];

  return rows
    .filter((row) =>
      row.events
        .split(',')
        .map((e) => e.trim())
        .includes(targetEvent),
    )
    .map(toDispatchTarget);
}

/** Records the latest delivery status code and error message for an outbound webhook. */
export function recordOutboundWebhookResult(
  id: string,
  statusCode: number | null,
  errorMsg = '',
): boolean {
  if (!id || typeof id !== 'string') return false;
  const safeStatus = statusCode !== null && Number.isFinite(statusCode)
    ? Math.trunc(statusCode)
    : null;
  const res = db.prepare(`
    UPDATE outbound_webhooks
    SET last_status = ?,
        last_error = ?,
        last_triggered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(safeStatus, String(errorMsg ?? '').slice(0, 1000), id);
  return Number(res.changes) > 0;
}

// ── Clip Collections (clip_collections + clip_collection_items) ────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS clip_collections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#6366f1',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS clip_collection_items (
    collection_id TEXT NOT NULL REFERENCES clip_collections(id) ON DELETE CASCADE,
    clip_id       TEXT NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,
    added_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (collection_id, clip_id)
  );
`);

export interface CollectionRecord {
  id: string;
  name: string;
  description: string;
  color: string;
  clip_count: number;
  created_at: number;
  updated_at: number;
}

export function createCollection(input: {
  name: string;
  description?: string;
  color?: string;
}): CollectionRecord {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO clip_collections (id, name, description, color)
    VALUES (?, ?, ?, ?)
  `).run(id, input.name.trim(), (input.description ?? '').trim(), (input.color ?? '#6366f1').trim());
  return getCollectionById(id)!;
}

export function listCollections(): CollectionRecord[] {
  return db.prepare(`
    SELECT c.id, c.name, c.description, c.color,
           COUNT(i.clip_id) AS clip_count,
           c.created_at, c.updated_at
    FROM clip_collections c
    LEFT JOIN clip_collection_items i ON i.collection_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all() as unknown as CollectionRecord[];
}

export function getCollectionById(id: string): CollectionRecord | null {
  if (!id) return null;
  return (db.prepare(`
    SELECT c.id, c.name, c.description, c.color,
           COUNT(i.clip_id) AS clip_count,
           c.created_at, c.updated_at
    FROM clip_collections c
    LEFT JOIN clip_collection_items i ON i.collection_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(id) as CollectionRecord | undefined) ?? null;
}

export function updateCollection(
  id: string,
  patch: { name?: string; description?: string; color?: string },
): boolean {
  const existing = getCollectionById(id);
  if (!existing) return false;
  const res = db.prepare(`
    UPDATE clip_collections
    SET name = ?, description = ?, color = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(
    patch.name !== undefined ? patch.name.trim() : existing.name,
    patch.description !== undefined ? patch.description.trim() : existing.description,
    patch.color !== undefined ? patch.color.trim() : existing.color,
    id,
  );
  return Number(res.changes) > 0;
}

export function deleteCollection(id: string): boolean {
  const res = db.prepare(`DELETE FROM clip_collections WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}

export function addClipToCollection(collectionId: string, clipId: string, position = 0): boolean {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO clip_collection_items (collection_id, clip_id, position)
      VALUES (?, ?, ?)
    `).run(collectionId, clipId, position);
    return true;
  } catch {
    return false;
  }
}

export function removeClipFromCollection(collectionId: string, clipId: string): boolean {
  const res = db.prepare(`
    DELETE FROM clip_collection_items WHERE collection_id = ? AND clip_id = ?
  `).run(collectionId, clipId);
  return Number(res.changes) > 0;
}

export interface CollectionItemRecord {
  collection_id: string;
  clip_id: string;
  position: number;
  added_at: number;
}

export function listCollectionClips(collectionId: string): CollectionItemRecord[] {
  return db.prepare(`
    SELECT collection_id, clip_id, position, added_at
    FROM clip_collection_items
    WHERE collection_id = ?
    ORDER BY position ASC, added_at ASC
  `).all(collectionId) as unknown as CollectionItemRecord[];
}

export function listCollectionClipDetails(collectionId: string): unknown[] {
  return db.prepare(`
    SELECT c.*, r.rating, r.rated_at,
           (SELECT COUNT(*) FROM clip_comments cc WHERE cc.clip_id = c.id AND cc.resolved = 0) AS unresolved_comments,
           i.position AS collection_position,
           i.added_at AS collection_added_at
    FROM clip_collection_items i
    INNER JOIN clips c ON c.id = i.clip_id
    LEFT JOIN clip_ratings r ON r.clip_id = c.id
    WHERE i.collection_id = ?
    ORDER BY i.position ASC, i.added_at ASC
  `).all(collectionId) as unknown[];
}

export function getClipCollections(clipId: string): CollectionRecord[] {
  return db.prepare(`
    SELECT c.id, c.name, c.description, c.color,
           (SELECT COUNT(*) FROM clip_collection_items ci WHERE ci.collection_id = c.id) AS clip_count,
           c.created_at, c.updated_at
    FROM clip_collections c
    INNER JOIN clip_collection_items i ON i.collection_id = c.id
    WHERE i.clip_id = ?
    ORDER BY c.name ASC
  `).all(clipId) as unknown as CollectionRecord[];
}

// ── Clip Ratings (clip_ratings) ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS clip_ratings (
    clip_id  TEXT PRIMARY KEY,
    rating   INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    rated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

export interface ClipRatingRecord {
  clip_id: string;
  rating: number;
  rated_at: number;
}

export function rateClip(clipId: string, rating: number): boolean {
  const r = Math.trunc(Number(rating));
  if (r < 1 || r > 5) return false;
  db.prepare(`
    INSERT INTO clip_ratings (clip_id, rating, rated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(clip_id) DO UPDATE SET rating = excluded.rating, rated_at = unixepoch()
  `).run(clipId, r);
  return true;
}

export function getClipRating(clipId: string): number | null {
  const row = db.prepare(`SELECT rating FROM clip_ratings WHERE clip_id = ?`).get(clipId) as
    | { rating: number }
    | undefined;
  return row ? row.rating : null;
}

export function getTopRatedClips(limit = 10): ClipRatingRecord[] {
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 10)));
  return db.prepare(`
    SELECT clip_id, rating, rated_at
    FROM clip_ratings
    ORDER BY rating DESC, rated_at DESC
    LIMIT ?
  `).all(safeLimit) as unknown as ClipRatingRecord[];
}

export function getTopRatedClipDetails(limit = 10): unknown[] {
  const safeLimit = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 10)));
  return db.prepare(`
    SELECT c.*, r.rating, r.rated_at,
           (SELECT COUNT(*) FROM clip_comments cc WHERE cc.clip_id = c.id AND cc.resolved = 0) AS unresolved_comments
    FROM clip_ratings r
    INNER JOIN clips c ON c.id = r.clip_id
    ORDER BY r.rating DESC, r.rated_at DESC
    LIMIT ?
  `).all(safeLimit) as unknown[];
}

// ── Clip Chapters (clip_chapters) ──────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS clip_chapters (
    id         TEXT PRIMARY KEY,
    clip_id    TEXT NOT NULL,
    title      TEXT NOT NULL,
    start_sec  REAL NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

export interface ChapterRecord {
  id: string;
  clip_id: string;
  title: string;
  start_sec: number;
  created_at: number;
}

export function addChapter(clipId: string, title: string, startSec: number): ChapterRecord {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO clip_chapters (id, clip_id, title, start_sec)
    VALUES (?, ?, ?, ?)
  `).run(id, clipId, title.trim(), Number(startSec));
  return db.prepare(`SELECT id, clip_id, title, start_sec, created_at FROM clip_chapters WHERE id = ?`).get(id) as unknown as ChapterRecord;
}

export function listChapters(clipId: string): ChapterRecord[] {
  return db.prepare(`
    SELECT id, clip_id, title, start_sec, created_at
    FROM clip_chapters
    WHERE clip_id = ?
    ORDER BY start_sec ASC
  `).all(clipId) as unknown as ChapterRecord[];
}

export function deleteChapter(id: string, clipId?: string): boolean {
  const res = clipId
    ? db.prepare(`DELETE FROM clip_chapters WHERE id = ? AND clip_id = ?`).run(id, clipId)
    : db.prepare(`DELETE FROM clip_chapters WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}

// ── Clip Share Links (clip_shares) ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS clip_shares (
    token         TEXT PRIMARY KEY,
    clip_id       TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at    INTEGER,
    view_count    INTEGER NOT NULL DEFAULT 0,
    max_views     INTEGER,
    password_hash TEXT
  );
`);

export interface ClipShareRecord {
  token: string;
  clip_id: string;
  created_at: number;
  expires_at: number | null;
  view_count: number;
  max_views: number | null;
  password_hash: string | null;
}

export function createClipShare(input: {
  clipId: string;
  expiresInHours?: number;
  maxViews?: number;
  password?: string;
}): ClipShareRecord {
  const token = crypto.randomBytes(16).toString('hex');
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt =
    input.expiresInHours != null && Number.isFinite(input.expiresInHours)
      ? nowSec + Math.trunc(input.expiresInHours * 3600)
      : null;
  const maxViews =
    input.maxViews != null && Number.isFinite(input.maxViews)
      ? Math.max(1, Math.trunc(input.maxViews))
      : null;
  let passwordHash: string | null = null;
  if (input.password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(input.password, salt, 64).toString('hex');
    passwordHash = `${salt}:${hash}`;
  }

  db.prepare(`
    INSERT INTO clip_shares (token, clip_id, expires_at, max_views, password_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, input.clipId, expiresAt, maxViews, passwordHash);

  return getClipShare(token)!;
}

export function getClipShare(token: string): ClipShareRecord | null {
  if (!token) return null;
  return (db.prepare(`
    SELECT token, clip_id, created_at, expires_at, view_count, max_views, password_hash
    FROM clip_shares WHERE token = ?
  `).get(token) as ClipShareRecord | undefined) ?? null;
}

export function incrementShareViewCount(token: string): void {
  db.prepare(`UPDATE clip_shares SET view_count = view_count + 1 WHERE token = ?`).run(token);
}

export function deleteClipShare(token: string): boolean {
  const res = db.prepare(`DELETE FROM clip_shares WHERE token = ?`).run(token);
  return Number(res.changes) > 0;
}

export interface ClipShareSummary extends Omit<ClipShareRecord, 'password_hash'> {
  has_password: number;
}

export function listClipShares(clipId: string): ClipShareSummary[] {
  return db.prepare(`
    SELECT token, clip_id, created_at, expires_at, view_count, max_views,
           CASE WHEN password_hash IS NOT NULL AND password_hash != '' THEN 1 ELSE 0 END AS has_password
    FROM clip_shares
    WHERE clip_id = ?
    ORDER BY created_at DESC
  `).all(clipId) as unknown as ClipShareSummary[];
}

// ── A/B Experiments (ab_experiments) ──────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ab_experiments (
    id               TEXT PRIMARY KEY,
    clip_id          TEXT NOT NULL,
    variant_a_title  TEXT NOT NULL,
    variant_b_title  TEXT NOT NULL,
    variant_a_views  INTEGER NOT NULL DEFAULT 0,
    variant_b_views  INTEGER NOT NULL DEFAULT 0,
    variant_a_clicks INTEGER NOT NULL DEFAULT 0,
    variant_b_clicks INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

export interface AbExperimentRecord {
  id: string;
  clip_id: string;
  variant_a_title: string;
  variant_b_title: string;
  variant_a_views: number;
  variant_b_views: number;
  variant_a_clicks: number;
  variant_b_clicks: number;
  created_at: number;
}

export function createAbExperiment(input: {
  clipId: string;
  variantATitle: string;
  variantBTitle: string;
}): AbExperimentRecord {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO ab_experiments (id, clip_id, variant_a_title, variant_b_title)
    VALUES (?, ?, ?, ?)
  `).run(id, input.clipId, input.variantATitle.trim(), input.variantBTitle.trim());
  return getAbExperiment(input.clipId)!;
}

export function getAbExperiment(clipId: string): AbExperimentRecord | null {
  if (!clipId) return null;
  return (db.prepare(`
    SELECT id, clip_id, variant_a_title, variant_b_title,
           variant_a_views, variant_b_views, variant_a_clicks, variant_b_clicks, created_at
    FROM ab_experiments WHERE clip_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(clipId) as AbExperimentRecord | undefined) ?? null;
}

export function recordAbView(clipId: string, variant: 'a' | 'b'): void {
  const col = variant === 'a' ? 'variant_a_views' : 'variant_b_views';
  db.prepare(`
    UPDATE ab_experiments SET ${col} = ${col} + 1 WHERE clip_id = ?
  `).run(clipId);
}

export function recordAbClick(clipId: string, variant: 'a' | 'b'): void {
  const col = variant === 'a' ? 'variant_a_clicks' : 'variant_b_clicks';
  db.prepare(`
    UPDATE ab_experiments SET ${col} = ${col} + 1 WHERE clip_id = ?
  `).run(clipId);
}

// ── Clip Comments & Social Upload Queue tables (ensured here for joins/cascades) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS clip_comments (
    id            TEXT PRIMARY KEY,
    clip_id       TEXT NOT NULL,
    author        TEXT NOT NULL DEFAULT 'admin',
    body          TEXT NOT NULL,
    timestamp_sec REAL,
    resolved      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_clip_comments_clip ON clip_comments(clip_id, resolved, created_at);

  CREATE TABLE IF NOT EXISTS social_upload_queue (
    id            TEXT PRIMARY KEY,
    clip_id       TEXT NOT NULL,
    platform      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',
    scheduled_for INTEGER,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    tags          TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    error_msg     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_social_upload_queue_clip ON social_upload_queue(clip_id);
  CREATE INDEX IF NOT EXISTS idx_social_upload_queue_status ON social_upload_queue(status, platform, created_at);
`);

// ── Clips with Ratings helper + archived flag ──────────────────────────────
// Add `archived` column if missing
(() => {
  const clpCols = db.prepare('PRAGMA table_info(clips)').all() as Array<{ name: string }>;
  const clpNames = new Set(clpCols.map((c) => c.name));
  if (!clpNames.has('archived')) {
    db.exec(`ALTER TABLE clips ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  }
})();

export interface ClipFilters {
  status?: string;
  platform?: string;
  archived?: boolean;
  limit?: number;
}

export function getClipsWithRatings(filters?: ClipFilters): unknown[] {
  const conditions: string[] = [];
  const args: Array<string | number | null> = [];

  if (filters?.status) {
    conditions.push('c.status = ?');
    args.push(filters.status);
  }
  if (filters?.platform) {
    conditions.push('c.source_platform = ?');
    args.push(filters.platform);
  }
  if (filters?.archived !== undefined) {
    conditions.push('c.archived = ?');
    args.push(filters.archived ? 1 : 0);
  }

  const limit = Math.min(1000, Math.max(1, Math.trunc(Number(filters?.limit ?? 200) || 200)));
  args.push(limit);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT c.*, r.rating, r.rated_at,
           (SELECT COUNT(*) FROM clip_comments cc WHERE cc.clip_id = c.id AND cc.resolved = 0) AS unresolved_comments
    FROM clips c
    LEFT JOIN clip_ratings r ON r.clip_id = c.id
    ${where}
    ORDER BY c.created_at DESC
    LIMIT ?
  `).all(...args) as unknown[];
}

export function updateClipArchived(id: string, archived: boolean): boolean {
  const res = db.prepare(`UPDATE clips SET archived = ? WHERE id = ?`).run(archived ? 1 : 0, id);
  return Number(res.changes) > 0;
}

/** Atomically deletes a clip and all related ratings, chapters, comments, shares, collections, A/B tests, and upload queue entries. */
export function deleteClipCascade(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  return withTransaction(db, () => {
    db.prepare(`DELETE FROM clip_ratings WHERE clip_id = ?`).run(id);
    db.prepare(`DELETE FROM clip_chapters WHERE clip_id = ?`).run(id);
    db.prepare(`DELETE FROM clip_comments WHERE clip_id = ?`).run(id);
    db.prepare(`DELETE FROM clip_shares WHERE clip_id = ?`).run(id);
    db.prepare(`DELETE FROM clip_collection_items WHERE clip_id = ?`).run(id);
    db.prepare(`DELETE FROM ab_experiments WHERE clip_id = ?`).run(id);
    db.prepare(`DELETE FROM social_upload_queue WHERE clip_id = ?`).run(id);
    const res = db.prepare(`DELETE FROM clips WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  });
}

// ── Stream Snapshots (stream_snapshots) ────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS stream_snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    recorded_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    velocity     REAL NOT NULL DEFAULT 0,
    viewer_count INTEGER,
    peak_db      REAL,
    clip_count   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_stream_snapshots_session ON stream_snapshots(session_id, recorded_at);
`);

export interface StreamSnapshotRecord {
  id: number;
  session_id: string;
  recorded_at: number;
  velocity: number;
  viewer_count: number | null;
  peak_db: number | null;
  clip_count: number;
}

export interface StreamSnapshotSessionSummary {
  session_id: string;
  count: number;
  last_recorded_at: number;
  peak_velocity: number;
}

export function insertStreamSnapshot(input: {
  sessionId: string;
  velocity: number;
  viewerCount?: number;
  peakDb?: number;
  clipCount?: number;
}): number {
  const res = db.prepare(`
    INSERT INTO stream_snapshots (session_id, velocity, viewer_count, peak_db, clip_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    Number(input.velocity) || 0,
    input.viewerCount !== undefined ? Math.trunc(input.viewerCount) : null,
    input.peakDb !== undefined ? Number(input.peakDb) : null,
    Math.trunc(input.clipCount ?? 0),
  );
  return Number(res.lastInsertRowid);
}

export function listStreamSnapshots(sessionId: string): StreamSnapshotRecord[] {
  return db.prepare(`
    SELECT id, session_id, recorded_at, velocity, viewer_count, peak_db, clip_count
    FROM stream_snapshots
    WHERE session_id = ?
    ORDER BY recorded_at ASC
  `).all(sessionId) as unknown as StreamSnapshotRecord[];
}

export function listStreamSnapshotSessions(): StreamSnapshotSessionSummary[] {
  return db.prepare(`
    SELECT session_id,
           COUNT(*) AS count,
           MAX(recorded_at) AS last_recorded_at,
           MAX(velocity) AS peak_velocity
    FROM stream_snapshots
    GROUP BY session_id
    ORDER BY last_recorded_at DESC
    LIMIT 25
  `).all() as unknown as StreamSnapshotSessionSummary[];
}

export function pruneOldSnapshots(keepDays = 7): number {
  const cutoff = Math.floor(Date.now() / 1000) - keepDays * 86400;
  const res = db.prepare(`DELETE FROM stream_snapshots WHERE recorded_at < ?`).run(cutoff);
  return Number(res.changes);
}
