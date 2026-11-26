import { NextResponse } from 'next/server';
import { getClipperServiceBaseUrl } from '@/lib/bridge';

export const dynamic = 'force-dynamic';

/**
 * Public unauthenticated proxy strictly scoped to shared clip tokens on clipper-service.
 */
export async function GET(req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(token)) {
    return NextResponse.json({ error: 'Invalid share token.' }, { status: 400 });
  }

  const url = new URL(req.url);
  const sub = url.searchParams.get('stream') === '1' ? 'stream' : '';
  const target = `${getClipperServiceBaseUrl()}/api/share/${encodeURIComponent(token)}${sub ? '/stream' : ''}${url.search}`;

  const forwardHeaders = new Headers();
  const range = req.headers.get('range');
  if (range) forwardHeaders.set('range', range);

  try {
    const res = await fetch(target, { headers: forwardHeaders, cache: 'no-store' });
    const headers = new Headers();
    const ct = res.headers.get('content-type');
    const cr = res.headers.get('content-range');
    const ar = res.headers.get('accept-ranges');
    const cl = res.headers.get('content-length');
    if (ct) headers.set('content-type', ct);
    if (cr) headers.set('content-range', cr);
    if (ar) headers.set('accept-ranges', ar);
    if (cl) headers.set('content-length', cl);

    return new NextResponse(res.body, { status: res.status, headers });
  } catch {
    return NextResponse.json({ error: 'Clipper share service unavailable.' }, { status: 503 });
  }
}

export async function POST(req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(token)) {
    return NextResponse.json({ error: 'Invalid share token.' }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  try {
    const res = await fetch(`${getClipperServiceBaseUrl()}/api/share/${encodeURIComponent(token)}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Clipper share service unavailable.' }, { status: 503 });
  }
}
