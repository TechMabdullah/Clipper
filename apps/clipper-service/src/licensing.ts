import crypto from 'node:crypto';
import os from 'node:os';
import Stripe from 'stripe';
import { db, getSetting, getDailyClipCount, verifyPassword } from './db.js';

export type PlanId = 'free' | 'pro' | 'ultra';
export type EntitlementFeature =
  | 'auto_captions'
  | 'audio_peak'
  | 'virality_ai'
  | 'watchlist'
  | 'custom_branding';

export class StripeWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeWebhookVerificationError';
  }
}

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
  stripe_payment_link: string;
  stripe_price_id: string;
  updated_at: string;
}

export interface ActiveLicenseRecord {
  id: string;
  license_key: string;
  instance_id: string;
  plan_id: PlanId;
  provider: 'free' | 'stripe' | 'local';
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

export function getStripeClient(): Stripe | null {
  const key = (getSetting('stripe_secret_key') || process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return null;
  return new Stripe(key, { timeout: 12_000 });
}

export function planExists(planId: string): boolean {
  if (!planId || typeof planId !== 'string') return false;
  const row = db.prepare(`SELECT 1 AS found FROM plans WHERE id=?`).get(planId) as
    | { found: number }
    | undefined;
  return Boolean(row?.found);
}

export function listPlans(): PlanRecord[] {
  return db.prepare(`SELECT * FROM plans ORDER BY price_usd ASC`).all() as unknown as PlanRecord[];
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
      stripe_payment_link = ?,
      stripe_price_id = ?,
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
    patch.stripe_payment_link ?? current.stripe_payment_link,
    patch.stripe_price_id ?? current.stripe_price_id,
    current.id,
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

  const expMs = lic.expires_on ? Date.parse(lic.expires_on) : NaN;
  const isExpired = lic.plan_id !== 'free' && !Number.isNaN(expMs) && expMs < Date.now();
  if (isExpired && (lic.provider !== 'stripe' || !getStripeClient())) {
    resetToFreeLicense();
    lic = getActiveLicenseRow();
  }

  if (lic.provider === 'stripe' && lic.license_key && !bgValidationInFlight) {
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
      maskedKey: lic.license_key ? maskLicenseKeyValue(lic.license_key) : '',
    },
    usage: {
      usedToday,
      dailyLimit: plan.daily_clip_limit,
      remaining,
      unlimited,
    },
    stripeConfigured: Boolean(
      (getSetting('stripe_secret_key') || process.env.STRIPE_SECRET_KEY || '').trim(),
    ),
    portalUrl: getSetting('stripe_portal_url') || process.env.STRIPE_PORTAL_URL || '',
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
      `Daily limit of ${plan.daily_clip_limit} clips reached on ${plan.name}. Upgrade to Pro or Ultra via Stripe for unlimited rendering.`,
      'DAILY_QUOTA_REACHED',
      'pro',
      plan.id,
    );
  }

  if (feature === 'auto_captions' && !plan.allow_auto_captions) {
    throw new EntitlementError(
      'Auto Kinetic Captions require Pro or Ultra plan. Subscribe via Stripe or activate a license key to unlock.',
      'PLAN_UPGRADE_REQUIRED',
      'pro',
      plan.id,
    );
  }
  if (feature === 'audio_peak' && !plan.allow_audio_peak) {
    throw new EntitlementError(
      'Audio Peak Hype Scanner requires Pro or Ultra plan.',
      'PLAN_UPGRADE_REQUIRED',
      'pro',
      plan.id,
    );
  }
  if (feature === 'virality_ai' && !plan.allow_virality_ai) {
    throw new EntitlementError(
      'AI Virality Scoring requires Pro or Ultra plan.',
      'PLAN_UPGRADE_REQUIRED',
      'pro',
      plan.id,
    );
  }
  if (feature === 'watchlist' && !plan.allow_watchlist) {
    throw new EntitlementError(
      'Multi-Stream Watchlist Scheduler requires the Ultra plan.',
      'PLAN_UPGRADE_REQUIRED',
      'ultra',
      plan.id,
    );
  }
  if (feature === 'custom_branding' && !plan.allow_custom_branding) {
    throw new EntitlementError(
      'Custom Channel Watermark Branding requires the Ultra plan.',
      'PLAN_UPGRADE_REQUIRED',
      'ultra',
      plan.id,
    );
  }

  return ent;
}

function mapStripePlanIdentifier(identifier?: string | null, name?: string | null): PlanId {
  const idLower = String(identifier ?? '').trim().toLowerCase();
  const nameLower = String(name ?? '').trim().toLowerCase();
  const plans = listPlans();

  if (idLower) {
    const exact = plans.find(
      (p) => p.stripe_price_id && p.stripe_price_id.trim().toLowerCase() === idLower,
    );
    if (exact) return exact.id;
  }

  if (idLower.includes('ultra') || nameLower.includes('ultra')) return 'ultra';
  if (idLower.includes('pro') || nameLower.includes('pro')) return 'pro';
  return 'free';
}

export async function activateLicenseKey(rawKey: string) {
  const key = rawKey.trim();
  if (!key) throw new Error('License key or Stripe Subscription ID is required');

  // 1. Check Admin-issued local keys first (VIP / manual keys)
  const local = db.prepare(`SELECT * FROM local_licenses WHERE license_key=?`).get(key) as any;
  if (local) {
    if (!local.active) throw new Error('This license key has been revoked by the administrator.');
    if (local.expires_on && Date.parse(local.expires_on) < Date.now()) {
      throw new Error('This license key has expired.');
    }

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
      nowIso,
    );

    return getActiveEntitlement();
  }

  // 2. Activate using a live Stripe Checkout Session ID (cs_...) or Subscription ID (sub_...)
  const stripe = getStripeClient();
  if (!stripe) {
    throw new Error(
      'Stripe Secret Key is not configured yet in Admin Settings, and key was not found in local VIP keys.',
    );
  }

  let subscriptionId = '';
  let customerId = '';
  let customerEmail = '';
  let customerName = 'Stripe Subscriber';
  let priceOrPlanHint = '';
  let expiresOnIso = '';

  if (key.startsWith('cs_')) {
    const session = await stripe.checkout.sessions.retrieve(key, {
      expand: ['subscription', 'customer'],
    });
    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      throw new Error('Stripe Checkout session is not paid/complete yet.');
    }
    customerEmail = session.customer_details?.email || session.customer_email || '';
    customerName = session.customer_details?.name || customerName;
    customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || '';
    const subObj =
      typeof session.subscription === 'object' && session.subscription
        ? session.subscription
        : null;
    subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : subObj?.id || session.id;
    priceOrPlanHint =
      (session.metadata?.planId as string | undefined) ||
      subObj?.items?.data?.[0]?.price?.id ||
      'pro';
    if (subObj && 'current_period_end' in subObj && typeof subObj.current_period_end === 'number') {
      expiresOnIso = new Date(subObj.current_period_end * 1000).toISOString();
    }
  } else if (key.startsWith('sub_')) {
    const sub = await stripe.subscriptions.retrieve(key, { expand: ['customer'] });
    if (!['active', 'trialing'].includes(sub.status)) {
      throw new Error(`Stripe subscription status is "${sub.status}" (expected active or trialing).`);
    }
    subscriptionId = sub.id;
    customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || '';
    if (typeof sub.customer === 'object' && sub.customer && !('deleted' in sub.customer)) {
      customerEmail = sub.customer.email || '';
      customerName = sub.customer.name || customerName;
    }
    priceOrPlanHint =
      (sub.metadata?.planId as string | undefined) || sub.items?.data?.[0]?.price?.id || 'pro';
    const firstItem = sub.items?.data?.[0];
    if (firstItem && 'current_period_end' in firstItem && typeof firstItem.current_period_end === 'number') {
      expiresOnIso = new Date(firstItem.current_period_end * 1000).toISOString();
    }
  } else {
    throw new Error(
      'Unrecognized key format. Enter a local VIP key (CLIP-...) or Stripe Subscription/Session ID (sub_... / cs_...).',
    );
  }

  const mappedPlanId = mapStripePlanIdentifier(priceOrPlanHint, priceOrPlanHint);
  const finalPlan: PlanId = mappedPlanId === 'free' ? 'pro' : mappedPlanId;
  const nowIso = new Date().toISOString();

  db.prepare(`
    UPDATE active_license SET
      license_key = ?,
      instance_id = ?,
      plan_id = ?,
      provider = 'stripe',
      customer_email = ?,
      customer_name = ?,
      expires_on = ?,
      last_validated_at = ?,
      activated_at = ?
    WHERE id = 'current'
  `).run(
    subscriptionId,
    customerId || `stripe_${os.hostname()}`,
    finalPlan,
    customerEmail,
    customerName,
    expiresOnIso,
    nowIso,
    nowIso,
  );

  db.prepare(`
    INSERT INTO stripe_events (id, event_type, customer_email, license_key, plan_identifier, raw_json)
    VALUES (?, 'subscription.activated', ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    customerEmail,
    maskLicenseKeyValue(subscriptionId),
    finalPlan,
    JSON.stringify({ subscriptionId, customerId, plan: finalPlan }),
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
  if (lic.provider !== 'stripe' || !lic.license_key) return true;

  const stripe = getStripeClient();
  if (!stripe) {
    const expMs = lic.expires_on ? Date.parse(lic.expires_on) : NaN;
    if (lic.plan_id !== 'free' && !Number.isNaN(expMs) && expMs < Date.now()) {
      resetToFreeLicense();
      return false;
    }
    return true;
  }

  try {
    if (!lic.license_key.startsWith('sub_')) return true;
    const sub = await stripe.subscriptions.retrieve(lic.license_key);
    if (!['active', 'trialing'].includes(sub.status)) {
      resetToFreeLicense();
      return false;
    }
    const nowIso = new Date().toISOString();
    const firstItem = sub.items?.data?.[0];
    const nextExp =
      firstItem && 'current_period_end' in firstItem && typeof firstItem.current_period_end === 'number'
        ? new Date(firstItem.current_period_end * 1000).toISOString()
        : lic.expires_on;

    db.prepare(`
      UPDATE active_license
      SET expires_on = ?, last_validated_at = ?
      WHERE id = 'current'
    `).run(nextExp, nowIso);
    return true;
  } catch (err: any) {
    const status = err?.statusCode as number | undefined;
    if (status === 401 || status === 404) {
      resetToFreeLicense();
      return false;
    }
    return true;
  }
}

export async function deactivateCurrentLicense() {
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
  userUid?: string,
): Promise<string> {
  if (!planExists(planId)) {
    throw new Error(`Invalid plan ID: ${planId}`);
  }
  if (planId === 'free') {
    throw new Error('The Free plan does not require checkout. Choose Pro or Ultra to upgrade.');
  }

  const plan = getPlanById(planId);
  const cleanEmail = customerEmail?.trim() ?? '';

  if (plan.stripe_payment_link && /^https?:\/\//i.test(plan.stripe_payment_link)) {
    const url = new URL(plan.stripe_payment_link);
    if (cleanEmail) url.searchParams.set('prefilled_email', cleanEmail);
    if (userUid) url.searchParams.set('client_reference_id', userUid);
    return url.toString();
  }

  const stripe = getStripeClient();
  if (stripe) {
    const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.CLIPPER_PORT ?? 4001}`).replace(/\/+$/, '');
    const cleanPriceId = (plan.stripe_price_id || '').trim();
    const isRealStripePrice = cleanPriceId.startsWith('price_');
    const mode = plan.billing_period === 'ONE_TIME' ? 'payment' : 'subscription';

    const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = isRealStripePrice
      ? { price: cleanPriceId, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: Math.max(100, Math.round((plan.price_usd || 12) * 100)),
            product_data: {
              name: `Clipper Studio ${plan.name}`,
              description: plan.tagline || 'AI Stream Clipping & Creator SaaS Subscription',
            },
            ...(mode === 'subscription'
              ? {
                  recurring: {
                    interval: plan.billing_period === 'YEARLY' ? 'year' : 'month',
                  },
                }
              : {}),
          },
        };

    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [lineItem],
      ...(customerId?.trim()
        ? { customer: customerId.trim() }
        : cleanEmail
          ? { customer_email: cleanEmail }
          : {}),
      ...(userUid ? { client_reference_id: userUid } : {}),
      success_url: `${appBaseUrl}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appBaseUrl}/billing?checkout=cancelled`,
      metadata: {
        planId: plan.id,
        ...(userUid ? { uid: userUid } : {}),
        ...(cleanEmail ? { customerEmail: cleanEmail } : {}),
      },
    });
    if (session.url) return session.url;
  }

  throw new Error(
    `Stripe Secret Key or Stripe Payment Link is not configured yet for ${plan.name}. Add STRIPE_SECRET_KEY or a Stripe Payment Link in Admin Settings.`,
  );
}

export async function resolveBillingPortalUrl(returnUrl?: string): Promise<string> {
  const configuredPortal = (getSetting('stripe_portal_url') || process.env.STRIPE_PORTAL_URL || '').trim();
  if (configuredPortal) return configuredPortal;

  const stripe = getStripeClient();
  const lic = getActiveLicenseRow();
  if (stripe && lic.instance_id?.startsWith('cus_')) {
    const portal = await stripe.billingPortal.sessions.create({
      customer: lic.instance_id,
      return_url: returnUrl || 'http://localhost:3000/billing',
    });
    return portal.url;
  }
  throw new Error('Configure STRIPE_PORTAL_URL or complete a Stripe Checkout subscription first.');
}

export function generateAdminLicenseKey(
  planId: PlanId,
  customerEmail = '',
  note = '',
  expiresDays = 0,
) {
  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  const key = `CLIP-${planId.toUpperCase()}-${rand.slice(0, 4)}-${rand.slice(4, 8)}-${rand.slice(8, 12)}`;
  const expiresOn =
    expiresDays > 0 ? new Date(Date.now() + expiresDays * 86400_000).toISOString() : '';

  db.prepare(`
    INSERT INTO local_licenses (license_key, plan_id, customer_email, note, active, expires_on)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(key, planId, customerEmail, note, expiresOn);

  return { license_key: key, plan_id: planId, customer_email: customerEmail, note, expires_on: expiresOn };
}

const WEBHOOK_REPLAY_WINDOW_SEC = 300;
const STRIPE_REVOCATION_EVENTS = new Set([
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'charge.refunded',
  'invoice.payment_failed',
]);
const STRIPE_ACTIVATION_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'invoice.paid',
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

export function handleStripeWebhook(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
) {
  const bodyStr = Buffer.isBuffer(rawBody)
    ? rawBody.toString('utf8')
    : typeof rawBody === 'string'
      ? rawBody
      : '';
  if (!bodyStr.trim()) {
    throw new StripeWebhookVerificationError('Webhook request body must not be empty.');
  }

  const webhookSecret = (
    getSetting('stripe_webhook_secret') ||
    process.env.STRIPE_WEBHOOK_SECRET ||
    ''
  ).trim();

  let parsed: Record<string, any>;

  if (webhookSecret) {
    const sig = getHeaderValue(headers, 'stripe-signature');
    if (!sig) {
      throw new StripeWebhookVerificationError('Missing stripe-signature header.');
    }
    const stripe = getStripeClient() ?? new Stripe('sk_test_webhook_verify_only');
    try {
      parsed = stripe.webhooks.constructEvent(
        rawBody,
        sig,
        webhookSecret,
        WEBHOOK_REPLAY_WINDOW_SEC,
      ) as unknown as Record<string, any>;
    } catch (err: any) {
      throw new StripeWebhookVerificationError(err?.message || 'Stripe signature verification failed');
    }
  } else if (process.env.STRIPE_ALLOW_UNSIGNED_WEBHOOKS === 'true') {
    const rawJson = JSON.parse(bodyStr);
    if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
      throw new Error('Webhook JSON payload must be an object.');
    }
    parsed = rawJson as Record<string, any>;
  } else {
    throw new StripeWebhookVerificationError(
      'Stripe webhook secret is not configured. Configure STRIPE_WEBHOOK_SECRET in Admin Settings before accepting webhooks.',
    );
  }

  const eventType = String(parsed.type ?? 'stripe.event');
  const obj = (parsed.data?.object ?? {}) as Record<string, any>;
  const email = String(
    obj.customer_details?.email ?? obj.customer_email ?? obj.receipt_email ?? obj.metadata?.customerEmail ?? '',
  );
  const subOrKeyId = String(obj.subscription ?? obj.id ?? '');
  const customerId = String(obj.customer ?? '');
  const planIdRaw = String(obj.metadata?.planId ?? obj.items?.data?.[0]?.price?.id ?? '');
  const mappedPlanId = mapStripePlanIdentifier(planIdRaw, planIdRaw);
  const amountNum =
    typeof obj.amount_total === 'number'
      ? obj.amount_total
      : typeof obj.amount_paid === 'number'
        ? obj.amount_paid
        : typeof obj.amount === 'number'
          ? obj.amount
          : undefined;
  const amount =
    amountNum !== undefined
      ? `${(amountNum / 100).toFixed(2)} ${String(obj.currency ?? 'usd').toUpperCase()}`
      : '';

  if (STRIPE_ACTIVATION_EVENTS.has(eventType)) {
    const targetPlan: PlanId = mappedPlanId === 'free' ? 'pro' : mappedPlanId;
    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE active_license SET
        license_key = COALESCE(NULLIF(?, ''), license_key),
        instance_id = COALESCE(NULLIF(?, ''), instance_id),
        plan_id = ?,
        provider = 'stripe',
        customer_email = COALESCE(NULLIF(?, ''), customer_email),
        customer_name = 'Stripe Subscriber',
        last_validated_at = ?,
        activated_at = COALESCE(NULLIF(activated_at, ''), ?)
      WHERE id = 'current'
    `).run(subOrKeyId, customerId, targetPlan, email, nowIso, nowIso);
  } else if (STRIPE_REVOCATION_EVENTS.has(eventType)) {
    const current = getActiveLicenseRow();
    if (
      !subOrKeyId ||
      current.license_key === subOrKeyId ||
      (customerId && current.instance_id === customerId)
    ) {
      resetToFreeLicense();
    }
  }

  const maskedKey = subOrKeyId ? maskLicenseKeyValue(subOrKeyId) : '';
  const sanitizedPayload = redactLicenseKeysInObject(parsed);

  db.prepare(`
    INSERT INTO stripe_events (id, event_type, customer_email, license_key, plan_identifier, amount, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    eventType,
    email,
    maskedKey,
    mappedPlanId,
    amount,
    JSON.stringify(sanitizedPayload),
  );

  return { ok: true, eventType, planId: mappedPlanId };
}
