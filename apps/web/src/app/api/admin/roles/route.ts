import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminAuth, getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { ROLE_PERMISSION_MAP } from '@/lib/permissions';
import { requirePermission } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requirePermission('admin:access', true);
  if (auth.errorResponse) return auth.errorResponse;
  return NextResponse.json({
    roles: ROLE_PERMISSION_MAP,
    canEditRoles: auth.session.role === 'superadmin',
  });
}

const RoleChangeSchema = z.object({
  uid: z.string().min(1),
  role: z.enum(['customer', 'support', 'admin', 'superadmin']),
  reason: z.string().min(3).max(300),
});

export async function PATCH(req: Request) {
  const auth = await requirePermission('roles:write', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ error: 'Firebase Admin SDK not configured.' }, { status: 503 });
  }

  let body: z.infer<typeof RoleChangeSchema>;
  try {
    body = RoleChangeSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid role update request' },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const userRef = db.collection('users').doc(body.uid);
  const snap = await userRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Target user not found.' }, { status: 404 });
  }
  const prevRole = String(snap.data()?.role ?? 'customer');

  if (prevRole === 'superadmin' && body.role !== 'superadmin') {
    const superSnap = await db.collection('users').where('role', '==', 'superadmin').get();
    if (superSnap.size <= 1) {
      return NextResponse.json(
        { error: 'Cannot demote the last remaining superadmin.' },
        { status: 400 },
      );
    }
  }

  const adminAuth = getAdminAuth();
  await adminAuth.setCustomUserClaims(body.uid, { role: body.role });
  await adminAuth.revokeRefreshTokens(body.uid);

  const now = Date.now();
  await userRef.set({ role: body.role, revokedAllBefore: now, updatedAt: now }, { merge: true });

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'admin.role.updated',
    target: `user:${body.uid}`,
    before: { role: prevRole },
    after: { role: body.role },
    reason: body.reason,
    ip: extractClientIp(req),
    userAgent: req.headers.get('user-agent') ?? '',
  });

  return NextResponse.json({ ok: true, uid: body.uid, previousRole: prevRole, role: body.role });
}
