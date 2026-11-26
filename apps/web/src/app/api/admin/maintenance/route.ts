import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { getMaintenanceState } from '@/lib/flags';
import { requirePermission } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requirePermission('admin:access', true);
  if (auth.errorResponse) return auth.errorResponse;
  return NextResponse.json(await getMaintenanceState());
}

const MaintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().max(300).default(''),
  reason: z.string().min(3).max(300),
});

export async function POST(req: Request) {
  const auth = await requirePermission('system:maintain', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ error: 'Firebase Admin SDK not configured.' }, { status: 503 });
  }

  let body: z.infer<typeof MaintenanceSchema>;
  try {
    body = MaintenanceSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid maintenance payload' },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const before = await getMaintenanceState();
  const after = {
    enabled: body.enabled,
    message: body.message.trim(),
    updatedAt: Date.now(),
    updatedBy: auth.session.email,
  };
  await db.collection('settings').doc('maintenance').set(after, { merge: true });

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'admin.maintenance.updated',
    target: 'settings:maintenance',
    before,
    after,
    reason: body.reason,
    ip: extractClientIp(req),
    userAgent: req.headers.get('user-agent') ?? '',
  });

  return NextResponse.json({ ok: true, maintenance: after });
}
