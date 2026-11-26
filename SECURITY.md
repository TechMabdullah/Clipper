# Security Policy & Hardening Architecture — Clipper Studio

## Local-First Security Model

Clipper Studio processes video streams, chat events, SQLite records, and AI metadata strictly on your local workstation (`127.0.0.1` by default). External network calls occur only for explicitly configured integrations (stream ingest, Kelviq licensing/checkout, optional Groq/OpenAI/Gemini AI keys, and Discord/Telegram notifications).

---

## Implemented Security Controls

### 1. Administrator Authentication & Session Hardening (`admin-routes.ts`, `db.ts`, `licensing.ts`, `admin.html`)

- **Salted `scrypt` Password Storage**: Admin passwords are hashed with per-record 16-byte random salts (`crypto.scryptSync(password, salt, 64)`) and verified using timing-safe comparison (`crypto.timingSafeEqual`).
- **Signed `HttpOnly` `SameSite=Strict` Sessions**: Successful login sets the `clipper_admin_session` cookie signed with `HMAC-SHA256` (`admin:<exp>:<sig>`, 24-hour expiration) and flags `HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`, verified via `crypto.timingSafeEqual`.
- **Minimum Password Length & Secret Rotation**: Updating the admin password via `PUT /api/admin/settings` requires at least 8 characters (`newAdminPassword.trim().length >= 8`), hashes the new password, calls `rotateSessionSecret()` to replace `admin_session_secret` in SQLite (invalidating all prior session cookies), and issues a fresh session cookie.
- **Default Password Warning Banner**: `isUsingDefaultAdminPassword()` detects when the initial `admin123` password is still active and displays a security alert banner and posture badge inside `/admin` until changed.
- **Brute-Force Protection & Route Guarding**: `POST /api/admin/login` locks out an IP after 8 failed login attempts within a 10-minute window (`429`). All protected `/api/admin/*` routes enforce `requireAdminAuth` (valid signed session cookie + local `Origin`/`Referer` check).

### 2. Local Origin/Referer CSRF Protection (`index.ts`, `admin-routes.ts`, `apps/notification-service/src/index.ts`)

- **Loopback-Only CORS**: Both `clipper-service` (`:4001`) and `notification-service` (`:4003`) permit cross-origin requests only from explicit loopback origins (`localhost`, `127.0.0.1`, `[::1]`). Untrusted `OPTIONS` preflight requests receive HTTP `403`.
- **Mutating Request Origin/Referer Validation**: State-changing `/api/*` requests (`POST`, `PUT`, `PATCH`, `DELETE`, excluding signed `POST /api/webhooks/kelviq`) validate `Origin` and `Referer` headers against `LOCAL_ORIGIN_RE` and reject untrusted sources with `403`.
- **Explicit CSRF / Auth Header on Destructive Clip Endpoints**: Both batch `DELETE /api/clipper/clips` (capped at 50 clips) and single-clip `DELETE /api/clipper/clips/:id` reject requests with `403` unless the caller supplies `X-Clipper-CSRF: 1`, an authenticated admin session, or a valid `csk_*` API key (`hasClipDeleteAuthorization()`). Deletions execute atomically across all child tables via `deleteClipCascade()` and unlink media files strictly through `safeUnlinkMediaFile()`. All browser UIs (`index.html`, `admin.html`, `upgrade.html`) and `clipper_tui.py` send `X-Clipper-CSRF: 1`.

### 3. Hashed `csk_*` API Keys (`db.ts`, `index.ts`, `admin.html`)

- **SHA-256 Storage & Constant-Time Verification**: External automation keys generated in `/admin` (`POST /api/admin/api-keys`) use the `csk_` prefix with 24 random bytes (hex-encoded). Only the `SHA-256` hash (`key_hash`), prefix (`csk_`), and `last4` characters are persisted in SQLite `api_keys` (legacy plaintext rows are automatically migrated to hashes on startup). Verification uses `crypto.timingSafeEqual`.
- **One-Time Reveal, Masked Listing & Instant Revocation**: Raw `csk_*` tokens are returned only once at creation time. `GET /api/admin/api-keys` lists masked tokens (`csk_***<last4>`), labels, and `last_used_at` timestamps. `DELETE /api/admin/api-keys/:id` sets `active = 0` for immediate revocation.
- **Optional Strict Enforcement (`REQUIRE_API_KEY`)**: When `REQUIRE_API_KEY="true"` is configured in `.env.local`, non-browser external requests to `/api/clipper/*` and `/api/studio/*` must present a valid `Authorization: Bearer csk_...` header (`401` otherwise).

### 4. Kelviq Webhook Verification & Replay Protection (`licensing.ts`, `admin-routes.ts`, `index.ts`)

- **Raw Body Signature Verification**: `POST /api/webhooks/kelviq` is mounted before `express.json()` with `express.raw({ type: 'application/json' })` so the exact raw `Buffer` payload is preserved.
- **Reject Unsigned Webhooks by Default (`403`)**: When `KELVIQ_WEBHOOK_SECRET` (or Admin setting `kelviq_webhook_secret`) is unset, incoming webhooks are rejected with HTTP `403` by default unless `KELVIQ_ALLOW_UNSIGNED_WEBHOOKS="true"` is explicitly set for local testing.
- **HMAC + 5-Minute Replay Freshness Window**: When a webhook secret is configured, payloads are verified with `@kelviq/node-sdk` `validateEvent()` and `webhook-timestamp` is checked to be within a 5-minute (`±300s`) replay window.
- **Automated License Revocation**: `license.revoked`, `license.disabled`, `license.expired`, `license.deleted`, and `subscription.canceled` / `cancelled` / `expired` / `revoked` events automatically revert matching active workstation licenses to Free.

### 5. Content Security Policy (CSP) & XSS Defense (`index.ts`, `index.html`, `admin.html`, `upgrade.html`)

- **Strict Security Headers**: `clipper-service` sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Content-Security-Policy` with `frame-ancestors 'none'`, `connect-src 'self' https://cdn.jsdelivr.net`, `media-src 'self' blob:`, and explicit `frame-src` embed allowlists (`'self'`, `https://player.twitch.tv`, `https://player.kick.com`, `https://www.youtube.com`, `https://www.youtube-nocookie.com`).
- **Zero Inline Event Handlers**: `index.html`, `admin.html`, and `upgrade.html` contain zero inline `on*=` HTML event attributes; interactions are wired via `addEventListener` and `data-*` attributes.
- **DOM Escaping & URL Validation**: Dynamic DOM content is escaped via `escapeHtml` / `escHtml`, and rendered checkout/media/image URLs are scheme-validated (`https:`, same-origin relative path, or strict `data:image/...;base64,...`).

### 6. Path Containment, Upload/CSV Sanitization, Command Hardening & SSRF Defense

- **Local Media Containment (`storage.ts`, `index.ts`)**: Local streaming (`/api/studio/stream`), clip file downloads (`/api/clipper/clips/:id/file`), public share streams (`/api/share/:token`), lazy thumbnail serving (`/api/clipper/clips/:id/thumbnail`), scheduled auto-clip local paths (`/api/studio/schedule-autoclip`), inbox cleanup, archiving (`/api/clipper/clips/:id/archive`), and clip deletions verify `isPathInsideMediaDirs()`, which resolves symlinks via `fs.realpathSync` and enforces `path.relative` containment inside `ClipperMedia` (`01_inbox`–`07_thumbs`) and explicitly user-selected Studio directories.
- **Clip Download & Collision-Safe Archiving (`index.ts`)**: `resolveSafeClipFilePath()` rejects empty/null-byte paths, checks containment before and after `fs.realpathSync()`, and verifies `fs.statSync(realPath).isFile()` before serving or archiving. `POST /api/clipper/clips/:id/archive` moves clips only between verified media directories using collision-safe `<name>_<timestamp><ext>` naming inside `04_archive/` (or `03_clips/` on unarchive).
- **Music Upload Magic-Byte Validation (`studio.ts`, `index.ts`)**: `POST /api/studio/music/upload` restricts filenames to `^[a-zA-Z0-9._-]{1,80}\.(mp3|wav|m4a|aac|ogg)$`, rejects path separators/`..`/dotfiles/null bytes, enforces a `15 MiB` payload limit (`413` on overflow), and validates container/frame magic bytes via `detectAudioMagicBytes()` (ID3 / MPEG sync for `.mp3`, `RIFF`/`WAVE` for `.wav`, `OggS` for `.ogg`, `ftyp` for `.m4a`, `ftyp`/ADTS sync for `.aac`) before writing into `06_music/`.
- **Formula-Injection-Safe CSV Export (`studio.ts`, `index.ts`)**: `GET /api/clipper/clips/export.csv` formats every cell with `escapeCsvCell()`, applying RFC-4180 double-quote escaping and prepending a single quote (`'`) whenever a cell (or its `trimStart()`) begins with `=`, `+`, `-`, `@`, `\t`, or `\r` to neutralize OWASP spreadsheet formula injection.
- **Root & System Directory Blocking (`index.ts`)**: `isSystemOrRootDirectory()` and `validateLocalVideoFilePath()` reject null bytes, unsupported extensions (allowing only `.mp4`, `.mkv`, `.mov`, `.webm`, `.ts`, `.flv`, `.avi`), filesystem roots, and OS/system directories (`C:\Windows`, `Program Files`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/boot`, `/dev`, `/proc`, `/sys`, `/root`).
- **FFmpeg `drawtext` Escaping & Argument-Array Spawning (`layout-utils.ts`, `downloader.ts`, `studio.ts`, `stream-buffer.ts`)**:
  - `escapeDrawtextText()` strips control characters/newlines, escapes `\`, `:`, `,`, `;`, `[`, `]`, `=`, and `'`, and sets `expansion=none` before passing hook/watermark text to FFmpeg `-filter_complex`.
  - External processes (`ffmpeg`, `ffprobe`, `yt-dlp`, `streamlink`, `python`, `whisper`, `git`) are invoked via `spawn` / `execFile` argument arrays without shell string interpolation, and `yt-dlp` invocations pass `--` option-end separators before target URLs.
- **SSRF IPv4/IPv6 Blocking, Outbound Webhooks & Proxy Byte Limits (`studio.ts`, `index.ts`, `features/webhooks.ts`)**:
  - `assertSafeRemoteUrl()` / `isBlockedIpAddress()` enforce `http:`/`https:` schemes, disallow embedded credentials (`user:pass@`), reject `.localhost`, `.local`, and `.internal` hostnames, resolve DNS records, and block private/loopback/link-local/CGNAT/multicast IPv4 (`0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `224.0.0.0/4+`) and IPv6 (`::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, plus IPv4-mapped `::ffff:` and `::` addresses).
  - Remote proxies (`/api/studio/hls-proxy`, `/api/studio/media-proxy`) manually validate up to 3 redirect hops (`redirect: 'manual'`) and enforce byte caps (`5 MiB` for HLS playlists/segments, `50 MiB` for progressive media proxy, returning HTTP `413` on overflow).
  - Admin outbound webhooks (`POST /api/admin/webhooks`, `dispatchOutboundWebhookSingle()`) require `https:` via `assertSafeRemoteUrl(..., { requireHttps: true })`, disable redirects (`redirect: 'error'`), mask signing secrets (`whsec_***<last4>`) in listings, and sign payloads with `HMAC-SHA256` (`X-Clipper-Signature-256: sha256=...`, `X-Clipper-Timestamp`, `X-Clipper-Event`).
- **Platform Input Sanitization (`chat-tracker.ts`, `live-manager.ts`, `watchlist.ts`)**:
  - Twitch IRC channel names strip all characters outside `[a-z0-9_]` (`replace(/[^a-z0-9_]/g, '')`), preventing CR/LF IRC command injection.
  - Kick channel slugs are validated against `^[a-zA-Z0-9_-]{1,64}$` and URL-encoded via `encodeURIComponent()` (as are Twitch/YouTube channel and video identifiers in API calls and embed URLs).
- **Notification Service Loopback Bind, Headers, Webhook SSRF & Attachment Containment (`apps/notification-service/src/index.ts`)**:
  - Binds to `HOST` (`127.0.0.1` by default) and sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin` on all responses.
  - `assertSafeWebhookUrl()` requires `https:`, rejects credentials and local/internal hostnames, validates literal and DNS-resolved IPv4/IPv6 addresses against `isBlockedIpAddress()`, disables HTTP redirects (`redirect: 'error'`), caps JSON bodies at 64 KiB, and enforces loopback CORS/Origin/Referer checks.
  - `resolveSafeAttachPath()` rejects null bytes and non-video extensions, resolves symlinks via `fs.realpathSync()`, blocks OS/root paths via `isBlockedSystemOrRootPath()`, enforces `MEDIA_ROOT_DIR` containment when configured, and bounds optional media attachments (`20 MiB` Discord / `50 MB` Telegram).

### 7. Public Share Link Security (`features/clip-share.ts`, `db.ts`, `index.ts`)

- **Salted `scrypt` Share Passwords & Masked Listings**: Password-protected share links hash passwords with per-link 16-byte random salts (`crypto.scryptSync(password, salt, 64)`) and verify them via `crypto.timingSafeEqual()`. `listClipShares()` and `POST /api/clipper/clips/:id/shares` omit `password_hash` and return only `has_password: 0 | 1`.
- **Auth-Tier Rate Limiting**: `POST /api/share/:token/access` is classified under the `auth` rate-limit tier (`20 req/min` per IP) to throttle share password brute-forcing.
- **Short-Lived HMAC `?grant=` Streaming URLs**: Passing `POST /api/share/:token/access` returns a 5-minute (`300s`) `HMAC-SHA256`-signed `streamUrl` (`/api/share/:token?grant=<exp>.<sig>`, signed with `admin_session_secret` and verified via `crypto.timingSafeEqual()`), ensuring share passwords never appear in URL query strings, browser history, or server logs.
- **Expiration & Max-View Enforcement**: `validateClipShareAccess()` enforces `expires_at` timestamps (`403` when expired) and `max_views` ceilings (`403` once reached) atomically before incrementing `view_count`.

### 8. Tiered Rate Limiting, Snapshot Auth, Audit Logs & Live Security Self-Audit (`index.ts`, `admin-routes.ts`, `db.ts`, `licensing.ts`)

- **Tiered Per-IP Rate Limiting**: `/api/*` (excluding `/api/live/chat/stream` SSE) enforces `20 req/min` on auth routes (`/api/admin/login`, `/api/billing/activate`, `POST /api/share/:token/access`), `60 req/min` on mutating requests, and `240 req/min` on read requests.
- **Admin-Protected Stream Telemetry**: Reading (`GET /api/studio/snapshots/sessions`, `GET /api/studio/snapshots/:sessionId`) and pruning (`DELETE /api/studio/snapshots`) stream health snapshots require `requireAdminAuth`.
- **Security & Admin Audit Log (`audit_logs`)**: Admin logins, plan updates, settings/password changes, VIP key generation/revocation, API key creation/revocation, outbound webhook operations, collections/ratings/chapters/comments/shares/A/B operations, CSV exports, music uploads, manual clip metadata updates, scheduled job create/delete, clip archive/unarchive, and single/batch clip deletions are persisted to `audit_logs` and exposed via admin-protected `GET /api/admin/audit-log`.
- **Redacted Webhook Event Logs**: License keys inside stored and displayed `kelviq_events` (`GET /api/admin/event-log`, `GET /api/admin/overview`) are masked via `maskLicenseKeyValue()` and `redactLicenseKeysInObject()`, with additional field masking in the `/admin` JSON previewer.
- **Live Admin Security Self-Audit (`GET /api/admin/security-scan`)**: Admin-authenticated runtime posture scan scoring 8 security checks (`0–100`): custom admin password, Kelviq webhook HMAC verification, loopback network bind, `REQUIRE_API_KEY` enforcement, active tiered rate limiter, CSRF Origin/Referer guard, CSP `frame-ancestors 'none'`, and share-link expiration/password coverage.

---

## Production & Hardening Recommendations

- **Change `ADMIN_PASSWORD` immediately** from the default (`admin123`) in `.env.local` or inside `/admin` (minimum 8 characters).
- **Keep `HOST="127.0.0.1"`** unless intentionally placing the service behind an authenticated reverse proxy.
- **Configure `KELVIQ_WEBHOOK_SECRET`** before enabling public Kelviq webhooks; never set `KELVIQ_ALLOW_UNSIGNED_WEBHOOKS="true"` outside isolated local testing.
- **Enable `REQUIRE_API_KEY="true"`** and issue scoped `csk_*` bearer keys in `/admin` when external automation scripts call `/api/clipper/*` or `/api/studio/*`.
- **Back up before upgrading**: Use `.\update.ps1` (Windows) or `./update.sh` (macOS/Linux) to automatically snapshot `.env.local` and SQLite databases to `data/backups/<timestamp>/` prior to pulling changes.
