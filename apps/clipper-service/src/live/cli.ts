import readline from 'node:readline';
import { liveManager } from './live-manager.js';
import type { LivePlatform } from './chat-tracker.js';

// Parse command line arguments
// e.g. pnpm live --twitch caseoh_ --landscape --multiplier 2.5
const args = process.argv.slice(2);

let platform: LivePlatform = 'twitch';
let channelOrUrl = '';
let vertical = true;
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
  } else if (arg === '--landscape' || arg === '--no-vertical' || arg === '--16:9') {
    vertical = false;
  } else if (arg === '--multiplier') {
    spikeMultiplier = parseFloat(args[++i] ?? '2.5');
  } else if (arg === '--min-threshold') {
    minSpikeThreshold = parseFloat(args[++i] ?? '4.0');
  } else if (!channelOrUrl && !arg.startsWith('--')) {
    channelOrUrl = arg;
  }
}

if (!channelOrUrl) {
  console.log(`
╔═════════════════════════════════════════════════════════════════════════╗
║                  CLIPPER STUDIO — LIVE CHAT EXPLOSION CLIPPER           ║
╚═════════════════════════════════════════════════════════════════════════╝

Usage:
  pnpm live --twitch <channel>       (e.g. pnpm live --twitch caseoh_)
  pnpm live --youtube <url_or_id>    (e.g. pnpm live --youtube https://youtube.com/live/...)

Options:
  --landscape                        Save 16:9 widescreen (default is 9:16 vertical crop)
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
  console.log(`  Format:       ${vertical ? '9:16 Vertical (Shorts/Reels/TikTok)' : '16:9 Landscape'}`);
  console.log(`  Sensitivity:  ${spikeMultiplier}x baseline (min ${minSpikeThreshold} msg/s)`);
  console.log(`  Clip Window:  10 seconds BEFORE spike  +  10 seconds AFTER spike (20s total)`);
  console.log(`  Clips Saved:  D:/ClipperMedia/03_clips/`);
  console.log('='.repeat(70));
  console.log('  Press [c] to clip immediately | Press [q] or Ctrl+C to quit\n');

  await liveManager.startSession({
    platform,
    channelOrUrl,
    vertical,
    spikeMultiplier,
    minSpikeThreshold,
  });

  // Setup keyboard hotkeys
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdin.on('keypress', async (_str, key) => {
    if (key.ctrl && key.name === 'c' || key.name === 'q') {
      console.log('\nStopping live session...');
      await liveManager.stopSession();
      process.exit(0);
    } else if (key.name === 'c') {
      console.log('\n[manual] 🎬 Manual clip triggered (last 20s)...');
      try {
        const result = await liveManager.manualClip(20);
        console.log(`[manual] ✅ Saved: ${result.filePath}`);
      } catch (err: any) {
        console.error(`[manual] ❌ Error: ${err.message}`);
      }
    }
  });

  // Live status ticker
  setInterval(() => {
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
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
