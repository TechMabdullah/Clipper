import { createChunkedCsvStream } from '@/lib/csv';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const resource = (url.searchParams.get('resource') ?? 'audit_logs').toLowerCase();

  const permMap: Record<string, 'audit:read' | 'users:read' | 'orders:read' | 'support:read'> = {
    audit_logs: 'audit:read',
    users: 'users:read',
    orders: 'orders:read',
    support_tickets: 'support:read',
  };
  const needed = permMap[resource];
  if (!needed) {
    return Response.json({ error: 'Unsupported export resource.' }, { status: 400 });
  }

  const auth = await requirePermission(needed, true);
  if (auth.errorResponse) return auth.errorResponse;

  let rows: Array<Record<string, unknown>> = [];
  if (isFirebaseAdminConfigured()) {
    const snap = await getAdminDb().collection(resource).limit(2000).get();
    rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'admin.export.csv',
    target: `collection:${resource}`,
    after: { rowCount: rows.length },
    ip: extractClientIp(req),
    userAgent: req.headers.get('user-agent') ?? '',
  });

  const columnsMap: Record<string, string[]> = {
    audit_logs: ['id', 'createdAtIso', 'actorEmail', 'actorRole', 'action', 'target', 'reason', 'ip'],
    users: ['id', 'email', 'name', 'role', 'plan', 'disabled', 'createdAt'],
    orders: ['id', 'uid', 'email', 'planName', 'amountFormatted', 'status', 'createdAtIso'],
    support_tickets: ['id', 'email', 'subject', 'category', 'priority', 'status', 'createdAt'],
  };

  const stream = createChunkedCsvStream(rows, columnsMap[resource]);
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="clipper-${resource}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
