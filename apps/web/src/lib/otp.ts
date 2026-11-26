import crypto from 'node:crypto';
import { Resend } from 'resend';
import { getAdminDb } from './firebase-admin';
import { OtpVerificationEmail } from '../emails/otp-verification';

if (typeof window !== 'undefined') {
  throw new Error('otp.ts is server-only.');
}

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_HOURLY_SEND_LIMIT = 5;

export type OtpPurpose = 'login' | 'signup' | 'sensitive_action';

export interface OtpChallengeRecord {
  uid: string;
  email: string;
  purpose: OtpPurpose;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
  consumed: boolean;
  lastSentAt: number;
  sendTimestamps: number[];
  createdAt: number;
  updatedAt: number;
}

export type OtpVerifyEvaluation =
  | { ok: true; nextRecord: OtpChallengeRecord }
  | {
      ok: false;
      code:
        | 'NOT_FOUND'
        | 'ALREADY_USED'
        | 'EXPIRED'
        | 'TOO_MANY_ATTEMPTS'
        | 'INVALID_CODE';
      error: string;
      remainingAttempts: number;
      nextRecord?: OtpChallengeRecord;
    };

function resolveOtpHmacSecret(overrideSecret?: string): string {
  const secret = (overrideSecret ?? process.env.OTP_HMAC_SECRET ?? '').trim();
  if (secret.length >= 16) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('OTP_HMAC_SECRET must be set (>= 16 chars) in production.');
  }
  return 'clipper-dev-otp-hmac-secret-do-not-use-in-prod';
}

export function generateOtpCode(): string {
  return String(crypto.randomInt(100_000, 1_000_000));
}

export function hashOtp(
  uid: string,
  email: string,
  purpose: OtpPurpose,
  code: string,
  secretOverride?: string,
): string {
  const secret = resolveOtpHmacSecret(secretOverride);
  return crypto
    .createHmac('sha256', secret)
    .update(`${uid}:${email.trim().toLowerCase()}:${purpose}:${code.trim()}`)
    .digest('hex');
}

export function verifyOtpHash(
  uid: string,
  email: string,
  purpose: OtpPurpose,
  code: string,
  expectedHash: string,
  secretOverride?: string,
): boolean {
  const actualHash = hashOtp(uid, email, purpose, code, secretOverride);
  const a = Buffer.from(actualHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function canResendOtp(
  record: Pick<OtpChallengeRecord, 'lastSentAt' | 'sendTimestamps'> | null,
  now = Date.now(),
): { ok: true } | { ok: false; code: 'COOLDOWN' | 'HOURLY_LIMIT'; retryAfterSec: number; error: string } {
  if (!record) return { ok: true };
  const elapsed = now - record.lastSentAt;
  if (elapsed < OTP_RESEND_COOLDOWN_MS) {
    const retryAfterSec = Math.max(1, Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000));
    return {
      ok: false,
      code: 'COOLDOWN',
      retryAfterSec,
      error: `Please wait ${retryAfterSec}s before requesting a new verification code.`,
    };
  }
  const oneHourAgo = now - 3600 * 1000;
  const recent = record.sendTimestamps.filter((ts) => ts >= oneHourAgo);
  if (recent.length >= OTP_HOURLY_SEND_LIMIT) {
    const oldest = Math.min(...recent);
    const retryAfterSec = Math.max(1, Math.ceil((oldest + 3600 * 1000 - now) / 1000));
    return {
      ok: false,
      code: 'HOURLY_LIMIT',
      retryAfterSec,
      error: 'Maximum of 5 verification codes per hour reached. Please try again later.',
    };
  }
  return { ok: true };
}

export function evaluateOtpSubmission(
  record: OtpChallengeRecord | null,
  submittedCode: string,
  now = Date.now(),
  secretOverride?: string,
): OtpVerifyEvaluation {
  if (!record) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      error: 'No active verification challenge found. Request a new code.',
      remainingAttempts: 0,
    };
  }
  if (record.consumed) {
    return {
      ok: false,
      code: 'ALREADY_USED',
      error: 'This verification code has already been used. Request a fresh one.',
      remainingAttempts: 0,
    };
  }
  if (now > record.expiresAt) {
    return {
      ok: false,
      code: 'EXPIRED',
      error: 'Verification code expired after 5 minutes. Request a new one.',
      remainingAttempts: 0,
    };
  }
  if (record.attempts >= record.maxAttempts) {
    return {
      ok: false,
      code: 'TOO_MANY_ATTEMPTS',
      error: 'Too many invalid attempts (5 max). Please resend a new verification code.',
      remainingAttempts: 0,
    };
  }

  const matched = verifyOtpHash(
    record.uid,
    record.email,
    record.purpose,
    submittedCode,
    record.codeHash,
    secretOverride,
  );

  if (!matched) {
    const nextAttempts = record.attempts + 1;
    const remaining = Math.max(0, record.maxAttempts - nextAttempts);
    const nextRecord: OtpChallengeRecord = {
      ...record,
      attempts: nextAttempts,
      consumed: nextAttempts >= record.maxAttempts,
      updatedAt: now,
    };
    return {
      ok: false,
      code: nextAttempts >= record.maxAttempts ? 'TOO_MANY_ATTEMPTS' : 'INVALID_CODE',
      error:
        remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
          : 'Too many invalid attempts (5 max). Please resend a new verification code.',
      remainingAttempts: remaining,
      nextRecord,
    };
  }

  return {
    ok: true,
    nextRecord: {
      ...record,
      consumed: true,
      updatedAt: now,
    },
  };
}

function getOtpDocId(uid: string, purpose: OtpPurpose): string {
  return `${uid}__${purpose}`;
}

export async function issueAndSendOtp(params: {
  uid: string;
  email: string;
  name?: string;
  purpose: OtpPurpose;
}): Promise<{
  ok: boolean;
  error?: string;
  retryAfterSec?: number;
  expiresAt?: number;
  delivery: 'resend' | 'dev_echo';
  devCode?: string;
}> {
  const now = Date.now();
  const db = getAdminDb();
  const docRef = db.collection('email_otps').doc(getOtpDocId(params.uid, params.purpose));
  const code = generateOtpCode();
  const codeHash = hashOtp(params.uid, params.email, params.purpose, code);
  const expiresAt = now + OTP_TTL_MS;

  const txResult = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const existing = snap.exists ? (snap.data() as OtpChallengeRecord) : null;
    const check = canResendOtp(existing, now);
    if (!check.ok) {
      return { blocked: true as const, ...check };
    }
    const oneHourAgo = now - 3600 * 1000;
    const prevTimestamps = existing?.sendTimestamps ?? [];
    const nextTimestamps = [...prevTimestamps.filter((ts) => ts >= oneHourAgo), now];

    const record: OtpChallengeRecord = {
      uid: params.uid,
      email: params.email.trim().toLowerCase(),
      purpose: params.purpose,
      codeHash,
      expiresAt,
      attempts: 0,
      maxAttempts: OTP_MAX_ATTEMPTS,
      consumed: false,
      lastSentAt: now,
      sendTimestamps: nextTimestamps,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    tx.set(docRef, record);
    return { blocked: false as const };
  });

  if (txResult.blocked) {
    return {
      ok: false,
      error: txResult.error,
      retryAfterSec: txResult.retryAfterSec,
      delivery: 'resend',
    };
  }

  const resendApiKey = (process.env.RESEND_API_KEY ?? '').trim();
  const fromEmail =
    (process.env.RESEND_FROM_EMAIL ?? '').trim() || 'Clipper Studio <onboarding@resend.dev>';

  if (!resendApiKey) {
    if (process.env.NODE_ENV !== 'production' && process.env.DEV_OTP_ECHO === 'true') {
      console.info(`[Clipper Auth DEV OTP] ${params.email} (${params.purpose}) => ${code}`);
      return { ok: true, expiresAt, delivery: 'dev_echo', devCode: code };
    }
    throw new Error(
      'RESEND_API_KEY is not configured. Add RESEND_API_KEY in .env.local (or set DEV_OTP_ECHO=true for local non-production testing).',
    );
  }

  const resend = new Resend(resendApiKey);
  const { error } = await resend.emails.send({
    from: fromEmail,
    to: [params.email],
    subject: `${code} is your Clipper Studio verification code`,
    react: OtpVerificationEmail({
      name: params.name || 'Creator',
      code,
      expiresMinutes: 5,
    }),
    text: `Your Clipper Studio verification code is ${code}. It expires in 5 minutes. Do not share this code with anyone.`,
  });

  if (error) {
    throw new Error(`Resend failed to deliver OTP: ${error.message}`);
  }

  return { ok: true, expiresAt, delivery: 'resend' };
}

export async function verifyStoredOtp(params: {
  uid: string;
  email: string;
  purpose: OtpPurpose;
  code: string;
}): Promise<OtpVerifyEvaluation> {
  const db = getAdminDb();
  const docRef = db.collection('email_otps').doc(getOtpDocId(params.uid, params.purpose));
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const record = snap.exists ? (snap.data() as OtpChallengeRecord) : null;
    const evaluation = evaluateOtpSubmission(record, params.code, now);
    if (evaluation.nextRecord) {
      tx.set(docRef, evaluation.nextRecord);
    }
    return evaluation;
  });
}
