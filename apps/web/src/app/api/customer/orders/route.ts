import { NextResponse } from 'next/server';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requirePermission('clipper:use');
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ orders: [] });
  }

  try {
    const db = getAdminDb();
    const snap = await db
      .collection('orders')
      .where('uid', '==', auth.session.uid)
      .limit(100)
      .get();

    const orders = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
        Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0),
      );
    return NextResponse.json({ orders });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load orders.' },
      { status: 500 },
    );
  }
}
