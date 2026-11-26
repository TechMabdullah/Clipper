import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requirePermission } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await requirePermission('support:read', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ tickets: [] });
  }

  const url = new URL(req.url);
  const statusFilter = (url.searchParams.get('status') ?? '').trim().toLowerCase();

  try {
    const snap = await getAdminDb().collection('support_tickets').limit(200).get();
    let tickets = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Array<Record<string, unknown>>;
    if (statusFilter && statusFilter !== 'all') {
      tickets = tickets.filter((t) => String(t.status ?? '') === statusFilter);
    }
    tickets.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
    return NextResponse.json({ tickets });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list tickets.' },
      { status: 500 },
    );
  }
}

const AdminSupportPatchSchema = z.object({
  ticketId: z.string().min(1),
  status: z.enum(['open', 'in_progress', 'waiting_customer', 'resolved', 'closed']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  replyMessage: z.string().max(4000).optional(),
  mergeIntoTicketId: z.string().optional(),
  reason: z.string().min(2).max(300).optional(),
});

export async function PATCH(req: Request) {
  const auth = await requirePermission('support:write', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ error: 'Firebase Admin SDK not configured.' }, { status: 503 });
  }

  let body: z.infer<typeof AdminSupportPatchSchema>;
  try {
    body = AdminSupportPatchSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid support update payload' },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const ref = db.collection('support_tickets').doc(body.ticketId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 });
  }
  const before = snap.data() as Record<string, unknown>;
  const now = Date.now();
  const existingMsgs = Array.isArray(before.messages) ? [...before.messages] : [];

  if (body.replyMessage?.trim()) {
    existingMsgs.push({
      id: `msg_${now}`,
      senderUid: auth.session.uid,
      senderName: auth.session.name,
      senderRole: auth.session.role,
      body: body.replyMessage.trim(),
      createdAt: now,
    });
  }

  const updateData: Record<string, unknown> = {
    updatedAt: now,
    messages: existingMsgs,
    assignedToUid: auth.session.uid,
    assignedToName: auth.session.name,
  };
  if (body.status) updateData.status = body.status;
  if (body.priority) updateData.priority = body.priority;
  if (body.mergeIntoTicketId) {
    updateData.mergedInto = body.mergeIntoTicketId;
    updateData.status = 'closed';
  }

  await ref.set(updateData, { merge: true });

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'admin.support.updated',
    target: `ticket:${body.ticketId}`,
    before: { status: before.status, priority: before.priority },
    after: { status: updateData.status ?? before.status, priority: updateData.priority ?? before.priority },
    reason: body.reason ?? 'Support agent action',
    ip: extractClientIp(req),
    userAgent: req.headers.get('user-agent') ?? '',
  });

  return NextResponse.json({ ok: true, ticketId: body.ticketId, updated: updateData });
}
