import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  normalizeRole,
  hasRoleAtLeast,
  isAdminSurfaceRole,
  getPermissionsForRole,
  hasPermission,
} from './rbac';
import {
  generateOtpCode,
  hashOtp,
  verifyOtpHash,
  canResendOtp,
  evaluateOtpSubmission,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  type OtpChallengeRecord,
} from './otp';
import {
  generateTotpSecret,
  buildTotpUri,
  verifyTotpCode,
  encryptTotpSecret,
  decryptTotpSecret,
} from './totp';
import { escapeCsvCell, serializeSafeCsv } from './csv';
import { buildSafeBridgeTargetUrl } from './bridge';
import { evaluateFeatureFlag, computeUserRolloutBucket } from './flags';
import {
  getSessionCookieDurationSec,
  createTotpVerifiedToken,
  verifyTotpVerifiedToken,
} from './session';

describe('RBAC & Permission Matrix', () => {
  it('normalizes unknown roles cleanly to customer', () => {
    assert.equal(normalizeRole(undefined), 'customer');
    assert.equal(normalizeRole('OWNER'), 'customer');
    assert.equal(normalizeRole('Admin'), 'admin');
    assert.equal(normalizeRole('SUPERADMIN'), 'superadmin');
  });

  it('enforces role hierarchy boundaries', () => {
    assert.equal(isAdminSurfaceRole('customer'), false);
    assert.equal(isAdminSurfaceRole('support'), true);
    assert.equal(isAdminSurfaceRole('admin'), true);
    assert.equal(hasRoleAtLeast('support', 'admin'), false);
    assert.equal(hasRoleAtLeast('admin', 'support'), true);
    assert.equal(hasRoleAtLeast('superadmin', 'admin'), true);
  });

  it('separates customer, support, admin, and superadmin privileges', () => {
    assert.equal(hasPermission('customer', 'clipper:use'), true);
    assert.equal(hasPermission('customer', 'admin:access'), false);
    assert.equal(hasPermission('support', 'support:write'), true);
    assert.equal(hasPermission('support', 'orders:refund'), false);
    assert.equal(hasPermission('admin', 'orders:refund'), true);
    assert.equal(hasPermission('admin', 'flags:write'), true);
    assert.equal(hasPermission('admin', 'roles:write'), false);
    assert.equal(hasPermission('superadmin', 'roles:write'), true);
    assert.ok(getPermissionsForRole('superadmin').length > getPermissionsForRole('admin').length);
  });

  it('uses shorter session lifetime (12h) for staff/admins vs customer (5d)', () => {
    assert.equal(getSessionCookieDurationSec('customer'), 5 * 24 * 3600);
    assert.equal(getSessionCookieDurationSec('support'), 12 * 3600);
    assert.equal(getSessionCookieDurationSec('admin'), 12 * 3600);
    assert.equal(getSessionCookieDurationSec('superadmin'), 12 * 3600);
  });
});

describe('OTP Security Lifecycle', () => {
  const secret = 'test-otp-hmac-secret-at-least-32-chars';

  it('generates 6-digit numeric codes and validates via constant-time HMAC', () => {
    const code = generateOtpCode();
    assert.match(code, /^\d{6}$/);
    const digest = hashOtp('uid1', 'User@Example.com', 'login', code, secret);
    assert.equal(verifyOtpHash('uid1', 'user@example.com', 'login', code, digest, secret), true);
    assert.equal(verifyOtpHash('uid1', 'user@example.com', 'login', '000000', digest, secret), false);
    assert.equal(verifyOtpHash('uid2', 'user@example.com', 'login', code, digest, secret), false);
  });

  it('enforces 60s resend cooldown and max 5 codes per hour', () => {
    const now = 1_700_000_000_000;
    const tooSoon = canResendOtp({ lastSentAt: now - 10_000, sendTimestamps: [now - 10_000] }, now);
    assert.equal(tooSoon.ok, false);
    if (!tooSoon.ok) assert.equal(tooSoon.code, 'COOLDOWN');

    const hourlyCap = canResendOtp(
      {
        lastSentAt: now - OTP_RESEND_COOLDOWN_MS - 5000,
        sendTimestamps: [now - 500_000, now - 400_000, now - 300_000, now - 200_000, now - 120_000],
      },
      now,
    );
    assert.equal(hourlyCap.ok, false);
    if (!hourlyCap.ok) assert.equal(hourlyCap.code, 'HOURLY_LIMIT');

    const allowed = canResendOtp(
      {
        lastSentAt: now - OTP_RESEND_COOLDOWN_MS - 1000,
        sendTimestamps: [now - 120_000],
      },
      now,
    );
    assert.equal(allowed.ok, true);
  });

  it('enforces 5-minute expiry, 5 max attempts, and single-use consumption', () => {
    const now = 1_700_000_000_000;
    const code = '654321';
    let rec: OtpChallengeRecord = {
      uid: 'u1',
      email: 'a@b.com',
      purpose: 'login',
      codeHash: hashOtp('u1', 'a@b.com', 'login', code, secret),
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
      maxAttempts: OTP_MAX_ATTEMPTS,
      consumed: false,
      lastSentAt: now,
      sendTimestamps: [now],
      createdAt: now,
      updatedAt: now,
    };

    const expiredRes = evaluateOtpSubmission(rec, code, now + OTP_TTL_MS + 1000, secret);
    assert.equal(expiredRes.ok, false);
    if (!expiredRes.ok) assert.equal(expiredRes.code, 'EXPIRED');

    // Burn 5 attempts
    for (let i = 1; i <= 5; i += 1) {
      const bad = evaluateOtpSubmission(rec, '111111', now + 1000, secret);
      assert.equal(bad.ok, false);
      if (!bad.ok) {
        assert.equal(bad.remainingAttempts, 5 - i);
        rec = bad.nextRecord!;
      }
    }
    assert.equal(rec.consumed, true);

    // Valid code no longer accepted once consumed
    const replay = evaluateOtpSubmission(rec, code, now + 2000, secret);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.code, 'ALREADY_USED');
  });
});

describe('Admin TOTP & Encrypted Secrets', () => {
  it('generates Base32 secret, verifies current RFC 6238 code, and encrypts with AES-256-GCM', () => {
    const secret = generateTotpSecret();
    assert.ok(secret.length >= 16);
    const uri = buildTotpUri({ email: 'admin@clipper.studio', secret });
    assert.ok(uri.startsWith('otpauth://totp/'));

    // Compute valid RFC 6238 code for current 30s counter using Base32 decode
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let val = 0;
    const bytes: number[] = [];
    for (const ch of secret) {
      const idx = alpha.indexOf(ch);
      if (idx === -1) continue;
      val = (val << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bytes.push((val >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    const key = Buffer.from(bytes);
    const counter = Math.floor(Date.now() / 1000 / 30);
    const cBuf = Buffer.alloc(8);
    cBuf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(cBuf).digest();
    const off = hmac[hmac.length - 1] & 0x0f;
    const bin =
      ((hmac[off] & 0x7f) << 24) |
      ((hmac[off + 1] & 0xff) << 16) |
      ((hmac[off + 2] & 0xff) << 8) |
      (hmac[off + 3] & 0xff);
    const validCode = String(bin % 1_000_000).padStart(6, '0');

    assert.equal(verifyTotpCode(secret, validCode), true);
    assert.equal(verifyTotpCode(secret, '000000') && validCode !== '000000', false);

    const enc = encryptTotpSecret(secret);
    assert.notEqual(enc, secret);
    assert.equal(decryptTotpSecret(enc), secret);

    const tok = createTotpVerifiedToken('admin-uid', 600);
    assert.equal(verifyTotpVerifiedToken('admin-uid', tok), true);
    assert.equal(verifyTotpVerifiedToken('other-uid', tok), false);
  });
});

describe('CSV Injection, Bridge Safety & Feature Flags', () => {
  it('neutralizes spreadsheet formula prefixes in CSV cells', () => {
    assert.equal(escapeCsvCell('=CMD|"/C calc"!A0'), '\'=CMD|"/C calc"!A0');
    assert.equal(escapeCsvCell('+SUM(A1:A2)'), '\'+SUM(A1:A2)');
    assert.equal(escapeCsvCell('-2+3'), '\'-2+3');
    assert.equal(escapeCsvCell('@IMPORTXML()'), '\'@IMPORTXML()');
    assert.equal(escapeCsvCell(42), '42');
    const csv = serializeSafeCsv([{ name: '=HYPERLINK("http://evil","x")', count: 5 }]);
    assert.ok(csv.includes("\"'=HYPERLINK"));
  });

  it('blocks path traversal and protocol smuggling on internal bridge URLs', () => {
    assert.throws(() => buildSafeBridgeTargetUrl(['..', 'etc', 'passwd'], ''), /Unsafe bridge path/);
    assert.throws(() => buildSafeBridgeTargetUrl(['http://evil.com'], ''), /Unsafe bridge path/);
    const okUrl = buildSafeBridgeTargetUrl(['clipper', 'jobs', '123'], '?limit=10');
    assert.ok(okUrl.endsWith('/api/clipper/jobs/123?limit=10'));
  });

  it('evaluates feature flag rollouts deterministically by uid + role', () => {
    const flag = {
      key: 'new_editor',
      enabled: true,
      rolloutPct: 50,
      targetRoles: ['admin' as const],
    };
    assert.equal(evaluateFeatureFlag(flag, 'user-abc', 'customer'), false);
    const b1 = computeUserRolloutBucket('new_editor', 'user-abc');
    const b2 = computeUserRolloutBucket('new_editor', 'user-abc');
    assert.equal(b1, b2);
    assert.equal(
      evaluateFeatureFlag({ ...flag, targetRoles: ['customer'] }, 'user-abc', 'customer'),
      b1 < 50,
    );
  });
});
