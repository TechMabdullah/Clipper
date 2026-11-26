import { NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requireSession, SESSION_COOKIE_NAME, TOTP_COOKIE_NAME } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

/** Export personal account data bundle as downloadable JSON */
export async function GET() {
  const auth = await requireSession();
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ exportedAt: new Date().toISOString(), user: auth.session });
  }

  const db = getAdminDb();
  const [userSnap, ordersSnap, ticketsSnap, notifSnap, sessionsSnap] = await Promise.all([
    db.collection('users').doc(auth.session.uid).get(),
    db.collection('orders').where('uid', '==', auth.session.uid).get(),
    db.collection('support_tickets').where('uid', '==', auth.session.uid).get(),
    db.collection('notifications').where('uid', '==', auth.session.uid).get(),
    db.collection('user_sessions').where('uid', '==', auth.session.uid).get(),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    user: userSnap.exists ? userSnap.data() : auth.session,
    orders: ordersSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    supportTickets: ticketsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    notifications: notifSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    sessions: sessionsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
  };

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="clipper-account-export-${auth.session.uid}.json"`,
    },
  });
}

/** Account deletion with email confirmation guard */
export async function DELETE(req: Request) {
  const auth = await requireSession();
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ error: 'Firebase Admin SDK not configured.' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  if (
    typeof body?.confirmEmail !== 'string' ||
    body.confirmEmail.trim().toLowerCase() !== auth.session.email.toLowerCase()
  ) {
    return NextResponse.json(
      { error: 'Please confirm your exact email address before deleting your account.' },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'customer.account.deleted',
    target: `user:${auth.session.uid}`,
    ip: extractClientIp(req),
    userAgent: req.headers.get('user-agent') ?? '',
  });

  await db.collection('users').doc(auth.session.uid).delete();
  await db.collection('admin_totp').doc(auth.session.uid).delete().catch(() => {});
  const sessions = await db.collection('user_sessions').where('uid', '==', auth.session.uid).get();
  const batch = db.batch();
  sessions.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  await getAdminAuth().deleteUser(auth.session.uid);

  const res = NextResponse.json({ ok: true, deleted: true });
  res.cookies.set(SESSION_COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
  res.cookies.set(TOTP_COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
