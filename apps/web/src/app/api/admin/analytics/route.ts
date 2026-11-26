import { NextResponse } from 'next/server';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { getClipperServiceBaseUrl } from '@/lib/bridge';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requirePermission('admin:access', true);
  if (auth.errorResponse) return auth.errorResponse;

  let usersCount = 0;
  let openTickets = 0;
  let ordersCount = 0;
  let totalRevenueCents = 0;
  let recentAuditCount = 0;

  if (isFirebaseAdminConfigured()) {
    try {
      const db = getAdminDb();
      const [usersSnap, ticketsSnap, ordersSnap, auditSnap] = await Promise.all([
        db.collection('users').limit(500).get(),
        db.collection('support_tickets').where('status', 'in', ['open', 'in_progress']).limit(200).get(),
        db.collection('orders').limit(500).get(),
        db.collection('audit_logs').limit(200).get(),
      ]);
      usersCount = usersSnap.size;
      openTickets = ticketsSnap.size;
      ordersCount = ordersSnap.size;
      for (const doc of ordersSnap.docs) {
        const d = doc.data();
        if (d.status === 'paid' || d.status === 'fulfilled') {
          totalRevenueCents += Number(d.amountCents ?? 0);
        }
      }
      recentAuditCount = auditSnap.size;
    } catch {
      // Non-fatal fallback
    }
  }

  let clipperAnalytics: Record<string, unknown> | null = null;
  try {
    const bridgeSecret = (process.env.INTERNAL_BRIDGE_SECRET ?? '').trim();
    const res = await fetch(`${getClipperServiceBaseUrl()}/api/analytics/summary`, {
      cache: 'no-store',
      headers: bridgeSecret.length >= 32 ? { 'x-clipper-bridge-secret': bridgeSecret } : undefined,
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      clipperAnalytics = (await res.json()) as Record<string, unknown>;
    }
  } catch {
    clipperAnalytics = null;
  }

  return NextResponse.json({
    saas: {
      usersCount,
      openTickets,
      ordersCount,
      totalRevenueFormatted: `$${(totalRevenueCents / 100).toFixed(2)}`,
      recentAuditCount,
    },
    clipperAnalytics,
  });
}
