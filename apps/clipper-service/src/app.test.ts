import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@clipper/db-utils';

type DbModule = typeof import('./db.js');
type StorageModule = typeof import('./storage.js');
type LicensingModule = typeof import('./licensing.js');
type StudioModule = typeof import('./studio.js');
type AudioPeaksModule = typeof import('./features/audio-peaks.js');
type HighlightPickerModule = typeof import('./highlight-picker.js');
type KelviqSdkModule = typeof import('@kelviq/node-sdk');
type ClipCommentsModule = typeof import('./features/clip-comments.js');
type ClipShareModule = typeof import('./features/clip-share.js');
type AbTestingModule = typeof import('./features/ab-testing.js');
type StreamHealthModule = typeof import('./features/stream-health.js');
type SocialUploadModule = typeof import('./features/social-upload.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps/clipper-service/src/index.ts');

function removeDirSafe(dirPath: string): void {
  if (!dirPath) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Ignore transient Windows EBUSY locks during teardown
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to allocate an ephemeral TCP port')));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForServerReady(
  baseUrl: string,
  proc: ChildProcess,
  getLogs: () => string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `Clipper server exited prematurely (code=${proc.exitCode}, signal=${proc.signalCode}). Logs:\n${getLogs()}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/api/system/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status === 200) return;
    } catch {
      // Server still booting
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for Clipper server at ${baseUrl}. Logs:\n${getLogs()}`);
}

async function stopChildProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    proc.once('close', finish);
    proc.once('exit', finish);
    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (!settled) {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }
    }, 3000).unref();
    setTimeout(finish, 5000).unref();
  });
}

async function requestJson<T = Record<string, any>>(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; data: T }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(8000),
  });
  const text = await res.text();
  const data = (text ? JSON.parse(text) : null) as T;
  return { status: res.status, headers: res.headers, data };
}

function extractCookiePair(setCookieHeader: string | null, cookieName: string): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header to be present');
  const match = setCookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
  assert.ok(match, `Expected ${cookieName} in Set-Cookie header`);
  return `${cookieName}=${match[1]}`;
}

describe('Unit & DB Security Tests', () => {
  let tmpDir = '';
  let dbMod: DbModule;
  let storageMod: StorageModule;
  let licensingMod: LicensingModule;
  let studioMod: StudioModule;
  let audioPeaksMod: AudioPeaksModule;
  let highlightPickerMod: HighlightPickerModule;
  let kelviqSdkMod: KelviqSdkModule;
  let clipCommentsMod: ClipCommentsModule;
  let clipShareMod: ClipShareModule;
  let abTestingMod: AbTestingModule;
  let streamHealthMod: StreamHealthModule;
  let socialUploadMod: SocialUploadModule;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-test-'));
    process.env.DATA_DIR = path.join(tmpDir, 'data');
    process.env.MEDIA_ROOT_DIR = path.join(tmpDir, 'media');
    process.env.LLM_PROVIDER = 'mock';
    process.env.ADMIN_PASSWORD = 'unit-test-admin-pass-2026';
    process.env.KELVIQ_WEBHOOK_SECRET = '';
    process.env.KELVIQ_API_KEY = '';
    delete process.env.KELVIQ_ALLOW_UNSIGNED_WEBHOOKS;

    dbMod = await import('./db.js');
    storageMod = await import('./storage.js');
    licensingMod = await import('./licensing.js');
    studioMod = await import('./studio.js');
    audioPeaksMod = await import('./features/audio-peaks.js');
    highlightPickerMod = await import('./highlight-picker.js');
    kelviqSdkMod = await import('@kelviq/node-sdk');
    clipCommentsMod = await import('./features/clip-comments.js');
    clipShareMod = await import('./features/clip-share.js');
    abTestingMod = await import('./features/ab-testing.js');
    streamHealthMod = await import('./features/stream-health.js');
    socialUploadMod = await import('./features/social-upload.js');
  });

  after(() => {
    try {
      dbMod?.db?.close();
    } catch {}
    removeDirSafe(tmpDir);
  });

  it('creates, masks, validates, and revokes API keys securely', () => {
    const created = dbMod.createApiKey('CI Test');
    assert.ok(created.key.startsWith('csk_'));
    assert.ok(created.maskedKey.startsWith('csk_***'));
    assert.equal(created.label, 'CI Test');

    const keys = dbMod.listApiKeys();
    const record = keys.find((k) => k.id === created.id);
    assert.ok(record, 'Created API key should appear in listApiKeys()');
    assert.equal(record.maskedKey, created.maskedKey);
    assert.equal(record.last_used_at, '');
    assert.equal(record.active, 1);
    assert.equal('key' in record, false, 'listApiKeys() must never expose plaintext key');
    assert.equal('key_hash' in record, false, 'listApiKeys() must never expose key_hash');
    assert.equal(JSON.stringify(record).includes(created.key), false);

    assert.equal(dbMod.validateApiKey(created.key), true);
    const afterValidate = dbMod.listApiKeys().find((k) => k.id === created.id);
    assert.ok(afterValidate && afterValidate.last_used_at.length > 0, 'last_used_at should be updated');

    assert.equal(dbMod.validateApiKey('csk_nonexistent_0000000000000000'), false);
    assert.equal(dbMod.validateApiKey('invalid_prefix_token'), false);

    assert.equal(dbMod.revokeApiKey(created.id), true);
    assert.equal(dbMod.validateApiKey(created.key), false);
    const afterRevoke = dbMod.listApiKeys().find((k) => k.id === created.id);
    assert.equal(afterRevoke?.active, 0);
  });

  it('supports clip metadata CRUD, audit logging, and scheduled jobs lifecycle', () => {
    const clipPath = path.join(storageMod.CLIPS_DIR, 'unit-test-clip.mp4');
    const clipId = dbMod.insertClip({
      title: 'Unit Test Clip',
      filePath: clipPath,
      startSec: 5,
      endSec: 30,
      sourcePlatform: 'twitch',
      viralityScore: 87,
    });

    assert.equal(dbMod.clipExists(clipId), true);
    assert.equal(dbMod.clipExists('missing-clip-id'), false);
    assert.equal(dbMod.updateClipTags(clipId, ['clutch', 'hype']), true);
    assert.equal(dbMod.updateClipNotes(clipId, 'Final round clutch'), true);
    assert.equal(dbMod.toggleClipFavourite(clipId), true);
    assert.equal(dbMod.toggleClipFavourite(clipId), false);

    const thumbPath = path.join(storageMod.THUMBS_DIR, `${clipId}.jpg`);
    assert.equal(dbMod.updateClipThumbnail(clipId, thumbPath), true);

    const row = dbMod.db
      .prepare('SELECT tags, notes, is_favourite, thumbnail_path FROM clips WHERE id=?')
      .get(clipId) as { tags: string; notes: string; is_favourite: number; thumbnail_path: string };
    assert.equal(row.tags, 'clutch,hype');
    assert.equal(row.notes, 'Final round clutch');
    assert.equal(row.is_favourite, 0);
    assert.equal(row.thumbnail_path, thumbPath);

    const auditId = dbMod.logAuditEvent('ci-tester', 'clip.updated', clipId, '127.0.0.1', { ok: true });
    const logs = dbMod.listAuditLogs(20);
    const auditEntry = logs.find((l) => l.id === auditId);
    assert.ok(auditEntry);
    assert.equal(auditEntry.actor, 'ci-tester');
    assert.equal(auditEntry.action, 'clip.updated');
    assert.equal(auditEntry.target, clipId);
    assert.equal(auditEntry.ip, '127.0.0.1');
    assert.deepEqual(JSON.parse(auditEntry.details), { ok: true });

    const job = dbMod.createScheduledJob({
      videoPath: path.join(storageMod.RECORDINGS_DIR, 'vod.mp4'),
      cronExpr: '0 3 * * *',
      maxClips: 4,
      layout: 'split',
      captionStyle: 'hormozi',
    });
    assert.equal(job.enabled, 1);
    assert.equal(job.max_clips, 4);
    assert.ok(dbMod.listScheduledJobs().some((j) => j.id === job.id));

    const disabledJob = dbMod.toggleScheduledJob(job.id);
    assert.equal(disabledJob?.enabled, 0);
    const enabledJob = dbMod.toggleScheduledJob(job.id, true);
    assert.equal(enabledJob?.enabled, 1);

    assert.equal(dbMod.deleteScheduledJob(job.id), true);
    assert.equal(dbMod.deleteScheduledJob(job.id), false);
    assert.equal(dbMod.listScheduledJobs().some((j) => j.id === job.id), false);
  });

  it('masks/redacts license keys and rejects unsigned Kelviq webhooks', () => {
    assert.equal(licensingMod.maskLicenseKeyValue(''), '');
    assert.equal(licensingMod.maskLicenseKeyValue('shortkey'), '***');
    assert.equal(licensingMod.maskLicenseKeyValue('CLIP-PRO-1234-5678-ABCD'), 'CLIP-PRO...ABCD');
    assert.equal(licensingMod.maskLicenseKeyValue('***ABCD'), '***ABCD');

    const payload = {
      event: 'license.activated',
      licenseKey: 'KQ-SECRET-1111-2222-9999',
      nested: {
        license_key: 'CLIP-ULTRA-AAAA-BBBB-CCCC',
        customer: 'creator@example.com',
      },
    };
    const redacted = licensingMod.redactLicenseKeysInObject(payload);
    assert.equal(redacted.licenseKey, 'KQ-SECRE...9999');
    assert.equal(redacted.nested.license_key, 'CLIP-ULT...CCCC');
    assert.equal(redacted.nested.customer, 'creator@example.com');

    assert.throws(
      () => licensingMod.handleKelviqWebhook(JSON.stringify({ type: 'license.activated', data: {} }), {}),
      (err) => err instanceof kelviqSdkMod.WebhookVerificationError,
    );
  });

  it('enforces SSRF IP/URL blocks and media/music path traversal protection', () => {
    for (const blockedIp of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.5',
      '169.254.169.254',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
    ]) {
      assert.equal(studioMod.isBlockedIpAddress(blockedIp), true, `Expected ${blockedIp} to be blocked`);
    }

    for (const publicIp of ['8.8.8.8', '1.1.1.1']) {
      assert.equal(studioMod.isBlockedIpAddress(publicIp), false, `Expected ${publicIp} to be allowed`);
    }

    for (const badUrl of [
      'file:///etc/passwd',
      'http://localhost/stream.m3u8',
      'http://127.0.0.1:8080/test.m3u8',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      assert.throws(
        () => studioMod.assertSafeRemoteUrlSyntax(badUrl),
        (err) => err instanceof studioMod.ProxyUrlError,
        `Expected ${badUrl} to throw ProxyUrlError`,
      );
    }

    assert.doesNotThrow(() => studioMod.assertSafeRemoteUrlSyntax('https://example.com/vod/master.m3u8'));

    assert.throws(() => studioMod.resolveMusicTrackPath('../secret.mp3'), /Invalid music track path/);
    assert.throws(
      () => studioMod.resolveMusicTrackPath(path.join(tmpDir, 'outside.mp3')),
      /Invalid music track path/,
    );
    assert.equal(studioMod.resolveMusicTrackPath('none'), null);

    const trackPath = path.join(storageMod.MUSIC_DIR, 'ci-beat.mp3');
    fs.writeFileSync(trackPath, 'mock-audio');
    assert.equal(studioMod.resolveMusicTrackPath('ci-beat.mp3'), trackPath);

    assert.equal(storageMod.isPathInsideMediaDirs(path.join(storageMod.CLIPS_DIR, 'clip.mp4')), true);
    assert.equal(storageMod.isPathInsideMediaDirs(path.join(tmpDir, 'outside.mp4')), false);
    assert.equal(
      storageMod.isPathInsideMediaDirs(path.resolve(storageMod.MEDIA_ROOT, '..', 'escape.mp4')),
      false,
    );
    assert.equal(
      storageMod.isPathInsideMediaDirs(path.join(tmpDir, 'media-evil', 'clip.mp4')),
      false,
    );
  });

  it('computes clamped virality scores and picks rule-based highlights in mock mode', async () => {
    const baseline = audioPeaksMod.calculateViralityScore({ durationSec: 5 });
    assert.ok(baseline.score >= 15 && baseline.score <= 99);
    assert.equal(baseline.reason, 'Manual Creator Cut');

    const hyped = audioPeaksMod.calculateViralityScore({
      audioDeltaDb: 40,
      chatMultiplier: 10,
      durationSec: 30,
      hasFacecam: true,
      hasCaptions: true,
      hasSpeechWords: 50,
    });
    assert.equal(hyped.score, 99);
    assert.ok(hyped.reason.includes('Chat Spike'));
    assert.ok(hyped.reason.includes('Audio Peak'));

    const segments = [
      {
        start: 0,
        end: 15,
        text: 'Welcome back everyone today we are attempting the hardest clutch challenge in ranked play',
      },
      {
        start: 15,
        end: 32,
        text: 'Wait no way did that shot actually connect oh my god look at chat going wild right now',
      },
      {
        start: 32,
        end: 50,
        text: 'One HP survival into a full team wipe let us go everybody drop a W in the chat',
      },
      {
        start: 50,
        end: 72,
        text: 'Let us watch that insane reaction back again because nobody expected that ending',
      },
    ];

    const highlights = await highlightPickerMod.pickHighlights(segments);
    assert.ok(Array.isArray(highlights) && highlights.length >= 1);
    for (const h of highlights) {
      assert.ok(typeof h.title === 'string' && h.title.length > 0);
      assert.ok(typeof h.description === 'string' && h.description.length > 0);
      assert.ok(Number.isFinite(h.startSec) && h.startSec >= 0);
      assert.ok(Number.isFinite(h.endSec) && h.endSec > h.startSec);
    }

    assert.deepEqual(await highlightPickerMod.pickHighlights([]), []);
  });

  it('supports collections, ratings, chapters, comments, presets protection, and cascade deletion', () => {
    dbMod.db
      .prepare(`INSERT OR IGNORE INTO ingest_jobs (id, source_url, status) VALUES (?, ?, 'DONE')`)
      .run('unit-job-1', 'https://example.com/vod');

    const clipId = dbMod.insertClip({
      jobId: 'unit-job-1',
      title: 'Cascade Unit Clip',
      filePath: path.join(storageMod.CLIPS_DIR, 'cascade-unit.mp4'),
      startSec: 0,
      endSec: 25,
      sourcePlatform: 'twitch',
      viralityScore: 91,
    });

    // Collections CRUD & getClipCollections
    const col1 = dbMod.createCollection({
      name: 'Best Clutches',
      description: 'Top plays',
      color: '#10b981',
    });
    const col2 = dbMod.createCollection({ name: 'Highlights Reel', color: '#6366f1' });
    assert.ok(dbMod.listCollections().some((c) => c.id === col1.id));
    assert.equal(dbMod.updateCollection(col1.id, { name: 'Updated Clutches' }), true);

    assert.equal(dbMod.addClipToCollection(col1.id, clipId, 1), true);
    assert.equal(dbMod.addClipToCollection(col2.id, clipId, 2), true);
    assert.ok(dbMod.listCollectionClips(col1.id).some((item) => item.clip_id === clipId));

    const clipCols = dbMod.getClipCollections(clipId);
    assert.equal(clipCols.length, 2);
    assert.ok(clipCols.some((c) => c.id === col1.id && c.name === 'Updated Clutches'));

    assert.equal(dbMod.removeClipFromCollection(col1.id, clipId), true);
    assert.equal(dbMod.getClipCollections(clipId).length, 1);
    assert.equal(dbMod.deleteCollection(col1.id), true);

    // 5-star ratings
    assert.equal(dbMod.rateClip(clipId, 5), true);
    assert.equal(dbMod.getClipRating(clipId), 5);
    assert.equal(dbMod.rateClip(clipId, 0), false);
    assert.equal(dbMod.rateClip(clipId, 6), false);
    assert.equal(dbMod.getClipRating(clipId), 5);
    assert.ok(dbMod.getTopRatedClips(10).some((r) => r.clip_id === clipId && r.rating === 5));

    // Chapters
    const ch1 = dbMod.addChapter(clipId, 'Intro Setup', 0);
    const ch2 = dbMod.addChapter(clipId, 'Final Clutch', 14.5);
    const chapters = dbMod.listChapters(clipId);
    assert.equal(chapters.length, 2);
    assert.deepEqual(
      chapters.map((c) => c.id),
      [ch1.id, ch2.id],
    );
    assert.equal(dbMod.deleteChapter(ch1.id, clipId), true);
    assert.equal(dbMod.listChapters(clipId).length, 1);

    // Timestamped review comments
    const cm1 = clipCommentsMod.addComment(clipId, 'Tighten intro cut', 'editor', 4.5);
    const cm2 = clipCommentsMod.addComment(clipId, 'Temporary note', 'qa', 10);
    assert.equal(clipCommentsMod.listComments(clipId).length, 2);
    assert.equal(clipCommentsMod.getUnresolvedCommentCount(clipId), 2);
    const toggled = clipCommentsMod.toggleCommentResolved(cm1.id);
    assert.equal(toggled?.resolved, 1);
    assert.equal(clipCommentsMod.getUnresolvedCommentCount(clipId), 1);
    assert.equal(clipCommentsMod.deleteComment(cm2.id), true);

    // Built-in vs custom presets protection
    const presets = dbMod.listPresets();
    assert.ok(presets.some((p) => p.id === 'builtin-viral-split' && p.is_builtin === 1));
    assert.equal(dbMod.deletePreset('builtin-viral-split'), false);
    assert.ok(dbMod.getPresetById('builtin-viral-split'));

    const customPreset = dbMod.createPreset({
      name: 'CI Custom Preset',
      description: 'Unit test preset',
      layout: 'portrait-4x5',
      captionStyle: 'neon',
      silenceCut: true,
      audioNormalize: true,
    });
    assert.equal(customPreset.is_builtin, 0);
    assert.equal(dbMod.deletePreset(customPreset.id), true);
    assert.equal(dbMod.getPresetById(customPreset.id), undefined);

    // Cascade delete cleans up all child tables
    socialUploadMod.addToUploadQueue({ clipId, platform: 'youtube', title: 'Cascade Upload' });
    assert.equal(dbMod.deleteClipCascade(clipId), true);
    assert.equal(dbMod.clipExists(clipId), false);
    assert.equal(dbMod.getClipRating(clipId), null);
    assert.equal(dbMod.listChapters(clipId).length, 0);
    assert.equal(clipCommentsMod.listComments(clipId).length, 0);
    assert.equal(dbMod.listCollectionClips(col2.id).length, 0);
    assert.equal(dbMod.getClipCollections(clipId).length, 0);
    const remainingQueue = dbMod.db
      .prepare('SELECT COUNT(*) AS cnt FROM social_upload_queue WHERE clip_id = ?')
      .get(clipId) as { cnt: number };
    assert.equal(Number(remainingQueue.cnt), 0);
    assert.equal(dbMod.deleteClipCascade(clipId), false);
    dbMod.deleteCollection(col2.id);
  });

  it('validates clip share access controls, A/B testing CTR math, and stream health scoring', () => {
    const clipId = dbMod.insertClip({
      title: 'Share & AB Unit Clip',
      filePath: path.join(storageMod.CLIPS_DIR, 'share-ab-unit.mp4'),
      startSec: 0,
      endSec: 20,
      sourcePlatform: 'kick',
    });

    // Share link password masking, view cap & expiry
    const share = dbMod.createClipShare({
      clipId,
      expiresInHours: 2,
      maxViews: 2,
      password: 'share-secret-pw',
    });
    const listedShares = dbMod.listClipShares(clipId);
    assert.equal(listedShares.length, 1);
    assert.equal('password_hash' in listedShares[0]!, false);
    assert.equal(listedShares[0]!.has_password, 1);
    assert.equal(JSON.stringify(listedShares).includes('share-secret-pw'), false);

    assert.deepEqual(clipShareMod.validateClipShareAccess(share.token), {
      valid: false,
      reason: 'Password required',
    });
    assert.deepEqual(clipShareMod.validateClipShareAccess(share.token, 'wrong-password'), {
      valid: false,
      reason: 'Incorrect password',
    });
    assert.deepEqual(clipShareMod.validateClipShareAccess(share.token, 'share-secret-pw'), {
      valid: true,
      clipId,
    });
    assert.equal(dbMod.getClipShare(share.token)?.view_count, 1);

    assert.deepEqual(clipShareMod.validateClipShareAccess(share.token, 'share-secret-pw'), {
      valid: true,
      clipId,
    });
    assert.equal(dbMod.getClipShare(share.token)?.view_count, 2);

    assert.deepEqual(clipShareMod.validateClipShareAccess(share.token, 'share-secret-pw'), {
      valid: false,
      reason: 'Share link view limit reached',
    });

    const expiredShare = dbMod.createClipShare({ clipId, expiresInHours: -1 });
    assert.deepEqual(clipShareMod.validateClipShareAccess(expiredShare.token), {
      valid: false,
      reason: 'Share link has expired',
    });

    // A/B title testing round-robin & CTR winner
    dbMod.createAbExperiment({
      clipId,
      variantATitle: 'Variant A Hook',
      variantBTitle: 'Variant B Hook',
    });
    assert.equal(abTestingMod.getActiveVariant(clipId), 'a');
    abTestingMod.recordAbView(clipId, 'a');
    assert.equal(abTestingMod.getActiveVariant(clipId), 'b');
    abTestingMod.recordAbView(clipId, 'b');
    assert.equal(abTestingMod.getActiveVariant(clipId), 'a');
    abTestingMod.recordAbClick(clipId, 'b');

    const abStats = abTestingMod.computeAbWinner(dbMod.getAbExperiment(clipId)!);
    assert.equal(abStats.winner, 'b');
    assert.equal(abStats.ctrA, 0);
    assert.equal(abStats.ctrB, 1);

    // Stream health snapshots & trend scoring
    assert.deepEqual(streamHealthMod.scoreStreamHealth([]), {
      score: 0,
      trend: 'stable',
      avgVelocity: 0,
      peakVelocity: 0,
    });

    for (const v of [10, 15, 45, 70]) {
      dbMod.insertStreamSnapshot({ sessionId: 'unit-rising', velocity: v });
    }
    const rising = streamHealthMod.scoreStreamHealth(dbMod.listStreamSnapshots('unit-rising'));
    assert.equal(rising.trend, 'rising');
    assert.ok(rising.score >= 0 && rising.score <= 100);

    for (const v of [70, 45, 15, 10]) {
      dbMod.insertStreamSnapshot({ sessionId: 'unit-falling', velocity: v });
    }
    const falling = streamHealthMod.scoreStreamHealth(dbMod.listStreamSnapshots('unit-falling'));
    assert.equal(falling.trend, 'falling');
    assert.ok(falling.score >= 0 && falling.score <= 100);

    for (const v of [30, 30, 30, 30]) {
      dbMod.insertStreamSnapshot({ sessionId: 'unit-stable', velocity: v });
    }
    const stable = streamHealthMod.scoreStreamHealth(dbMod.listStreamSnapshots('unit-stable'));
    assert.equal(stable.trend, 'stable');
    assert.equal(stable.score, 30);

    assert.equal(dbMod.deleteClipCascade(clipId), true);
    assert.equal(dbMod.listClipShares(clipId).length, 0);
    assert.equal(dbMod.getAbExperiment(clipId), null);
  });

  it('defends CSV export against formula injection and validates audio magic bytes', () => {
    assert.equal(studioMod.escapeCsvCell('=cmd|calc'), '"\'=cmd|calc"');
    assert.equal(studioMod.escapeCsvCell('+1+1'), '"\'+1+1"');
    assert.equal(studioMod.escapeCsvCell('@SUM(A1)'), '"\'@SUM(A1)"');
    assert.equal(studioMod.escapeCsvCell('-2+3'), '"\'-2+3"');
    assert.equal(studioMod.escapeCsvCell(' =1+1'), '"\' =1+1"');
    assert.equal(studioMod.escapeCsvCell('hello "world"'), '"hello ""world"""');

    const id3Mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
    const riffWav = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary');
    const oggHeader = Buffer.from('OggS\x00\x02\x00\x00', 'binary');
    const ftypM4a = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

    assert.equal(studioMod.detectAudioMagicBytes(id3Mp3, '.mp3'), true);
    assert.equal(studioMod.detectAudioMagicBytes(riffWav, '.wav'), true);
    assert.equal(studioMod.detectAudioMagicBytes(oggHeader, '.ogg'), true);
    assert.equal(studioMod.detectAudioMagicBytes(ftypM4a, '.m4a'), true);

    assert.equal(studioMod.detectAudioMagicBytes(fakePng, '.mp3'), false);
    assert.equal(studioMod.detectAudioMagicBytes(fakePng, '.wav'), false);
    assert.equal(studioMod.detectAudioMagicBytes(fakePng, '.ogg'), false);
    assert.equal(studioMod.detectAudioMagicBytes(fakePng, '.m4a'), false);
  });
});

describe('Live HTTP Server Integration Tests', () => {
  const TEST_ADMIN_PASSWORD = 'ci-http-admin-secret-9988';
  let serverTmpDir = '';
  let serverProc: ChildProcess;
  let baseUrl = '';
  let serverLogs = '';
  let adminCookie = '';

  before(async () => {
    serverTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-http-test-'));
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    serverProc = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATA_DIR: path.join(serverTmpDir, 'data'),
        MEDIA_ROOT_DIR: path.join(serverTmpDir, 'media'),
        HOST: '127.0.0.1',
        CLIPPER_PORT: String(port),
        ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
        REQUIRE_API_KEY: 'false',
        LLM_PROVIDER: 'mock',
        KELVIQ_API_KEY: '',
        KELVIQ_WEBHOOK_SECRET: '',
        KELVIQ_ALLOW_UNSIGNED_WEBHOOKS: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout?.on('data', (chunk: Buffer) => {
      serverLogs += chunk.toString();
    });
    serverProc.stderr?.on('data', (chunk: Buffer) => {
      serverLogs += chunk.toString();
    });

    await waitForServerReady(baseUrl, serverProc, () => serverLogs);
  });

  after(async () => {
    await stopChildProcess(serverProc);
    removeDirSafe(serverTmpDir);
  });

  it('serves /api/system/version with security headers', async () => {
    const { status, headers, data } = await requestJson<{
      ok: boolean;
      version: string;
      gitRepo: boolean;
    }>(baseUrl, '/api/system/version');

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(typeof data.version, 'string');
    assert.equal(typeof data.gitRepo, 'boolean');

    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-frame-options'), 'DENY');
    const csp = headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes('https://cdn.jsdelivr.net'));
    assert.ok(csp.includes('player.twitch.tv'));
    assert.ok(csp.includes("frame-ancestors 'none'"));
  });

  it('serves billing and licensing status on the default free plan', async () => {
    for (const endpoint of ['/api/billing/status', '/api/licensing/status']) {
      const { status, data } = await requestJson<{
        ok: boolean;
        entitlement: { plan: { id: string } };
        plans: Array<{ id: string }>;
      }>(baseUrl, endpoint);

      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.entitlement.plan.id, 'free');
      assert.ok(Array.isArray(data.plans) && data.plans.length >= 3);
    }
  });

  it('serves analytics summary with expected metrics', async () => {
    const { status, data } = await requestJson<{
      ok: boolean;
      clipsThisMonth: number;
      clipsPerDay: unknown[];
      topPlatforms: unknown[];
      totalClips: number;
    }>(baseUrl, '/api/analytics/summary');

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(typeof data.totalClips, 'number');
    assert.equal(typeof data.clipsThisMonth, 'number');
    assert.ok(Array.isArray(data.clipsPerDay));
    assert.ok(Array.isArray(data.topPlatforms));
  });

  it('routes /clips/search and /clips/favourites before :id shadowing', async () => {
    const searchRes = await requestJson<{ ok: boolean; clips: unknown[] }>(
      baseUrl,
      '/api/clipper/clips/search?q=test',
    );
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.data.ok, true);
    assert.ok(Array.isArray(searchRes.data.clips));

    const favRes = await requestJson<{ ok: boolean; clips: unknown[] }>(
      baseUrl,
      '/api/clipper/clips/favourites',
    );
    assert.equal(favRes.status, 200);
    assert.equal(favRes.data.ok, true);
    assert.ok(Array.isArray(favRes.data.clips));
  });

  it('rejects unauthenticated access to protected admin endpoints', async () => {
    for (const endpoint of ['/api/admin/api-keys', '/api/admin/event-log', '/api/admin/audit-log']) {
      const { status } = await requestJson(baseUrl, endpoint);
      assert.equal(status, 401, `Expected ${endpoint} to return 401 without admin cookie`);
    }
  });

  it('handles admin login, cookie attributes, API key CRUD, Bearer enforcement, and audit log', async () => {
    const badLogin = await requestJson(baseUrl, '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(badLogin.status, 401);

    const goodLogin = await requestJson<{ ok: boolean }>(baseUrl, '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
    });
    assert.equal(goodLogin.status, 200);
    assert.equal(goodLogin.data.ok, true);

    const setCookie = goodLogin.headers.get('set-cookie') ?? '';
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Strict'));
    adminCookie = extractCookiePair(setCookie, 'clipper_admin_session');

    const createKeyRes = await requestJson<{
      ok: boolean;
      id: string;
      key: string;
      maskedKey: string;
    }>(baseUrl, '/api/admin/api-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
      },
      body: JSON.stringify({ label: 'Integration Test Key' }),
    });
    assert.equal(createKeyRes.status, 201);
    assert.equal(createKeyRes.data.ok, true);
    assert.ok(createKeyRes.data.key.startsWith('csk_'));
    assert.ok(createKeyRes.data.maskedKey.startsWith('csk_***'));

    const listKeysRes = await requestJson<{
      ok: boolean;
      keys: Array<{ id: string; maskedKey: string; active: number }>;
    }>(baseUrl, '/api/admin/api-keys', {
      headers: { Cookie: adminCookie },
    });
    assert.equal(listKeysRes.status, 200);
    const listed = listKeysRes.data.keys.find((k) => k.id === createKeyRes.data.id);
    assert.ok(listed);
    assert.equal(listed.maskedKey, createKeyRes.data.maskedKey);
    assert.equal(JSON.stringify(listKeysRes.data).includes(createKeyRes.data.key), false);

    // Valid Bearer key passes
    const validBearerRes = await requestJson(baseUrl, '/api/clipper/clips', {
      headers: { Authorization: `Bearer ${createKeyRes.data.key}` },
    });
    assert.equal(validBearerRes.status, 200);

    // Invalid Bearer key returns 401 even when REQUIRE_API_KEY=false
    const invalidBearerRes = await requestJson(baseUrl, '/api/clipper/clips', {
      headers: { Authorization: 'Bearer csk_invalid' },
    });
    assert.equal(invalidBearerRes.status, 401);

    // Revoke key via admin route
    const revokeRes = await requestJson<{ ok: boolean; revoked: boolean }>(
      baseUrl,
      `/api/admin/api-keys/${createKeyRes.data.id}`,
      {
        method: 'DELETE',
        headers: { Cookie: adminCookie },
      },
    );
    assert.equal(revokeRes.status, 200);
    assert.equal(revokeRes.data.revoked, true);

    // Revoked Bearer key is now rejected
    const revokedBearerRes = await requestJson(baseUrl, '/api/clipper/clips', {
      headers: { Authorization: `Bearer ${createKeyRes.data.key}` },
    });
    assert.equal(revokedBearerRes.status, 401);

    // Audit log captured admin actions
    const auditRes = await requestJson<{
      ok: boolean;
      logs: Array<{ action: string; target: string }>;
    }>(baseUrl, '/api/admin/audit-log', {
      headers: { Cookie: adminCookie },
    });
    assert.equal(auditRes.status, 200);
    const actions = new Set(auditRes.data.logs.map((l) => l.action));
    assert.ok(actions.has('admin.login'));
    assert.ok(actions.has('api_key.create'));
    assert.ok(actions.has('api_key.revoke'));
  });

  it('blocks untrusted Origin headers via CSRF middleware', async () => {
    const scheduleRes = await requestJson(baseUrl, '/api/studio/schedule-autoclip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ videoPath: 'ignored.mp4', cronExpr: '0 3 * * *' }),
    });
    assert.equal(scheduleRes.status, 403);

    const billingRes = await requestJson(baseUrl, '/api/billing/deactivate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({}),
    });
    assert.equal(billingRes.status, 403);
  });

  it('rejects Kelviq webhooks with 403 when webhook secret is unconfigured', async () => {
    const res = await requestJson(baseUrl, '/api/webhooks/kelviq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'license.activated', data: {} }),
    });
    assert.equal(res.status, 403);
  });

  it('blocks SSRF probes targeting loopback/private addresses', async () => {
    const res = await requestJson(baseUrl, '/api/studio/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'http://127.0.0.1:8080/test.m3u8' }),
    });
    assert.ok(res.status === 400 || res.status === 403, `Expected 400/403, got ${res.status}`);
  });

  it('supports scheduled auto-clip jobs CRUD lifecycle', async () => {
    const streamsDir = path.join(serverTmpDir, 'media', '05_streams');
    fs.mkdirSync(streamsDir, { recursive: true });
    const dummyVideoPath = path.join(streamsDir, 'scheduled-source.mp4');
    fs.writeFileSync(dummyVideoPath, 'dummy-mp4-content');

    const createRes = await requestJson<{
      ok: boolean;
      job: { id: string; enabled: number; max_clips: number };
    }>(baseUrl, '/api/studio/schedule-autoclip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: dummyVideoPath,
        cronExpr: '0 3 * * *',
        maxClips: 2,
        layout: 'split',
        captionStyle: 'none',
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.ok, true);
    assert.equal(createRes.data.job.enabled, 1);

    const jobId = createRes.data.job.id;

    const listRes = await requestJson<{
      ok: boolean;
      jobs: Array<{ id: string }>;
    }>(baseUrl, '/api/studio/scheduled-jobs');
    assert.equal(listRes.status, 200);
    assert.ok(listRes.data.jobs.some((j) => j.id === jobId));

    const toggleRes = await requestJson<{
      ok: boolean;
      job: { id: string; enabled: number };
    }>(baseUrl, `/api/studio/scheduled-jobs/${jobId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(toggleRes.status, 200);
    assert.equal(toggleRes.data.job.enabled, 0);

    const deleteRes = await requestJson<{ ok: boolean }>(
      baseUrl,
      `/api/studio/scheduled-jobs/${jobId}`,
      { method: 'DELETE' },
    );
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.data.ok, true);

    const afterDeleteRes = await requestJson<{
      ok: boolean;
      jobs: Array<{ id: string }>;
    }>(baseUrl, '/api/studio/scheduled-jobs');
    assert.equal(afterDeleteRes.status, 200);
    assert.equal(afterDeleteRes.data.jobs.some((j) => j.id === jobId), false);
  });

  it('serves clean HTML pages without inline event handlers and keeps .env.example keys empty', async () => {
    for (const route of ['/', '/admin', '/upgrade']) {
      const res = await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(res.status, 200, `Expected ${route} to return 200`);
      const html = await res.text();
      const inlineMatches = html.match(/\son[a-z]+\s*=/gi);
      assert.equal(inlineMatches, null, `Expected ${route} HTML to have no inline on*= handlers`);
    }

    const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(envExample, /^LLM_API_KEY=""$/m);
  });

  async function ensureAdminCookie(): Promise<string> {
    if (adminCookie) return adminCookie;
    const res = await requestJson(baseUrl, '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
    });
    assert.equal(res.status, 200);
    adminCookie = extractCookiePair(res.headers.get('set-cookie'), 'clipper_admin_session');
    return adminCookie;
  }

  it('supports presets CRUD and protects built-in presets', async () => {
    const listRes = await requestJson<{
      ok: boolean;
      presets: Array<{ id: string; name: string; is_builtin: number }>;
    }>(baseUrl, '/api/presets');
    assert.equal(listRes.status, 200);
    assert.equal(listRes.data.ok, true);
    assert.ok(listRes.data.presets.some((p) => p.id === 'builtin-viral-split' && p.is_builtin === 1));

    const createRes = await requestJson<{
      ok: boolean;
      preset: { id: string; name: string; is_builtin: number };
    }>(baseUrl, '/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      body: JSON.stringify({
        name: 'HTTP Custom Preset',
        description: 'Integration test preset',
        layout: 'portrait-4x5',
        captionStyle: 'neon',
        silenceCut: true,
        audioNormalize: true,
        musicVolume: 0.2,
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.ok, true);
    assert.equal(createRes.data.preset.is_builtin, 0);

    const deleteBuiltinRes = await requestJson(baseUrl, '/api/presets/builtin-viral-split', {
      method: 'DELETE',
      headers: { Origin: baseUrl, 'X-Clipper-CSRF': '1' },
    });
    assert.equal(deleteBuiltinRes.status, 400);

    const deleteCustomRes = await requestJson<{ ok: boolean }>(
      baseUrl,
      `/api/presets/${createRes.data.preset.id}`,
      {
        method: 'DELETE',
        headers: { Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      },
    );
    assert.equal(deleteCustomRes.status, 200);
    assert.equal(deleteCustomRes.data.ok, true);
  });

  it('routes /clips/top-rated and /clips/export.csv before :id shadowing', async () => {
    const topRes = await requestJson<{ ok: boolean; clips: unknown[] }>(
      baseUrl,
      '/api/clipper/clips/top-rated',
    );
    assert.equal(topRes.status, 200);
    assert.equal(topRes.data.ok, true);
    assert.ok(Array.isArray(topRes.data.clips));

    const csvRes = await fetch(`${baseUrl}/api/clipper/clips/export.csv`, {
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(csvRes.status, 200);
    const contentType = csvRes.headers.get('content-type') ?? '';
    assert.ok(contentType.includes('text/csv'), `Expected text/csv, got ${contentType}`);
    const csvText = await csvRes.text();
    assert.ok(
      csvText.startsWith('id,title,social_title,social_description,hashtags,platform,'),
      'Expected RFC-4180 CSV header row',
    );
  });

  it('validates music upload magic bytes and supports safe upload/delete', async () => {
    const spoofedPngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const badRes = await requestJson(baseUrl, '/api/studio/music/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseUrl,
        'X-Clipper-CSRF': '1',
      },
      body: JSON.stringify({ filename: 'evil.mp3', base64Data: spoofedPngBase64 }),
    });
    assert.equal(badRes.status, 400);

    const validMp3Base64 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).toString(
      'base64',
    );
    const goodRes = await requestJson<{ ok: boolean; track: { name: string } }>(
      baseUrl,
      '/api/studio/music/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
          'X-Clipper-CSRF': '1',
        },
        body: JSON.stringify({ filename: 'safe_test.mp3', base64Data: validMp3Base64 }),
      },
    );
    assert.equal(goodRes.status, 201);
    assert.equal(goodRes.data.ok, true);
    assert.equal(goodRes.data.track.name, 'safe_test.mp3');

    const delRes = await requestJson<{ ok: boolean }>(baseUrl, '/api/studio/music/safe_test.mp3', {
      method: 'DELETE',
      headers: { Origin: baseUrl, 'X-Clipper-CSRF': '1' },
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.ok, true);
  });

  it('supports full clip workflows: collections, ratings, chapters, comments, A/B tests, shares, upload queue, kit, snapshots, diagnostics, security scan, and CSRF-guarded delete', async () => {
    const cookie = await ensureAdminCookie();

    // Seed a real dummy MP4 inside media/03_clips and insert into the running server's SQLite DB
    const clipsDir = path.join(serverTmpDir, 'media', '03_clips');
    fs.mkdirSync(clipsDir, { recursive: true });
    const dummyClipPath = path.join(clipsDir, 'seeded-integration-clip.mp4');
    const dummyClipBytes = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
    fs.writeFileSync(dummyClipPath, dummyClipBytes);

    const seededClipId = 'http-seed-clip-001';
    const seedDb = openDb(path.join(serverTmpDir, 'data', 'clipper.sqlite'));
    try {
      seedDb
        .prepare(`INSERT OR IGNORE INTO ingest_jobs (id, source_url, status) VALUES ('seed-job', 'https://example.com/vod', 'DONE')`)
        .run();
      seedDb
        .prepare(`
          INSERT INTO clips (
            id, job_id, title, description, start_sec, end_sec, duration_sec,
            file_path, file_size_bytes, status, virality_score, source_platform, layout
          ) VALUES (?, 'seed-job', ?, ?, 0, 25, 25, ?, ?, 'READY', 92, 'twitch', 'split')
        `)
        .run(seededClipId, 'Integration Seed Clip', 'Insane 1v5 clutch', dummyClipPath, dummyClipBytes.length);
    } finally {
      seedDb.close();
    }

    // 1. Collections CRUD + /clips/:id/collections
    const colCreate = await requestJson<{ ok: boolean; collection: { id: string; name: string } }>(
      baseUrl,
      '/api/clipper/collections',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
        body: JSON.stringify({ name: 'Top Clutches', description: 'Tournament highlights', color: '#22c55e' }),
      },
    );
    assert.equal(colCreate.status, 201);
    const colId = colCreate.data.collection.id;

    const colAdd = await requestJson<{ ok: boolean }>(baseUrl, `/api/clipper/collections/${colId}/clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      body: JSON.stringify({ clipId: seededClipId, position: 1 }),
    });
    assert.equal(colAdd.status, 200);

    const clipCollectionsRes = await requestJson<{
      ok: boolean;
      collections: Array<{ id: string; name: string }>;
    }>(baseUrl, `/api/clipper/clips/${seededClipId}/collections`);
    assert.equal(clipCollectionsRes.status, 200);
    assert.equal(clipCollectionsRes.data.ok, true);
    assert.ok(clipCollectionsRes.data.collections.some((c) => c.id === colId));

    const missingClipColsRes = await requestJson(baseUrl, '/api/clipper/clips/nonexistent-clip-id/collections');
    assert.equal(missingClipColsRes.status, 404);

    const colClipsRes = await requestJson<{ ok: boolean; clips: Array<{ id: string }> }>(
      baseUrl,
      `/api/clipper/collections/${colId}/clips`,
    );
    assert.equal(colClipsRes.status, 200);
    assert.ok(colClipsRes.data.clips.some((c) => c.id === seededClipId));

    const colRemove = await requestJson<{ ok: boolean }>(
      baseUrl,
      `/api/clipper/collections/${colId}/clips/${seededClipId}`,
      { method: 'DELETE', headers: { Origin: baseUrl, 'X-Clipper-CSRF': '1' } },
    );
    assert.equal(colRemove.status, 200);

    const colDelete = await requestJson<{ ok: boolean }>(baseUrl, `/api/clipper/collections/${colId}`, {
      method: 'DELETE',
      headers: { Origin: baseUrl, 'X-Clipper-CSRF': '1' },
    });
    assert.equal(colDelete.status, 200);

    // 2. Ratings
    const goodRate = await requestJson<{ ok: boolean; rating: number }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/rate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
        body: JSON.stringify({ rating: 5 }),
      },
    );
    assert.equal(goodRate.status, 200);
    assert.equal(goodRate.data.rating, 5);

    const badRate = await requestJson(baseUrl, `/api/clipper/clips/${seededClipId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      body: JSON.stringify({ rating: 9 }),
    });
    assert.equal(badRate.status, 400);

    const topRatedRes = await requestJson<{ ok: boolean; clips: Array<{ id: string; rating: number }> }>(
      baseUrl,
      '/api/clipper/clips/top-rated',
    );
    assert.equal(topRatedRes.status, 200);
    assert.ok(topRatedRes.data.clips.some((c) => c.id === seededClipId && c.rating === 5));

    // 3. Chapters
    const chCreate = await requestJson<{ ok: boolean; chapter: { id: string; start_sec: number } }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/chapters`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
        body: JSON.stringify({ title: 'Setup', startSec: 2.5 }),
      },
    );
    assert.equal(chCreate.status, 201);
    const chList = await requestJson<{ ok: boolean; chapters: Array<{ id: string }> }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/chapters`,
    );
    assert.equal(chList.status, 200);
    assert.ok(chList.data.chapters.some((c) => c.id === chCreate.data.chapter.id));
    const chDel = await requestJson<{ ok: boolean }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/chapters/${chCreate.data.chapter.id}`,
      { method: 'DELETE', headers: { Origin: baseUrl, 'X-Clipper-CSRF': '1' } },
    );
    assert.equal(chDel.status, 200);

    // 4. Review Comments
    const cmCreate = await requestJson<{ ok: boolean; comment: { id: string; resolved: number } }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
        body: JSON.stringify({ body: 'Trim 1s off start', author: 'reviewer', timestampSec: 1.5 }),
      },
    );
    assert.equal(cmCreate.status, 201);
    const cmList = await requestJson<{ ok: boolean; comments: Array<{ id: string }> }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/comments`,
    );
    assert.equal(cmList.status, 200);
    assert.ok(cmList.data.comments.some((c) => c.id === cmCreate.data.comment.id));

    const cmResolve = await requestJson<{ ok: boolean; comment: { resolved: number } }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/comments/${cmCreate.data.comment.id}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
        body: JSON.stringify({}),
      },
    );
    assert.equal(cmResolve.status, 200);
    assert.equal(cmResolve.data.comment.resolved, 1);

    const cmDel = await requestJson<{ ok: boolean }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/comments/${cmCreate.data.comment.id}`,
      { method: 'DELETE', headers: { Origin: baseUrl, 'X-Clipper-CSRF': '1' } },
    );
    assert.equal(cmDel.status, 200);

    // 5. A/B Title Test
    const abCreate = await requestJson<{ ok: boolean; experiment: { id: string } }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/ab-test`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
        body: JSON.stringify({ variantATitle: 'Unbelievable Clutch!', variantBTitle: '1v5 Impossible Win!' }),
      },
    );
    assert.equal(abCreate.status, 201);

    const abGet = await requestJson<{ ok: boolean; activeVariant: string }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/ab-test`,
    );
    assert.equal(abGet.status, 200);
    assert.equal(abGet.data.activeVariant, 'a');

    const abEvent = await requestJson<{
      ok: boolean;
      activeVariant: string;
      experiment: { variant_a_views: number };
    }>(baseUrl, `/api/clipper/clips/${seededClipId}/ab-test/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      body: JSON.stringify({ variant: 'a', type: 'view' }),
    });
    assert.equal(abEvent.status, 200);
    assert.equal(abEvent.data.experiment.variant_a_views, 1);
    assert.equal(abEvent.data.activeVariant, 'b');

    // 6. Share Links security & streaming grant flow
    const shareCreate = await requestJson<{
      ok: boolean;
      share: { token: string; has_password: number; password_hash?: string };
    }>(baseUrl, `/api/clipper/clips/${seededClipId}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      body: JSON.stringify({ password: 'secret', maxViews: 2 }),
    });
    assert.equal(shareCreate.status, 201);
    assert.equal('password_hash' in shareCreate.data.share, false);
    assert.equal(shareCreate.data.share.has_password, 1);
    const shareToken = shareCreate.data.share.token;

    const shareGetNoPw = await requestJson<{ passwordRequired?: boolean }>(baseUrl, `/api/share/${shareToken}`);
    assert.equal(shareGetNoPw.status, 401);
    assert.equal(shareGetNoPw.data.passwordRequired, true);

    const shareBadPw = await requestJson(baseUrl, `/api/share/${shareToken}/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(shareBadPw.status, 401);

    const shareGood1 = await requestJson<{ ok: boolean; streamUrl: string }>(
      baseUrl,
      `/api/share/${shareToken}/access`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'secret' }),
      },
    );
    assert.equal(shareGood1.status, 200);
    assert.ok(shareGood1.data.streamUrl.includes('?grant='));

    const streamRes = await fetch(`${baseUrl}${shareGood1.data.streamUrl}`, {
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(streamRes.status, 200);
    const streamedBytes = Buffer.from(await streamRes.arrayBuffer());
    assert.deepEqual(streamedBytes, dummyClipBytes);

    const shareGood2 = await requestJson<{ ok: boolean }>(baseUrl, `/api/share/${shareToken}/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    assert.equal(shareGood2.status, 200);

    const shareExceeded = await requestJson(baseUrl, `/api/share/${shareToken}/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    assert.equal(shareExceeded.status, 403);

    // 7. Social Upload Queue CRUD + stats + invalid platform
    const queueBad = await requestJson(baseUrl, '/api/studio/upload-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      body: JSON.stringify({ clipId: seededClipId, platform: 'invalid_platform', title: 'Bad' }),
    });
    assert.equal(queueBad.status, 400);

    const queueCreate = await requestJson<{ ok: boolean; item: { id: string; status: string } }>(
      baseUrl,
      '/api/studio/upload-queue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
        body: JSON.stringify({ clipId: seededClipId, platform: 'tiktok', title: 'Clutch TikTok Cut' }),
      },
    );
    assert.equal(queueCreate.status, 201);
    const queueId = queueCreate.data.item.id;

    const queueList = await requestJson<{
      ok: boolean;
      items: Array<{ id: string }>;
      stats: Record<string, { queued: number; done: number }>;
    }>(baseUrl, '/api/studio/upload-queue');
    assert.equal(queueList.status, 200);
    assert.ok(queueList.data.items.some((i) => i.id === queueId));
    assert.ok(queueList.data.stats.tiktok.queued >= 1);

    const queuePatch = await requestJson<{ ok: boolean; item: { status: string } }>(
      baseUrl,
      `/api/studio/upload-queue/${queueId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
        body: JSON.stringify({ status: 'done' }),
      },
    );
    assert.equal(queuePatch.status, 200);
    assert.equal(queuePatch.data.item.status, 'done');

    const queueDel = await requestJson<{ ok: boolean }>(baseUrl, `/api/studio/upload-queue/${queueId}`, {
      method: 'DELETE',
      headers: { Origin: baseUrl, 'X-Clipper-CSRF': '1' },
    });
    assert.equal(queueDel.status, 200);

    // 8. Creator Kit & Batch Metadata invalid count (>20)
    const kitRes = await requestJson<{
      ok: boolean;
      platforms: { youtubeShorts: unknown; tiktok: unknown; instagramReels: unknown };
    }>(baseUrl, `/api/clipper/clips/${seededClipId}/kit`);
    assert.equal(kitRes.status, 200);
    assert.equal(kitRes.data.ok, true);
    assert.ok(kitRes.data.platforms.youtubeShorts);
    assert.ok(kitRes.data.platforms.tiktok);
    assert.ok(kitRes.data.platforms.instagramReels);

    const batchTooMany = await requestJson(baseUrl, '/api/clipper/clips/batch-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      body: JSON.stringify({ clipIds: Array.from({ length: 21 }, (_, idx) => `id-${idx}`) }),
    });
    assert.equal(batchTooMany.status, 400);

    // 9. Stream Health Snapshots
    const snapUnauth = await requestJson(baseUrl, '/api/studio/snapshots/sessions');
    assert.equal(snapUnauth.status, 401);

    const snapPost1 = await requestJson<{ ok: boolean; id: number }>(baseUrl, '/api/studio/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      body: JSON.stringify({ sessionId: 'http-sess-1', velocity: 10, viewerCount: 200, peakDb: -9, clipCount: 1 }),
    });
    assert.equal(snapPost1.status, 201);

    const snapPost2 = await requestJson<{ ok: boolean; id: number }>(baseUrl, '/api/studio/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      body: JSON.stringify({ sessionId: 'http-sess-1', velocity: 50, viewerCount: 320, peakDb: -4, clipCount: 2 }),
    });
    assert.equal(snapPost2.status, 201);

    const snapSessions = await requestJson<{
      ok: boolean;
      sessions: Array<{ session_id: string; count: number }>;
    }>(baseUrl, '/api/studio/snapshots/sessions', {
      headers: { Cookie: cookie },
    });
    assert.equal(snapSessions.status, 200);
    assert.ok(snapSessions.data.sessions.some((s) => s.session_id === 'http-sess-1' && s.count === 2));

    const snapDetail = await requestJson<{
      ok: boolean;
      snapshots: unknown[];
      health: { score: number; trend: string };
    }>(baseUrl, '/api/studio/snapshots/http-sess-1', {
      headers: { Cookie: cookie },
    });
    assert.equal(snapDetail.status, 200);
    assert.equal(snapDetail.data.snapshots.length, 2);
    assert.equal(typeof snapDetail.data.health.score, 'number');

    const snapPrune = await requestJson<{ ok: boolean; pruned: number }>(
      baseUrl,
      '/api/studio/snapshots?keepDays=1',
      {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      },
    );
    assert.equal(snapPrune.status, 200);
    assert.equal(snapPrune.data.ok, true);

    // 10. System Diagnostics & Admin Security Scan
    const diagRes = await requestJson<{
      ok: boolean;
      binaries: Record<string, unknown>;
      storage: Record<string, unknown>;
      counts: Record<string, number>;
      security: Record<string, unknown>;
    }>(baseUrl, '/api/system/diagnostics');
    assert.equal(diagRes.status, 200);
    assert.equal(diagRes.data.ok, true);
    assert.ok(diagRes.data.binaries && diagRes.data.storage && diagRes.data.counts && diagRes.data.security);

    const scanUnauth = await requestJson(baseUrl, '/api/admin/security-scan');
    assert.equal(scanUnauth.status, 401);

    const scanAuth = await requestJson<{
      ok: boolean;
      score: number;
      checks: Array<{ id: string; status: string }>;
    }>(baseUrl, '/api/admin/security-scan', {
      headers: { Cookie: cookie },
    });
    assert.equal(scanAuth.status, 200);
    assert.equal(scanAuth.data.ok, true);
    assert.equal(typeof scanAuth.data.score, 'number');
    assert.ok(Array.isArray(scanAuth.data.checks) && scanAuth.data.checks.length >= 8);

    // 10b. Path-contained archive & unarchive round-trip
    const archiveRes = await requestJson<{ ok: boolean; archived: boolean; archivedTo: string }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/archive`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
        body: JSON.stringify({}),
      },
    );
    assert.equal(archiveRes.status, 200);
    assert.equal(archiveRes.data.archived, true);
    assert.ok(archiveRes.data.archivedTo.includes('04_archive'));

    const unarchiveRes = await requestJson<{ ok: boolean; archived: boolean; restoredTo: string }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}/archive`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'X-Clipper-CSRF': '1' },
        body: JSON.stringify({ archived: false }),
      },
    );
    assert.equal(unarchiveRes.status, 200);
    assert.equal(unarchiveRes.data.archived, false);
    assert.ok(unarchiveRes.data.restoredTo.includes('03_clips'));

    // 11. Single-clip Delete security (requires X-Clipper-CSRF: 1 / admin cookie / API key)
    const delUnauth = await requestJson(baseUrl, `/api/clipper/clips/${seededClipId}`, {
      method: 'DELETE',
    });
    assert.equal(delUnauth.status, 403);

    const delAuth = await requestJson<{ ok: boolean; deleted: boolean }>(
      baseUrl,
      `/api/clipper/clips/${seededClipId}`,
      {
        method: 'DELETE',
        headers: { Origin: baseUrl, 'X-Clipper-CSRF': '1' },
      },
    );
    assert.equal(delAuth.status, 200);
    assert.equal(delAuth.data.ok, true);
    assert.equal(delAuth.data.deleted, true);

    const afterDelGet = await requestJson(baseUrl, `/api/clipper/clips/${seededClipId}`);
    assert.equal(afterDelGet.status, 404);
    assert.equal(fs.existsSync(dummyClipPath), false);
  });
});
