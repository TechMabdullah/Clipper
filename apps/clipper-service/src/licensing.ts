import crypto from 'node:crypto';
import os from 'node:os';
import {
  Kelviq,
  validateEvent,
  WebhookVerificationError,
  type KelviqEnvironment,
} from '@kelviq/node-sdk';
import { db, getSetting, getDailyClipCount, verifyPassword } from './db.js';

export type PlanId = 'free' | 'pro' | 'ultra';
export type EntitlementFeature =
  | 'auto_captions'
  | 'audio_peak'
  | 'virality_ai'
  | 'watchlist'
  | 'custom_branding';

export interface PlanRecord {
  id: PlanId;
  name: string;
  tagline: string;
  price_usd: number;
  billing_period: string;
  daily_clip_limit: number;
  max_resolution: number;
  watermark_enabled: number;
  allow_auto_captions: number;
  allow_audio_peak: number;
  allow_virality_ai: number;
  allow_watchlist: number;
  allow_custom_branding: number;
  kelviq_payment_link: string;
  kelviq_plan_identifier: string;
  updated_at: string;
}

export interface ActiveLicenseRecord {
  id: string;
  license_key: string;
  instance_id: string;
  plan_id: PlanId;
  provider: 'free' | 'kelviq' | 'local';
  customer_email: string;
  customer_name: string;
  expires_on: string;
  last_validated_at: string;
  activated_at: string;
}

export class EntitlementError extends Error {
  public readonly statusCode = 402;
  public readonly code: 'DAILY_QUOTA_REACHED' | 'PLAN_UPGRADE_REQUIRED';
  public readonly requiredPlan: PlanId;
  public readonly currentPlan: PlanId;

  constructor(
    message: string,
    code: 'DAILY_QUOTA_REACHED' | 'PLAN_UPGRADE_REQUIRED',
    requiredPlan: PlanId,
    currentPlan: PlanId,
  ) {
    super(message);
    this.code = code;
    this.requiredPlan = requiredPlan;
    this.currentPlan = currentPlan;
  }
}

export function getKelviqClient(): Kelviq | null {
  const token = getSetting('kelviq_access_token') || process.env.KELVIQ_API_KEY || '';
  if (!token.trim()) return null;
  const envRaw = (getSetting('kelviq_environment') || process.env.KELVIQ_ENV || 'production').toLowerCase();
  const environment: KelviqEnvironment = envRaw === 'sandbox' ? 'sandbox' : 'production';
  return new Kelviq({
    accessToken: token.trim(),
    environment,
    timeout: 12_000,
    enableCache: true,
  });
}

export function planExists(planId: string): boolean {
  if (!planId || typeof planId !== 'string') return false;
  const row = db.prepare(`SELECT 1 AS found FROM plans WHERE id=?`).get(planId) as
    | { found: number }
    | undefined;
  return Boolean(row?.found);
}

export function listPlans(): PlanRecord[] {
  const rows = db.prepare(`SELECT * FROM plans ORDER BY price_usd ASC`).all() as unknown as PlanRecord[];
  return rows;
}

export function getPlanById(planId: string): PlanRecord {
  const row = db.prepare(`SELECT * FROM plans WHERE id=?`).get(planId) as PlanRecord | undefined;
  if (row) return row;
  return db.prepare(`SELECT * FROM plans WHERE id='free'`).get() as unknown as PlanRecord;
}

function parseFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : fallback;
  }
  return fallback;
}

export function updatePlanConfig(planId: string, patch: Partial<PlanRecord>): PlanRecord {
  if (!planExists(planId)) {
    throw new Error(`Invalid plan ID: ${planId}`);
  }
  const current = getPlanById(planId);
  db.prepare(`
    UPDATE plans SET
      name = ?,
      tagline = ?,
      price_usd = ?,
      billing_period = ?,
      daily_clip_limit = ?,
      max_resolution = ?,
      watermark_enabled = ?,
      allow_auto_captions = ?,
      allow_audio_peak = ?,
      allow_virality_ai = ?,
      allow_watchlist = ?,
      allow_custom_branding = ?,
      kelviq_payment_link = ?,
      kelviq_plan_identifier = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(
    patch.name ?? current.name,
    patch.tagline ?? current.tagline,
    parseFiniteNumber(patch.price_usd, current.price_usd),
    patch.billing_period ?? current.billing_period,
    Math.trunc(parseFiniteNumber(patch.daily_clip_limit, current.daily_clip_limit)),
    Math.trunc(parseFiniteNumber(patch.max_resolution, current.max_resolution)),
    patch.watermark_enabled !== undefined ? (patch.watermark_enabled ? 1 : 0) : current.watermark_enabled,
    patch.allow_auto_captions !== undefined ? (patch.allow_auto_captions ? 1 : 0) : current.allow_auto_captions,
    patch.allow_audio_peak !== undefined ? (patch.allow_audio_peak ? 1 : 0) : current.allow_audio_peak,
    patch.allow_virality_ai !== undefined ? (patch.allow_virality_ai ? 1 : 0) : current.allow_virality_ai,
    patch.allow_watchlist !== undefined ? (patch.allow_watchlist ? 1 : 0) : current.allow_watchlist,
    patch.allow_custom_branding !== undefined ? (patch.allow_custom_branding ? 1 : 0) : current.allow_custom_branding,
    patch.kelviq_payment_link ?? current.kelviq_payment_link,
    patch.kelviq_plan_identifier ?? current.kelviq_plan_identifier,
    current.id
  );
  return getPlanById(current.id);
}

export function getActiveLicenseRow(): ActiveLicenseRecord {
  const row = db.prepare(`SELECT * FROM active_license WHERE id='current'`).get() as ActiveLicenseRecord | undefined;
  if (row) return row;
  return {
    id: 'current',
    license_key: '',
    instance_id: '',
    plan_id: 'free',
    provider: 'free',
    customer_email: '',
    customer_name: '',
    expires_on: '',
    last_validated_at: '',
    activated_at: '',
  };
}

let bgValidationInFlight = false;

export function getActiveEntitlement() {
  let lic = getActiveLicenseRow();

  // Verify local VIP licenses against DB active flag & expiration immediately
  if (lic.provider === 'local') {
    const localRow = lic.license_key
      ? (db.prepare(`SELECT active, expires_on FROM local_licenses WHERE license_key=?`).get(lic.license_key) as
          | { active: number; expires_on: string }
          | undefined)
      : undefined;
    const localExpMs = localRow?.expires_on ? Date.parse(localRow.expires_on) : NaN;
    const localExpired = !Number.isNaN(localExpMs) && localExpMs < Date.now();
    if (!localRow || localRow.active !== 1 || localExpired) {
      resetToFreeLicense();
      lic = getActiveLicenseRow();
    }
  }

  // Check expiration locally; for Kelviq subscriptions with an API key configured, mark stale so
  // validateCurrentLicense() can confirm renewal or cancellation before revoking.
  const expMs = lic.expires_on ? Date.parse(lic.expires_on) : NaN;
  const isExpired = lic.plan_id !== 'free' && !Number.isNaN(expMs) && expMs < Date.now();
  if (isExpired && (lic.provider !== 'kelviq' || !getKelviqClient())) {
    resetToFreeLicense();
    lic = getActiveLicenseRow();
  }

  // Periodic background Kelviq validation (every 6h, or immediately if locally expired/invalid timestamp)
  if (lic.provider === 'kelviq' && lic.license_key && !bgValidationInFlight) {
    const parsedLast = lic.last_validated_at ? Date.parse(lic.last_validated_at) : 0;
    const lastMs = Number.isFinite(parsedLast) ? parsedLast : 0;
    if (isExpired || Date.now() - lastMs > 6 * 3600_000) {
      bgValidationInFlight = true;
      void validateCurrentLicense().finally(() => {
        bgValidationInFlight = false;
      });
    }
  }

  const plan = getPlanById(lic.plan_id);
  const usedToday = getDailyClipCount();
  const unlimited = plan.daily_clip_limit < 0;
  const remaining = unlimited ? -1 : Math.max(0, plan.daily_clip_limit - usedToday);

  return {
    plan,
    license: {
      ...lic,
      maskedKey: lic.license_key
        ? maskLicenseKeyValue(lic.license_key)
        : '',
    },
    usage: {
      usedToday,
      dailyLimit: plan.daily_clip_limit,
      remaining,
      unlimited,
    },
    kelviqConfigured: Boolean((getSetting('kelviq_access_token') || process.env.KELVIQ_API_KEY || '').trim()),
    portalUrl: getSetting('kelviq_portal_url') || process.env.KELVIQ_PORTAL_URL || '',
  };
}

export function maskLicenseKeyValue(rawKey: string): string {
  const k = rawKey.trim();
  if (!k) return '';
  if (k.startsWith('***') || k.includes('...')) return k;
  if (k.length <= 8) return '***';
  return `${k.slice(0, 8)}...${k.slice(-4)}`;
}

export function redactLicenseKeysInObject<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined) return node;
    if (typeof node !== 'object') return node;
    if (seen.has(node as object)) return '[Circular]';
    seen.add(node as object);

    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (/^license_?key$/i.test(k) && typeof v === 'string' && v.trim()) {
        out[k] = maskLicenseKeyValue(v);
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  };
  return walk(value) as T;
}

export function isUsingDefaultAdminPassword(): boolean {
  const storedHash = getSetting('admin_password_hash');
  if (!storedHash) return true;
  if (verifyPassword('admin123', storedHash)) return true;
  const envDefault = (process.env.ADMIN_PASSWORD ?? 'admin123').trim();
  if (envDefault === 'admin123' && verifyPassword(envDefault, storedHash)) return true;
  return false;
}

export function assertEntitlement(feature?: EntitlementFeature, willRenderClip = false) {
  const ent = getActiveEntitlement();
  const plan = ent.plan;

  if (willRenderClip && !ent.usage.unlimited && ent.usage.usedToday >= plan.daily_clip_limit) {
    throw new EntitlementError(
      `Daily limit of ${plan.daily_clip_limit} clips reached on ${plan.name}. Upgrade to Pro or Ultra via Kelviq for unlimited rendering.`,
      'DAILY_QUOTA_REACHED',
      'pro',
      plan.id
    );
  }

  if (feature === 'auto_captions' && !plan.allow_auto_captions) {
    throw new EntitlementError(
      'Auto Kinetic Captions require Pro or Ultra plan. Activate your Kelviq license key to unlock.',
      'PLAN_UPGRADE_REQUIRED',
      'pro',
      plan.id
    );
  }
  if (feature === 'audio_peak' && !plan.allow_audio_peak) {
    throw new EntitlementError(
      'Audio Peak Hype Scanner requires Pro or Ultra plan.',
      'PLAN_UPGRADE_REQUIRED',
      'pro',
      plan.id
    );
  }
  if (feature === 'virality_ai' && !plan.allow_virality_ai) {
    throw new EntitlementError(
      'AI Virality Scoring requires Pro or Ultra plan.',
      'PLAN_UPGRADE_REQUIRED',
      'pro',
      plan.id
    );
  }
  if (feature === 'watchlist' && !plan.allow_watchlist) {
    throw new EntitlementError(
      'Multi-Stream Watchlist Scheduler requires the Ultra plan.',
      'PLAN_UPGRADE_REQUIRED',
      'ultra',
      plan.id
    );
  }
  if (feature === 'custom_branding' && !plan.allow_custom_branding) {
    throw new EntitlementError(
      'Custom Channel Watermark Branding requires the Ultra plan.',
      'PLAN_UPGRADE_REQUIRED',
      'ultra',
      plan.id
    );
  }

  return ent;
}

function mapKelviqPlanIdentifier(identifier?: string | null, name?: string | null): PlanId {
  const idLower = String(identifier ?? '').trim().toLowerCase();
  const nameLower = String(name ?? '').trim().toLowerCase();
  const plans = listPlans();

  if (idLower) {
    const exact = plans.find(
      p => p.kelviq_plan_identifier && p.kelviq_plan_identifier.trim().toLowerCase() === idLower
    );
    if (exact) return exact.id;
  }

  if (idLower.includes('ultra') || nameLower.includes('ultra')) return 'ultra';
  if (idLower.includes('pro') || nameLower.includes('pro')) return 'pro';
  return 'free';
}

async function deactivatePreviousKelviqIfChanged(
  newKey: string,
  client?: Kelviq | null,
): Promise<void> {
  const current = getActiveLicenseRow();
  if (
    current.provider === 'kelviq' &&
    current.license_key &&
    current.license_key !== newKey &&
    current.instance_id
  ) {
    const kelviq = client ?? getKelviqClient();
    if (!kelviq) return;
    try {
      await kelviq.license.deactivate({
        licenseKey: current.license_key,
        instanceId: current.instance_id,
      });
    } catch (err) {
      console.warn('[kelviq] Deactivate previous license warning:', err);
    }
  }
}

export async function activateLicenseKey(rawKey: string) {
  const key = rawKey.trim();
  if (!key) throw new Error('License key is required');

  // 1. Check Admin-issued local keys first (VIP / manual keys)
  const local = db.prepare(`SELECT * FROM local_licenses WHERE license_key=?`).get(key) as any;
  if (local) {
    if (!local.active) throw new Error('This license key has been revoked by the administrator.');
    if (local.expires_on && Date.parse(local.expires_on) < Date.now()) {
      throw new Error('This license key has expired.');
    }

    await deactivatePreviousKelviqIfChanged(key);

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE active_license SET
        license_key = ?,
        instance_id = ?,
        plan_id = ?,
        provider = 'local',
        customer_email = ?,
        customer_name = 'Licensed Creator',
        expires_on = ?,
        last_validated_at = ?,
        activated_at = ?
      WHERE id = 'current'
    `).run(
      key,
      `local_${os.hostname()}`,
      local.plan_id,
      local.customer_email ?? '',
      local.expires_on ?? '',
      nowIso,
      nowIso
    );

    return getActiveEntitlement();
  }

  // 2. Activate via official Kelviq License SDK (/api/v1/)
  const kelviq = getKelviqClient();
  if (!kelviq) {
    throw new Error(
      'Kelviq API Key is not configured yet in Admin Settings, and key was not found in local VIP keys.'
    );
  }

  const res = await kelviq.license.activate({
    licenseKey: key,
    instanceName: os.hostname(),
    metadata: {
      app: 'clipper-studio',
      os: process.platform,
    },
  });

  if (!res.license?.enabled) {
    throw new Error('Kelviq reports this license key is currently disabled.');
  }

  const activatedKey = res.license.licenseKey || key;
  await deactivatePreviousKelviqIfChanged(activatedKey, kelviq);

  const mappedPlanId = mapKelviqPlanIdentifier(
    res.license.plan?.identifier ?? res.license.plan?.product?.identifier,
    res.license.plan?.name
  );
  const nowIso = new Date().toISOString();

  db.prepare(`
    UPDATE active_license SET
      license_key = ?,
      instance_id = ?,
      plan_id = ?,
      provider = 'kelviq',
      customer_email = ?,
      customer_name = ?,
      expires_on = ?,
      last_validated_at = ?,
      activated_at = ?
    WHERE id = 'current'
  `).run(
    activatedKey,
    res.instanceId,
    mappedPlanId,
    res.license.customer?.email ?? '',
    res.license.customer?.name ?? '',
    res.expiresOn ?? res.license.expiresOn ?? '',
    nowIso,
    res.activatedAt || nowIso
  );

  // Record activation inside event log for Admin Dashboard visibility
  db.prepare(`
    INSERT INTO kelviq_events (id, event_type, customer_email, license_key, plan_identifier, raw_json)
    VALUES (?, 'license.activated', ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    res.license.customer?.email ?? '',
    maskLicenseKeyValue(key),
    mappedPlanId,
    JSON.stringify({ instanceId: res.instanceId, plan: res.license.plan?.name ?? mappedPlanId })
  );

  return getActiveEntitlement();
}

export async function validateCurrentLicense(): Promise<boolean> {
  const lic = getActiveLicenseRow();
  if (lic.provider === 'local') {
    const localRow = lic.license_key
      ? (db.prepare(`SELECT active, expires_on FROM local_licenses WHERE license_key=?`).get(lic.license_key) as
          | { active: number; expires_on: string }
          | undefined)
      : undefined;
    const localExpMs = localRow?.expires_on ? Date.parse(localRow.expires_on) : NaN;
    if (!localRow || localRow.active !== 1 || (!Number.isNaN(localExpMs) && localExpMs < Date.now())) {
      resetToFreeLicense();
      return false;
    }
    return true;
  }
  if (lic.provider !== 'kelviq' || !lic.license_key) return true;

  const kelviq = getKelviqClient();
  if (!kelviq) {
    const expMs = lic.expires_on ? Date.parse(lic.expires_on) : NaN;
    if (lic.plan_id !== 'free' && !Number.isNaN(expMs) && expMs < Date.now()) {
      resetToFreeLicense();
      return false;
    }
    return true;
  }

  try {
    const res = await kelviq.license.validate({
      licenseKey: lic.license_key,
      instanceId: lic.instance_id || null,
    });
    if (!res.valid) {
      resetToFreeLicense();
      return false;
    }
    const nowIso = new Date().toISOString();
    const hasPlanInfo = Boolean(
      res.license?.plan?.identifier ||
      res.license?.plan?.product?.identifier ||
      res.license?.plan?.name
    );
    const nextPlanId = hasPlanInfo
      ? mapKelviqPlanIdentifier(
          res.license?.plan?.identifier ?? res.license?.plan?.product?.identifier,
          res.license?.plan?.name
        )
      : lic.plan_id;
    const nextExpiresOn = res.license?.expiresOn !== undefined
      ? (res.license.expiresOn ?? '')
      : lic.expires_on;

    db.prepare(`
      UPDATE active_license
      SET plan_id = ?, expires_on = ?, last_validated_at = ?
      WHERE id = 'current'
    `).run(nextPlanId, nextExpiresOn, nowIso);
    return true;
  } catch (err: any) {
    const status: number | undefined =
      typeof err?.statusCode === 'number'
        ? err.statusCode
        : (typeof err?.response?.status === 'number' ? err.response.status : undefined);
    if (status === 401 || status === 403 || status === 404) {
      resetToFreeLicense();
      return false;
    }
    if (status === undefined || status >= 500) {
      // Transient network or 5xx error: keep active until next validation check
      return true;
    }
    return false;
  }
}

export async function deactivateCurrentLicense() {
  const lic = getActiveLicenseRow();
  if (lic.provider === 'kelviq' && lic.license_key && lic.instance_id) {
    const kelviq = getKelviqClient();
    if (kelviq) {
      try {
        await kelviq.license.deactivate({
          licenseKey: lic.license_key,
          instanceId: lic.instance_id,
        });
      } catch (err) {
        console.warn('[kelviq] Deactivate warning:', err);
      }
    }
  }
  resetToFreeLicense();
  return getActiveEntitlement();
}

export function resetToFreeLicense(): void {
  db.prepare(`
    UPDATE active_license SET
      license_key = '',
      instance_id = '',
      plan_id = 'free',
      provider = 'free',
      customer_email = '',
      customer_name = '',
      expires_on = '',
      last_validated_at = '',
      activated_at = ''
    WHERE id = 'current'
  `).run();
}

export async function resolveCheckoutUrl(
  planId: string,
  customerEmail?: string,
  customerId?: string,
): Promise<string> {
  if (!planExists(planId)) {
    throw new Error(`Invalid plan ID: ${planId}`);
  }
  if (planId === 'free') {
    throw new Error('The Free plan does not require checkout. Choose Pro or Ultra to upgrade.');
  }

  const plan = getPlanById(planId);
  const cleanEmail = customerEmail?.trim() ?? '';

  if (plan.kelviq_payment_link && /^https?:\/\//i.test(plan.kelviq_payment_link)) {
    const url = new URL(plan.kelviq_payment_link);
    if (cleanEmail) url.searchParams.set('email', cleanEmail);
    return url.toString();
  }

  const kelviq = getKelviqClient();
  if (kelviq && plan.kelviq_plan_identifier) {
    const cleanCustomerId = customerId?.trim();
    const session = await kelviq.checkout.createSession({
      planIdentifier: plan.kelviq_plan_identifier,
      chargePeriod: plan.billing_period === 'ONE_TIME'
        ? 'ONE_TIME'
        : (plan.billing_period === 'YEARLY' ? 'YEARLY' : 'MONTHLY'),
      successUrl: `http://localhost:${process.env.CLIPPER_PORT ?? 4001}/?checkout=success&plan=${plan.id}`,
      customerId: cleanCustomerId || null,
      metadata: cleanEmail ? { customerEmail: cleanEmail, planId: plan.id } : { planId: plan.id },
      defaultBillingCountry: 'PK',
    });
    if (session.checkoutUrl) return session.checkoutUrl;
  }

  throw new Error(
    `No Kelviq Payment Link or Kelviq Plan ID configured for ${plan.name}. Set it in the Admin Dashboard (/admin).`
  );
}

export function generateAdminLicenseKey(
  planId: PlanId,
  customerEmail = '',
  note = '',
  expiresDays = 0,
) {
  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  const key = `CLIP-${planId.toUpperCase()}-${rand.slice(0, 4)}-${rand.slice(4, 8)}-${rand.slice(8, 12)}`;
  const expiresOn = expiresDays > 0
    ? new Date(Date.now() + expiresDays * 86400_000).toISOString()
    : '';

  db.prepare(`
    INSERT INTO local_licenses (license_key, plan_id, customer_email, note, active, expires_on)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(key, planId, customerEmail, note, expiresOn);

  return { license_key: key, plan_id: planId, customer_email: customerEmail, note, expires_on: expiresOn };
}

const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const REVOCATION_EVENT_TYPES = new Set([
  'license.revoked',
  'license.disabled',
  'license.expired',
  'license.deleted',
  'subscription.cancelled',
  'subscription.canceled',
  'subscription.expired',
  'subscription.revoked',
]);

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  targetName: string,
): string | undefined {
  const lower = targetName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function assertWebhookTimestampFresh(
  headers: Record<string, string | string[] | undefined>,
): void {
  const rawTs = getHeaderValue(headers, 'webhook-timestamp')?.trim() ?? '';
  let tsMs = NaN;
  if (/^\d+(?:\.\d+)?$/.test(rawTs)) {
    const num = Number(rawTs);
    tsMs = num > 1e12 ? num : num * 1000;
  } else if (rawTs) {
    tsMs = Date.parse(rawTs);
  }
  if (!Number.isFinite(tsMs)) {
    throw new WebhookVerificationError('Invalid webhook-timestamp header.');
  }
  if (Math.abs(Date.now() - tsMs) > WEBHOOK_REPLAY_WINDOW_MS) {
    throw new WebhookVerificationError('Webhook timestamp outside 5-minute replay freshness window.');
  }
}

export function handleKelviqWebhook(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
) {
  const bodyStr = Buffer.isBuffer(rawBody)
    ? rawBody.toString('utf8')
    : (typeof rawBody === 'string' ? rawBody : '');
  if (!bodyStr.trim()) {
    throw new WebhookVerificationError('Webhook request body must not be empty.');
  }

  const webhookSecret = getSetting('kelviq_webhook_secret') || process.env.KELVIQ_WEBHOOK_SECRET || '';
  let parsed: Record<string, any>;

  if (webhookSecret.trim()) {
    try {
      parsed = validateEvent(rawBody, headers, webhookSecret.trim()) as Record<string, any>;
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        throw err;
      }
      throw new WebhookVerificationError('Webhook verification failed');
    }
    assertWebhookTimestampFresh(headers);
  } else if (process.env.KELVIQ_ALLOW_UNSIGNED_WEBHOOKS === 'true') {
    const rawJson = JSON.parse(bodyStr);
    if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
      throw new Error('Webhook JSON payload must be an object.');
    }
    parsed = rawJson as Record<string, any>;
  } else {
    throw new WebhookVerificationError(
      'Kelviq webhook secret is not configured. Configure KELVIQ_WEBHOOK_SECRET in Admin Settings before accepting webhooks.'
    );
  }

  const eventType = String(parsed.type ?? parsed.event ?? 'kelviq.event');
  const data = parsed.data ?? parsed;
  const email = String(data?.customer?.email ?? data?.customerEmail ?? '');
  const rawKey = String(
    data?.license?.licenseKey ??
    data?.licenseKey ??
    data?.license_key ??
    data?.object?.licenseKey ??
    data?.object?.license?.licenseKey ??
    ''
  ).trim();
  const maskedKey = rawKey ? maskLicenseKeyValue(rawKey) : '';
  const planId = String(data?.plan?.identifier ?? data?.planIdentifier ?? '');
  const amount = data?.amount !== undefined ? `${data.amount} ${data.currencyCode ?? 'USD'}` : '';

  if (REVOCATION_EVENT_TYPES.has(eventType.trim().toLowerCase()) && rawKey) {
    const current = getActiveLicenseRow();
    if (current.license_key && current.license_key === rawKey) {
      resetToFreeLicense();
    }
  }

  const sanitizedPayload = redactLicenseKeysInObject(parsed);

  db.prepare(`
    INSERT INTO kelviq_events (id, event_type, customer_email, license_key, plan_identifier, amount, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    eventType,
    email,
    maskedKey,
    planId,
    amount,
    JSON.stringify(sanitizedPayload)
  );

  return { ok: true, eventType };
}
