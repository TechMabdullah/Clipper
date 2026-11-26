import readline from 'node:readline';
import { liveManager } from './live-manager.js';
import type { LivePlatform } from './chat-tracker.js';
import type { ClipLayout, FacecamPosition } from './layout-utils.js';
import type { CaptionStyle } from '../features/captions.js';
import { EntitlementError } from '../licensing.js';

const VALID_LAYOUTS: ReadonlyArray<ClipLayout> = [
  'split',
  'split-crop',
  'crop',
  'blur',
  'portrait-4x5',
  'square',
  'landscape',
];
const VALID_FACECAMS: ReadonlyArray<FacecamPosition> = [
  'auto',
  'bottom-left',
  'top-left',
  'bottom-right',
  'top-right',
];
const VALID_CAPTIONS: ReadonlyArray<CaptionStyle> = ['none', 'hormozi', 'neon', 'minimal'];

// Parse command line arguments
// e.g. pnpm live --kick xqc --layout split-crop --captions hormozi --triggers "!clip,omg"
const args = process.argv.slice(2);

let platform: LivePlatform = 'twitch';
let channelOrUrl = '';
let vertical = true;
let layout: ClipLayout = 'split';
let facecamPosition: FacecamPosition = 'auto';
let captionStyle: CaptionStyle = 'none';
let watermarkText = '';
let hookTitleText = '';
let audioNormalize = false;
let saveRecording = false;
let triggerKeywords: string[] | undefined;
let spikeMultiplier = 2.5;
let minSpikeThreshold = 4.0;

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '--twitch') {
    platform = 'twitch';
    channelOrUrl = args[++i] ?? '';
  } else if (arg === '--youtube' || arg === '--yt') {
    platform = 'youtube';
    channelOrUrl = args[++i] ?? '';
  } else if (arg === '--kick') {
    platform = 'kick';
    channelOrUrl = args[++i] ?? '';
  } else if (arg === '--landscape' || arg === '--no-vertical' || arg === '--16:9') {
    vertical = false;
    layout = 'landscape';
  } else if (arg === '--layout') {
    const val = (args[++i] ?? 'split') as ClipLayout;
    if (!VALID_LAYOUTS.includes(val)) {
      console.error(`Invalid --layout "${val}". Valid options: ${VALID_LAYOUTS.join(', ')}`);
      process.exit(1);
    }
    layout = val;
    vertical = layout !== 'landscape';
  } else if (arg === '--facecam') {
    const val = (args[++i] ?? 'auto') as FacecamPosition;
    if (!VALID_FACECAMS.includes(val)) {
      console.error(`Invalid --facecam "${val}". Valid options: ${VALID_FACECAMS.join(', ')}`);
      process.exit(1);
    }
    facecamPosition = val;
  } else if (arg === '--captions') {
    const next = args[i + 1];
    if (next && !next.startsWith('--') && VALID_CAPTIONS.includes(next as CaptionStyle)) {
      captionStyle = next as CaptionStyle;
      i++;
    } else {
      captionStyle = 'hormozi';
    }
  } else if (arg === '--watermark') {
    watermarkText = args[++i] ?? '';
  } else if (arg === '--hook') {
    hookTitleText = args[++i] ?? '';
  } else if (arg === '--audio-normalize') {
    audioNormalize = true;
  } else if (arg === '--save-recording') {
    saveRecording = true;
  } else if (arg === '--triggers') {
    const raw = args[++i] ?? '';
    triggerKeywords = raw.split(',').map(s => s.trim()).filter(Boolean);
  } else if (arg === '--multiplier') {
    spikeMultiplier = parseFloat(args[++i] ?? '2.5');
    if (!Number.isFinite(spikeMultiplier) || spikeMultiplier <= 0) spikeMultiplier = 2.5;
  } else if (arg === '--min-threshold') {
    minSpikeThreshold = parseFloat(args[++i] ?? '4.0');
    if (!Number.isFinite(minSpikeThreshold) || minSpikeThreshold <= 0) minSpikeThreshold = 4.0;
  } else if (!channelOrUrl && !arg.startsWith('--')) {
    channelOrUrl = arg;
  }
}

function printUpgradeNotice(err: unknown): boolean {
  if (
    err instanceof EntitlementError ||
    (err && typeof err === 'object' && (err as { statusCode?: number }).statusCode === 402)
  ) {
    const e = err as { message?: string; code?: string; requiredPlan?: string };
    const planLabel = (e.requiredPlan ?? 'pro').toUpperCase();
    console.error(`\n💳 [402 UPGRADE REQUIRED — ${planLabel}] ${e.message ?? 'Plan upgrade required.'}`);
    console.error('   Activate your Kelviq license key in the Web Dashboard or Admin Console (/admin).\n');
    return true;
  }
  return false;
}

if (!channelOrUrl) {
  console.log(`
╔═════════════════════════════════════════════════════════════════════════╗
║                  CLIPPER STUDIO — LIVE CHAT EXPLOSION CLIPPER           ║
╚═════════════════════════════════════════════════════════════════════════╝

Usage:
  pnpm live --twitch <channel>       (e.g. pnpm live --twitch caseoh_)
  pnpm live --kick <channel>         (e.g. pnpm live --kick xqc)
  pnpm live --youtube <url_or_id>    (e.g. pnpm live --youtube https://youtube.com/live/...)

Options:
  --layout <split|split-crop|crop|blur|portrait-4x5|square|landscape>
                                     Default: split (Facecam Top + Game Bottom)
  --facecam <auto|bottom-left|top-left|bottom-right|top-right>
                                     Default: auto
  --landscape                        Save 16:9 widescreen (same as --layout landscape)
  --captions [hormozi|neon|minimal|none]
                                     Burn kinetic captions (defaults to hormozi if flag given)
  --watermark <text>                 Burn custom channel watermark (Ultra plan)
  --hook <text>                      Burn 3.5s top hook headline banner
  --audio-normalize                  Apply broadcast audio leveling (highpass + compressor + loudnorm)
  --save-recording                   Save full rolling stream MP4 to 05_streams/ on exit
  --triggers <csv>                   Custom chat trigger keywords (e.g. "!clip,omg")
  --multiplier <number>              Spike multiplier vs baseline (default: 2.5)
  --min-threshold <number>           Minimum messages/sec to trigger (default: 4.0)

Hotkeys while running:
  [c] Clip last 20 seconds immediately
  [q] Stop live session
`);
  process.exit(1);
}

async function main() {
  console.clear();
  console.log('='.repeat(70));
  console.log('  🎬 CLIPPER STUDIO — LIVE CHAT EXPLOSION DETECTOR');
  console.log('='.repeat(70));
  console.log(`  Target:       ${platform.toUpperCase()} -> ${channelOrUrl}`);
  console.log(`  Layout:       ${layout.toUpperCase()} ${layout === 'split' ? '(Facecam Top + Gameplay Bottom)' : ''}`);
  console.log(`  Facecam Pos:  ${facecamPosition}`);
  console.log(`  Captions:     ${captionStyle}`);
  if (watermarkText) console.log(`  Watermark:    ${watermarkText}`);
  if (hookTitleText) console.log(`  Hook Banner:  ${hookTitleText}`);
  if (audioNormalize) console.log(`  Audio FX:     Broadcast Normalize ON`);
  if (saveRecording) console.log(`  VOD Record:   Saving full recording on stop`);
  if (triggerKeywords?.length) console.log(`  Triggers:     ${triggerKeywords.join(', ')}`);
  console.log(`  Sensitivity:  ${spikeMultiplier}x baseline (min ${minSpikeThreshold} msg/s)`);
  console.log(`  Clip Window:  10 seconds BEFORE spike  +  10–30 seconds AFTER spike (20–40s total)`);
  console.log(`  Clips Saved:  03_clips/ inside active ClipperMedia directory`);
  console.log('='.repeat(70));
  console.log('  Press [c] to clip immediately | Press [q] or Ctrl+C to quit\n');

  await liveManager.startSession({
    platform,
    channelOrUrl,
    vertical,
    layout,
    facecamPosition,
    captionStyle,
    watermarkText: watermarkText || undefined,
    hookTitleText: hookTitleText || undefined,
    audioNormalize,
    saveRecording,
    triggerKeywords,
    spikeMultiplier,
    minSpikeThreshold,
  });

  // Setup keyboard hotkeys
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let tickerTimer: NodeJS.Timeout | null = null;
  const shutdown = async () => {
    if (tickerTimer) clearInterval(tickerTimer);
    console.log('\nStopping live session...');
    const { savedRecordingPath } = await liveManager.stopSession();
    if (savedRecordingPath) {
      console.log(`💾 Full stream VOD saved: ${savedRecordingPath}`);
    }
    process.exit(0);
  };

  process.stdin.on('keypress', async (_str, key) => {
    if ((key.ctrl && key.name === 'c') || key.name === 'q') {
      await shutdown();
    } else if (key.name === 'c') {
      console.log('\n[manual] 🎬 Manual clip triggered (last 20s)...');
      try {
        const result = await liveManager.manualClip(20);
        console.log(`[manual] ✅ Saved: ${result.filePath}`);
      } catch (err: any) {
        if (!printUpgradeNotice(err)) {
          console.error(`[manual] ❌ Error: ${err.message}`);
        }
      }
    }
  });

  // Live status ticker
  tickerTimer = setInterval(() => {
    const status = liveManager.getStatus();
    const vel = status.currentVelocity.toFixed(1);
    const base = status.baselineVelocity.toFixed(1);
    process.stdout.write(`\r[LIVE] Chat Velocity: ${vel} msg/s | Baseline: ${base} msg/s | Clips captured: ${status.recentClips.length}    `);
  }, 1000);

  liveManager.on('clip', (data) => {
    console.log(`\n\n🎉 [CLIP CAPTURED!]`);
    console.log(`   File:     ${data.filePath}`);
    console.log(`   Velocity: ${data.event.velocity} msg/s (${data.event.multiplier}x baseline)`);
    console.log(`   Sample:   ${data.event.sampleMessages.slice(0, 2).join(' | ')}\n`);
  });

  liveManager.on('quota_reached', (info: { code?: string; message?: string; requiredPlan?: string }) => {
    printUpgradeNotice({
      statusCode: 402,
      code: info.code,
      message: info.message,
      requiredPlan: info.requiredPlan,
    });
  });
}

main().catch((err) => {
  if (!printUpgradeNotice(err)) {
    console.error('Fatal error:', err);
  }
  process.exit(1);
});
