import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requirePermission } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requirePermission('admin:access', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ announcements: [], faqs: [] });
  }

  const db = getAdminDb();
  const [annSnap, faqSnap] = await Promise.all([
    db.collection('announcements').limit(50).get(),
    db.collection('faq_items').limit(50).get(),
  ]);

  return NextResponse.json({
    announcements: annSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    faqs: faqSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
  });
}

const ContentMutateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('announcement'),
    id: z.string().optional(),
    title: z.string().min(2).max(160),
    body: z.string().min(2).max(500),
    tone: z.enum(['info', 'promo', 'warning']).default('info'),
    active: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('faq'),
    id: z.string().optional(),
    question: z.string().min(3).max(200),
    answer: z.string().min(3).max(2000),
    category: z.string().max(60).default('General'),
    order: z.number().int().min(0).max(999).default(1),
  }),
  z.object({
    kind: z.literal('delete'),
    collection: z.enum(['announcements', 'faq_items']),
    id: z.string().min(1),
  }),
]);

export async function POST(req: Request) {
  const auth = await requirePermission('content:write', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ error: 'Firebase Admin SDK not configured.' }, { status: 503 });
  }

  let body: z.infer<typeof ContentMutateSchema>;
  try {
    body = ContentMutateSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid content payload' },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const now = Date.now();
  const ip = extractClientIp(req);

  if (body.kind === 'delete') {
    await db.collection(body.collection).doc(body.id).delete();
    await writeAuditLog({
      actorUid: auth.session.uid,
      actorEmail: auth.session.email,
      actorRole: auth.session.role,
      action: 'admin.content.deleted',
      target: `${body.collection}:${body.id}`,
      ip,
      userAgent: req.headers.get('user-agent') ?? '',
    });
    return NextResponse.json({ ok: true });
  }

  if (body.kind === 'announcement') {
    const ref = body.id ? db.collection('announcements').doc(body.id) : db.collection('announcements').doc();
    const docData = {
      id: ref.id,
      title: body.title,
      body: body.body,
      tone: body.tone,
      active: body.active,
      updatedAt: now,
      updatedBy: auth.session.email,
    };
    await ref.set(docData, { merge: true });
    await writeAuditLog({
      actorUid: auth.session.uid,
      actorEmail: auth.session.email,
      actorRole: auth.session.role,
      action: 'admin.announcement.saved',
      target: `announcement:${ref.id}`,
      after: docData,
      ip,
      userAgent: req.headers.get('user-agent') ?? '',
    });
    return NextResponse.json({ ok: true, item: docData });
  }

  const ref = body.id ? db.collection('faq_items').doc(body.id) : db.collection('faq_items').doc();
  const docData = {
    id: ref.id,
    question: body.question,
    answer: body.answer,
    category: body.category,
    order: body.order,
    updatedAt: now,
    updatedBy: auth.session.email,
  };
  await ref.set(docData, { merge: true });
  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'admin.faq.saved',
    target: `faq:${ref.id}`,
    after: docData,
    ip,
    userAgent: req.headers.get('user-agent') ?? '',
  });
  return NextResponse.json({ ok: true, item: docData });
}
