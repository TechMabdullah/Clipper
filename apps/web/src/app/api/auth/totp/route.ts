import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminDb } from '@/lib/firebase-admin';
import { isAdminSurfaceRole } from '@/lib/rbac';
import {
  createTotpVerifiedToken,
  requireSession,
  TOTP_COOKIE_NAME,
} from '@/lib/session';
import {
  buildTotpUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  getUserTotpStatus,
  verifyTotpCode,
} from '@/lib/totp';
import { writeAuditLog } from '@/lib/audit';
import { extractClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireSession();
  if (auth.errorResponse) return auth.errorResponse;
  if (!isAdminSurfaceRole(auth.session.role)) {
    return NextResponse.json({ error: 'Admin role required for TOTP.' }, { status: 403 });
  }
  const status = await getUserTotpStatus(auth.session.uid);
  return NextResponse.json({
    enabled: status.enabled,
    verifiedThisSession: auth.session.totpVerified,
  });
}

const TotpActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enroll_start') }),
  z.object({ action: z.literal('enroll_confirm'), code: z.string().regex(/^\d{6}$/) }),
  z.object({ action: z.literal('verify'), code: z.string().regex(/^\d{6}$/) }),
  z.object({ action: z.literal('disable'), code: z.string().regex(/^\d{6}$/) }),
]);

export async function POST(req: Request) {
  const auth = await requireSession();
  if (auth.errorResponse) return auth.errorResponse;
  if (!isAdminSurfaceRole(auth.session.role)) {
    return NextResponse.json({ error: 'Admin role required.' }, { status: 403 });
  }

  let body: z.infer<typeof TotpActionSchema>;
  try {
    body = TotpActionSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid TOTP request' },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const docRef = db.collection('admin_totp').doc(auth.session.uid);
  const ip = extractClientIp(req);

  if (body.action === 'enroll_start') {
    const secret = generateTotpSecret();
    const uri = buildTotpUri({ email: auth.session.email, secret });
    await docRef.set(
      {
        uid: auth.session.uid,
        pendingEncryptedSecret: encryptTotpSecret(secret),
        pendingCreatedAt: Date.now(),
      },
      { merge: true },
    );
    return NextResponse.json({ ok: true, secret, otpauthUri: uri });
  }

  if (body.action === 'enroll_confirm') {
    const snap = await docRef.get();
    const pendingEncrypted = snap.data()?.pendingEncryptedSecret as string | undefined;
    if (!pendingEncrypted) {
      return NextResponse.json({ error: 'Start TOTP enrollment first.' }, { status: 400 });
    }
    const secret = decryptTotpSecret(pendingEncrypted);
    if (!verifyTotpCode(secret, body.code)) {
      return NextResponse.json({ error: 'Invalid 6-digit authenticator code.' }, { status: 400 });
    }
    await docRef.set({
      uid: auth.session.uid,
      enabled: true,
      encryptedSecret: pendingEncrypted,
      pendingEncryptedSecret: null,
      enabledAt: Date.now(),
    });
    await writeAuditLog({
      actorUid: auth.session.uid,
      actorEmail: auth.session.email,
      actorRole: auth.session.role,
      action: 'admin.totp.enabled',
      target: `user:${auth.session.uid}`,
      ip,
      userAgent: req.headers.get('user-agent') ?? '',
    });
    const res = NextResponse.json({ ok: true, enabled: true, verified: true });
    res.cookies.set(TOTP_COOKIE_NAME, createTotpVerifiedToken(auth.session.uid), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 3600,
    });
    return res;
  }

  const status = await getUserTotpStatus(auth.session.uid);
  if (!status.enabled || !status.encryptedSecret) {
    return NextResponse.json({ error: 'TOTP 2FA is not enabled on your account.' }, { status: 400 });
  }
  const secret = decryptTotpSecret(status.encryptedSecret);
  if (!verifyTotpCode(secret, body.code)) {
    return NextResponse.json({ error: 'Invalid 6-digit authenticator code.' }, { status: 400 });
  }

  if (body.action === 'disable') {
    await docRef.set({ enabled: false, encryptedSecret: null, disabledAt: Date.now() }, { merge: true });
    await writeAuditLog({
      actorUid: auth.session.uid,
      actorEmail: auth.session.email,
      actorRole: auth.session.role,
      action: 'admin.totp.disabled',
      target: `user:${auth.session.uid}`,
      ip,
      userAgent: req.headers.get('user-agent') ?? '',
    });
    const res = NextResponse.json({ ok: true, enabled: false });
    res.cookies.set(TOTP_COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
    return res;
  }

  await writeAuditLog({
    actorUid: auth.session.uid,
    actorEmail: auth.session.email,
    actorRole: auth.session.role,
    action: 'admin.totp.verified',
    target: `user:${auth.session.uid}`,
    ip,
    userAgent: req.headers.get('user-agent') ?? '',
  });

  const res = NextResponse.json({ ok: true, verified: true });
  res.cookies.set(TOTP_COOKIE_NAME, createTotpVerifiedToken(auth.session.uid), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 12 * 3600,
  });
  return res;
}
