import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import {
  db,
  getSetting,
  setSetting,
  hashPassword,
  verifyPassword,
  rotateSessionSecret,
  getDashboardAnalytics,
  logAuditEvent,
} from './db.js';
import { getStorageInfo } from './storage.js';
import {
  listPlans,
  planExists,
  updatePlanConfig,
  getActiveEntitlement,
  activateLicenseKey,
  deactivateCurrentLicense,
  validateCurrentLicense,
  resolveCheckoutUrl,
  generateAdminLicenseKey,
  handleKelviqWebhook,
  getKelviqClient,
  assertEntitlement,
  isUsingDefaultAdminPassword,
  maskLicenseKeyValue,
  redactLicenseKeysInObject,
  EntitlementError,
  type PlanId,
  type PlanRecord,
} from './licensing.js';
import {
  listWatchlist,
  addWatchlistChannel,
  removeWatchlistChannel,
  toggleWatchlistAutoClip,
  pollWatchlistStatuses,
  isChannelLive,
} from './features/watchlist.js';
import type { LivePlatform } from './live/chat-tracker.js';
import type { ClipLayout, FacecamPosition } from './live/layout-utils.js';
import type { CaptionStyle } from './features/captions.js';

const COOKIE_NAME = 'clipper_admin_session';
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const loginFailures = new Map<string, { count: number; windowStartMs: number }>();

export const VALID_LIVE_PLATFORMS = new Set<LivePlatform>(['twitch', 'youtube', 'kick']);
export const VALID_CLIP_LAYOUTS = new Set<ClipLayout>([
  'split',
  'split-crop',
  'crop',
  'blur',
  'portrait-4x5',
  'square',
  'landscape',
]);
export const VALID_FACECAM_POSITIONS = new Set<FacecamPosition>([
  'auto',
  'bottom-left',
  'top-left',
  'bottom-right',
  'top-right',
]);
export const VALID_CAPTION_STYLES = new Set<CaptionStyle>(['none', 'hormozi', 'neon', 'minimal']);
const VALID_PLAN_IDS = new Set<PlanId>(['free', 'pro', 'ultra']);

function recordLoginFailure(ip: string, now: number): void {
  if (loginFailures.size > 1000) {
    for (const [key, entry] of loginFailures) {
      if (now - entry.windowStartMs > LOGIN_WINDOW_MS) {
        loginFailures.delete(key);
      }
    }
  }
  const prev = loginFailures.get(ip);
  if (!prev || now - prev.windowStartMs > LOGIN_WINDOW_MS) {
    loginFailures.set(ip, { count: 1, windowStartMs: now });
  } else {
    prev.count += 1;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function createSessionToken(): string {
  const secret = getSetting('admin_session_secret', 'fallback_secret');
  const exp = Date.now() + 24 * 3600_000;
  const payload = `admin:${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}:${sig}`;
}

function verifySessionToken(token?: string): boolean {
  if (!token) return false;
  const parts = token.split(':');
  if (parts.length !== 3) return false;
  const [role, expStr, sig] = parts;
  if (role !== 'admin') return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;

  const secret = getSetting('admin_session_secret', 'fallback_secret');
  const expected = crypto.createHmac('sha256', secret).update(`${role}:${expStr}`).digest('hex');
  const a = Buffer.from(sig || '', 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isLocalOriginOrReferer(req: Request): { ok: true } | { ok: false; error: string } {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && !LOCAL_ORIGIN_RE.test(origin)) {
    return { ok: false, error: 'Forbidden: untrusted Origin header' };
  }
  if (MUTATING_METHODS.has(req.method.toUpperCase())) {
    const referer = req.headers.referer;
    if (typeof referer === 'string' && referer.trim()) {
      let refOrigin = '';
      try {
        refOrigin = new URL(referer).origin;
      } catch {
        refOrigin = '';
      }
      if (!refOrigin || !LOCAL_ORIGIN_RE.test(refOrigin)) {
        return { ok: false, error: 'Forbidden: untrusted Referer header' };
      }
    }
  }
  return { ok: true };
}

export function hasAdminSession(req: Request): boolean {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!hasAdminSession(req)) {
    res.status(401).json({ error: 'Admin authentication required' });
    return;
  }
  const csrfCheck = isLocalOriginOrReferer(req);
  if (!csrfCheck.ok) {
    res.status(403).json({ error: csrfCheck.error });
    return;
  }
  next();
}

export function handleErrorStatus(res: Response, err: unknown): void {
  if (err instanceof EntitlementError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      requiredPlan: err.requiredPlan,
      currentPlan: err.currentPlan,
    });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  res.status(400).json({ error: msg });
}

/** Raw JSON webhook handler — MUST be mounted before express.json() */
export const kelviqWebhookMiddleware: express.RequestHandler[] = [
  express.raw({ type: 'application/json' }),
  (req: Request, res: Response) => {
    const rawBody = req.body;
    const isValidRaw =
      (Buffer.isBuffer(rawBody) && rawBody.length > 0) ||
      (typeof rawBody === 'string' && rawBody.trim().length > 0);

    if (!isValidRaw) {
      res.status(400).json({ error: 'Webhook request body must be non-empty JSON' });
      return;
    }

    const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    try {
      const parsed = JSON.parse(bodyText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        res.status(400).json({ error: 'Webhook JSON payload must be an object' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Webhook request body is not valid JSON' });
      return;
    }

    try {
      const result = handleKelviqWebhook(rawBody, req.headers);
      res.status(202).json(result);
    } catch (err: any) {
      console.warn('[kelviq-webhook] Verification error:', err.message);
      res.status(403).json({ error: err.message });
    }
  },
];

export function registerSaasAndAdminRoutes(
  app: express.Express,
  onWatchlistAutoStart?: (entry: any) => Promise<void>,
): void {
  // ── Billing & Kelviq License Endpoints ─────────────────────────────────
  const handleBillingStatus = (_req: Request, res: Response) => {
    res.json({
      ok: true,
      entitlement: getActiveEntitlement(),
      plans: listPlans(),
      analytics: getDashboardAnalytics(),
    });
  };
  app.get('/api/billing/status', handleBillingStatus);
  app.get('/api/licensing/status', handleBillingStatus);

  app.post('/api/billing/checkout', async (req, res) => {
    const { planId, email } = (req.body ?? {}) as { planId?: string; email?: string };
    try {
      const checkoutUrl = await resolveCheckoutUrl(planId || 'pro', email);
      res.json({ ok: true, checkoutUrl });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/billing/activate', async (req, res) => {
    const { licenseKey } = (req.body ?? {}) as { licenseKey?: string };
    try {
      const entitlement = await activateLicenseKey(typeof licenseKey === 'string' ? licenseKey : '');
      res.json({ ok: true, entitlement });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/billing/deactivate', async (_req, res) => {
    try {
      const entitlement = await deactivateCurrentLicense();
      res.json({ ok: true, entitlement });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/billing/validate', async (_req, res) => {
    const valid = await validateCurrentLicense();
    res.json({ ok: true, valid, entitlement: getActiveEntitlement() });
  });

  // ── Stream Watchlist Scheduler API ─────────────────────────────────────
  app.get('/api/watchlist', (_req, res) => {
    res.json({ ok: true, items: listWatchlist() });
  });

  app.post('/api/watchlist', async (req, res) => {
    const { platform, channel, layout, facecamPosition, captionStyle, autoClip } = (req.body ?? {}) as {
      platform?: unknown;
      channel?: unknown;
      layout?: unknown;
      facecamPosition?: unknown;
      captionStyle?: unknown;
      autoClip?: unknown;
    };
    const resolvedPlatform = platform === undefined ? 'twitch' : platform;
    if (typeof resolvedPlatform !== 'string' || !VALID_LIVE_PLATFORMS.has(resolvedPlatform as LivePlatform)) {
      res.status(400).json({ error: 'platform must be one of: twitch, youtube, kick' });
      return;
    }
    if (typeof channel !== 'string' || !channel.trim()) {
      res.status(400).json({ error: 'channel is required' });
      return;
    }
    if (layout !== undefined && (typeof layout !== 'string' || !VALID_CLIP_LAYOUTS.has(layout as ClipLayout))) {
      res.status(400).json({ error: 'Invalid layout' });
      return;
    }
    if (
      facecamPosition !== undefined &&
      (typeof facecamPosition !== 'string' || !VALID_FACECAM_POSITIONS.has(facecamPosition as FacecamPosition))
    ) {
      res.status(400).json({ error: 'Invalid facecamPosition' });
      return;
    }
    if (
      captionStyle !== undefined &&
      (typeof captionStyle !== 'string' || !VALID_CAPTION_STYLES.has(captionStyle as CaptionStyle))
    ) {
      res.status(400).json({ error: 'Invalid captionStyle' });
      return;
    }

    try {
      assertEntitlement('watchlist', false);
      const item = addWatchlistChannel({
        platform: resolvedPlatform as LivePlatform,
        channel,
        layout: layout as ClipLayout | undefined,
        facecamPosition: facecamPosition as FacecamPosition | undefined,
        captionStyle: captionStyle as CaptionStyle | undefined,
        autoClip: Boolean(autoClip),
      });
      const liveNow = await isChannelLive(item.platform, item.channel);
      db.prepare(`UPDATE stream_watchlist SET is_currently_live=?, last_checked_at=? WHERE id=?`)
        .run(liveNow ? 1 : 0, new Date().toISOString(), item.id);
      res.json({ ok: true, item: { ...item, is_currently_live: liveNow ? 1 : 0 } });
    } catch (err) {
      handleErrorStatus(res, err);
    }
  });

  app.post('/api/watchlist/:id/toggle', (req, res) => {
    const { autoClip } = (req.body ?? {}) as { autoClip?: boolean };
    try {
      assertEntitlement('watchlist', false);
      toggleWatchlistAutoClip(req.params.id, Boolean(autoClip));
      res.json({ ok: true });
    } catch (err) {
      handleErrorStatus(res, err);
    }
  });

  app.delete('/api/watchlist/:id', (req, res) => {
    removeWatchlistChannel(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/watchlist/check-now', async (_req, res) => {
    try {
      assertEntitlement('watchlist', false);
      const items = await pollWatchlistStatuses(onWatchlistAutoStart);
      res.json({ ok: true, items });
    } catch (err) {
      handleErrorStatus(res, err);
    }
  });

  // ── Admin Authentication & Protected Routes (/api/admin/*) ─────────────
  app.get('/api/admin/me', (req, res) => {
    res.json({ ok: true, authenticated: hasAdminSession(req) });
  });

  app.post('/api/admin/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rateEntry = loginFailures.get(ip);
    if (rateEntry) {
      if (now - rateEntry.windowStartMs > LOGIN_WINDOW_MS) {
        loginFailures.delete(ip);
      } else if (rateEntry.count >= MAX_LOGIN_ATTEMPTS) {
        res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
        return;
      }
    }

    const { password } = (req.body ?? {}) as { password?: unknown };
    if (typeof password !== 'string') {
      recordLoginFailure(ip, now);
      res.status(400).json({ error: 'Password is required' });
      return;
    }

    const cleanPassword = password.trim();
    const storedHash = getSetting('admin_password_hash');
    if (!cleanPassword || !verifyPassword(cleanPassword, storedHash)) {
      recordLoginFailure(ip, now);
      res.status(401).json({ error: 'Invalid administrator password' });
      return;
    }

    loginFailures.delete(ip);
    const token = createSessionToken();
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`
    );
    logAuditEvent('admin', 'admin.login', 'session', ip);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/admin/overview', requireAdminAuth, (_req, res) => {
    const rawToken = (getSetting('kelviq_access_token') || process.env.KELVIQ_API_KEY || '').trim();
    const rawSecret = (getSetting('kelviq_webhook_secret') || process.env.KELVIQ_WEBHOOK_SECRET || '').trim();
    const rawEnv = (getSetting('kelviq_environment') || process.env.KELVIQ_ENV || 'production').trim().toLowerCase();
    const kelviqEnvironment = rawEnv === 'sandbox' ? 'sandbox' : 'production';
    const kelviqPortalUrl = (getSetting('kelviq_portal_url') || process.env.KELVIQ_PORTAL_URL || '').trim();
    const usingDefaultPassword = isUsingDefaultAdminPassword();

    const rawEvents = db.prepare(`SELECT * FROM kelviq_events ORDER BY received_at DESC LIMIT 50`).all() as Array<
      Record<string, unknown>
    >;
    const events = rawEvents.map((ev) => {
      let sanitizedRawJson = String(ev.raw_json ?? '{}');
      try {
        const parsed = JSON.parse(sanitizedRawJson);
        sanitizedRawJson = JSON.stringify(redactLicenseKeysInObject(parsed));
      } catch {
        // Leave unparseable string untouched
      }
      const lk = String(ev.license_key ?? '');
      return {
        ...ev,
        license_key: lk ? maskLicenseKeyValue(lk) : '',
        raw_json: sanitizedRawJson,
      };
    });

    const localLicenses = db.prepare(`SELECT * FROM local_licenses ORDER BY created_at DESC LIMIT 100`).all();

    res.json({
      ok: true,
      usingDefaultPassword,
      analytics: getDashboardAnalytics(),
      storage: getStorageInfo(),
      entitlement: getActiveEntitlement(),
      plans: listPlans(),
      events,
      localLicenses,
      settings: {
        kelviqTokenConfigured: Boolean(rawToken),
        kelviqTokenMasked: rawToken ? `${rawToken.slice(0, 6)}...${rawToken.slice(-4)}` : '',
        kelviqEnvironment,
        kelviqWebhookSecretConfigured: Boolean(rawSecret),
        kelviqPortalUrl,
        defaultWatermarkText: getSetting('default_watermark_text', 'Clipper Studio'),
        usingDefaultPassword,
      },
    });
  });

  app.put('/api/admin/plans/:id', requireAdminAuth, (req, res) => {
    const planId = String(req.params.id ?? '');
    if (!planExists(planId)) {
      res.status(404).json({ error: `Plan not found: ${planId}` });
      return;
    }
    try {
      const updated = updatePlanConfig(planId, (req.body ?? {}) as Partial<PlanRecord>);
      logAuditEvent('admin', 'plan.update', planId, req.ip || req.socket.remoteAddress || '');
      res.json({ ok: true, plan: updated });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/admin/settings', requireAdminAuth, (req, res) => {
    const {
      kelviqAccessToken,
      kelviqEnvironment,
      kelviqWebhookSecret,
      clearWebhookSecret,
      kelviqPortalUrl,
      defaultWatermarkText,
      newAdminPassword,
    } = (req.body ?? {}) as {
      kelviqAccessToken?: unknown;
      kelviqEnvironment?: unknown;
      kelviqWebhookSecret?: unknown;
      clearWebhookSecret?: unknown;
      kelviqPortalUrl?: unknown;
      defaultWatermarkText?: unknown;
      newAdminPassword?: unknown;
    };

    let shouldRotatePassword = false;
    if (newAdminPassword !== undefined && newAdminPassword !== '') {
      if (typeof newAdminPassword !== 'string' || newAdminPassword.trim().length < 8) {
        res.status(400).json({ error: 'New admin password must be at least 8 characters long' });
        return;
      }
      shouldRotatePassword = true;
    }

    if (typeof kelviqAccessToken === 'string' && !kelviqAccessToken.includes('...')) {
      setSetting('kelviq_access_token', kelviqAccessToken.trim());
    }
    if (typeof kelviqEnvironment === 'string') {
      setSetting('kelviq_environment', kelviqEnvironment === 'sandbox' ? 'sandbox' : 'production');
    }
    if (clearWebhookSecret === true) {
      setSetting('kelviq_webhook_secret', '');
    } else if (typeof kelviqWebhookSecret === 'string' && kelviqWebhookSecret.trim() !== '') {
      setSetting('kelviq_webhook_secret', kelviqWebhookSecret.trim());
    }
    if (typeof kelviqPortalUrl === 'string') {
      setSetting('kelviq_portal_url', kelviqPortalUrl.trim());
    }
    if (typeof defaultWatermarkText === 'string') {
      setSetting('default_watermark_text', defaultWatermarkText.trim());
    }

    if (shouldRotatePassword && typeof newAdminPassword === 'string') {
      setSetting('admin_password_hash', hashPassword(newAdminPassword.trim()));
      rotateSessionSecret();
      const freshToken = createSessionToken();
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(freshToken)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`
      );
    }

    logAuditEvent(
      'admin',
      shouldRotatePassword ? 'admin.password_rotated' : 'admin.settings_updated',
      'app_settings',
      req.ip || req.socket.remoteAddress || '',
    );

    res.json({ ok: true });
  });

  app.post('/api/admin/licenses/generate', requireAdminAuth, (req, res) => {
    const { planId, customerEmail, note, expiresDays } = (req.body ?? {}) as {
      planId?: unknown;
      customerEmail?: unknown;
      note?: unknown;
      expiresDays?: unknown;
    };
    const resolvedPlan = planId === undefined ? 'pro' : planId;
    if (typeof resolvedPlan !== 'string' || !VALID_PLAN_IDS.has(resolvedPlan as PlanId)) {
      res.status(400).json({ error: 'planId must be one of: free, pro, ultra' });
      return;
    }
    let parsedDays = 0;
    if (expiresDays !== undefined) {
      if (typeof expiresDays === 'number') {
        parsedDays = expiresDays;
      } else if (typeof expiresDays === 'string' && expiresDays.trim() !== '') {
        parsedDays = Number(expiresDays);
      } else {
        parsedDays = NaN;
      }
      if (!Number.isFinite(parsedDays) || parsedDays < 0) {
        res.status(400).json({ error: 'expiresDays must be a finite number >= 0' });
        return;
      }
    }

    const license = generateAdminLicenseKey(
      resolvedPlan as PlanId,
      typeof customerEmail === 'string' ? customerEmail.trim() : '',
      typeof note === 'string' ? note.trim() : 'Admin generated key',
      parsedDays
    );
    logAuditEvent(
      'admin',
      'license.generate',
      maskLicenseKeyValue(license.license_key),
      req.ip || req.socket.remoteAddress || '',
      { planId: resolvedPlan, expiresDays: parsedDays },
    );
    res.json({ ok: true, license });
  });

  app.post('/api/admin/licenses/revoke', requireAdminAuth, (req, res) => {
    const { licenseKey } = (req.body ?? {}) as { licenseKey?: unknown };
    if (typeof licenseKey !== 'string' || !licenseKey.trim()) {
      res.status(400).json({ error: 'licenseKey is required' });
      return;
    }
    const cleanKey = licenseKey.trim();
    db.prepare(`UPDATE local_licenses SET active=0 WHERE license_key=?`).run(cleanKey);
    logAuditEvent('admin', 'license.revoke', maskLicenseKeyValue(cleanKey), req.ip || req.socket.remoteAddress || '');
    res.json({ ok: true });
  });

  app.post('/api/admin/kelviq/test', requireAdminAuth, async (req, res) => {
    const { sampleLicenseKey } = (req.body ?? {}) as { sampleLicenseKey?: unknown };
    const kelviq = getKelviqClient();
    if (!kelviq) {
      res.status(400).json({ error: 'Kelviq API key is not configured yet' });
      return;
    }
    try {
      if (typeof sampleLicenseKey === 'string' && sampleLicenseKey.trim()) {
        const result = await kelviq.license.validate({ licenseKey: sampleLicenseKey.trim() });
        res.json({ ok: true, connected: true, result });
      } else {
        // Basic connectivity sanity test against Kelviq license validate endpoint
        try {
          const result = await kelviq.license.validate({ licenseKey: 'CHECK-CONN-0000' });
          res.json({ ok: true, connected: true, details: result });
        } catch (e: any) {
          const reachable = Boolean(e?.statusCode || e?.response);
          const details = {
            reachable,
            status: e?.statusCode ?? e?.response?.status ?? null,
            message: e?.message ?? 'Connection failed',
          };
          if (!reachable) {
            res.status(400).json({
              ok: false,
              connected: false,
              error: `Kelviq API unreachable: ${details.message}`,
              details,
            });
            return;
          }
          res.json({ ok: true, connected: true, details });
        }
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
}
