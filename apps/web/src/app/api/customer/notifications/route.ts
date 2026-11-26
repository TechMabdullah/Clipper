import { NextResponse } from 'next/server';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requireSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireSession();
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ notifications: [], unreadCount: 0 });
  }

  try {
    const db = getAdminDb();
    const snap = await db
      .collection('notifications')
      .where('uid', 'in', [auth.session.uid, '*'])
      .limit(60)
      .get();

    const notifications = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
        Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0),
      );
    const unreadCount = notifications.filter((n: Record<string, unknown>) => !n.read).length;

    return NextResponse.json({ notifications, unreadCount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load notifications.' },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  const auth = await requireSession();
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ ok: true });
  }

  const body = await req.json().catch(() => ({}));
  const db = getAdminDb();

  if (body?.markAllRead) {
    const snap = await db
      .collection('notifications')
      .where('uid', '==', auth.session.uid)
      .get();
    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.set(doc.ref, { read: true }, { merge: true });
    }
    await batch.commit();
    return NextResponse.json({ ok: true });
  }

  if (typeof body?.id === 'string') {
    const ref = db.collection('notifications').doc(body.id);
    const snap = await ref.get();
    if (snap.exists && snap.data()?.uid === auth.session.uid) {
      await ref.set({ read: Boolean(body.read ?? true) }, { merge: true });
    }
  }
  return NextResponse.json({ ok: true });
}
