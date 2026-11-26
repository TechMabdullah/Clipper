import { NextResponse } from 'next/server';
import { isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { isFirebaseClientConfigured } from '@/lib/firebase';
import { getClipperServiceBaseUrl } from '@/lib/bridge';

export const dynamic = 'force-dynamic';

export async function GET() {
  let bridgeReachable = false;
  let bridgeStatus: number | null = null;
  try {
    const res = await fetch(`${getClipperServiceBaseUrl()}/api/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    bridgeReachable = res.ok;
    bridgeStatus = res.status;
  } catch {
    bridgeReachable = false;
  }

  return NextResponse.json({
    ok: true,
    service: '@clipper/web',
    timestamp: new Date().toISOString(),
    firebaseClientConfigured: isFirebaseClientConfigured(),
    firebaseAdminConfigured: isFirebaseAdminConfigured(),
    resendConfigured: Boolean((process.env.RESEND_API_KEY ?? '').trim()),
    upstashConfigured: Boolean(
      (process.env.UPSTASH_REDIS_REST_URL ?? '').trim() &&
        (process.env.UPSTASH_REDIS_REST_TOKEN ?? '').trim(),
    ),
    clipperBridge: {
      url: getClipperServiceBaseUrl(),
      reachable: bridgeReachable,
      status: bridgeStatus,
    },
  });
}
