import type { AppSession } from './session';

if (typeof window !== 'undefined') {
  throw new Error('bridge.ts is server-only.');
}

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'content-length',
  // Prevent external header spoofing from passing through unauthenticated
  'x-clipper-bridge-secret',
  'x-clipper-actor-uid',
  'x-clipper-actor-email',
  'x-clipper-actor-role',
  'x-admin-token',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
]);

export function getClipperServiceBaseUrl(): string {
  return (process.env.CLIPPER_SERVICE_URL || 'http://127.0.0.1:4001').replace(/\/+$/, '');
}

/**
 * Validates relative path segments against directory traversal or SSRF host injection.
 */
export function buildSafeBridgeTargetUrl(pathSegments: string[], search: string): string {
  const cleaned = pathSegments
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);

  for (const seg of cleaned) {
    if (seg === '.' || seg === '..' || seg.includes('\\') || seg.includes('://')) {
      throw new Error(`Unsafe bridge path segment: ${seg}`);
    }
  }

  const base = getClipperServiceBaseUrl();
  const joined = cleaned.map((s) => encodeURIComponent(s)).join('/');
  return `${base}/api/${joined}${search}`;
}

export async function forwardToClipperService(
  req: Request,
  pathSegments: string[],
  session: AppSession | null,
): Promise<Response> {
  const incomingUrl = new URL(req.url);
  const targetUrl = buildSafeBridgeTargetUrl(pathSegments, incomingUrl.search);

  const forwardHeaders = new Headers();
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_REQUEST_HEADERS.has(lower)) {
      forwardHeaders.set(key, value);
    }
  });

  const bridgeSecret = (process.env.INTERNAL_BRIDGE_SECRET ?? '').trim();
  if (bridgeSecret.length >= 32) {
    forwardHeaders.set('x-clipper-bridge-secret', bridgeSecret);
  }
  if (session) {
    forwardHeaders.set('x-clipper-actor-uid', session.uid);
    forwardHeaders.set('x-clipper-actor-email', session.email);
    forwardHeaders.set('x-clipper-actor-role', session.role);
  }

  // Forward optional local API key if configured so API_KEY gated endpoints also work seamlessly
  const configuredApiKey = (process.env.CLIPPER_API_KEY ?? '').trim();
  if (configuredApiKey && !forwardHeaders.has('x-api-key')) {
    forwardHeaders.set('x-api-key', configuredApiKey);
  }

  const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase());

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error Node 22 fetch requires duplex: 'half' when forwarding ReadableStream bodies
      duplex: hasBody ? 'half' : undefined,
      cache: 'no-store',
    });
  } catch (err) {
    return Response.json(
      {
        error: 'Clipper media engine (clipper-service :4001) is offline or unreachable.',
        detail: err instanceof Error ? err.message : String(err),
        bridgeTarget: targetUrl,
      },
      { status: 503 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) {
      responseHeaders.set(key, value);
    }
  });

  const contentType = upstream.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    responseHeaders.set('Cache-Control', 'no-cache, no-transform');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
