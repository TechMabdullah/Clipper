import crypto from 'node:crypto';
import {
  getEnabledOutboundWebhooksForEvent,
  getOutboundWebhookDispatchTarget,
  recordOutboundWebhookResult,
  type OutboundWebhookDispatchTarget,
} from '../db.js';
import { assertSafeRemoteUrl } from '../studio.js';

export type OutboundWebhookEvent =
  | 'clip.ready'
  | 'live.explosion'
  | 'job.completed'
  | 'webhook.test';

export interface WebhookDispatchResult {
  ok: boolean;
  status: number | null;
  error: string;
}

export interface WebhookDispatchTargetLike {
  id: string;
  url: string;
  secret?: string;
}

const WEBHOOK_TIMEOUT_MS = 8000;

/**
 * Signs and delivers a single outbound webhook event over HTTPS after SSRF/DNS validation,
 * recording delivery status and error details back into SQLite.
 */
export async function dispatchOutboundWebhookSingle(
  webhook: OutboundWebhookDispatchTarget | WebhookDispatchTargetLike,
  eventType: OutboundWebhookEvent | string,
  payload: unknown,
): Promise<WebhookDispatchResult> {
  const secret = webhook.secret || getOutboundWebhookDispatchTarget(webhook.id)?.secret || '';
  if (!secret) {
    const errMsg = 'Webhook signing secret is missing';
    recordOutboundWebhookResult(webhook.id, null, errMsg);
    return { ok: false, status: null, error: errMsg };
  }

  let safeUrl: URL;
  try {
    safeUrl = await assertSafeRemoteUrl(webhook.url, { requireHttps: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    recordOutboundWebhookResult(webhook.id, null, errMsg);
    return { ok: false, status: null, error: errMsg };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: eventType,
    timestamp,
    data: payload ?? {},
  });

  const signatureHex = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');

  try {
    const res = await fetch(safeUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Clipper-Event': String(eventType),
        'X-Clipper-Timestamp': String(timestamp),
        'X-Clipper-Signature-256': `sha256=${signatureHex}`,
        'User-Agent': 'Clipper-Studio-Webhooks/1.0',
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      recordOutboundWebhookResult(webhook.id, res.status, '');
      return { ok: true, status: res.status, error: '' };
    }

    let detail = '';
    try {
      detail = (await res.text()).trim().slice(0, 200);
    } catch {}
    const errMsg = detail
      ? `HTTP ${res.status}: ${detail}`
      : `HTTP ${res.status} ${res.statusText}`.trim();
    recordOutboundWebhookResult(webhook.id, res.status, errMsg);
    return { ok: false, status: res.status, error: errMsg };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    recordOutboundWebhookResult(webhook.id, null, errMsg);
    return { ok: false, status: null, error: errMsg };
  }
}

/**
 * Best-effort parallel dispatch to all enabled outbound webhooks subscribed to `eventType`.
 * Never throws to callers.
 */
export async function dispatchOutboundWebhooks(
  eventType: OutboundWebhookEvent | string,
  payload: unknown,
): Promise<void> {
  try {
    const hooks = getEnabledOutboundWebhooksForEvent(eventType);
    if (hooks.length === 0) return;
    await Promise.allSettled(
      hooks.map((hook) => dispatchOutboundWebhookSingle(hook, eventType, payload)),
    );
  } catch (err) {
    console.warn(`[webhooks] Dispatch error for event ${eventType}:`, err);
  }
}
