import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminAuth, getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requirePermission } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await requirePermission('users:read', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ users: [], total: 0 });
  }

  const url = new URL(req.url);
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const roleFilter = (url.searchParams.get('role') ?? '').trim().toLowerCase();

  try {
    const snap = await getAdminDb().collection('users').limit(500).get();
    let users = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Array<Record<string, unknown>>;

    if (query) {
      users = users.filter((u) => {
        const hay = `${u.email ?? ''} ${u.name ?? ''} ${u.uid ?? ''} ${u.creatorHandle ?? ''}`.toLowerCase();
        return hay.includes(query);
      });
    }
    if (roleFilter && roleFilter !== 'all') {
      users = users.filter((u) => String(u.role ?? 'customer') === roleFilter);
    }

    users.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
    return NextResponse.json({ users, total: users.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list users.' },
      { status: 500 },
    );
  }
}

const PatchUserSchema = z.object({
  uid: z.string().min(1),
  disabled: z.boolean().optional(),
  revokeSessions: z.boolean().optional(),
  plan: z.enum(['free', 'pro', 'studio']).optional(),
  name: z.string().max(120).optional(),
  reason: z.string().min(3).max(300),
});

export async function PATCH(req: Request) {
  const auth = await requirePermission('users:write', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ error: 'Firebase Admin SDK not configured.' }, { status: 503 });
  }

  let body: z.infer<typeof PatchUserSchema>;
  try {
    body = PatchUserSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid user update payload' },
      { status: 400 },
    );
  }

  if (body.uid === auth.session.uid && body.disabled) {
    return NextResponse.json({ error: 'Administrators cannot disable their own account.' }, { status: 400 });
  }

  const db = getAdminDb();
  const userRef = db.collection('users').doc(body.uid);
  const snap = await userRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }
  const before = snap.data();

  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (body.disabled !== undefined) patch.disabled = body.disabled;
  if (body.plan !== undefined) patch.plan = body.plan;
  if (body.name !== undefined) patch.name = body.name.trim();

  if (body.disabled || body.revokeSessions) {
    patch.revokedAllBefore = Date.now();
    await getAdminAuth().revokeRefreshTokens(body.uid);
    const sessionsSnap = await db.collection('user_sessions').where('uid', '==', body.uid).get();
    const batch = db.batch();
    sessionsSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  if (body.disabled !== undefined) {
    await getAdminAuth().updateUser(body.uid, { disabled: body.disabled });
  }
  await userRef.set(patch, { merge: true });

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: body.disabled !== undefined ? 'admin.user.status_changed' : 'admin.user.updated',
    target: `user:${body.uid}`,
    before,
    after: { ...before, ...patch },
    reason: body.reason,
    ip: extractClientIp(req),
    userAgent: req.headers.get('user-agent') ?? '',
  });

  return NextResponse.json({ ok: true, uid: body.uid, patch });
}
