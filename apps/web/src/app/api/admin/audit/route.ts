import { NextResponse } from 'next/server';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await requirePermission('audit:read', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ logs: [] });
  }

  const url = new URL(req.url);
  const actionFilter = (url.searchParams.get('action') ?? '').trim().toLowerCase();
  const actorFilter = (url.searchParams.get('actor') ?? '').trim().toLowerCase();
  const limit = Math.min(500, Math.max(10, Number(url.searchParams.get('limit') ?? 150)));

  try {
    const snap = await getAdminDb()
      .collection('audit_logs')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    let logs = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Array<Record<string, unknown>>;
    if (actionFilter) {
      logs = logs.filter((l) => String(l.action ?? '').toLowerCase().includes(actionFilter));
    }
    if (actorFilter) {
      logs = logs.filter((l) => String(l.actorEmail ?? '').toLowerCase().includes(actorFilter));
    }
    return NextResponse.json({ logs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load audit logs.' },
      { status: 500 },
    );
  }
}
