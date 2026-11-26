# 🎬 Clipper Studio — Local-First AI Live & VOD Viral Clipper

A high-performance, **local-first** AI video clipping SaaS suite and real-time live stream chat velocity monitor. It captures live streams and VODs from **Twitch**, **Kick**, and **YouTube**, listens for sudden chat explosions, keyword triggers (`!clip`), or loudest audio reaction peaks, and automatically renders **9:16**, **4:5**, **1:1**, and **16:9** clips with OpenCV facecam tracking, kinetic auto-captions, broadcast `-14 LUFS` audio normalization, background music mixing, and AI virality scoring.

All video processing, rolling stream buffers, OpenCV webcam tracking, FFmpeg rendering, and SQLite records run strictly on your local PC — with **zero cloud video storage fees**, complete user privacy, **Kelviq Merchant-of-Record** licensing & admin controls, and built-in security hardening ([`SECURITY.md`](SECURITY.md)).

---

## 🤖 AI Agent & Automated Setup Protocol

> [!TIP]
> **Instructions for AI Assistants (Claude Code, Cursor, Copilot, Codex, Aider, etc.)**:
> Follow the deterministic step-by-step setup procedure below to install, configure, verify, and run Clipper Studio without manual intervention.

### Step 1: Verify Host Prerequisites

Run these commands to confirm system binaries are installed:

```bash
# Node.js 22+
node -v

# pnpm package manager (install via: npm install -g pnpm)
pnpm -v

# FFmpeg & FFprobe with libx264 & aac
ffmpeg -version
ffprobe -version

# Streamlink live stream recorder & yt-dlp VOD/past-stream resolver
streamlink --version
yt-dlp --version

# Python 3.10+
python --version
```

*Binary installation shortcuts if missing:*
- **Windows (Winget)**: `winget install Gyan.FFmpeg Streamlink.Streamlink yt-dlp.yt-dlp --source winget`
- **macOS (Homebrew)**: `brew install ffmpeg streamlink yt-dlp`
- **Linux (Ubuntu/Debian)**: `sudo apt update && sudo apt install -y ffmpeg streamlink yt-dlp python3-pip`

### Step 2: Install Node & Python Dependencies

```bash
# 1. Install Node.js monorepo dependencies (allows native esbuild/nx build scripts on pnpm v10+)
pnpm install --allow-build esbuild --allow-build nx

# 2. Install Python computer vision & TUI packages
pip install -r requirements.txt
```

> [!IMPORTANT]
> **OpenCV Version Pin**: Keep `opencv-python==4.10.0.84`. Do not upgrade to OpenCV 5.x alpha as it removes `cv2.CascadeClassifier` needed for streamer webcam tracking.

### Step 3: Initialize Environment

```bash
# Copy example environment configuration
# Windows PowerShell:
Copy-Item .env.example .env.local

# Linux / macOS / Bash:
cp .env.example .env.local
```

> [!WARNING]
> **Change `ADMIN_PASSWORD` immediately**: `.env.example` ships with `ADMIN_PASSWORD="admin123"`. Set a strong password (minimum 8 characters) in `.env.local` or via `/admin` before sharing or exposing your instance.

*Storage Note for Agents:* Do not hardcode drive letters in `.env.local`. Clipper Studio automatically detects whether the machine has a secondary disk (e.g. `D:\ClipperMedia`) or a single disk (e.g. `C:\ClipperMedia` or `./ClipperMedia`), and initializes `01_inbox` through `07_thumbs` on boot.

### Step 4: Verify Monorepo Build & Type Integrity

```bash
pnpm nx run-many -t build typecheck
python -m py_compile clipper_tui.py apps/clipper-service/src/live/detect_face.py
```
*Expected result: 0 errors (exits with code 0).*

### Step 5: Start Services & Launch TUI

```bash
# Start backend services (clipper-service on :4001 and notification-service on :4003)
pnpm dev

# Windows PowerShell helper (creates .env.local if missing, sets default env vars, runs pnpm dev):
.\start-clipper.ps1
```

Once backend services are running, open the Web Dashboard at **`http://localhost:4001`** or launch the Python Terminal UI in another terminal:

```bash
# Via pnpm or Python
pnpm tui
python clipper_tui.py

# Windows double-click / batch launcher for the Python TUI & CLI
clipper.bat
```

### Step 6: Automated Health Check Verification

Test that the services, storage auto-discovery, and billing subsystem are online:

```bash
# 1. Verify live clipper API status
curl -s http://localhost:4001/api/live/status

# 2. Verify storage engine & disk detection (01_inbox .. 07_thumbs)
curl -s http://localhost:4001/api/storage/info

# 3. Verify Kelviq plan/entitlement status
curl -s http://localhost:4001/api/billing/status

# 4. Verify tool version & upstream status
curl -s "http://localhost:4001/api/system/version?checkRemote=1"

# 5. Verify Python CLI controller
python clipper_tui.py --status
python clipper_tui.py --plan-status
```
*Expected JSON from `/api/storage/info`:*
```json
{
  "mediaRoot": "...",
  "inbox": ".../01_inbox",
  "tempDir": ".../02_temp",
  "clipsDir": ".../03_clips",
  "archiveDir": ".../04_archive",
  "recordingsDir": ".../05_streams",
  "musicDir": ".../06_music",
  "thumbsDir": ".../07_thumbs",
  "isSingleDisk": true/false
}
```

---

## 🔄 Updating Your Tool Installation (Repo Updater)

Clipper Studio includes dedicated cross-platform repository updaters — [`update.ps1`](update.ps1) (Windows PowerShell) and [`update.sh`](update.sh) (macOS/Linux Bash) — so you can pull new releases without losing local databases, licenses, or configuration.

### Running the Updater

```powershell
# Windows (PowerShell)
.\update.ps1                # Interactive update with automatic backup
.\update.ps1 -Check         # Check upstream commits without modifying files
.\update.ps1 -AutoStash     # Automatically stash uncommitted changes, pull, and restore
.\update.ps1 -SkipPython    # Skip pip upgrade & Python py_compile checks
.\update.ps1 -Yes           # Skip interactive stash confirmation prompt
```

```bash
# macOS / Linux (Bash)
./update.sh                 # Interactive update with automatic backup
./update.sh --check         # Check upstream commits without modifying files
./update.sh --auto-stash    # Automatically stash uncommitted changes, pull, and restore
./update.sh --skip-python   # Skip pip3 upgrade & Python py_compile checks
./update.sh --yes           # Skip interactive stash confirmation prompt (alias: -y)
```

### What the Updater Performs Automatically

1. **Pre-Pull Backups (`data/backups/<timestamp>/`)**: Snapshots all SQLite databases (`clipper.sqlite*`, `notifications.sqlite*`) and `.env.local` (`.env.local.bak`) into `data/backups/<YYYYMMDD-HHMMSS>/` before pulling changes.
2. **Safe Dirty-Tree Handling**: Prompts to stash uncommitted edits (or auto-stashes with `-AutoStash` / `--auto-stash` or `-Yes` / `--yes`), performs `git pull --ff-only`, and re-applies stashed changes (`git stash pop`).
3. **Environment Key Sync**: Syncs newly added keys from [`.env.example`](.env.example) into `.env.local` without overwriting your existing values (or creates `.env.local` if missing).
4. **Dependency & Build Verification**:
   - Runs `pnpm install --allow-build esbuild --allow-build nx`.
   - Unless `-SkipPython` / `--skip-python` is passed, upgrades Python packages from `requirements.txt` and validates `clipper_tui.py` and `apps/clipper-service/src/live/detect_face.py` via `py_compile`.
   - Runs `pnpm nx run-many -t build typecheck` to confirm TypeScript builds and types pass cleanly.
5. **Running-Service Notice**: On Windows, warns if ports `4001`/`4003` are still listening so you remember to restart `pnpm dev` / `.\start-clipper.ps1`.

### Built-In Update Checking (Web UI, API & TUI)

- **Web Dashboard (`/`)**: Click the topbar version pill (`v<version> (<commit>)`) to open the **Check Updates** modal, inspect upstream commit count, and copy `.\update.ps1` / `./update.sh`.
- **Upgrade & Admin Pages (`/upgrade`, `/admin`)**: Both pages include a **System Version / Repository Updater** panel with a **Check Upstream Updates** button and quick-copy updater commands.
- **HTTP Endpoint**: `GET /api/system/version` returns package version, branch, commit SHA, and dirty state; pass `?checkRemote=1` to fetch upstream Git status (`remote.updateAvailable`, `remote.ahead`, `remote.behind`, `remote.remoteCommit`).
- **Python TUI / CLI**:
  ```bash
  python clipper_tui.py --check-update       # Print local version & upstream update status
  python clipper_tui.py --update-tool        # Run update.ps1 (Windows) or update.sh (macOS/Linux)
  python clipper_tui.py --update-tool -y     # Run updater without confirmation prompt
  ```

---

## 🗺️ Project File Map (For Agents & Developers)

| File / Directory | Description |
|:---|:---|
| [`apps/clipper-service/src/index.ts`](apps/clipper-service/src/index.ts) | **Express API Server (`:4001`)**: Live clipper endpoints, VOD Studio routes, montage, presets, collections, ratings, chapters, review comments, A/B title testing, expiring/password share links, social upload queue, stream health snapshots, scheduled auto-clip cron, diagnostics, analytics, system version, SSE chat/progress streams, `/upgrade`, `/admin`, `/api/webhooks/kelviq`, admin security self-audit, and security middleware. |
| [`apps/clipper-service/src/storage.ts`](apps/clipper-service/src/storage.ts) | **Storage Engine**: Single-disk / secondary-disk auto-discovery; creates `01_inbox` through `07_thumbs` and enforces `isPathInsideMediaDirs` realpath containment. |
| [`apps/clipper-service/src/db.ts`](apps/clipper-service/src/db.ts) | **SQLite Store & Migrations**: Jobs, clips (virality, tags, notes, favourites, thumbnails, social metadata, aspect ratio, archived flag), plans, licenses, Kelviq events, watchlist, hashed `api_keys`, `audit_logs`, `scheduled_jobs`, `clip_presets`, `outbound_webhooks`, `clip_collections`, `clip_collection_items`, `clip_ratings`, `clip_chapters`, `clip_comments`, `clip_shares`, `ab_experiments`, `social_upload_queue`, and `stream_snapshots`. |
| [`apps/clipper-service/src/licensing.ts`](apps/clipper-service/src/licensing.ts) | **Kelviq Licensing & Entitlements**: `@kelviq/node-sdk` activation/validation, local VIP keys, daily quotas, `402` gating, webhook HMAC + 5-minute replay verification, key masking. |
| [`apps/clipper-service/src/admin-routes.ts`](apps/clipper-service/src/admin-routes.ts) | **Billing, Watchlist & Admin API**: `/api/billing/*`, `/api/watchlist/*`, `scrypt` + HMAC cookie-signed `/api/admin/*`, and raw-body Kelviq webhook middleware. |
| [`apps/clipper-service/src/studio.ts`](apps/clipper-service/src/studio.ts) | **After-Live VOD Studio**: Local recordings, past broadcasts, media probing, SSRF URL validator, `yt-dlp` VOD downloads, audio peak scanning, manual cutting, batch auto-clip, montage compiler. |
| [`apps/clipper-service/src/live/live-manager.ts`](apps/clipper-service/src/live/live-manager.ts) | **Live Session Orchestrator**: Coordinates rolling 240s buffer, explosion/keyword triggers, entitlement checks, and clip rendering. |
| [`apps/clipper-service/src/live/stream-buffer.ts`](apps/clipper-service/src/live/stream-buffer.ts) | **Stream Buffer & FFmpeg Pipeline**: Circular `.ts` segment buffer, live PNG snapshots, and full stream export to `05_streams/`. |
| [`apps/clipper-service/src/live/layout-utils.ts`](apps/clipper-service/src/live/layout-utils.ts) | **7-Layout FFmpeg Filter Builder**: `split`, `split-crop`, `portrait-4x5`, `square`, `crop`, `blur`, `landscape`, escaped hook banner & watermark, `-14 LUFS`. |
| [`apps/clipper-service/src/live/chat-tracker.ts`](apps/clipper-service/src/live/chat-tracker.ts) | **Chat Velocity & Keyword Tracker**: Twitch IRC WS, Kick Centrifugo WS, YouTube LiveChat, hype emote weighting, and `!clip` triggers. |
| [`apps/clipper-service/src/live/detect_face.py`](apps/clipper-service/src/live/detect_face.py) | **OpenCV Facecam Tracker**: Edge-weighted Haar Cascade facial recognition for streamer corner webcams. |
| [`apps/clipper-service/src/features/audio-peaks.ts`](apps/clipper-service/src/features/audio-peaks.ts) | **Audio Peak Hype Scanner & Virality AI**: Zero-API FFmpeg RMS loudness scanner and 0–100 Virality Potential scoring. |
| [`apps/clipper-service/src/features/captions.ts`](apps/clipper-service/src/features/captions.ts) | **Kinetic Captions & `.srt`**: Word-level STT (Groq Whisper, OpenAI Whisper, or `whisper.cpp`) into styled `.ass` (`hormozi`/`neon`/`minimal`) and `.srt`. |
| [`apps/clipper-service/src/features/audio-fx.ts`](apps/clipper-service/src/features/audio-fx.ts) | **Broadcast Audio FX & Music Mixer**: `-14 LUFS` normalization, FFmpeg `silencedetect` dead-air trimmer, and `06_music/` mixing. |
| [`apps/clipper-service/src/features/metadata-ai.ts`](apps/clipper-service/src/features/metadata-ai.ts) | **Thumbnails & Social AI**: Extracts cover JPEGs into `07_thumbs/` and generates punchy social titles + `#hashtags` (Gemini/OpenAI/local). |
| [`apps/clipper-service/src/features/watchlist.ts`](apps/clipper-service/src/features/watchlist.ts) | **Stream Watchlist Scheduler**: Polls Twitch/Kick/YouTube live status every 60s and auto-starts clipping when channels go live. |
| [`apps/clipper-service/src/features/clip-comments.ts`](apps/clipper-service/src/features/clip-comments.ts) | **Timestamped Review Comments**: Add, list, resolve/unresolve, and delete editor feedback anchored to clip timestamps. |
| [`apps/clipper-service/src/features/clip-share.ts`](apps/clipper-service/src/features/clip-share.ts) | **Public Share Access Validator**: Verifies expiration, max-view limits, and `scrypt` passwords before issuing streaming grants. |
| [`apps/clipper-service/src/features/ab-testing.ts`](apps/clipper-service/src/features/ab-testing.ts) | **A/B Title Testing**: Round-robin variant assignment (`a`/`b`), view/click tracking, and CTR winner computation. |
| [`apps/clipper-service/src/features/social-upload.ts`](apps/clipper-service/src/features/social-upload.ts) | **Social Upload Queue**: Per-platform export queue (`youtube`, `tiktok`, `instagram`, `twitter`, `twitch_clips`) with status tracking and stats. |
| [`apps/clipper-service/src/features/stream-health.ts`](apps/clipper-service/src/features/stream-health.ts) | **Live Stream Health Scorer**: Computes `0–100` health score and `rising` / `falling` / `stable` velocity trend from `stream_snapshots`. |
| [`apps/clipper-service/src/features/webhooks.ts`](apps/clipper-service/src/features/webhooks.ts) | **Signed Outbound Webhooks**: HTTPS SSRF-guarded dispatch (`clip.ready`, `live.explosion`, `job.completed`) with `X-Clipper-Signature-256` HMAC headers. |
| [`apps/clipper-service/src/public/index.html`](apps/clipper-service/src/public/index.html) | **SaaS Creator Web Dashboard (`/`)**: Analytics overview, live player + SSE chat preview, VOD studio + Safe-Zone guide + scheduled jobs, clips gallery, collections, ratings, chapters/comments/shares/A/B drawers, upload queue, presets, update & Kelviq modals. |
| [`apps/clipper-service/src/public/upgrade.html`](apps/clipper-service/src/public/upgrade.html) | **Plan Upgrade & Licensing Page (`/upgrade`)**: Tier comparison cards, email-prefilled Kelviq Checkout, license key activation, FAQ, and updater box. |
| [`apps/clipper-service/src/public/admin.html`](apps/clipper-service/src/public/admin.html) | **Protected Admin Console (`/admin`)**: Plan pricing/quota editor, Kelviq API/webhook config, VIP license generator, `csk_*` API key manager, outbound webhooks, live security self-audit scan, redacted event log, and security audit log. |
| [`apps/notification-service/src/index.ts`](apps/notification-service/src/index.ts) | **Notification Service (`:4003`)**: Local loopback Discord webhook (`https:` SSRF-guarded) and Telegram bot clip-ready & error notifications. |
| [`clipper_tui.py`](clipper_tui.py) | **Cross-Platform Python TUI & CLI**: Rich terminal dashboard, Kelviq `[K]` & Upgrade `[U]`, `[P]` Presets Manager, `[D]` Diagnostics Doctor, `[M]` studio + audio peaks, `[G]` gallery (ratings, tags/notes/favourites, re-export `r1`, Creator Kit `k1`, upload queue `u1`, CSV `csv`, batch metadata `bmeta`, montage), and full CLI flags. |
| [`update.ps1`](update.ps1) / [`update.sh`](update.sh) | **Safe Repo Updaters**: Git upstream check, SQLite & `.env.local` backup, env key sync, `pnpm install`, Python check, and Nx build/typecheck. |
| [`start-clipper.ps1`](start-clipper.ps1) / [`clipper.bat`](clipper.bat) | **Windows Launchers**: `start-clipper.ps1` starts backend services (`pnpm dev`); `clipper.bat` launches `clipper_tui.py`. |
| [`.env.example`](.env.example) | **Environment Template**: Ports, storage override, Admin password, `REQUIRE_API_KEY`, Kelviq keys, Groq/OpenAI Whisper keys, LLM & alert hooks. |
| [`SECURITY.md`](SECURITY.md) | **Security Policy & Hardening Architecture**: Detailed documentation of authentication, CSRF, hashed API keys, CSP, SSRF, path containment, and audit logging. |

---

## 🌟 Core System & SaaS Features

- **🔴 Multi-Platform Live Monitoring + Live Chat Preview (SSE)**:
  - **Twitch**: Anonymous IRC WebSocket chat + Streamlink ad-bypass capture.
  - **Kick**: Guest Centrifugo WebSocket (`wss://realtime.us-east-1.platform.kick.com/connection/websocket`) + Streamlink capture.
  - **YouTube**: `youtube-chat` live feed + Streamlink capture.
  - **Live Chat Preview**: Real-time Server-Sent Events (`/api/live/chat/stream`) stream chat messages, hype badges, and explosion markers directly to the Web UI and TUI.
- **💥 Chat Explosion & Custom Keyword Triggers**:
  - Evaluates real-time chat velocity (msg/s) + hype emote boost against a 60-second rolling baseline ($\ge 2.5\times$ baseline and $\ge 4.0$ msg/s).
  - **Custom Chat Keyword Triggers**: Default `!clip`, `clip it`, `clipped` (or custom `--triggers`) automatically trigger a clip when typed $\ge 2$ times within 6 seconds — ideal for smaller/low-viewer streams.
  - **Strict Window Rules**: Starts **10 seconds before** spike ($T_{\text{spike}} - 10\text{s}$), **20s minimum**, **40s maximum**, with **Dynamic Hype Extension** while chat stays elevated.
- **🎬 7 Aspect Ratio Layouts & OpenCV Facecam Tracking**:
  - `split`: **9:16** Facecam Top (`1080×720`) + Ambient Blurred Full 16:9 Gameplay Bottom (`1080×1200`).
  - `split-crop`: **9:16** Facecam Top + Center-Cropped Gameplay Bottom.
  - `portrait-4x5`: **4:5** (`1080×1350`) Instagram/Facebook Feed with ambient blurred backdrop.
  - `square`: **1:1** (`1080×1080`) X/Twitter & LinkedIn Feed with ambient blurred backdrop.
  - `crop`: **9:16** (`1080×1920`) Action Center Crop.
  - `blur`: **9:16** (`1080×1920`) Full frame centered over blurred backdrop.
  - `landscape`: **16:9** Widescreen original aspect ratio.
  - OpenCV Haar Cascades (`cv2.CascadeClassifier`) detect corner webcams across multiple segments to avoid gameplay transitions.
- **✂ After-Live VOD Studio, Stream Recordings (`05_streams/`) & Scheduled Auto-Clip**:
  - Enable `saveRecording` (or call `POST /api/live/save-recording` mid-stream) to save full sessions to `05_streams/`.
  - Browse past live broadcasts on Twitch, Kick, or YouTube, stream locally via HTTP 206 byte-range or HLS CORS proxy (`/api/studio/hls-proxy`), preview TikTok/Shorts/Reels UI Safe-Zone guides, or download VODs offline.
  - Schedule recurring cron-based AI auto-clipping jobs (`/api/studio/schedule-autoclip`) persisted in SQLite (`scheduled_jobs`).
- **⚡ Local Audio Peak Hype Scanner & Virality Score (`0–100`)**:
  - Runs FFmpeg `astats` RMS loudness analysis locally (**zero API cost**) to rank loudest screams, laughs, and clutch reactions.
  - Scores every rendered clip `0–100` (`virality_score` + `virality_reason`) based on chat spike multiplier, audio peak dB delta, Shorts pacing (`18–42s`), facecam split, kinetic captions, and hook dialogue.
- **💬 Kinetic Word-Level Auto-Captions & `.srt` Subtitles (`PRO`)**:
  - Transcribes clip audio via **Groq** (`whisper-large-v3-turbo`), **OpenAI** (`whisper-1`), or local **`whisper.cpp`**, burning animated `.ass` subtitles in `hormozi` (bold yellow pop), `neon` (cyan/magenta glow), or `minimal` styles.
  - Export clean `.srt` subtitle files via `GET /api/clipper/clips/:id/srt`.
- **🔊 Broadcast Audio FX (`-14 LUFS`), Silence Trimmer & Music Mixer (`06_music/`)**:
  - Applies `highpass=f=80,acompressor=threshold=-18dB:ratio=3,loudnorm=I=-14:TP=-1.5:LRA=11` for crisp voice clarity.
  - Trims dead-air pauses cleanly using FFmpeg `silencedetect` (`silenceCut` / `--silence-cut`).
  - Mixes background tracks from `06_music/` (`/api/studio/music`) at configurable volume (`musicVolume`, default `0.18` via CLI / `0.15` in Web Studio).
- **🏷️ Hook Headline Overlay, Auto Thumbnails (`07_thumbs/`) & Social AI**:
  - Burn a 3.5-second bold top hook headline banner (`hookTitleText` / `--hook`) to maximize 3-second retention.
  - Extract JPEG cover thumbnails into `07_thumbs/` (`/api/clipper/clips/:id/thumbnail`) and generate viral short-form titles, descriptions & `#hashtags` (`/api/clipper/clips/:id/metadata` using Gemini, OpenAI, or smart local fallback, or save manual edits).
- **🚀 Batch VOD Auto-Clipper, Montage Compiler & Clips Organization**:
  - One-click **Batch Auto-Clip Top N Moments** (`/api/studio/auto-clip-batch`) scans audio peaks and renders the top hype highlights automatically.
  - **Montage Compiler** (`/api/studio/compile-montage`) stitches 2–20 selected clips into a single compilation reel with optional `-14 LUFS` normalization and background music.
  - Organize rendered clips with **⭐ Favourites**, **tags** (`a-z0-9-`), **notes**, search filtering, archive/unarchive (`04_archive/`), and CSRF-protected single or batch deletion (`DELETE /api/clipper/clips/:id`, `DELETE /api/clipper/clips`).
- **🗂️ Collections, 5-Star Ratings, Chapters & Timestamped Review Comments**:
  - **Collections**: Group clips into color-coded named playlists/collections (`clip_collections`), assign ordered positions, and query clip memberships via `GET /api/clipper/clips/:id/collections`.
  - **5-Star Ratings**: Rate any clip `1–5` stars (`/api/clipper/clips/:id/rate`) and surface best takes via `GET /api/clipper/clips/top-rated`.
  - **Chapters**: Add, list, and delete timestamped chapter markers (`clip_chapters`) per clip.
  - **Review Comments**: Leave timestamp-anchored review notes (`clip_comments`), toggle resolved/unresolved status, and track unresolved counts across the library.
- **🔗 Expiring & Password-Protected Share Links & A/B Title Testing**:
  - **Share Links**: Create public `/api/share/:token` links with optional expiration (`0.1–8760` hours), max view limits (`1–100,000`), `scrypt` password protection, and HMAC-signed 5-minute `?grant=` streaming URLs.
  - **A/B Title Testing**: Configure Variant A vs Variant B titles per clip (`ab_experiments`), serve variants round-robin, record views/clicks, and compute live CTR winners.
- **📤 Social Upload Queue, Presets, Re-Export, Creator Kit & CSV Export**:
  - **Social Upload Queue**: Schedule and track clip exports across `youtube`, `tiktok`, `instagram`, `twitter`, and `twitch_clips` (`queued` / `in_progress` / `done` / `failed`) with per-platform queue stats.
  - **Saved Editing Presets (`/api/presets`)**: Apply 3 built-in presets or save custom layout/facecam/caption/audio/music/hook recipes (built-ins protected from deletion).
  - **Re-Export, Creator Kit & Batch Metadata**: Trim, adjust speed (`0.5×–2.0×`), flip horizontally, or re-apply captions/music on existing clips (`/api/clipper/clips/:id/re-export`), export all-in-one Creator Kit JSON (`/api/clipper/clips/:id/kit`), run batch AI metadata (up to 20 clips), manage `06_music/` uploads (magic-byte validated), and export formula-safe CSV (`/api/clipper/clips/export.csv`).
- **📈 Live Stream Health Snapshots, System Diagnostics & Admin Security Self-Audit**:
  - **Stream Health Snapshots**: Persist session telemetry (`velocity`, `viewerCount`, `peakDb`, `clipCount`) and score live stream health (`0–100`, `rising` / `falling` / `stable` trend) with admin-protected queries and pruning.
  - **Diagnostics & Security Self-Audit**: Inspect binary versions (`ffmpeg`, `ffprobe`, `yt-dlp`, `streamlink`, `python`, `opencv`), DB counts, and storage via `GET /api/system/diagnostics`, and run the 8-check admin security posture audit via `GET /api/admin/security-scan`.
- **📡 Multi-Platform Stream Watchlist (`ULTRA`)**:
  - Add Twitch, Kick, or YouTube channels to `/api/watchlist`; polls live status every 60s and automatically launches Chat Explosion Monitoring when a watched creator goes live.

---

## 💎 Plan Upgrades & Kelviq Licensing (`/upgrade`, Web UI & TUI `[U]`)

Clipper Studio supports **Free -> Pro -> Ultra** licensing powered by **Kelviq** (`@kelviq/node-sdk`) and local SQLite plan configuration.

### Default Tiers (Editable in `/admin`)

| Tier | Default Price | Daily Clip Quota | Max Resolution | Watermark | Unlocked SaaS Features |
|:---|:---:|:---:|:---:|:---:|:---|
| **Free Starter** (`free`) | **$0** | 3 clips / day | `720p` | Default watermark | Live chat velocity clipping, 7 layouts, OpenCV facecam, manual VOD cutting |
| **Pro Creator** (`pro`) | **$12 / mo** | Unlimited | `1080p60` | Removed | Everything in Free + **Kinetic Auto-Captions**, **Audio Peak AI**, **Virality Score** |
| **Ultra Studio** (`ultra`) | **$29 / mo** | Unlimited | `1080p60` | Custom `@handle` | Everything in Pro + **Multi-Stream Watchlist Auto-Monitor**, **Custom Branding** |

*Requests exceeding a tier's daily quota or locked feature return HTTP **`402 Payment Required`** with `{ error, code, requiredPlan, currentPlan }`.*

### Upgrading & Activating Licenses

- **Dedicated Upgrade Page (`GET /upgrade`)**: Visit **`http://localhost:4001/upgrade`** (or click **Upgrade** in the Web Dashboard sidebar/topbar) to compare Free, Pro, and Ultra plans, enter an optional receipt email, launch **Kelviq Checkout**, activate a license key, or check for tool updates.
- **Web Dashboard Upgrade Modal**: Triggering a `402` quota limit or locked feature in `/` automatically opens the Upgrade Modal with Kelviq Checkout, `/upgrade` shortcut, and key entry.
- **Python TUI `[U]` & `[K]` Hotkeys**:
  - Press **`[U]`** anywhere in `clipper_tui.py` to open the direct upgrade link / Kelviq checkout for your next tier (`pro` from Free, `ultra` from Pro) or open `/upgrade` in your browser.
  - Press **`[K]`** to inspect your active tier and quota, compare plans, generate a Kelviq checkout link, or activate/deactivate a license key.
  - The TUI header displays a live plan badge (`🆓 FREE`, `💎 PRO`, or `🚀 ULTRA`) with current daily quota and resolution, updating immediately upon key activation.
- **Local VIP Keys (`CLIP-PRO-...` / `CLIP-ULTRA-...`) & Kelviq Keys**:
  - Administrators can issue local VIP/support keys in `/admin` (`POST /api/admin/licenses/generate`) with optional expiration days (`0` = lifetime).
  - Activate either a Kelviq-emailed key or local VIP key via `/upgrade`, the Web Dashboard **Activate License Key** modal, TUI `[K]`, or CLI:
    ```bash
    python clipper_tui.py --activate-key YOUR-LICENSE-KEY
    ```
  - `licensing.ts` verifies local keys against SQLite `local_licenses` and Kelviq keys via `kelviq.license.activate` / `kelviq.license.validate` (with `kelviq_portal_url` customer portal support).

### Protected Admin Dashboard & Kelviq Webhooks

- **Admin Console (`GET /admin`)**: Open **`http://localhost:4001/admin`**
  - Sign in with `ADMIN_PASSWORD` (`admin123` initially — `/admin` shows a security alert banner until changed to a custom >= 8-char password).
  - Live-edit plan prices, billing periods, daily quotas (`-1` = unlimited), resolutions, feature toggles, and Kelviq Payment Links / Plan Identifiers.
  - Configure `KELVIQ_API_KEY`, `KELVIQ_ENV` (`production` / `sandbox`), `KELVIQ_WEBHOOK_SECRET`, `KELVIQ_PORTAL_URL`, and test API connectivity.
  - Generate/revoke VIP override license keys, issue/revoke `csk_*` API keys, inspect redacted Kelviq webhook logs, and audit admin/security actions.
- **Webhook Endpoint (`POST /api/webhooks/kelviq`)**:
  - Mounted before `express.json()` using `express.raw({ type: 'application/json' })` to preserve the raw `Buffer` body.
  - Rejects unsigned webhooks (`403`) by default unless `KELVIQ_WEBHOOK_SECRET` verifies the HMAC signature + 5-minute `webhook-timestamp` replay freshness window (or `KELVIQ_ALLOW_UNSIGNED_WEBHOOKS="true"` is set for local testing).
  - Automatically revokes active licenses on `license.revoked`, `license.disabled`, `license.expired`, `license.deleted`, or `subscription.canceled` / `cancelled` / `expired` / `revoked` events.

---

## 🔒 Security Features Summary

Clipper Studio is hardened for local-first operation. See [`SECURITY.md`](SECURITY.md) for full implementation details:

- **Change Default Admin Password**: Initial `ADMIN_PASSWORD` is `admin123`; change it immediately in `.env.local` or `/admin` (minimum 8 characters; rotates `admin_session_secret` automatically; `/admin` displays a warning banner while default is active).
- **Admin Sessions**: Salted `scrypt` password hashes (`16-byte` random salt) + `HMAC-SHA256` `HttpOnly; SameSite=Strict` cookies + IP login lockout (8 failures / 10 min).
- **Hashed `csk_*` API Keys**: Automation bearer keys are stored as `SHA-256` hashes in SQLite `api_keys`, shown once on creation, masked in listings (`csk_***<last4>`), revocable instantly, and optionally enforced globally via `REQUIRE_API_KEY="true"`.
- **CSRF, CORS & CSP**: Loopback-only CORS (`localhost` / `127.0.0.1` / `[::1]`), local `Origin`/`Referer` enforcement on mutating API calls, `X-Clipper-CSRF: 1` (or session/API key) enforcement on `DELETE /api/clipper/clips` and `DELETE /api/clipper/clips/:id`, `Content-Security-Policy` with `frame-ancestors 'none'`, zero inline `on*=` HTML event attributes, and DOM escaping (`escapeHtml` / `escHtml`).
- **Share Link, Upload & CSV Defenses**: `scrypt` share passwords + HMAC-signed 5-minute `?grant=` streaming URLs (auth-tier `20 req/min` rate limit on `POST /api/share/:token/access`), `detectAudioMagicBytes()` + `15 MiB` cap on `/api/studio/music/upload`, and OWASP formula-injection escaping (`escapeCsvCell()`) on `/api/clipper/clips/export.csv`.
- **Path, Command & SSRF Defenses**: `isPathInsideMediaDirs` + `fs.realpathSync` containment (`resolveSafeClipFilePath` for downloads/shares/archives and `resolveSafeAttachPath` in `notification-service`), root/system directory blocking, FFmpeg `drawtext` escaping (`escapeDrawtextText`), argument-array `spawn`/`execFile` with `--` URL delimiters, IPv4/IPv6 + redirect + byte-limit proxy SSRF blocks, Twitch IRC sanitization, Kick URL encoding, and `https:`-only SSRF validation + `127.0.0.1` loopback bind in `notification-service`.
- **Audit, Self-Audit & Redacted Logs**: Security actions persist to `audit_logs` (`GET /api/admin/audit-log`), stored Kelviq event logs redact license keys, and `GET /api/admin/security-scan` scores 8 live security posture checks in `/admin`.

---

## 🎮 Web Dashboard Usage

Open **`http://localhost:4001`**:

1. **📊 Dashboard Overview**: View Total Viral Clips, Clips This Month, Total Duration, Avg Virality Score, Storage Used, Active Tier & daily quota bar, Top Platforms breakdown, 14-day clip output chart, and top-scored clips.
2. **💥 Live Chat Clipper**: Pick Twitch/Kick/YouTube, layout (`split`, `split-crop`, `portrait-4x5`, `square`, `crop`, `blur`, `landscape`), facecam mode, kinetic captions, custom watermark, hook headline, `-14 LUFS` normalize, and `Save VOD Recording (05_streams/)`. Watch the live player + **Facecam Inspector** + real-time **SSE Live Chat Preview**.
3. **✂ After-Live VOD Studio**: Browse channel past broadcasts or local recordings, toggle **📱 Safe-Zone Guide**, run **⚡ Scan Audio Peaks**, batch auto-clip top moments, manually scrub Start/End timestamps (with captions, hook banner, `-14 LUFS` normalize, silence cutting, and `06_music/` background mixing), or configure **⏰ Scheduled Auto-Clip Jobs (Cron)**.
4. **📁 Clips Library**: Search by title, filter by tag, platform, Virality Score (`70+` / `85+`), or **⭐ Favourites**, edit tags/notes/manual social metadata, generate AI social titles & hashtags, export `.srt` / thumbnails, compile 2+ selected clips into a **Montage Reel**, batch-delete selected clips, or download MP4s.
5. **📡 Stream Watchlist (`ULTRA`)**: Track channels and auto-launch Live Monitor the moment they go live.
6. **📥 Batch AI Ingest & 🔔 Notifications**: Submit URLs/local files (or drop videos in `01_inbox/`), track ingestion jobs via SSE, and test/inspect Discord & Telegram dispatches.

---

## 💻 Python Terminal UI (TUI) & CLI Control

### Launching the Interactive TUI:

```bash
# Via pnpm
pnpm tui

# Direct Python
python clipper_tui.py

# Windows launcher
clipper.bat
```

### Hotkeys inside TUI:

| Key | Action |
|:---:|:---|
| `[S]` | **Start Stream Monitor**: Configure platform, channel, 7 layouts, facecam, captions, triggers (`!clip`), hook headline, `-14 LUFS` normalize, watermark, and save recording |
| `[X]` | **Stop Monitor**: Ends active stream capture and chat tracking session |
| `[SPACE]` or `[C]` | **Instant Clip**: Immediately extracts the last 20 seconds to `03_clips/` |
| `[M]` | **After-Live VOD Studio**: Choose local/VOD/past stream → **⚡ Scan Audio Peaks**, **🚀 Batch Auto-Clip Top N**, or **✂ Custom Cut** (with captions, `-14 LUFS` normalize, silence cut, `06_music/`, hook) |
| `[L]` | **Cycle Layout**: Toggle through `split`, `split-crop`, `portrait-4x5`, `square`, `crop`, `blur`, `landscape` |
| `[F]` | **Cycle Facecam**: Toggle `auto`, `top-left`, `top-right`, `bottom-left`, `bottom-right` |
| `[G]` | **Clips Gallery**: Open clips, reveal in file manager, toggle ⭐ favourites, rate 1–5 ★ (`star1`), edit tags/notes, generate Social Metadata AI (`m1` / `bmeta`), re-export (`r1`), download Creator Kit (`k1`), queue social upload (`u1`), export CSV (`csv`), compile Montage Reels |
| `[P]` | **Presets Manager**: Browse built-in and custom presets, apply a preset to active TUI defaults, create new custom presets, or delete custom presets |
| `[D]` | **Doctor (System Diagnostics)**: Inspect FFmpeg/FFprobe/yt-dlp/Streamlink/Python/OpenCV availability, SQLite counts, storage usage, and security posture |
| `[K]` | **Kelviq License & Plans**: View active tier & quota, inspect Free/Pro/Ultra features, get Kelviq checkout URL, activate/deactivate license key |
| `[U]` | **Upgrade Plan**: Open the next tier's Kelviq upgrade/checkout link (or `/upgrade` page) directly in your browser |
| `[Q]` | **Quit**: Cleanly exit the TUI (restores TTY cleanly on Linux/macOS) |

#### Interactive Gallery (`[G]`) Commands

| Command | Action |
|:---|:---|
| `1` *(clip number)* | Open clip #1 in system media player |
| `e1` | Reveal clip #1 in Windows Explorer / macOS Finder / Linux file manager |
| `s1` or `*1` | Toggle ⭐ Favourite on clip #1 |
| `star1 5` *(or `star1`)* | Rate clip #1 with `1–5` ★ stars |
| `t1` | Edit comma-separated tags for clip #1 (`a-z0-9-`, max 10) |
| `n1` | Edit notes for clip #1 (max 2000 chars) |
| `m1` | Generate AI Social Title, Description & `#Hashtags` for clip #1 |
| `r1` | Launch Trim / Speed / Flip Re-Export wizard for clip #1 |
| `k1` | Save Creator Kit JSON (`creator_kit_<id>.json`) and render summary for clip #1 |
| `u1` | Queue clip #1 for Social Upload (`youtube`, `tiktok`, `instagram`, `twitter`, `twitch_clips`) |
| `bmeta 1,2,3` | Batch-generate AI social metadata for selected clips (max 20) |
| `c 1,2,3` | Compile selected clip numbers (`>= 2`) into a Montage Reel (optional title, `-14 LUFS`, `06_music/` track) |
| `csv` | Export entire clips library metadata to `./clipper_clips_export.csv` |
| `s <query>` or `/<query>` | Search clips by title, social title, or tags (`s` alone to clear) |
| `fav` | Toggle ⭐ Favourites-only filter |
| `f <score>` | Filter by minimum virality score (e.g. `f 70`, `f 0` to clear) |
| `r` | Refresh clips list from API |
| `[Enter]` / `q` | Return to main TUI dashboard |

### Complete CLI Non-Interactive Automation Flags (`python clipper_tui.py --help`):

| Flag | Description |
|:---|:---|
| `--status` | Print live monitoring status and exit |
| `--plan-status` | Show active Kelviq plan, license, and daily clip quota |
| `--activate-key KEY` | Activate a Kelviq or Admin VIP license key |
| `--start` | Start monitoring a stream (requires `--channel`) |
| `--stop` | Stop the active monitoring session |
| `--clip [CLIP]` | Trigger manual clip (optional seconds, default `20`) |
| `--clips` | List all rendered clips |
| `--platform {twitch,kick,youtube}` | Platform for `--start` / `--list-streams` (default `twitch`) |
| `--channel CHANNEL` | Channel name or stream URL for `--start` / `--list-streams` |
| `--layout {split,split-crop,portrait-4x5,square,crop,blur,landscape}` | Layout preset (default `split`) |
| `--facecam {auto,top-left,top-right,bottom-left,bottom-right}` | Facecam positioning (default `auto`) |
| `--captions [{none,hormozi,neon,minimal}]` | Kinetic auto-caption style (`PRO`/`ULTRA`; defaults to `hormozi` if flag passed without value) |
| `--watermark WATERMARK` | Custom channel watermark text (`ULTRA`) |
| `--hook HOOK` | 3.5s top hook headline banner text |
| `--triggers TRIGGERS` | Comma-separated chat trigger keywords (e.g. `'!clip,clip it'`) |
| `--normalize` | Enable `-14 LUFS` broadcast audio normalization |
| `--silence-cut` | Auto-trim dead-air silence pauses from rendered clips |
| `--music PATH_OR_NAME` | Background music track path or name from `06_music/` |
| `--music-volume MUSIC_VOLUME` | Background music mix volume (default `0.18`) |
| `--multiplier MULTIPLIER` | Chat spike multiplier vs baseline (default `2.5`) |
| `--min-threshold MIN_THRESHOLD` | Minimum chat msg/s spike threshold (default `4.0`) |
| `--save-recording` | Save full live recording to `05_streams/` for after-live clipping |
| `--list-streams` | List recent past live streams for `--platform` and `--channel` |
| `--audio-peaks` | Scan `--source` for loudest hype audio peaks |
| `--auto-clip-top N` | Batch auto-clip top `N` audio peaks from `--source` |
| `--manual-clip` | Cut an after-live manual clip from `--source` |
| `--montage CLIP_IDS` | Compile comma-separated clip IDs into a single montage reel |
| `--analytics` | Show workspace clip analytics summary |
| `--check-update` | Check current tool version and upstream Git updates |
| `--update-tool` | Run `update.ps1` (Windows) or `update.sh` (macOS/Linux) to update the tool |
| `--yes`, `-y` | Skip confirmation prompt for `--update-tool` |
| `--source SOURCE` | Local video path or VOD URL for `--manual-clip` / `--audio-peaks` / `--auto-clip-top` |
| `--start-sec START_SEC` | Start timestamp in seconds for `--manual-clip` (default `0.0`) |
| `--end-sec END_SEC` | End timestamp in seconds for `--manual-clip` (default `25.0`) |
| `--title TITLE` | Custom clip title for `--manual-clip` / `--montage` |
| `--api-url API_URL` | Clipper service URL (default `$CLIPPER_SERVICE_URL` or `http://localhost:4001`) |
| `--doctor` | Run system diagnostics — binary check, DB counts, storage, security posture |
| `--preset NAME` | Apply a saved editing preset by name or ID before clipping |
| `--presets` | List all saved editing presets |
| `--collections` | List all clip collections |
| `--top-rated` | List top-rated clips with star ratings and virality scores |
| `--queue-list` | Show Social Upload Queue table and per-platform stats |
| `--share CLIP_ID` | Create a shareable link for a clip and print its URL |
| `--share-hours FLOAT` | Optional expiry hours (`0.1–8760`) for `--share` |
| `--share-views INT` | Optional max views (`1–100000`) for `--share` |
| `--share-password STR` | Optional password protection for `--share` |
| `--reexport CLIP_ID` | Re-export an existing clip by ID with optional trim/speed/flip/music |
| `--trim-start SEC` | Trim start seconds for `--reexport` |
| `--trim-end SEC` | Trim end seconds for `--reexport` (0 = keep full clip) |
| `--speed FLOAT` | Playback speed multiplier for `--reexport` (0.5–2.0) |
| `--flip` | Flip clip horizontally during `--reexport` |
| `--export-csv OUT_PATH` | Export all clips library metadata to a CSV file |
| `--batch-metadata CLIP_IDS` | Run AI metadata generation on comma-separated clip IDs (max 20) |
| `--kit CLIP_ID` | Download Creator Kit JSON (title, platform copy, hashtags) for a clip |

#### CLI Examples:

```bash
# Check active Kelviq plan, license & daily quota
python clipper_tui.py --plan-status

# Activate a Kelviq or VIP license key
python clipper_tui.py --activate-key CLIP-PRO-XXXX-XXXX-XXXX

# Check workspace analytics & upstream tool updates
python clipper_tui.py --analytics
python clipper_tui.py --check-update
python clipper_tui.py --update-tool -y

# System diagnostics (binaries, DB, storage, security)
python clipper_tui.py --doctor

# List presets, collections, top-rated clips & social upload queue
python clipper_tui.py --presets
python clipper_tui.py --collections
python clipper_tui.py --top-rated
python clipper_tui.py --queue-list

# Create an expiring, password-protected share link
python clipper_tui.py --share abc123def --share-hours 24 --share-views 10 --share-password mypass

# Apply a saved editing preset
python clipper_tui.py --preset "Viral Shorts" --montage id1,id2,id3

# Re-export a clip with trim, speed, and flip
python clipper_tui.py --reexport abc123 --trim-start 2.5 --trim-end 30 --speed 1.2 --flip

# Export clips library to CSV
python clipper_tui.py --export-csv clips_export.csv

# Batch AI metadata on multiple clips
python clipper_tui.py --batch-metadata id1,id2,id3

# Download Creator Kit JSON for a clip
python clipper_tui.py --kit abc123def

# Start monitoring with captions, custom triggers, hook banner, audio normalize & recording
python clipper_tui.py --start --platform kick --channel xqc \
  --layout split --facecam auto --captions hormozi \
  --triggers "!clip,clip it,omg" --hook "WAIT FOR IT" \
  --normalize --multiplier 2.5 --min-threshold 4.0 --save-recording

# Trigger an instant manual clip (25s) or stop session
python clipper_tui.py --clip 25
python clipper_tui.py --stop

# List past broadcasts or scan audio peaks on a VOD
python clipper_tui.py --list-streams --platform twitch --channel caseoh_
python clipper_tui.py --audio-peaks --source "D:\ClipperMedia\05_streams\vod.mp4"

# Batch auto-clip top 3 moments with captions, silence cut & background music
python clipper_tui.py --auto-clip-top 3 --source "D:\ClipperMedia\05_streams\vod.mp4" \
  --layout portrait-4x5 --captions neon --normalize --silence-cut \
  --music "hype_beat.mp3" --music-volume 0.18

# Cut a manual timestamp range with custom hook & watermark
python clipper_tui.py --manual-clip --source "D:\ClipperMedia\05_streams\vod.mp4" \
  --start-sec 120 --end-sec 150 --layout split --captions hormozi \
  --hook "INSANE CLUTCH" --watermark "@MyChannel" --title "clutch_play"

# Compile 2+ existing clips into a normalized montage reel
python clipper_tui.py --montage "CLIP_ID_1,CLIP_ID_2,CLIP_ID_3" \
  --title "best_moments" --normalize --music "hype_beat.mp3"

# List rendered clips & virality scores
python clipper_tui.py --clips
```
*All CLI flags exit with code `1` on API, connection, or `402` plan-lock errors for reliable scripting/CI.*

---

## 📡 REST API Reference

### Pages (`:4001`)

| Method & Path | Description |
|:---|:---|
| `GET /` | Creator SaaS Web Dashboard (`index.html`) |
| `GET /upgrade` | Dedicated Plan Upgrade, Kelviq Checkout & Key Activation Page (`upgrade.html`) |
| `GET /admin` | Protected Admin Console (`admin.html`) |

### Live Stream & Chat Endpoints

| Method & Path | Description |
|:---|:---|
| `GET /api/live/status` | Current session state, velocity, baseline, recent chat, clips, and storage metadata |
| `POST /api/live/start` | Start monitoring (`{ platform, channelOrUrl, layout, facecamPosition, captionStyle, watermarkText, hookTitleText, audioNormalize, triggerKeywords, spikeMultiplier, minSpikeThreshold, saveRecording }`) |
| `POST /api/live/stop` | Stop active stream monitor (exports `05_streams/` recording if enabled) |
| `POST /api/live/clip-now` | Instant clip of last `durationSec` (`20–40s`) |
| `POST /api/live/save-recording` | Flush current rolling buffer immediately to `05_streams/` |
| `GET /api/live/chat/stream` | SSE stream of real-time chat messages, explosion markers & `quota_reached` events |
| `GET /api/live/preview-frame` | Latest live PNG frame snapshot |
| `GET /api/live/preview-facecam` | Detected OpenCV facecam bounding coordinates |

### After-Live Studio, Audio Peaks, Montage & Scheduled Jobs

| Method & Path | Description |
|:---|:---|
| `GET /api/studio/local-videos` | List local videos across `05_streams`, `01_inbox`, `04_archive`, `03_clips` |
| `GET /api/studio/past-streams?platform=twitch&channel=...` | Fetch channel VODs across Twitch, Kick, YouTube |
| `GET /api/studio/music` | List background audio tracks in `06_music/` with probed durations |
| `POST /api/studio/probe` | Probe local file or VOD URL for playback mode & duration |
| `POST /api/studio/browse-file` | Open native Windows file picker on desktop host |
| `POST /api/studio/detect-facecam` | Run OpenCV facecam detection at a specific `timestampSec` |
| `POST /api/studio/audio-peaks` | Scan `{ source, streamUrl, clipDurationSec }` for loudest hype spikes (`PRO`) |
| `POST /api/studio/auto-clip-batch` | Auto-scan & batch render top `N` moments (`{ source, maxClips, layout, facecamPosition, captionStyle, silenceCut, musicTrack, musicVolume, ... }`) |
| `POST /api/studio/compile-montage` | Concatenate `{ clipIds, title, musicTrack, musicVolume, audioNormalize }` into a montage reel |
| `POST /api/studio/clip` | Render custom `[startSec, endSec]` clip with layout, captions, hook, watermark, normalize, `silenceCut` & `musicTrack` |
| `POST /api/studio/download-vod` / `GET /api/studio/downloads/:id` | Background VOD download into `05_streams/` & progress polling |
| `GET /api/studio/stream` / `GET /api/studio/hls-proxy` / `GET /api/studio/media-proxy` | Contained HTTP 206 byte-range local player & SSRF/byte-limited remote HLS/progressive proxies |
| `GET /api/studio/scheduled-jobs` | List scheduled auto-clip cron jobs |
| `POST /api/studio/schedule-autoclip` | Create & register cron auto-clip job (`{ videoPath, cronExpr, maxClips, layout, captionStyle }`) |
| `POST /api/studio/scheduled-jobs/:id/toggle` | Enable/disable a scheduled auto-clip job |
| `DELETE /api/studio/scheduled-jobs/:id` | Stop and delete a scheduled auto-clip job |

### Clips Library, Search, Tags/Notes/Favourites & Analytics

| Method & Path | Description |
|:---|:---|
| `GET /api/clipper/health` | Service health + `inbox` and `clipsDir` paths |
| `GET /api/clipper/jobs` / `GET /api/clipper/jobs/:id` / `POST /api/clipper/jobs` | List, inspect, or enqueue batch ingest jobs (`{ sourceUrl }` or `{ sourceFilePath }`) |
| `GET /api/clipper/jobs/:id/progress` | SSE progress stream for an ingest job |
| `GET /api/clipper/clips` / `GET /api/clipper/clips/:id` | List clips (`?archived=0\|1\|all`, joined with `rating` and `unresolved_comments`) or fetch a clip record |
| `GET /api/clipper/clips/search` | Filter clips by `?tag=...&platform=...&minScore=...&favourite=1&limit=...&offset=...` |
| `GET /api/clipper/clips/favourites` | List ⭐ favourited clips |
| `GET /api/clipper/clips/top-rated` | List top-rated clips joined with `clip_ratings` (`?limit=1..50`) |
| `GET /api/clipper/clips/:id/file` | Inline MP4 playback with Range support (`?download=1` for attachment download; `resolveSafeClipFilePath` guarded) |
| `GET /api/clipper/clips/:id/thumbnail` | Serve (or lazily extract into `07_thumbs/`) JPEG cover frame |
| `POST /api/clipper/clips/:id/metadata` | Generate viral `socialTitle`, `socialDescription` & `#hashtags` (or save manual `{ socialTitle, socialHashtags, mode: 'manual' }`) |
| `GET /api/clipper/clips/:id/srt` | Download `.srt` subtitle file generated from clip audio |
| `POST /api/clipper/clips/:id/tags` | Set clip tags (`{ tags: ["clutch", "rank1"] }`, `a-z0-9-`, max 10) |
| `PATCH /api/clipper/clips/:id/notes` | Update clip notes (`{ notes }`, max 2000 chars) |
| `POST /api/clipper/clips/:id/favourite` | Toggle ⭐ favourite status on a clip |
| `POST /api/clipper/clips/:id/archive` | Archive clip to `04_archive/` (`{ archived?: true }`) or restore to `03_clips/` (`{ archived: false }`) |
| `DELETE /api/clipper/clips/:id` | Cascade-delete a single clip + files/thumbnails (`X-Clipper-CSRF: 1`, admin session, or `csk_*` key) |
| `DELETE /api/clipper/clips` | Batch cascade-delete up to 50 clips + files/thumbnails (`{ ids: [...] }`; requires `X-Clipper-CSRF: 1`, admin session, or `csk_*` key) |
| `GET /api/analytics/summary` | Workspace summary (`totalClips`, `totalDurationSec`, `storageUsedBytes`, `avgViralityScore`, `clipsThisMonth`, `topPlatforms`, `clipsPerDay`) |
| `GET /api/storage/info` | Active disk detection & paths (`01_inbox` .. `07_thumbs`) |

### Collections, Ratings, Chapters, Review Comments, A/B Testing & Share Links

| Method & Path | Description |
|:---|:---|
| `GET /api/clipper/collections` / `POST /api/clipper/collections` | List all collections or create `{ name, description?, color? }` |
| `PUT /api/clipper/collections/:id` / `DELETE /api/clipper/collections/:id` | Update collection metadata or delete collection |
| `GET /api/clipper/collections/:id/clips` | List ordered clip details inside a collection |
| `POST /api/clipper/collections/:id/clips` / `DELETE /api/clipper/collections/:id/clips/:clipId` | Add `{ clipId, position? }` to or remove clip from collection |
| `GET /api/clipper/clips/:id/collections` | List all collections that contain clip `:id` |
| `POST /api/clipper/clips/:id/rate` | Rate a clip `1–5` stars (`{ rating: 1..5 }`) |
| `GET /api/clipper/clips/:id/chapters` / `POST /api/clipper/clips/:id/chapters` / `DELETE /api/clipper/clips/:id/chapters/:chapterId` | List, add (`{ title, startSec }`), or delete timestamped chapter markers |
| `GET /api/clipper/clips/:id/comments` / `POST /api/clipper/clips/:id/comments` | List or add timestamped review comments (`{ body, author?, timestampSec? }`) |
| `POST /api/clipper/clips/:id/comments/:commentId/resolve` / `DELETE /api/clipper/clips/:id/comments/:commentId` | Toggle/set resolved status (`{ resolved? }`) or delete review comment |
| `GET /api/clipper/clips/:id/ab-test` / `POST /api/clipper/clips/:id/ab-test` | Get A/B experiment stats + CTR winner + `activeVariant`, or create `{ variantATitle, variantBTitle }` |
| `POST /api/clipper/clips/:id/ab-test/event` | Record an A/B impression or click (`{ variant: 'a'\|'b', type: 'view'\|'click' }`) |
| `GET /api/clipper/clips/:id/shares` / `POST /api/clipper/clips/:id/shares` / `DELETE /api/clipper/clips/:id/shares/:token` | List (masked, no `password_hash`), create (`{ expiresInHours?, maxViews?, password? }`), or revoke share links |
| `GET /api/share/:token` / `POST /api/share/:token/access` | Public share access: verify optional `scrypt` password (`401` if required/invalid, `403` if expired/max views) to receive signed 5-min `?grant=` `streamUrl`, then stream or `?download=1` |

### Social Upload Queue & Live Stream Health Snapshots

| Method & Path | Description |
|:---|:---|
| `GET /api/studio/upload-queue` | List queued social uploads and per-platform status breakdown (`youtube`, `tiktok`, `instagram`, `twitter`, `twitch_clips`) |
| `POST /api/studio/upload-queue` | Queue a clip for social export (`{ clipId, platform, title, description?, tags?, scheduledFor? }`) |
| `PATCH /api/studio/upload-queue/:id` / `DELETE /api/studio/upload-queue/:id` | Update queue item `{ status: 'queued'\|'in_progress'\|'done'\|'failed', errorMsg? }` or remove entry |
| `POST /api/studio/snapshots` | Record a stream health telemetry snapshot (`{ sessionId, velocity, viewerCount?, peakDb?, clipCount? }`) |
| `GET /api/studio/snapshots/sessions` | List recent recorded telemetry sessions (`requireAdminAuth`) |
| `GET /api/studio/snapshots/:sessionId` | Fetch session snapshots + computed `health` (`score`, `trend`, `avgVelocity`, `peakVelocity`) (`requireAdminAuth`) |
| `DELETE /api/studio/snapshots` | Prune snapshots older than `?keepDays=1..365` (default `30`, `requireAdminAuth`) |

### System Version & Notifications Proxy

| Method & Path | Description |
|:---|:---|
| `GET /api/system/version` | Package name/version, Git branch/commit/dirty state, and optional upstream check (`?checkRemote=1`) |
| `GET /api/notifications/log` | Proxied dispatch log from `notification-service` (`:4003`) |
| `POST /api/notifications/test` | Proxied Discord/Telegram test dispatch via `notification-service` (`:4003`) |
| `GET /api/notifications/health` *(on `:4003`)* | Direct health check on `notification-service` (`:4003` also serves `POST /api/notifications/clip-ready` and `POST /api/notifications/alert`) |

### Kelviq Billing, Upgrade, Watchlist, Webhooks & Protected Admin API

| Method & Path | Description |
|:---|:---|
| `GET /api/billing/status` *(alias `GET /api/licensing/status`)* | Active plan, masked license info, daily usage quota, plans list, and analytics |
| `GET /api/licensing/upgrade-link?plan=pro\|ultra` | Resolve configured Kelviq Payment Link or Checkout URL for `pro` / `ultra` |
| `POST /api/billing/checkout` | Resolve Kelviq Payment Link or create Kelviq checkout session (`{ planId, email }`) |
| `POST /api/billing/activate` / `POST /api/billing/deactivate` / `POST /api/billing/validate` | Activate, deactivate, or re-validate Kelviq / VIP license key |
| `GET /api/watchlist` / `POST /api/watchlist` / `POST /api/watchlist/:id/toggle` / `DELETE /api/watchlist/:id` / `POST /api/watchlist/check-now` | Multi-platform Stream Watchlist (`ULTRA`) |
| `POST /api/webhooks/kelviq` | Raw-body Kelviq webhook receiver with HMAC + 5-minute timestamp replay verification |
| `GET /api/admin/me` / `POST /api/admin/login` / `POST /api/admin/logout` | Admin session status, rate-limited `scrypt` login, and cookie logout |
| `GET /api/admin/overview` / `PUT /api/admin/plans/:id` / `PUT /api/admin/settings` | Admin overview, live plan editor, Kelviq config & >= 8-char password rotation (`requireAdminAuth`) |
| `POST /api/admin/licenses/generate` / `POST /api/admin/licenses/revoke` / `POST /api/admin/kelviq/test` | Issue/revoke local VIP keys & test Kelviq API connectivity (`requireAdminAuth`) |
| `POST /api/admin/api-keys` / `GET /api/admin/api-keys` / `DELETE /api/admin/api-keys/:id` | Issue (`csk_*`, raw secret shown once), list masked, or revoke API keys (`requireAdminAuth`) |
| `GET /api/admin/event-log` / `GET /api/admin/audit-log` | Inspect redacted Kelviq webhook logs and security/admin audit logs (`requireAdminAuth`) |
| `GET /api/admin/security-scan` | Run live 8-check security posture self-audit (`score` 0–100 + per-check `pass`/`warn`/`fail` details, `requireAdminAuth`) |

### Saved Presets, Re-Export, CSV Export, Webhooks & Diagnostics

| Method & Path | Description |
|:---|:---|
| `GET /api/presets` | List all saved editing presets (3 built-ins + custom) |
| `POST /api/presets` | Create a custom editing preset (`{ name, description, settings }`) |
| `DELETE /api/presets/:id` | Delete a custom preset (built-ins are protected) |
| `POST /api/clipper/clips/:id/re-export` | Re-export an existing clip with new settings (trim, speed, flip, music, captions) → `201 { ok, clip }` |
| `GET /api/clipper/clips/export.csv` | Download all clips metadata as RFC-4180 CSV (formula-injection-safe) |
| `GET /api/clipper/clips/:id/kit` | Creator Kit JSON bundle (clip metadata + per-platform caption copy + hashtags + SRT) |
| `POST /api/clipper/clips/batch-metadata` | AI metadata generation for 1–20 clips in one request (`{ clipIds: string[] }`) |
| `POST /api/studio/music/upload` | Upload a background music track (`.mp3/.wav/.m4a/.aac/.ogg`, max 15 MiB, magic byte validated) |
| `DELETE /api/studio/music/:name` | Delete a background music track from `06_music/` |
| `GET /api/system/diagnostics` | System health check: binary versions, DB record counts, storage usage, security posture |
| `GET /api/admin/webhooks` | List outbound webhooks with masked secrets (`requireAdminAuth`) |
| `POST /api/admin/webhooks` | Create an outbound webhook — secret returned once (`requireAdminAuth`) |
| `POST /api/admin/webhooks/:id/toggle` | Enable or disable an outbound webhook (`requireAdminAuth`) |
| `POST /api/admin/webhooks/:id/test` | Send a test ping to an outbound webhook (`requireAdminAuth`) |
| `DELETE /api/admin/webhooks/:id` | Delete an outbound webhook (`requireAdminAuth`) |

---

## 📁 Storage Folder Hierarchy

```text
<DiskRoot>\ClipperMedia\
├── 01_inbox\       # Long-form video files dropped for offline AI batch ingestion
├── 02_temp\        # Live stream rolling circular segments & temp renders (auto-pruned)
├── 03_clips\       # Rendered viral clips ready for upload
├── 04_archive\     # Archived source videos & clips
├── 05_streams\     # Saved full live stream recordings & downloaded VODs
├── 06_music\       # Background music tracks (.mp3/.wav/.m4a/.aac/.ogg) for mixing
└── 07_thumbs\      # Auto-extracted JPEG cover thumbnails for rendered clips
```

---

## ⚙️ Environment Variables ([`.env.example`](.env.example))

| Variable | Default | Description |
|:---|:---|:---|
| `CLIPPER_PORT` | `4001` | HTTP port for `clipper-service` Web UI, API, `/upgrade`, and `/admin` |
| `NOTIFICATION_PORT` | `4003` | HTTP port for `notification-service` |
| `HOST` | `127.0.0.1` | Bind host for `clipper-service` (keep `127.0.0.1` for local-only security) |
| `CLIPPER_SERVICE_URL` / `NOTIFICATION_SERVICE_URL` | `http://localhost:4001` / `http://localhost:4003` | Service base URLs used by CLI/TUI and internal notification proxy |
| `MEDIA_ROOT_DIR` | *(auto-detected)* | Optional override for `ClipperMedia` root directory |
| `DATA_DIR` | `./data` | SQLite database and backup storage directory |
| `FFMPEG_BIN_PATH` / `FFPROBE_BIN_PATH` / `YTDLP_BIN_PATH` / `PYTHON_BIN_PATH` | `ffmpeg` / `ffprobe` / `yt-dlp` / `python` | System binary paths if not on global `PATH` |
| `HDD_RETENTION_DAYS` | `30` | Days before `01_inbox/` processed sources auto-archive to `04_archive/` |
| `REQUIRE_API_KEY` | `false` | Set `"true"` to require `Authorization: Bearer csk_...` on external calls to `/api/clipper/*` & `/api/studio/*` |
| `ADMIN_PASSWORD` | `admin123` | Initial password for `/admin` Console (stored `scrypt`-hashed in SQLite; change immediately!) |
| `KELVIQ_API_KEY` | `""` | Kelviq server/client API access token for license activation & checkout |
| `KELVIQ_ENV` | `production` | `production` or `sandbox` |
| `KELVIQ_WEBHOOK_SECRET` | `""` | Kelviq webhook signing secret (`kq_whsec_...`) for HMAC + replay verification |
| `KELVIQ_PRO_PAYMENT_LINK` / `KELVIQ_ULTRA_PAYMENT_LINK` | `""` | Direct Kelviq checkout links for Pro Creator / Ultra Studio plans |
| `KELVIQ_PRO_PLAN_ID` / `KELVIQ_ULTRA_PLAN_ID` | `pro` / `ultra` | Kelviq plan identifiers for dynamic checkout sessions |
| `KELVIQ_PORTAL_URL` | `""` | Optional Kelviq customer billing portal URL |
| `GROQ_API_KEY` / `OPENAI_API_KEY` | `""` | Optional STT / AI keys (`whisper-large-v3-turbo`, `whisper-1`, `gpt-4o-mini`) for captions & metadata |
| `WHISPER_BIN_PATH` / `WHISPER_MODEL_PATH` | `""` / `./models/ggml-base.en.bin` | Optional local `whisper.cpp` binary & GGML model path |
| `LLM_PROVIDER` / `LLM_API_KEY` / `GEMINI_API_KEY` / `LLM_MODEL` | `mock` / `""` / `""` / `gemini-2.5-flash` | Optional AI highlight picker & social metadata (`gemini`, `openai`, or `mock` local fallback) |
| `DISCORD_WEBHOOK_GENERAL` / `DISCORD_WEBHOOK_ALERTS` | `""` | Optional HTTPS Discord webhook URLs for clip-ready and error alerts |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | `""` | Optional Telegram bot credentials for alerts |
| `NOTIFY_ATTACH_VIDEO_PREVIEW` | `true` | Attach rendered clip previews (`<=20 MiB` Discord / `<=50 MB` Telegram) to notifications |

---

## 🛠️ Edge Cases & Troubleshooting (For Agents)

- **OpenCV Missing Classifier**: If `cv2.CascadeClassifier` throws an attribute error, ensure `opencv-python==4.10.0.84` is installed via `pip install -r requirements.txt`.
- **FFmpeg Snapshot Errors**: FFmpeg 9.1 enforces strict MJPEG color-space rules. Snapshot extraction in `stream-buffer.ts` uses `.png` format to avoid encoder aborts on MPEG-TS video streams.
- **SQLite Foreign Key Integrity**: Every clip record inserted into `clips` must reference an existing `job_id` in `ingest_jobs`. This is automatically handled via `INSERT OR IGNORE INTO ingest_jobs` inside `insertClip()` in `db.ts`.
- **HTTP `402` Plan Locks**: Paid SaaS features (`--captions`, `--audio-peaks`, `--watermark`, Watchlist, or >3 clips/day on Free) return HTTP `402`. Upgrade via `/upgrade` or `[U]` in the TUI, or activate a Kelviq/VIP key via `/admin`, `[K]`, or `--activate-key`.
- **Port In Use (4001 / 4003)**: If port 4001 or 4003 is already bound, check background Node processes with `Get-Process node` (PowerShell) or `lsof -i :4001` (Linux/macOS).

---

## 🛡️ License

MIT License. Free for personal and commercial content creation.
