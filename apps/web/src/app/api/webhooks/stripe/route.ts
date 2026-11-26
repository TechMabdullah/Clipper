import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getClipperServiceBaseUrl } from '@/lib/bridge';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';

export const dynamic = 'force-dynamic';

/**
 * Verifies raw Stripe webhook signature (when configured), forwards raw payload to clipper-service :4001,
 * and records/updates SaaS order state inside Firestore `orders`.
 */
export async function POST(req: Request) {
  const rawBuf = await req.arrayBuffer();
  const rawText = Buffer.from(rawBuf).toString('utf8');
  const sig = req.headers.get('stripe-signature') || '';
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();

  // Verify signature inside Next.js if configured (and sync Firestore orders cleanly)
  let stripeEvent: Stripe.Event | null = null;
  if (webhookSecret) {
    if (!sig) {
      return NextResponse.json({ error: 'Missing stripe-signature header.' }, { status: 403 });
    }
    try {
      const stripe = new Stripe(
        (process.env.STRIPE_SECRET_KEY ?? '').trim() || 'sk_test_webhook_verify_only',
      );
      stripeEvent = stripe.webhooks.constructEvent(rawText, sig, webhookSecret, 300);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid Stripe webhook signature.' },
        { status: 403 },
      );
    }
  } else if (process.env.STRIPE_ALLOW_UNSIGNED_WEBHOOKS === 'true') {
    try {
      stripeEvent = JSON.parse(rawText) as Stripe.Event;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON webhook payload.' }, { status: 400 });
    }
  }

  // Sync paid / refunded order to Firestore `orders` collection when Admin SDK is configured
  if (stripeEvent && isFirebaseAdminConfigured()) {
    try {
      const obj = stripeEvent.data?.object as unknown as Record<string, any>;
      const now = Date.now();
      if (
        stripeEvent.type === 'checkout.session.completed' ||
        stripeEvent.type === 'invoice.paid'
      ) {
        const orderId = String(obj.id || stripeEvent.id);
        const uid = String(obj.client_reference_id || obj.metadata?.uid || '');
        const email = String(
          obj.customer_details?.email || obj.customer_email || obj.metadata?.customerEmail || '',
        ).toLowerCase();
        const planId = String(obj.metadata?.planId || 'pro');
        const amountCents = Number(obj.amount_total ?? obj.amount_paid ?? 0);
        await getAdminDb()
          .collection('orders')
          .doc(orderId)
          .set(
            {
              id: orderId,
              uid: uid || email || 'stripe-customer',
              email,
              planId,
              planName: `Clipper Studio ${planId.toUpperCase()}`,
              amountCents,
              amountFormatted: `$${(amountCents / 100).toFixed(2)}`,
              status: 'paid',
              stripeCustomerId: typeof obj.customer === 'string' ? obj.customer : '',
              stripeSubscriptionId: typeof obj.subscription === 'string' ? obj.subscription : '',
              createdAt: now,
              createdAtIso: new Date(now).toISOString(),
              updatedAt: now,
            },
            { merge: true },
          );
      } else if (stripeEvent.type === 'charge.refunded') {
        const refId = String(obj.payment_intent || obj.id || stripeEvent.id);
        await getAdminDb()
          .collection('orders')
          .doc(refId)
          .set({ status: 'refunded', refundedAt: now, updatedAt: now }, { merge: true });
      }
    } catch (err) {
      console.warn('[stripe-webhook] Firestore order sync warning:', err);
    }
  }

  // Always forward raw body untouched to local clipper-service entitlement DB
  const headers = new Headers();
  if (sig) headers.set('stripe-signature', sig);
  headers.set('content-type', req.headers.get('content-type') || 'application/json');

  try {
    const res = await fetch(`${getClipperServiceBaseUrl()}/api/webhooks/stripe`, {
      method: 'POST',
      headers,
      body: rawBuf,
      cache: 'no-store',
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
    });
  } catch (err) {
    if (stripeEvent) {
      return NextResponse.json({
        ok: true,
        eventType: stripeEvent.type,
        note: 'Processed on SaaS backend (local clipper-service :4001 offline).',
      });
    }
    return NextResponse.json(
      {
        error: 'Failed to forward Stripe webhook to clipper-service.',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
