import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
const PORT = Number(process.env.GATEWAY_PORT ?? 4000);
const BRIDGE_SECRET = process.env.INTERNAL_BRIDGE_SECRET ?? '';

// ── Public OAuth callback paths — no bridge-secret check ──────────────────
const PUBLIC_PATHS = [
  '/api/publisher/auth/youtube/callback',
  '/api/publisher/auth/meta/callback',
  '/api/publisher/auth/tiktok/callback',
];

// ── Bridge-secret authentication middleware ───────────────────────────────
app.use((req, res, next) => {
  if (PUBLIC_PATHS.some((p) => req.path.startsWith(p))) return next();
  if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

// ── Health probe (Vercel cron heartbeat target) ───────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Reverse-proxy routes ──────────────────────────────────────────────────
const proxyOpts = (target: string) => ({
  target,
  changeOrigin: true,
  pathRewrite: (p: string) => p,
});

app.use(
  '/api/clipper',
  createProxyMiddleware(proxyOpts(process.env.CLIPPER_SERVICE_URL ?? 'http://localhost:4001')),
);
app.use(
  '/api/publisher',
  createProxyMiddleware(proxyOpts(process.env.PUBLISHER_SERVICE_URL ?? 'http://localhost:4002')),
);
app.use(
  '/api/notifications',
  createProxyMiddleware(proxyOpts(process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:4003')),
);

app.listen(PORT, () => {
  console.log(`[api-gateway] listening on :${PORT}`);
});
