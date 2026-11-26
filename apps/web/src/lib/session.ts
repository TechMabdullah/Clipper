import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb, isFirebaseAdminConfigured } from './firebase-admin';
import {
  getPermissionsForRole,
  hasPermission,
  hasRoleAtLeast,
  normalizeRole,
  type Permission,
  type Role,
} from './rbac';

if (typeof window !== 'undefined') {
  throw new Error('session.ts is server-only.');
}

export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'clipper_fb_session';
export const TOTP_COOKIE_NAME = 'clipper_admin_totp';

export interface AppSession {
  uid: string;
  email: string;
  name: string;
  picture: string;
  role: Role;
  permissions: Permission[];
  totpEnabled: boolean;
  totpVerified: boolean;
  sessionId: string;
  authTime: number;
}

export function getSessionCookieDurationSec(role: Role): number {
  // Shorter cookie lifetime for privileged roles
  if (hasRoleAtLeast(role, 'support')) {
    return 12 * 3600; // 12 hours
  }
  return 5 * 24 * 3600; // 5 days
}

function getTotpCookieSigningKey(): string {
  return (
    process.env.OTP_HMAC_SECRET ||
    process.env.ADMIN_TOTP_ENCRYPTION_KEY ||
    'clipper-dev-totp-cookie-key'
  );
}

export function createTotpVerifiedToken(uid: string, ttlSec = 12 * 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${uid}:${exp}`;
  const sig = crypto
    .createHmac('sha256', getTotpCookieSigningKey())
    .update(payload)
    .digest('hex');
  return `${payload}:${sig}`;
}

export function verifyTotpVerifiedToken(uid: string, rawToken?: string): boolean {
  if (!rawToken) return false;
  const parts = rawToken.split(':');
  if (parts.length !== 3) return false;
  const [tokUid, expStr, sig] = parts;
  if (tokUid !== uid) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto
    .createHmac('sha256', getTotpCookieSigningKey())
    .update(`${tokUid}:${expStr}`)
    .digest('hex');
  const a = Buffer.from(sig ?? '', 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verifies the Firebase session cookie on the server, resolves role custom claims & RBAC permissions,
 * checks session revocation & optional/admin TOTP status, and returns null when unauthenticated.
 */
export async function getSession(): Promise<AppSession | null> {
  if (!isFirebaseAdminConfigured()) return null;

  const cookieStore = await cookies();
  const rawSession = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawSession) return null;

  try {
    const adminAuth = getAdminAuth();
    const decoded = await adminAuth.verifySessionCookie(rawSession, true);
    const uid = decoded.uid;
    let role = normalizeRole(decoded.role);

    const bootstrapEmail = (process.env.SUPERADMIN_BOOTSTRAP_EMAIL ?? '').trim().toLowerCase();
    if (
      bootstrapEmail &&
      decoded.email?.toLowerCase() === bootstrapEmail &&
      decoded.email_verified &&
      role !== 'superadmin'
    ) {
      await adminAuth.setCustomUserClaims(uid, { role: 'superadmin' });
      role = 'superadmin';
    }

    const db = getAdminDb();
    let userDocData: Record<string, unknown> | undefined;
    try {
      const userSnap = await db.collection('users').doc(uid).get();
      userDocData = userSnap.data();
      if (userDocData?.disabled === true) {
        return null;
      }
      if (
        typeof userDocData?.revokedAllBefore === 'number' &&
        decoded.auth_time &&
        decoded.auth_time * 1000 < userDocData.revokedAllBefore
      ) {
        return null;
      }
    } catch {
      // Non-fatal if user doc doesn't exist yet
    }

    let totpEnabled = false;
    try {
      const totpDoc = await db.collection('admin_totp').doc(uid).get();
      totpEnabled = Boolean(totpDoc.data()?.enabled && totpDoc.data()?.encryptedSecret);
    } catch {}

    const rawTotpCookie = cookieStore.get(TOTP_COOKIE_NAME)?.value;
    const totpVerified = !totpEnabled || verifyTotpVerifiedToken(uid, rawTotpCookie);

    const sessionId = crypto.createHash('sha256').update(rawSession).digest('hex').slice(0, 16);

    return {
      uid,
      email: String(decoded.email ?? ''),
      name: String(decoded.name ?? userDocData?.name ?? decoded.email?.split('@')[0] ?? 'Creator'),
      picture: String(decoded.picture ?? userDocData?.picture ?? ''),
      role,
      permissions: getPermissionsForRole(role),
      totpEnabled,
      totpVerified,
      sessionId,
      authTime: Number(decoded.auth_time ?? 0),
    };
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<
  { session: AppSession; errorResponse?: never } | { session?: never; errorResponse: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      errorResponse: NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    };
  }
  return { session };
}

export async function requirePermission(
  permission: Permission,
  requireAdminTotp = false,
): Promise<
  { session: AppSession; errorResponse?: never } | { session?: never; errorResponse: NextResponse }
> {
  const auth = await requireSession();
  if (auth.errorResponse) return auth;
  if (!hasPermission(auth.session.role, permission)) {
    return {
      errorResponse: NextResponse.json(
        { error: `Forbidden: missing permission "${permission}"` },
        { status: 403 },
      ),
    };
  }
  if (requireAdminTotp && auth.session.totpEnabled && !auth.session.totpVerified) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Admin TOTP 2FA verification required', code: 'TOTP_REQUIRED' },
        { status: 403 },
      ),
    };
  }
  return auth;
}
