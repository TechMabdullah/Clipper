import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminAuth, getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { issueAndSendOtp } from '@/lib/otp';
import { extractClientIp, rateLimitCheck } from '@/lib/ratelimit';
import { writeAuditLog } from '@/lib/audit';

const SendOtpSchema = z.object({
  idToken: z.string().min(20),
  purpose: z.enum(['login', 'signup', 'sensitive_action']).default('login'),
  name: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  if (!isFirebaseAdminConfigured()) {
    return NextResponse.json(
      { error: 'Firebase Admin SDK is not configured on the server yet.' },
      { status: 503 },
    );
  }

  const ip = extractClientIp(req);
  const ipLimit = await rateLimitCheck('otp_send_ip', ip, 15, 600);
  if (!ipLimit.success) {
    return NextResponse.json(
      { error: 'Too many OTP requests from your network. Please wait before trying again.' },
      { status: 429 },
    );
  }

  let body: z.infer<typeof SendOtpSchema>;
  try {
    body = SendOtpSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request payload' },
      { status: 400 },
    );
  }

  try {
    const adminAuth = getAdminAuth();
    const decoded = await adminAuth.verifyIdToken(body.idToken, true);
    if (!decoded.email) {
      return NextResponse.json(
        { error: 'Authenticated Firebase user has no email address for OTP delivery.' },
        { status: 400 },
      );
    }

    const userLimit = await rateLimitCheck('otp_send_uid', decoded.uid, 5, 3600);
    if (!userLimit.success) {
      return NextResponse.json(
        { error: 'Hourly OTP send limit (5/hr) reached for this account.' },
        { status: 429 },
      );
    }

    const userSnap = await getAdminDb().collection('users').doc(decoded.uid).get();
    if (userSnap.exists && userSnap.data()?.disabled === true) {
      return NextResponse.json({ error: 'Account has been disabled by an administrator.' }, { status: 403 });
    }

    const result = await issueAndSendOtp({
      uid: decoded.uid,
      email: decoded.email,
      name: body.name || decoded.name || decoded.email.split('@')[0],
      purpose: body.purpose,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, retryAfterSec: result.retryAfterSec },
        { status: 429 },
      );
    }

    await writeAuditLog({
      actorUid: decoded.uid,
      actorEmail: decoded.email,
      actorRole: String(decoded.role ?? 'customer'),
      action: 'auth.otp.sent',
      target: `user:${decoded.uid}`,
      after: { purpose: body.purpose, delivery: result.delivery },
      ip,
      userAgent: req.headers.get('user-agent') ?? '',
    });

    return NextResponse.json({
      ok: true,
      email: decoded.email,
      expiresAt: result.expiresAt,
      cooldownSec: 60,
      delivery: result.delivery,
      ...(result.devCode ? { devCode: result.devCode } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unable to send OTP verification code.' },
      { status: 400 },
    );
  }
}
