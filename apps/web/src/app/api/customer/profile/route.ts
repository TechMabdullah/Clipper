import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminAuth, getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { requireSession } from '@/lib/session';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireSession();
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ profile: auth.session, preferences: {} });
  }

  try {
    const db = getAdminDb();
    const [userSnap, fbUser] = await Promise.all([
      db.collection('users').doc(auth.session.uid).get(),
      getAdminAuth().getUser(auth.session.uid),
    ]);
    return NextResponse.json({
      profile: {
        uid: auth.session.uid,
        email: auth.session.email,
        name: auth.session.name,
        picture: userSnap.data()?.picture || auth.session.picture,
        bio: userSnap.data()?.bio || '',
        creatorHandle: userSnap.data()?.creatorHandle || '',
        timezone: userSnap.data()?.timezone || 'UTC',
        role: auth.session.role,
        providers: fbUser.providerData.map((p) => p.providerId),
        preferences: userSnap.data()?.preferences ?? {
          emailAlerts: true,
          clipReadyAlerts: true,
          marketingUpdates: false,
          reducedMotion: false,
        },
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unable to fetch profile.' },
      { status: 500 },
    );
  }
}

const ProfilePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  bio: z.string().max(400).optional(),
  creatorHandle: z.string().max(64).optional(),
  timezone: z.string().max(64).optional(),
  picture: z.string().max(500_000).optional(),
  preferences: z
    .object({
      emailAlerts: z.boolean().optional(),
      clipReadyAlerts: z.boolean().optional(),
      marketingUpdates: z.boolean().optional(),
      reducedMotion: z.boolean().optional(),
    })
    .optional(),
});

export async function PATCH(req: Request) {
  const auth = await requireSession();
  if (auth.errorResponse) return auth.errorResponse;
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json({ error: 'Firebase Admin SDK not configured.' }, { status: 503 });
  }

  let body: z.infer<typeof ProfilePatchSchema>;
  try {
    body = ProfilePatchSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid profile payload' },
      { status: 400 },
    );
  }

  const now = Date.now();
  const updatePayload: Record<string, unknown> = { updatedAt: now };
  if (body.name !== undefined) updatePayload.name = body.name.trim();
  if (body.bio !== undefined) updatePayload.bio = body.bio.trim();
  if (body.creatorHandle !== undefined) updatePayload.creatorHandle = body.creatorHandle.trim();
  if (body.timezone !== undefined) updatePayload.timezone = body.timezone.trim();
  if (body.picture !== undefined) updatePayload.picture = body.picture;
  if (body.preferences !== undefined) updatePayload.preferences = body.preferences;

  await getAdminDb().collection('users').doc(auth.session.uid).set(updatePayload, { merge: true });
  if (body.name) {
    await getAdminAuth().updateUser(auth.session.uid, { displayName: body.name.trim() });
  }

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'customer.profile.updated',
    target: `user:${auth.session.uid}`,
    after: { fields: Object.keys(updatePayload) },
    ip: extractClientIp(req),
    userAgent: req.headers.get('user-agent') ?? '',
  });

  return NextResponse.json({ ok: true, updated: updatePayload });
}
