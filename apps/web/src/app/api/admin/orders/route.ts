import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requirePermission } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await requirePermission('orders:read', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ orders: [] });
  }

  const url = new URL(req.url);
  const statusFilter = (url.searchParams.get('status') ?? '').trim().toLowerCase();

  try {
    const snap = await getAdminDb().collection('orders').limit(300).get();
    let orders = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Array<Record<string, unknown>>;
    if (statusFilter && statusFilter !== 'all') {
      orders = orders.filter((o) => String(o.status ?? '').toLowerCase() === statusFilter);
    }
    orders.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
    return NextResponse.json({ orders });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list orders.' },
      { status: 500 },
    );
  }
}

const OrderActionSchema = z.object({
  orderId: z.string().min(1),
  status: z.enum(['pending', 'paid', 'fulfilled', 'refunded', 'cancelled']),
  reason: z.string().min(3).max(300),
});

export async function PATCH(req: Request) {
  let body: z.infer<typeof OrderActionSchema>;
  try {
    body = OrderActionSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid order update payload' },
      { status: 400 },
    );
  }

  const neededPermission = body.status === 'refunded' ? 'orders:refund' : 'orders:read';
  const auth = await requirePermission(neededPermission, true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ error: 'Firebase Admin SDK not configured.' }, { status: 503 });
  }

  const db = getAdminDb();
  const ref = db.collection('orders').doc(body.orderId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
  }

  const before = snap.data();
  const after = {
    ...before,
    status: body.status,
    updatedAt: Date.now(),
    ...(body.status === 'refunded' ? { refundedAt: Date.now(), refundReason: body.reason } : {}),
  };
  await ref.set(after, { merge: true });

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: body.status === 'refunded' ? 'admin.order.refunded' : 'admin.order.status_updated',
    target: `order:${body.orderId}`,
    before,
    after,
    reason: body.reason,
    ip: extractClientIp(req),
    userAgent: req.headers.get('user-agent') ?? '',
  });

  return NextResponse.json({ ok: true, order: after });
}
