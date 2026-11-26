import crypto from 'node:crypto';
import { getAdminDb } from './firebase-admin';

if (typeof window !== 'undefined') {
  throw new Error('totp.ts is server-only.');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  }
  return output;
}

function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function getTotpEncryptionKey(): Buffer {
  const raw = (
    process.env.ADMIN_TOTP_ENCRYPTION_KEY ||
    process.env.OTP_HMAC_SECRET ||
    ''
  ).trim();
  if (!raw && process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_TOTP_ENCRYPTION_KEY or OTP_HMAC_SECRET must be set in production.');
  }
  const material = raw || 'clipper-studio-local-dev-totp-key';
  return crypto.createHash('sha256').update(material).digest();
}

export function encryptTotpSecret(secret: string): string {
  const key = getTotpEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptTotpSecret(payload: string): string {
  const [ivHex, tagHex, encHex] = payload.split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('Corrupt TOTP payload');
  const key = getTotpEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function buildTotpUri(
  params: { secret: string; email: string; issuer?: string },
): string {
  const issuer = params.issuer ?? 'Clipper Studio Admin';
  const label = encodeURIComponent(`${issuer}:${params.email}`);
  const iss = encodeURIComponent(issuer);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(params.secret)}&issuer=${iss}&digits=6&period=30`;
}

export function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  let rem = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = rem & 0xff;
    rem = Math.floor(rem / 256);
  }
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff)) %
    1_000_000;
  return String(code).padStart(6, '0');
}

export function verifyTotpCode(secret: string, token: string, windowSteps = 1): boolean {
  const clean = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const step = Math.floor(Date.now() / 30_000);
  const targetBuf = Buffer.from(clean, 'utf8');
  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const candidate = Buffer.from(hotp(secret, step + delta), 'utf8');
    if (candidate.length === targetBuf.length && crypto.timingSafeEqual(candidate, targetBuf)) {
      return true;
    }
  }
  return false;
}

export async function getUserTotpStatus(
  uid: string,
): Promise<{ enabled: boolean; encryptedSecret?: string }> {
  try {
    const doc = await getAdminDb().collection('admin_totp').doc(uid).get();
    const data = doc.data();
    const encryptedSecret =
      typeof data?.encryptedSecret === 'string' ? data.encryptedSecret : undefined;
    return { enabled: Boolean(data?.enabled && encryptedSecret), encryptedSecret };
  } catch {
    return { enabled: false };
  }
}
