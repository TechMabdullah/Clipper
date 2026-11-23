# 🎬 Clipper Studio — Local-First Live Video Clipper & Chat Explosion Detector

A high-performance, **local-first** video clipping automation suite and real-time live stream chat velocity monitor. It captures live streams from **Twitch**, **Kick**, and **YouTube**, listens for sudden chat explosions (hype spikes, viral moments, funny fails, rage moments), and automatically renders professional **9:16 vertical shorts** with auto-detected streamer facecam and uncropped gameplay.

All video processing, stream rolling buffers, OpenCV facial tracking, and database records remain strictly on your local PC — with **zero cloud video storage fees**, **zero external API costs**, and complete user privacy.

---

## 🌟 Highlights

- **🔴 Multi-Platform Live Monitoring**:
  - **Twitch**: IRC WebSocket chat tracker + Streamlink ad-bypass stream capture.
  - **Kick**: Pusher WebSocket protocol (`wss://ws-us2.pusher.com`) + Streamlink capture.
  - **YouTube**: Live chat polling + live stream ingestion.
- **💥 Real-Time Chat Explosion Detection**:
  - Calculates real-time chat velocity (messages/sec) against a 60-second rolling baseline.
  - Triggers automatic clip generation when chat velocity surges (e.g. $\ge 2.5\times$ baseline).
  - **Strict Duration Rules**:
    - **Starts 10 seconds before** the explosion spike ($T_{\text{start}} = T_{\text{spike}} - 10\text{s}$).
    - **Minimum Duration**: 20 seconds ($T_{\text{end}} \ge T_{\text{spike}} + 10\text{s}$).
    - **Maximum Duration**: 40 seconds ($T_{\text{end}} \le T_{\text{spike}} + 30\text{s}$).
    - **Dynamic Hype Extension**: If chat activity stays elevated post-spike, the clip automatically extends up to the 40-second cap before finalizing.
- **👤 Auto-Detecting Streamer Facecam (OpenCV)**:
  - Computer vision Haar Cascades tuned for streamer webcam face dimensions ($25\text{px}$ to $50\text{px}$ on 720p/1080p streams).
  - Spatial edge weighting prioritizes corner/edge webcams and ignores centered in-game video game characters.
  - Multi-segment candidate sampling checks across the clip window to prevent false fallbacks during stream transitions or black loading screens.
- **📱 Professional 9:16 Shorts Split-Screen Layout**:
  - **Top (1080×720)**: Exact 1.5 aspect ratio webcam crop — zero distortion, zero squishing.
  - **Bottom (1080×1200)**: Full 16:9 gameplay uncropped and centered with an ambient blurred background — keeps mini-maps, health bars, crosshairs, killfeeds, and subtitles 100% visible.
  - Alternate layout options: Action Center Crop, Full Blurred Backdrop, and 16:9 Landscape.
- **🖥️ Web Control Dashboard & Live Stream Preview**:
  - Local control plane served at `http://localhost:4001`.
  - Embedded live video player + **Facecam Inspector** showing real-time SVG bounding box tracking.
  - Manual **"Clip Last 20s Now"** trigger for instant on-demand captures.
  - Local gallery to preview, download, or copy file paths.

---

## 🏗️ Architecture

```text
                                [ Live Stream Platform ]
                               (Twitch / Kick / YouTube)
                                   │               │
                     Live HLS Stream               Real-Time Chat WebSocket
                                   ▼                               ▼
                      ┌────────────────────────┐      ┌─────────────────────────┐
                      │    Streamlink HLS      │      │    Chat Tracker (WS)    │
                      │  Rolling Buffer (240s) │      │  Rolling Velocity & Hype│
                      └───────────┬────────────┘      └────────────┬────────────┘
                                  │                                │
                                  │                    Chat Explosion Event!
                                  │                     (Spike >= 2.5x Baseline)
                                  │                                │
                                  ▼                                ▼
                      ┌─────────────────────────────────────────────────────────┐
                      │                  Live Clipper Manager                   │
                      │  - Clip Window: [Spike - 10s] to [Spike + 10s..30s]     │
                      │  - OpenCV Facecam Detection (detect_face.py)            │
                      │  - Multi-candidate Segment Evaluation                   │
                      └───────────────────────────┬─────────────────────────────┘
                                                  │
                                                  ▼
                      ┌─────────────────────────────────────────────────────────┐
                      │                     FFmpeg Filter                       │
                      │  Top: 1080x720 Facecam (1.5 aspect ratio)               │
                      │  Bottom: 1080x1200 Full 16:9 Game + Ambient Backdrop    │
                      │  Output: 1080x1920 9:16 MP4 (libx264 + AAC)            │
                      └───────────────────────────┬─────────────────────────────┘
                                                  │
                                                  ▼
                                      ┌───────────────────────┐
                                      │  D:\ClipperMedia\     │
                                      │       03_clips\       │
                                      └───────────────────────┘
```

---

## 📋 Prerequisites & Requirements

- **Operating System**: Windows 10/11, macOS, or Linux.
- **Node.js**: v22.0.0 or higher.
- **Package Manager**: `pnpm` (`npm install -g pnpm`).
- **FFmpeg**: Must be available on system `PATH` with `libx264` and `aac` support.
- **Streamlink**: `streamlink` CLI on system `PATH`.
- **Python**: Python 3.10+ with OpenCV:
  ```bash
  pip install opencv-python==4.10.0.84
  ```

---

## 🚀 Installation & Getting Started

1. **Clone the repository**:
   ```bash
   git clone <repo-url>
   cd Clipper
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Configure Environment Variables**:
   Create or verify `.env.local`:
   ```env
   CLIPPER_PORT=4001
   NOTIFICATION_PORT=4003
   DATA_DIR="./data"
   MEDIA_ROOT_DIR="D:/ClipperMedia"
   ```

4. **Start the Clipper Studio Services**:
   ```bash
   pnpm dev
   ```

5. **Open Dashboard**:
   Navigate to **[http://localhost:4001](http://localhost:4001)** in your browser.

---

## 🎮 Web Dashboard Usage

1. **Choose Platform**: Select **Twitch**, **Kick**, or **YouTube**.
2. **Enter Channel**: E.g., `caseoh_`, `iceposeidon`, or enter a full stream URL.
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
7. **Find Your Clips**: All clips are stored in `D:\ClipperMedia\03_clips\` and displayed in the **Clips Library** tab.

---

## 📡 REST API Reference

The service exposes a complete HTTP REST API for automation and integrations:

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
**Response**:
```json
{
  "active": true,
  "platform": "kick",
  "channelOrUrl": "iceposeidon",
  "vertical": true,
  "layout": "split",
  "facecamPosition": "auto",
  "embedUrl": "https://player.kick.com/iceposeidon?muted=true&autoplay=true",
  "currentVelocity": 4.8,
  "baselineVelocity": 1.4,
  "recentClips": [
    {
      "id": "47e91e73-36e5-4d94-9702-55c127937683",
      "filePath": "D:\\ClipperMedia\\03_clips\\iceposeidon_manual_2026-11-23T12-36-14-596Z.mp4",
      "timestamp": "2026-11-23T12:37:16.892Z"
    }
  ]
}
```

### 3. Live Preview Snapshot & Facecam Detection
```http
GET /api/live/preview-frame
# Returns latest JPEG/PNG binary snapshot from the rolling buffer

GET /api/live/preview-facecam
# Returns detected webcam bounding box:
# { "ok": true, "facecam": { "found": true, "corner": "bottom-right", "crop_x": 922, "crop_y": 338, "crop_w": 358, "crop_h": 238 } }
```

### 4. Manual Clip Trigger
```http
POST /api/live/clip-now
Content-Type: application/json

{
  "durationSec": 20
}
```

### 5. Stop Monitoring
```http
POST /api/live/stop
```

### 6. List Rendered Clips
```http
GET /api/clipper/clips
```

---

## 📁 Storage Folder Structure

Clipper Studio organizes media using an optimized folder hierarchy:

```text
D:\ClipperMedia\
├── 01_inbox\       # Long-form batch video files for offline ingestion
├── 02_temp\        # Live stream rolling circular segments (auto-pruned)
├── 03_clips\       # Rendered 9:16 vertical shorts ready for upload
└── 04_archive\     # Archived source files
```

---

## 🛡️ License

MIT License. Free for personal and commercial content creation.
