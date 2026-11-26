import { NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { getSession, SESSION_COOKIE_NAME, TOTP_COOKIE_NAME } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export async function POST(req: Request) {
  const session = await getSession();
  const ip = extractClientIp(req);

  if (session && isFirebaseAdminConfigured()) {
    try {
      await getAdminDb()
        .collection('user_sessions')
        .doc(`${session.uid}__${session.sessionId}`)
        .delete();
      await writeAuditLog({
        actorUid: session.uid,
        actorEmail: session.email,
        actorRole: session.role,
        action: 'auth.logout',
        target: `session:${session.sessionId}`,
        ip,
        userAgent: req.headers.get('user-agent') ?? '',
      });
    } catch {
      // Non-fatal
    }
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  res.cookies.set(TOTP_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  // Optional revoke all flag
  try {
    const body = await req.json().catch(() => null);
    if (body?.revokeAll && session && isFirebaseAdminConfigured()) {
      await getAdminAuth().revokeRefreshTokens(session.uid);
      await getAdminDb().collection('users').doc(session.uid).set(
        { revokedAllBefore: Date.now() },
        { merge: true },
      );
    }
  } catch {}

  return res;
}
