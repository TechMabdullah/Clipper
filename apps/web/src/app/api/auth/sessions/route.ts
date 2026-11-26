import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminAuth, getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requireSession, SESSION_COOKIE_NAME, TOTP_COOKIE_NAME } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireSession();
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ sessions: [] });
  }

  try {
    const snap = await getAdminDb()
      .collection('user_sessions')
      .where('uid', '==', auth.session.uid)
      .orderBy('createdAt', 'desc')
      .limit(25)
      .get();

    const sessions = snap.docs.map((d) => ({
      ...d.data(),
      current: d.data().sessionId === auth.session.sessionId,
    }));

    return NextResponse.json({ sessions });
  } catch (err) {
    // Fallback without orderBy index if composite index isn't deployed yet
    try {
      const snap = await getAdminDb()
        .collection('user_sessions')
        .where('uid', '==', auth.session.uid)
        .limit(25)
        .get();
      const sessions = snap.docs
        .map((d) => ({
          ...d.data(),
          current: d.data().sessionId === auth.session.sessionId,
        }))
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
          Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0),
        );
      return NextResponse.json({ sessions });
    } catch {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to list active sessions.' },
        { status: 500 },
      );
    }
  }
}

const RevokeSchema = z.object({
  mode: z.enum(['single', 'all']).default('single'),
  sessionId: z.string().optional(),
});

export async function DELETE(req: Request) {
  const auth = await requireSession();
  if (auth.errorResponse) return auth.errorResponse;
  const ip = extractClientIp(req);

  let body: z.infer<typeof RevokeSchema>;
  try {
    body = RevokeSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid session revocation request' },
      { status: 400 },
    );
  }

  const db = getAdminDb();

  if (body.mode === 'all') {
    await getAdminAuth().revokeRefreshTokens(auth.session.uid);
    await db.collection('users').doc(auth.session.uid).set(
      { revokedAllBefore: Date.now() },
      { merge: true },
    );
    const snap = await db
      .collection('user_sessions')
      .where('uid', '==', auth.session.uid)
      .get();
    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();

    await writeAuditLog({
      actorUid: auth.session.uid,
      actorEmail: auth.session.email,
      actorRole: auth.session.role,
      action: 'auth.sessions.revoked_all',
      target: `user:${auth.session.uid}`,
      ip,
      userAgent: req.headers.get('user-agent') ?? '',
    });

    const res = NextResponse.json({ ok: true, revokedAll: true });
    res.cookies.set(SESSION_COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
    res.cookies.set(TOTP_COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
    return res;
  }

  const targetSessionId = body.sessionId || auth.session.sessionId;
  await db.collection('user_sessions').doc(`${auth.session.uid}__${targetSessionId}`).delete();

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'auth.session.revoked',
    target: `session:${targetSessionId}`,
    ip,
    userAgent: req.headers.get('user-agent') ?? '',
  });

  const res = NextResponse.json({ ok: true, revokedSessionId: targetSessionId });
  if (targetSessionId === auth.session.sessionId) {
    res.cookies.set(SESSION_COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
    res.cookies.set(TOTP_COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
  }
  return res;
}
