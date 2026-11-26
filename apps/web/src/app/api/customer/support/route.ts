import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requirePermission } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requirePermission('clipper:use');
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ tickets: [] });
  }

  try {
    const snap = await getAdminDb()
      .collection('support_tickets')
      .where('uid', '==', auth.session.uid)
      .limit(50)
      .get();

    const tickets = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
        Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0),
      );
    return NextResponse.json({ tickets });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load support tickets.' },
      { status: 500 },
    );
  }
}

const CreateTicketSchema = z.object({
  subject: z.string().min(3).max(160),
  category: z.enum(['billing', 'clipper', 'account', 'bug', 'feature']).default('clipper'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  message: z.string().min(5).max(4000),
  attachmentNames: z.array(z.string().max(160)).max(5).optional(),
});

const ReplyTicketSchema = z.object({
  ticketId: z.string().min(2),
  message: z.string().min(1).max(4000),
  attachmentNames: z.array(z.string().max(160)).max(5).optional(),
});

export async function POST(req: Request) {
  const auth = await requirePermission('clipper:use');
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ error: 'Firebase Admin SDK not configured.' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 });
  }

  const db = getAdminDb();
  const now = Date.now();
  const ip = extractClientIp(req);

  if (typeof (body as Record<string, unknown>)?.ticketId === 'string') {
    let parsed: z.infer<typeof ReplyTicketSchema>;
    try {
      parsed = ReplyTicketSchema.parse(body);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid reply payload' },
        { status: 400 },
      );
    }

    const ticketRef = db.collection('support_tickets').doc(parsed.ticketId);
    const snap = await ticketRef.get();
    if (!snap.exists || snap.data()?.uid !== auth.session.uid) {
      return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 });
    }
    const existingMessages = Array.isArray(snap.data()?.messages) ? snap.data()?.messages : [];
    const nextMsg = {
      id: `msg_${now}`,
      senderUid: auth.session.uid,
      senderName: auth.session.name,
      senderRole: auth.session.role,
      body: parsed.message,
      attachments: parsed.attachmentNames ?? [],
      createdAt: now,
    };

    await ticketRef.set(
      {
        status: snap.data()?.status === 'resolved' ? 'open' : snap.data()?.status || 'open',
        messages: [...existingMessages, nextMsg],
        updatedAt: now,
      },
      { merge: true },
    );

    return NextResponse.json({ ok: true, message: nextMsg });
  }

  let parsed: z.infer<typeof CreateTicketSchema>;
  try {
    parsed = CreateTicketSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid ticket payload' },
      { status: 400 },
    );
  }

  const ticketRef = db.collection('support_tickets').doc();
  const slaHours = parsed.priority === 'urgent' ? 4 : parsed.priority === 'high' ? 12 : 24;
  const ticketDoc = {
    id: ticketRef.id,
    uid: auth.session.uid,
    email: auth.session.email,
    userName: auth.session.name,
    subject: parsed.subject,
    category: parsed.category,
    priority: parsed.priority,
    status: 'open',
    slaDueAt: now + slaHours * 3600 * 1000,
    messages: [
      {
        id: `msg_${now}`,
        senderUid: auth.session.uid,
        senderName: auth.session.name,
        senderRole: auth.session.role,
        body: parsed.message,
        attachments: parsed.attachmentNames ?? [],
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await ticketRef.set(ticketDoc);

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'support.ticket.created',
    target: `ticket:${ticketRef.id}`,
    after: { subject: parsed.subject, category: parsed.category, priority: parsed.priority },
    ip,
    userAgent: req.headers.get('user-agent') ?? '',
  });

  return NextResponse.json({ ok: true, ticket: ticketDoc }, { status: 201 });
}
