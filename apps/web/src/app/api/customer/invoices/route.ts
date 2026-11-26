import { renderToBuffer } from '@react-pdf/renderer';
import { NextResponse } from 'next/server';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requirePermission } from '@/lib/session';
import { buildInvoicePdfDocument } from '@/lib/invoice-pdf';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await requirePermission('billing:manage');
  if (auth.errorResponse) return auth.errorResponse;

  const url = new URL(req.url);
  const orderId = (url.searchParams.get('orderId') ?? '').trim();
  if (!orderId) {
    return NextResponse.json({ error: 'orderId query parameter is required.' }, { status: 400 });
  }

  let orderData: Record<string, unknown> = {
    id: orderId,
    uid: auth.session.uid,
    email: auth.session.email,
    planName: 'Clipper Studio Subscription',
    amountFormatted: '$0.00',
    status: 'paid',
    createdAtIso: new Date().toISOString(),
  };

  if (isFirebaseAdminConfigured()) {
    const snap = await getAdminDb().collection('orders').doc(orderId).get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Order invoice not found.' }, { status: 404 });
    }
    const raw = snap.data() as Record<string, unknown>;
    const isAdmin = ['support', 'admin', 'superadmin'].includes(auth.session.role);
    if (raw.uid !== auth.session.uid && !isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    orderData = { id: snap.id, ...raw };
  }

  const amountDisplay =
    typeof orderData.amountFormatted === 'string'
      ? orderData.amountFormatted
      : typeof orderData.amountCents === 'number'
        ? `$${(orderData.amountCents / 100).toFixed(2)}`
        : '$0.00';

  const doc = buildInvoicePdfDocument({
    orderId: String(orderData.id),
    customerName: auth.session.name,
    customerEmail: String(orderData.email ?? auth.session.email),
    planLabel: String(orderData.planName ?? orderData.planId ?? 'Clipper Studio Plan'),
    statusLabel: String(orderData.status ?? 'paid'),
    amountDisplay,
    issuedDate: String(orderData.createdAtIso ?? new Date().toISOString()).slice(0, 10),
  });

  const buffer = await renderToBuffer(doc);
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="clipper-invoice-${orderId.replace(/[^a-zA-Z0-9_-]/g, '')}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
