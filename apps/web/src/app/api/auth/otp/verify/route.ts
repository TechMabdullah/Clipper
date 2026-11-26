import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminAuth, getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { verifyStoredOtp } from '@/lib/otp';
import { extractClientIp, rateLimitCheck } from '@/lib/ratelimit';
import { normalizeRole, isAdminSurfaceRole } from '@/lib/rbac';
import {
  getSessionCookieDurationSec,
  SESSION_COOKIE_NAME,
} from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';

const VerifyOtpSchema = z.object({
  idToken: z.string().min(20),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit verification code'),
  purpose: z.enum(['login', 'signup', 'sensitive_action']).default('login'),
  name: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json(
      { error: 'Firebase Admin SDK is not configured on the server yet.' },
      { status: 503 },
    );
  }

  const ip = extractClientIp(req);
  const ipLimit = await rateLimitCheck('otp_verify_ip', ip, 30, 600);
  if (!ipLimit.success) {
    return NextResponse.json(
      { error: 'Too many verification attempts. Please wait a few minutes.' },
      { status: 429 },
    );
  }

  let body: z.infer<typeof VerifyOtpSchema>;
  try {
    body = VerifyOtpSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid verification payload' },
      { status: 400 },
    );
  }

  try {
    const adminAuth = getAdminAuth();
    const decoded = await adminAuth.verifyIdToken(body.idToken, true);
    if (!decoded.email) {
      return NextResponse.json({ error: 'Authenticated Firebase user has no email.' }, { status: 400 });
    }

    const uidLimit = await rateLimitCheck('otp_verify_uid', decoded.uid, 12, 600);
    if (!uidLimit.success) {
      return NextResponse.json(
        { error: 'Rate limit exceeded for OTP verification.' },
        { status: 429 },
      );
    }

    const db = getAdminDb();
    const userRef = db.collection('users').doc(decoded.uid);
    const userSnap = await userRef.get();
    if (userSnap.exists && userSnap.data()?.disabled === true) {
      return NextResponse.json({ error: 'Account has been disabled.' }, { status: 403 });
    }

    const verification = await verifyStoredOtp({
      uid: decoded.uid,
      email: decoded.email,
      purpose: body.purpose,
      code: body.code,
    });

    if (!verification.ok) {
      await writeAuditLog({
        actorUid: decoded.uid,
        actorEmail: decoded.email,
        actorRole: String(decoded.role ?? 'customer'),
        action: 'auth.otp.failed',
        target: `user:${decoded.uid}`,
        after: { code: verification.code, remainingAttempts: verification.remainingAttempts },
        ip,
        userAgent: req.headers.get('user-agent') ?? '',
      });
      return NextResponse.json(
        {
          error: verification.error,
          code: verification.code,
          remainingAttempts: verification.remainingAttempts,
        },
        { status: verification.code === 'TOO_MANY_ATTEMPTS' ? 429 : 400 },
      );
    }

    // Bootstrap first superadmin if SUPERADMIN_BOOTSTRAP_EMAIL matches verified email
    let role = normalizeRole(decoded.role ?? userSnap.data()?.role);
    const bootstrapEmail = (process.env.SUPERADMIN_BOOTSTRAP_EMAIL ?? '').trim().toLowerCase();
    if (
      bootstrapEmail &&
      decoded.email.toLowerCase() === bootstrapEmail &&
      decoded.email_verified &&
      role !== 'superadmin'
    ) {
      await adminAuth.setCustomUserClaims(decoded.uid, { role: 'superadmin' });
      role = 'superadmin';
    } else if (!decoded.role) {
      await adminAuth.setCustomUserClaims(decoded.uid, { role });
    }

    const now = Date.now();
    const displayName =
      body.name?.trim() ||
      decoded.name ||
      (userSnap.data()?.name as string | undefined) ||
      decoded.email.split('@')[0] ||
      'Creator';

    await userRef.set(
      {
        uid: decoded.uid,
        email: decoded.email.toLowerCase(),
        name: displayName,
        picture: decoded.picture || userSnap.data()?.picture || '',
        role,
        disabled: false,
        emailVerifiedAt: now,
        lastLoginAt: now,
        updatedAt: now,
        ...(userSnap.exists ? {} : { createdAt: now, plan: 'free' }),
      },
      { merge: true },
    );

    const maxAgeSec = getSessionCookieDurationSec(role);
    const sessionCookie = await adminAuth.createSessionCookie(body.idToken, {
      expiresIn: maxAgeSec * 1000,
    });
    const sessionId = crypto.createHash('sha256').update(sessionCookie).digest('hex').slice(0, 16);

    await db.collection('user_sessions').doc(`${decoded.uid}__${sessionId}`).set({
      uid: decoded.uid,
      sessionId,
      ip,
      userAgent: (req.headers.get('user-agent') ?? 'Unknown device').slice(0, 200),
      role,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + maxAgeSec * 1000,
    });

    let totpRequired = false;
    if (isAdminSurfaceRole(role)) {
      const totpSnap = await db.collection('admin_totp').doc(decoded.uid).get();
      totpRequired = Boolean(totpSnap.exists && totpSnap.data()?.enabled);
    }

    await writeAuditLog({
      actorUid: decoded.uid,
      actorEmail: decoded.email,
      actorRole: role,
      action: 'auth.session.minted',
      target: `user:${decoded.uid}`,
      after: { role, totpRequired, sessionId },
      ip,
      userAgent: req.headers.get('user-agent') ?? '',
    });

    const redirectTo = isAdminSurfaceRole(role) ? '/admin/overview' : '/overview';
    const response = NextResponse.json({
      ok: true,
      role,
      redirectTo,
      totpRequired,
      sessionId,
    });

    response.cookies.set(SESSION_COOKIE_NAME, sessionCookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeSec,
    });

    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Verification failed.' },
      { status: 400 },
    );
  }
}
