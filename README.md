<div align="center">
  <img src="./assets/hero-banner.svg" alt="Clipper Studio Animated Banner" width="100%" />
  <br />
  <br />
  <img src="./assets/live-status.svg" alt="Clipper Studio Live Telemetry Strip" width="100%" />
  <br />
  <br />
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js_15-App_Router-6C63FF?style=for-the-badge&logo=nextdotjs&logoColor=white" alt="Next.js 15" /></a>
  <a href="https://stripe.com/"><img src="https://img.shields.io/badge/Stripe-Checkout_%26_Portal-635BFF?style=for-the-badge&logo=stripe&logoColor=white" alt="Stripe" /></a>
  <a href="https://firebase.google.com/"><img src="https://img.shields.io/badge/Firebase-Auth_%2B_Firestore-FF8A30?style=for-the-badge&logo=firebase&logoColor=white" alt="Firebase" /></a>
  <a href="https://resend.com/"><img src="https://img.shields.io/badge/Resend-Email_OTP-FF5FA2?style=for-the-badge&logo=resend&logoColor=white" alt="Resend OTP" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-1A1A2E?style=for-the-badge" alt="MIT License" /></a>
</div>

<br />

**Clipper Studio** is a **local-first AI live & VOD clipping SaaS** wrapped in a playful **Next.js 15 + shadcn/ui** dual-surface web app (`:3000`), backed by a zero-cloud-cost local **FFmpeg / OpenCV / yt-dlp** engine (`:4001`), **Firebase + Resend OTP** auth, **Stripe** billing, and a rich **Python TUI**.

<div align="center">
  <img src="./assets/pipeline-flow.svg" alt="Clipper Studio Animated Architecture Pipeline" width="100%" />
</div>

---

## ✨ What’s Inside

<div align="center">
  <img src="./assets/features-animated.svg" alt="Clipper Studio Animated Feature Showcase" width="100%" />
</div>

| Surface | Highlights |
|:---|:---|
| 🎨 **Doodle Auth & 2FA** | Animated cursor-tracking SVG doodles (`/login`, `/signup`, `/verify-otp`), Google + Email/Password, **Resend 6-digit OTP**, Admin TOTP 2FA |
| 🎬 **Customer SaaS (`/(app)/*`)** | Live capture + SSE chat spikes, VOD Studio, BlazeFace split-facecam, 5★ ratings, chapters, comments, password share links, A/B titles, PDF invoices |
| 🛡️ **Zero-Trust `/admin`** | RBAC (`customer` → `support` → `admin` → `superadmin`), virtualized users table, Stripe orders/refunds, SLA support inbox, flags, immutable audit logs |
| 💻 **Engine & TUI (`:4001`)** | SQLite library, Streamlink capture, OpenCV webcam crop, `-14 LUFS` audio normalization, Discord/Telegram alerts (`:4003`), `clipper_tui.py` |

---

## 💸 100% Free Setup & Zero-Card Deployment (No Credit/Debit Card Needed)

You can run, test, and deploy this entire SaaS stack **100% free of charge without entering any credit or debit card** anywhere.

### 1. Free Firebase Auth & Firestore (Spark Plan — $0, No Card)
1. Go to [Firebase Console](https://console.firebase.google.com/) and sign in with any free Google account.
2. Click **Create Project** (accept defaults; keep Google Analytics optional).
3. Under **Build → Authentication**, click **Get Started** and enable:
   - **Email/Password**
   - **Google** (set support email to your own Gmail).
   - Under **Settings → Authorized Domains**, verify `localhost` is listed (and add your Vercel domain later).
4. Under **Build → Firestore Database**, click **Create Database** (choose **Start in production mode** or **test mode**). The default Spark plan gives you **50,000 free reads/day & 20,000 free writes/day** forever without a card.
5. In **Project Settings (⚙️) → General**, scroll to **Your apps**, click the Web (`</>`) icon, and copy the `firebaseConfig` object keys into `.env.local`:
   ```bash
   NEXT_PUBLIC_FIREBASE_API_KEY="AIzaSy..."
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="your-app.firebaseapp.com"
   NEXT_PUBLIC_FIREBASE_PROJECT_ID="your-app"
   NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="your-app.appspot.com"
   NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="123456789"
   NEXT_PUBLIC_FIREBASE_APP_ID="1:123456789:web:abcdef"
   ```
6. In **Project Settings → Service Accounts**, click **Generate new private key** (downloads a `.json` file). Copy values into `.env.local`:
   ```bash
   FIREBASE_PROJECT_ID="your-app"
   FIREBASE_CLIENT_EMAIL="firebase-adminsdk-...@your-app.iam.gserviceaccount.com"
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```

---

### 2. Free Stripe Billing (Test Mode — $0, No Card)
1. Register for free at [Stripe Dashboard](https://dashboard.stripe.com/register). **No credit card or bank details are required** to use Test Mode!
2. Ensure the top toggle is set to **Test Mode**.
3. Under **Developers → API keys**, copy:
   ```bash
   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_..."
   STRIPE_SECRET_KEY="sk_test_..."
   ```
4. For local testing without Stripe CLI, set `STRIPE_ALLOW_UNSIGNED_WEBHOOKS="true"` in dev, or forward webhooks with the free Stripe CLI:
   ```bash
   stripe listen --forward-to http://localhost:3000/api/webhooks/stripe
   ```
5. You can simulate test purchases using Stripe's official test card `4242 4242 4242 4242` (any future date, any 3 digits CVC).

---

### 3. Free Resend Email OTP (or 100% Offline Echo — $0, No Card)
- **Option A (Real Free Emails)**:
  1. Sign up at [Resend.com](https://resend.com/) with GitHub or email. **No credit card required** (3,000 free emails/month).
  2. Under **API Keys**, click **Create API Key** and paste into `.env.local`:
     ```bash
     RESEND_API_KEY="re_..."
     RESEND_FROM_EMAIL="Clipper Studio <onboarding@resend.dev>"
     ```
     *(The default `onboarding@resend.dev` sender sends test OTPs directly to your account email for free!)*
- **Option B (Zero-Config Offline Echo)**:
  If you don't want to sign up for Resend, set in `.env.local`:
  ```bash
  DEV_OTP_ECHO="true"
  ```
  The 6-digit OTP code will be shown directly on the `/verify-otp` screen and printed to your dev terminal!

---

### 4. Free AI Highlights & Speech-to-Text API Keys ($0, No Card)
- **Google Gemini API (Free Tier)**:
  1. Open [Google AI Studio](https://aistudio.google.com/) and click **Get API key**.
  2. Generate a key on the Free Tier (**zero card or billing account needed**).
  3. In `.env.local`:
     ```bash
     LLM_PROVIDER="gemini"
     GEMINI_API_KEY="AIzaSy..."
     LLM_MODEL="gemini-2.5-flash"
     ```
- **Groq Whisper STT (Free Tier)**:
  1. Open [Groq Cloud Console](https://console.groq.com/) and click **API Keys**.
  2. Create a free key (**zero card needed**).
  3. In `.env.local`:
     ```bash
     GROQ_API_KEY="gsk_..."
     ```
- **Offline Mock Fallback**:
  If you don't enter any AI keys, set `LLM_PROVIDER="mock"` — Clipper Studio automatically uses rule-based chat density & audio peak scanners completely offline!

---

### 5. Free Deployment ($0, No Card)

#### Surface A: Next.js SaaS Web Dashboard (`apps/web`) → Vercel Free Hobby Tier
1. Push your repository to GitHub (ensure `.env.local` is in `.gitignore`).
2. Log in to [Vercel](https://vercel.com/) with GitHub. **No card is required** on the Hobby plan!
3. Click **Add New → Project**, import your repo, set **Root Directory** to `apps/web`.
4. Under **Environment Variables**, paste the keys from `.env.local` (`NEXT_PUBLIC_FIREBASE_*`, `FIREBASE_*`, `STRIPE_*`, `OTP_HMAC_SECRET`, etc.).
5. Click **Deploy**. Your SaaS is live with a free `*.vercel.app` domain and free SSL!

#### Surface B: Clipper Engine (`:4001`) → Free Cloudflare Tunnel (or Render Free Web Service)
Because Clipper uses local `ffmpeg`, `yt-dlp`, and `streamlink` to process gigabytes of video without cloud bandwidth costs:
- **Zero-Cloud Tunneling (Recommended)**:
  Download [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`cloudflared`) for free without any payment method:
  ```powershell
  # Expose your local engine securely to the web with free Cloudflare HTTPS:
  cloudflared tunnel --url http://127.0.0.1:4001
  ```
  Then set `CLIPPER_SERVICE_URL="https://your-tunnel.trycloudflare.com"` in your Vercel dashboard!
- **Or Render Free Tier**:
  Create a free Docker Web Service on [Render.com](https://render.com/) (**no card needed** on the Free Tier).

---

## 🚀 Quick Start

### 1. Prerequisites
Install **Node.js 22+**, **pnpm 12+**, **Python 3.10+**, `ffmpeg`, `ffprobe`, `yt-dlp`, and `streamlink`:
```powershell
# Windows (Winget)
winget install Gyan.FFmpeg Streamlink.Streamlink yt-dlp.yt-dlp --source winget
```

### 2. Install & Initialize Environment
```bash
pnpm install --allow-build esbuild --allow-build nx
pip install -r requirements.txt
cp .env.example .env.local   # PowerShell: Copy-Item .env.example .env.local
```

Generate required 32-byte secrets for `.env.local`:
```bash
node -e "const c=require('crypto'); for (const k of ['OTP_HMAC_SECRET','ADMIN_TOTP_ENCRYPTION_KEY','INTERNAL_BRIDGE_SECRET']) console.log(`${k}=\"${c.randomBytes(32).toString('hex')}\"`);"
```

### 3. Run Full Stack (`:3000`, `:4001`, `:4003`)
```bash
pnpm dev      # Next.js SaaS (:3000) + Clipper Engine (:4001) + Notifier (:4003)
pnpm tui      # Optional Python Terminal UI
```
Open **`http://localhost:3000/login`** (or **`http://127.0.0.1:4001`** for legacy engine controls).

---

## ⚙️ Service Setup Details (Click to Expand)

<details>
<summary><strong>🔥 Firestore Rules & Indexes Deployment</strong></summary>

```bash
cd apps/web && firebase deploy --only firestore:rules,firestore:indexes
```

To automatically grant `superadmin` role on first login:
```bash
SUPERADMIN_BOOTSTRAP_EMAIL="your-email@gmail.com"
```

</details>

<details>
<summary><strong>🔄 Safe Tool Updates & Verification</strong></summary>

```powershell
.\update.ps1 -Check   # Windows: check upstream commits without modifying files
.\update.ps1          # Backup .env.local & SQLite -> pull -> install -> build
```
```bash
./update.sh           # macOS / Linux updater
```

Run tests & build checks anytime:
```bash
pnpm test
pnpm nx run-many -t build typecheck
```

</details>

---

## 🔒 Security

Zero-trust RBAC, timing-safe `HMAC-SHA256` OTPs, `AES-256-GCM` Admin TOTP, loopback `INTERNAL_BRIDGE_SECRET` isolation, OWASP CSV formula escaping, and SSRF IPv4/IPv6 blocking are documented in [`SECURITY.md`](SECURITY.md).
