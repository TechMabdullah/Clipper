import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { getAllFeatureFlags } from '@/lib/flags';
import { requirePermission } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requirePermission('flags:read', true);
  if (auth.errorResponse) return auth.errorResponse;
  const flags = await getAllFeatureFlags();
  return NextResponse.json({ flags });
}

const FlagUpsertSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,64}$/, 'Use lowercase letters, numbers, and underscores'),
  description: z.string().max(240).default(''),
  enabled: z.boolean(),
  rolloutPct: z.number().int().min(0).max(100),
  targetRoles: z.array(z.enum(['customer', 'support', 'admin', 'superadmin'])).default(['customer', 'support', 'admin', 'superadmin']),
  reason: z.string().min(3).max(300),
});

export async function POST(req: Request) {
  const auth = await requirePermission('flags:write', true);
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ error: 'Firebase Admin SDK not configured.' }, { status: 503 });
  }

  let body: z.infer<typeof FlagUpsertSchema>;
  try {
    body = FlagUpsertSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid feature flag payload' },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const ref = db.collection('feature_flags').doc(body.key);
  const existing = (await ref.get()).data();
  const nextDoc = {
    key: body.key,
    description: body.description,
    enabled: body.enabled,
    rolloutPct: body.rolloutPct,
    targetRoles: body.targetRoles,
    updatedAt: Date.now(),
    updatedBy: auth.session.email,
  };
  await ref.set(nextDoc, { merge: true });

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'admin.flag.updated',
    target: `flag:${body.key}`,
    before: existing ?? null,
    after: nextDoc,
    reason: body.reason,
    ip: extractClientIp(req),
    userAgent: req.headers.get('user-agent') ?? '',
  });

  return NextResponse.json({ ok: true, flag: nextDoc });
}
