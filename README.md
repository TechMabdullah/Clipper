# 🎬 Clipper Studio — Local-First Live Video Clipper & Chat Explosion Detector

A high-performance, **local-first** video clipping automation suite and real-time live stream chat velocity monitor. It captures live streams from **Twitch**, **Kick**, and **YouTube**, listens for sudden chat explosions (hype spikes, viral moments, funny fails, rage moments), and automatically renders professional **9:16 vertical shorts** with auto-detected streamer facecam and uncropped gameplay.

All video processing, stream rolling buffers, OpenCV facial tracking, and database records remain strictly on your local PC — with **zero cloud video storage fees**, **zero external API costs**, and complete user privacy.

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

# FFmpeg with libx264 & aac
ffmpeg -version

# Streamlink live stream recorder
streamlink --version

# Python 3.10+
python --version
```

*Binary Installation shortcuts if missing:*
- **Windows (Winget)**: `winget install Gyan.FFmpeg Streamlink.Streamlink yt-dlp.yt-dlp --source winget`
- **macOS (Homebrew)**: `brew install ffmpeg streamlink yt-dlp`
- **Linux (Ubuntu/Debian)**: `sudo apt update && sudo apt install -y ffmpeg streamlink python3-pip`

### Step 2: Install Node & Python Dependencies

```bash
# 1. Install Node.js monorepo dependencies
pnpm install

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

*Storage Note for Agents:* Do not hardcode drive letters in `.env.local`. Clipper Studio automatically detects whether the machine has a secondary disk (e.g. `D:\ClipperMedia`) or a single disk (e.g. `C:\ClipperMedia`), and creates all required subdirectories on boot.

### Step 4: Verify Monorepo Type Integrity

```bash
pnpm tsc -p tsconfig.base.json --noEmit
```
*Expected result: 0 errors (exits with code 0).*

### Step 5: Start Background Dev Services

```bash
pnpm dev
```
*Starts `clipper-service` on port `4001` and `notification-service` on port `4003`.*

### Step 6: Automated Health Check Verification

Test that the services are online and storage is auto-discovered:

```bash
# 1. Verify live clipper API status
curl -s http://localhost:4001/api/live/status

# 2. Verify storage engine & disk detection
curl -s http://localhost:4001/api/storage/info

# 3. Verify Python CLI controller
python clipper_tui.py --status
```
*Expected JSON from `/api/storage/info`:*
```json
{
  "mediaRoot": "...",
  "inbox": ".../01_inbox",
  "tempDir": ".../02_temp",
  "clipsDir": ".../03_clips",
  "archiveDir": ".../04_archive",
  "isSingleDisk": true/false
}
```

---

## 🗺️ Project File Map (For Agents & Developers)

| File / Directory | Description |
|:---|:---|
| [`apps/clipper-service/src/storage.ts`](file:///d:/Clipper/apps/clipper-service/src/storage.ts) | **Storage Engine**: Auto-detects single-disk vs. dual-disk setups; initializes folder structures. |
| [`apps/clipper-service/src/live/live-manager.ts`](file:///d:/Clipper/apps/clipper-service/src/live/live-manager.ts) | **Live Session Orchestrator**: Coordinates rolling buffers, explosion triggers, and clip rendering. |
| [`apps/clipper-service/src/live/stream-buffer.ts`](file:///d:/Clipper/apps/clipper-service/src/live/stream-buffer.ts) | **Stream Buffer & FFmpeg Pipeline**: 240s rolling circular segment buffer, live snapshots, and filter graph. |
| [`apps/clipper-service/src/live/chat-tracker.ts`](file:///d:/Clipper/apps/clipper-service/src/live/chat-tracker.ts) | **Chat Explosion Tracker**: Real-time WebSockets (Twitch IRC, Kick Pusher, YouTube) & velocity analytics. |
| [`apps/clipper-service/src/live/detect_face.py`](file:///d:/Clipper/apps/clipper-service/src/live/detect_face.py) | **OpenCV Facecam Tracker**: Edge-weighted facial recognition for streamer corner webcams. |
| [`apps/clipper-service/src/index.ts`](file:///d:/Clipper/apps/clipper-service/src/index.ts) | **Express API Server**: Serves live preview frames, clip downloads, SSE progress, and Web Dashboard. |
| [`apps/clipper-service/src/public/index.html`](file:///d:/Clipper/apps/clipper-service/src/public/index.html) | **Web Dashboard UI**: Live stream player, Facecam Inspector with SVG overlays, and clips gallery. |
| [`clipper_tui.py`](file:///d:/Clipper/clipper_tui.py) | **Python TUI & CLI Controller**: Terminal dashboard with velocity bars, hotkey controls, and automation flags. |
| [`clipper.bat`](file:///d:/Clipper/clipper.bat) | **Windows Launcher**: Double-click launcher for the Python TUI. |
| [`requirements.txt`](file:///d:/Clipper/requirements.txt) | **Python Dependencies**: Pinned OpenCV, rich, and requests. |
| [`.env.example`](file:///d:/Clipper/.env.example) | **Environment Template**: Default ports, retention, and optional notification hooks. |

---

## 🌟 Core System Highlights

- **🔴 Multi-Platform Live Monitoring**:
  - **Twitch**: IRC WebSocket chat tracker + Streamlink ad-bypass stream capture.
  - **Kick**: Pusher WebSocket protocol (`wss://ws-us2.pusher.com`) + Streamlink capture.
  - **YouTube**: Live chat polling + live stream ingestion.
- **💥 Real-Time Chat Explosion Detection**:
  - Calculates real-time chat velocity (messages/sec) against a 60-second rolling baseline.
  - Triggers automatic clip generation when chat velocity surges ($\ge 2.5\times$ baseline).
  - **Strict Duration Rules**:
    - **Starts 10 seconds before** the explosion spike ($T_{\text{start}} = T_{\text{spike}} - 10\text{s}$).
    - **Minimum Duration**: 20 seconds ($T_{\text{end}} \ge T_{\text{spike}} + 10\text{s}$).
    - **Maximum Duration**: 40 seconds ($T_{\text{end}} \le T_{\text{spike}} + 30\text{s}$).
    - **Dynamic Hype Extension**: If chat activity stays elevated post-spike, the clip automatically extends up to the 40-second cap before finalizing.
- **👤 Auto-Detecting Streamer Facecam (OpenCV)**:
  - Computer vision Haar Cascades tuned for streamer webcam face dimensions ($25\text{px}$ to $50\text{px}$ on 720p/1080p streams).
  - Spatial edge weighting prioritizes corner/edge webcams and ignores centered in-game video game characters.
  - Multi-segment candidate sampling checks across the clip window (middle, last, first) to prevent false fallbacks during stream transitions or black loading screens.
- **📱 Professional 9:16 Shorts Split-Screen Layout**:
  - **Top (1080×720)**: Exact 1.5 aspect ratio webcam crop — zero distortion, zero squishing.
  - **Bottom (1080×1200)**: Full 16:9 gameplay uncropped and centered with an ambient blurred background — keeps mini-maps, health bars, crosshairs, killfeeds, and subtitles 100% visible.
  - Alternate layout options: Action Center Crop, Full Blurred Backdrop, and 16:9 Landscape.
- **📁 Intelligent Storage & Single-Disk Auto-Discovery**:
  - **Dual-Disk Mode**: Uses secondary drive (e.g. `D:\ClipperMedia\`), protecting the primary OS drive.
  - **Single-Disk Mode**: If the machine has only one disk (e.g. `C:\`), **automatically creates `C:\ClipperMedia\` on that same disk** (or `<project_dir>\ClipperMedia`).

---

## 🎮 Web Dashboard Usage

Open your browser to:
👉 **[http://localhost:4001](http://localhost:4001)**

1. **Choose Platform**: Select **Twitch**, **Kick**, or **YouTube**.
2. **Enter Channel**: E.g., `caseoh_`, `iceposeidon`, or enter a stream URL.
3. **Select Layout**:
   - `📱 Split: Facecam + Ambient 16:9 Game (Professional Shorts)` *(Recommended default)*
   - `📱 Split: Facecam + Action Center Crop`
   - `📱 9:16 Action Center Crop`
   - `📱 9:16 Full Blurred Background`
   - `🖥️ 16:9 Landscape`
4. **Select Facecam Position**: Leave on `👤 Auto-Detect`, or pick a manual corner preset (`Top-Left`, `Top-Right`, `Bottom-Left`, `Bottom-Right`).
5. **Click "Start Monitor"**:
   - The embedded player connects to the live stream.
   - Switch to **👤 Facecam Inspector** to see the detected webcam bounding box overlaid on the live feed.
   - Chat velocity meters track message bursts in real-time.
6. **Automatic & Manual Clipping**:
   - **Automatic**: When an explosion occurs, the clip triggers, buffers until hype settles (20s to 40s), and exports.
   - **Manual Override**: Click **"Clip Last 20s Now"** anytime to immediately capture the last 20 seconds.
7. **Find Your Clips**: All clips are stored in `03_clips\` and displayed in the **Clips Library** tab.

---

## 💻 Python Terminal UI (TUI) & CLI Control

In addition to the Web Dashboard, Clipper Studio includes an interactive **Terminal User Interface (TUI)** and Python CLI tool:

### Launching the Interactive TUI:

```bash
# Via pnpm
pnpm tui

# Or direct Python
python clipper_tui.py

# Or via Windows double-click batch launcher
clipper.bat
```

### Hotkeys & Controls inside TUI:

| Key | Action |
|:---:|:---|
| `[S]` | **Start Monitor**: Interactive prompt to pick Twitch/Kick/YouTube, channel, layout & facecam |
| `[X]` | **Stop Monitor**: Ends the active stream capture and chat tracking session |
| `[SPACE]` or `[C]` | **Instant Clip**: Immediately extracts the last 20 seconds to `03_clips\` |
| `[L]` | **Cycle Layout**: Toggle between Split Shorts, Split Action, Center Crop, Blur, Landscape |
| `[F]` | **Cycle Facecam**: Toggle between Auto-Detect, Top-Left, Top-Right, Bottom-Left, Bottom-Right |
| `[G]` | **Clips Gallery**: Browse rendered clips; press `Enter` to open in media player, or `e` to reveal in Explorer |
| `[Q]` | **Quit**: Cleanly exit the TUI |

### CLI Non-Interactive Automation Flags:

```bash
# Check current live monitoring status & chat velocity
python clipper_tui.py --status

# Start monitoring a stream directly
python clipper_tui.py --start --platform kick --channel iceposeidon --layout split --facecam auto

# Stop the current monitoring session
python clipper_tui.py --stop

# Trigger a manual clip (20s to 40s)
python clipper_tui.py --clip 20

# View all rendered clips in a formatted terminal table
python clipper_tui.py --clips
```

---

## 📡 REST API Reference

The service exposes a complete HTTP REST API for automation:

### 1. Start Monitoring
```http
POST /api/live/start
Content-Type: application/json

{
  "platform": "kick",
  "channelOrUrl": "iceposeidon",
  "vertical": true,
  "layout": "split",
  "facecamPosition": "auto",
  "spikeMultiplier": 2.5,
  "minSpikeThreshold": 4.0
}
```

### 2. Poll Status & Velocity
```http
GET /api/live/status
```

### 3. Live Preview Snapshot & Facecam Detection
```http
GET /api/live/preview-frame
# Returns latest PNG binary snapshot from the rolling buffer

GET /api/live/preview-facecam
# Returns detected webcam bounding box:
# { "ok": true, "facecam": { "found": true, "corner": "bottom-right", "crop_x": 922, "crop_y": 338, "crop_w": 358, "crop_h": 238 } }
```

### 4. Storage Discovery
```http
GET /api/storage/info
# Returns resolved active disk paths and single-disk status
```

### 5. Manual Clip Trigger
```http
POST /api/live/clip-now
Content-Type: application/json

{
  "durationSec": 20
}
```

### 6. Stop Monitoring
```http
POST /api/live/stop
```

### 7. List Rendered Clips
```http
GET /api/clipper/clips
```

---

## 📁 Storage Folder Hierarchy

```text
<DiskRoot>\ClipperMedia\
├── 01_inbox\       # Long-form batch video files for offline ingestion
├── 02_temp\        # Live stream rolling circular segments (auto-pruned)
├── 03_clips\       # Rendered 9:16 vertical shorts ready for upload
└── 04_archive\     # Archived source files
```

---

## 🛠️ Edge Cases & Troubleshooting (For Agents)

- **OpenCV Missing Classifier**: If `cv2.CascadeClassifier` throws an attribute error, ensure `opencv-python==4.10.0.84` is installed via `pip install -r requirements.txt`.
- **FFmpeg Snapshot Errors**: FFmpeg 9.1 enforces strict MJPEG color-space rules. Snapshot extraction in `stream-buffer.ts` uses `.png` format to avoid encoder aborts on MPEG-TS video streams.
- **SQLite Foreign Key Integrity**: Every clip record inserted into `clips` must reference an existing `job_id` in `ingest_jobs`. This is automatically handled via `INSERT OR IGNORE INTO ingest_jobs` in `live-manager.ts`.
- **Port In Use (4001 / 4003)**: If port 4001 is already bound, check background node processes with `Get-Process node` (PowerShell) or `lsof -i :4001` (Linux/Mac).

---

## 🛡️ License

MIT License. Free for personal and commercial content creation.
