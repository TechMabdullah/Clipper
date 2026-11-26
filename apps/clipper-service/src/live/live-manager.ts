import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { ChatTracker, type ChatExplosionEvent, type LivePlatform } from './chat-tracker.js';
import { StreamBuffer, type ClipLayout, type FacecamPosition, type FacecamDetectionResult } from './stream-buffer.js';
import { insertClip, getSetting, insertStreamSnapshot } from '../db.js';
import { assertEntitlement, EntitlementError } from '../licensing.js';
import { calculateViralityScore } from '../features/audio-peaks.js';
import type { CaptionStyle } from '../features/captions.js';

export interface LiveSessionConfig {
  platform: LivePlatform;
  channelOrUrl: string;
  vertical?: boolean;
  layout?: ClipLayout;
  facecamPosition?: FacecamPosition;
  captionStyle?: CaptionStyle;
  watermarkText?: string;
  hookTitleText?: string;
  audioNormalize?: boolean;
  triggerKeywords?: string[];
  spikeMultiplier?: number;
  minSpikeThreshold?: number;
  cooldownMs?: number;
  saveRecording?: boolean;
}

export class LiveManager extends EventEmitter {
  private tracker: ChatTracker | null = null;
  private buffer: StreamBuffer | null = null;
  private config: LiveSessionConfig | null = null;
  private isRunning = false;
  private sessionId: string | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private activeHypeTimers: Set<NodeJS.Timeout> = new Set();
  private recentClips: Array<{ id: string; filePath: string; timestamp: string }> = [];

  public getStatus() {
    return {
      active: this.isRunning,
      sessionId: this.sessionId,
      platform: this.config?.platform ?? null,
      channelOrUrl: this.config?.channelOrUrl ?? null,
      vertical: this.config?.vertical ?? true,
      layout: this.config?.layout ?? 'split',
      facecamPosition: this.config?.facecamPosition ?? 'auto',
      captionStyle: this.config?.captionStyle ?? 'none',
      watermarkText: this.config?.watermarkText ?? '',
      hookTitleText: this.config?.hookTitleText ?? '',
      audioNormalize: this.config?.audioNormalize ?? false,
      triggerKeywords: this.tracker?.getTriggerKeywords() ?? this.config?.triggerKeywords ?? [],
      saveRecording: this.config?.saveRecording ?? false,
      embedUrl: this.getEmbedUrl(),
      currentVelocity: this.tracker?.currentVelocity ?? 0,
      baselineVelocity: this.tracker?.baselineVelocity ?? 0,
      recentChat: this.tracker?.getRecentChat(40) ?? [],
      recentClips: this.recentClips.slice(-10),
    };
  }

  public getEmbedUrl(): string | null {
    if (!this.config || !this.isRunning) return null;
    const { platform, channelOrUrl } = this.config;
    const clean = channelOrUrl
      .replace(/^https?:\/\/(?:www\.)?(?:twitch\.tv|kick\.com)\//i, '')
      .replace(/\/.*$/, '')
      .replace(/^#/, '')
      .replace(/[\r\n\s]+/g, '')
      .trim();

    if (platform === 'twitch' && /^[a-zA-Z0-9_]{1,64}$/.test(clean)) {
      const slug = encodeURIComponent(clean.toLowerCase());
      return `https://player.twitch.tv/?channel=${slug}&parent=localhost&parent=127.0.0.1&muted=true&autoplay=true`;
    }
    if (platform === 'kick' && /^[a-zA-Z0-9_-]{1,64}$/.test(clean)) {
      const slug = encodeURIComponent(clean);
      return `https://player.kick.com/${slug}?muted=true&autoplay=true`;
    }
    if (platform === 'youtube') {
      let vid = '';
      if (channelOrUrl.includes('watch?v=')) {
        vid = channelOrUrl.split('watch?v=')[1]?.split(/[&#/?]/)[0] ?? '';
      } else if (channelOrUrl.includes('/live/')) {
        vid = channelOrUrl.split('/live/')[1]?.split(/[/?#]/)[0] ?? '';
      } else if (channelOrUrl.includes('youtu.be/')) {
        vid = channelOrUrl.split('youtu.be/')[1]?.split(/[/?#]/)[0] ?? '';
      }
      if (/^[a-zA-Z0-9_-]{6,20}$/.test(vid)) {
        return `https://www.youtube.com/embed/${encodeURIComponent(vid)}?autoplay=1&mute=1`;
      }
    }
    return null;
  }

  public async getPreviewSnapshot(): Promise<Buffer | null> {
    if (!this.buffer) return null;
    return this.buffer.getLatestSnapshot();
  }

  public async getDetectedFacecam(): Promise<FacecamDetectionResult | null> {
    if (!this.buffer) return null;
    return this.buffer.detectFaceCam();
  }

  public async startSession(config: LiveSessionConfig): Promise<void> {
    assertEntitlement(undefined, false);
    if (config.captionStyle && config.captionStyle !== 'none') {
      assertEntitlement('auto_captions', false);
    }
    if (config.watermarkText && config.watermarkText.trim()) {
      assertEntitlement('custom_branding', false);
    }

    if (this.isRunning || this.buffer || this.tracker) {
      await this.stopSession();
    }

    const nextConfig: LiveSessionConfig = {
      ...config,
      layout: config.layout ?? (config.vertical === false ? 'landscape' : 'split'),
      facecamPosition: config.facecamPosition ?? 'auto',
      captionStyle: config.captionStyle ?? 'none',
      watermarkText: config.watermarkText ?? '',
      hookTitleText: config.hookTitleText ?? '',
      audioNormalize: Boolean(config.audioNormalize),
      triggerKeywords: config.triggerKeywords,
    };

    console.log(
      `[live-manager] Starting live clip monitor for ${nextConfig.platform}: ${nextConfig.channelOrUrl} ` +
      `(Layout: ${nextConfig.layout}, Facecam: ${nextConfig.facecamPosition})`
    );

    // 1. Initialize rolling stream buffer
    const buffer = new StreamBuffer({
      channelOrUrl: nextConfig.channelOrUrl,
      platform: nextConfig.platform,
      quality: '720p60,720p,best',
      bufferWindowSec: 240, // 4-minute rolling buffer
      saveRecording: nextConfig.saveRecording,
    });

    try {
      await buffer.start();
    } catch (err) {
      try { await buffer.stop(); } catch {}
      throw err;
    }

    // 2. Initialize real-time chat explosion tracker
    const tracker = new ChatTracker({
      platform: nextConfig.platform,
      channelOrUrl: nextConfig.channelOrUrl,
      spikeMultiplier: nextConfig.spikeMultiplier ?? 2.5,
      minSpikeThreshold: nextConfig.minSpikeThreshold ?? 4.0,
      cooldownMs: nextConfig.cooldownMs ?? 35_000,
      triggerKeywords: nextConfig.triggerKeywords,
    });

    tracker.on('chat', (msg) => {
      this.emit('chat', msg);
    });

    tracker.on('explosion', (evt: ChatExplosionEvent) => {
      this.emit('explosion', evt);
      this.handleExplosion(evt);
    });

    this.config = nextConfig;
    this.buffer = buffer;
    this.tracker = tracker;
    this.sessionId = crypto.randomUUID();

    try {
      await tracker.start();
      this.isRunning = true;
      this.startSnapshotTimer();
    } catch (err) {
      this.isRunning = false;
      this.stopSnapshotTimer();
      this.sessionId = null;
      try { tracker.stop(); } catch {}
      try { await buffer.stop(); } catch {}
      this.tracker = null;
      this.buffer = null;
      this.config = null;
      throw err;
    }
  }

  private recordStreamSnapshot(velocityOverride?: number): void {
    if (!this.isRunning || !this.sessionId) return;
    try {
      insertStreamSnapshot({
        sessionId: this.sessionId,
        velocity: velocityOverride ?? this.tracker?.currentVelocity ?? 0,
        clipCount: this.recentClips.length,
      });
    } catch {}
  }

  private startSnapshotTimer(): void {
    this.stopSnapshotTimer();
    this.snapshotTimer = setInterval(() => {
      this.recordStreamSnapshot();
    }, 15_000);
    this.snapshotTimer.unref();
  }

  private stopSnapshotTimer(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  public async saveCurrentRecording(): Promise<string | null> {
    if (!this.buffer) throw new Error('No live stream session active');
    return this.buffer.exportFullRecording(this.config?.channelOrUrl ?? 'live_stream');
  }

  public async stopSession(): Promise<{ savedRecordingPath: string | null }> {
    this.isRunning = false;
    this.stopSnapshotTimer();
    this.sessionId = null;
    for (const timer of this.activeHypeTimers) {
      clearInterval(timer);
    }
    this.activeHypeTimers.clear();

    if (this.tracker) {
      this.tracker.stop();
      this.tracker = null;
    }
    let savedRecordingPath: string | null = null;
    if (this.buffer) {
      savedRecordingPath = await this.buffer.stop();
      this.buffer = null;
    }
    this.config = null;
    console.log('[live-manager] Live session stopped.');
    return { savedRecordingPath };
  }

  private resolveRenderPolicy(ent: ReturnType<typeof assertEntitlement>): {
    layout: ClipLayout;
    captionStyle: CaptionStyle;
    watermarkText: string;
    maxResolution: number;
  } {
    const layout: ClipLayout = this.config?.layout ?? 'split';
    const captionStyle: CaptionStyle =
      this.config?.captionStyle && this.config.captionStyle !== 'none' && ent.plan.allow_auto_captions
        ? this.config.captionStyle
        : 'none';
    const customWm = this.config?.watermarkText?.trim();
    const watermarkText =
      customWm && ent.plan.allow_custom_branding
        ? customWm
        : ent.plan.watermark_enabled
          ? getSetting('default_watermark_text', 'Clipper Studio')
          : '';
    return {
      layout,
      captionStyle,
      watermarkText,
      maxResolution: ent.plan.max_resolution,
    };
  }

  /**
   * Handles chat explosion event:
   * - Starts exactly 10 seconds before the explosion spike: (T_spike - 10s).
   * - Minimum duration: 20 seconds (ends at least T_spike + 10s).
   * - Maximum duration: 40 seconds (ends at most T_spike + 30s).
   * - Dynamically extends if chat hype remains elevated after the explosion.
   * - Layout contains Facecam (split 9:16 layout: Facecam Top + Gameplay Bottom).
   */
  private handleExplosion(evt: ChatExplosionEvent): void {
    if (!this.buffer || !this.isRunning) return;

    this.recordStreamSnapshot(evt.velocity);

    const spikeTime = evt.timestampMs;
    // Exactly 10s before the explosion
    const clipStartMs = spikeTime - 10_000;
    const minEndMs = spikeTime + 10_000; // 20s total minimum duration
    const maxEndMs = spikeTime + 30_000; // 40s total maximum duration

    console.log(
      `[live-manager] 🎯 Chat explosion at ${new Date(spikeTime).toLocaleTimeString()}!` +
      ` Tracking hype window: -10s start, 20s min to 40s max duration.`
    );

    // Dynamic hype tracker: check velocity after minEndMs has elapsed
    const checkIntervalMs = 1000;
    const pollHype = setInterval(async () => {
      if (!this.isRunning || !this.buffer) {
        clearInterval(pollHype);
        this.activeHypeTimers.delete(pollHype);
        return;
      }

      const now = Date.now();

      // Ensure minimum 20s window is reached before ending
      if (now < minEndMs) return;

      const currentVel = this.tracker?.currentVelocity ?? 0;
      const baselineVel = this.tracker?.baselineVelocity ?? 1;
      const hypeStillElevated = currentVel > (baselineVel * 1.3);

      // Continue clip if hype is still rolling and within 40s max cap
      if (hypeStillElevated && now < maxEndMs) {
        console.log(`[live-manager] 🔥 Hype continues (${currentVel.toFixed(1)} msg/s) — extending clip...`);
        return;
      }

      // Hype subsided or 40s cap reached -> finalize clip
      clearInterval(pollHype);
      this.activeHypeTimers.delete(pollHype);

      const clipEndMs = Math.min(maxEndMs, Math.max(minEndMs, now - 1000));
      const durationSec = Math.min(40, Math.max(20, (clipEndMs - clipStartMs) / 1000));

      console.log(
        `[live-manager] ✂ Extracting explosion clip: ${durationSec.toFixed(1)}s ` +
        `(-10s pre-spike to +${((clipEndMs - spikeTime) / 1000).toFixed(1)}s post-spike)`
      );

      try {
        if (!this.buffer) return;

        const ent = assertEntitlement(undefined, true);
        const policy = this.resolveRenderPolicy(ent);
        const cleanChannel = (this.config?.channelOrUrl ?? 'stream')
          .replace(/https?:\/\//, '')
          .replace(/[^a-zA-Z0-9_-]/g, '_');

        const title = `${cleanChannel}_explosion_${evt.velocity.toFixed(0)}mps`;
        const hookTitleText = this.config?.hookTitleText?.trim() || undefined;

        const result = await this.buffer.extractClip(clipStartMs, clipEndMs, {
          title,
          layout: policy.layout,
          facecamPosition: this.config?.facecamPosition ?? 'auto',
          captionStyle: policy.captionStyle,
          watermarkText: policy.watermarkText,
          hookTitleText,
          audioNormalize: this.config?.audioNormalize,
          maxResolution: policy.maxResolution,
          fallbackHookText: evt.sampleMessages[0] ?? `CHAT EXPLODED ${evt.velocity} MSG/S`,
        });

        const virality = calculateViralityScore({
          chatMultiplier: evt.multiplier,
          durationSec: result.durationSec,
          hasFacecam: result.hasFacecam,
          hasCaptions: result.hasCaptions,
        });

        const clipId = crypto.randomUUID();
        const jobId = `live_${cleanChannel}`;
        const description = `Chat exploded to ${evt.velocity} msg/s (${evt.multiplier}x baseline). Sample: ${evt.sampleMessages.slice(0, 3).join(' | ')}`;

        insertClip({
          id: clipId,
          jobId,
          title,
          description,
          startSec: 0,
          endSec: result.durationSec,
          durationSec: result.durationSec,
          filePath: result.filePath,
          fileSizeBytes: result.fileSizeBytes,
          viralityScore: virality.score,
          viralityReason: virality.reason,
          captionsStyle: policy.captionStyle,
          layout: policy.layout,
          sourcePlatform: this.config?.platform ?? 'twitch',
        });

        this.recentClips.push({
          id: clipId,
          filePath: result.filePath,
          timestamp: new Date().toISOString(),
        });

        void this.notifyClip(title, result.filePath, result.fileSizeBytes);

        this.emit('clip', {
          id: clipId,
          filePath: result.filePath,
          event: evt,
        });
      } catch (err) {
        if (err instanceof EntitlementError) {
          console.warn(`[live-manager] ⚠ Auto-clip blocked by plan entitlement (${err.code}): ${err.message}`);
          this.emit('quota_reached', {
            code: err.code,
            message: err.message,
            error: err.message,
            requiredPlan: err.requiredPlan,
            currentPlan: err.currentPlan,
            timestampMs: Date.now(),
          });
        } else {
          console.error('[live-manager] Failed to extract explosion clip:', err);
        }
      }
    }, checkIntervalMs);

    this.activeHypeTimers.add(pollHype);
  }

  /**
   * Manual trigger: clip the last N seconds on demand (enforced 20s min to 40s max).
   */
  public async manualClip(durationSec = 20): Promise<{ id: string; filePath: string }> {
    if (!this.buffer) throw new Error('No live buffer active. Click "Start Monitor" first!');

    const ent = assertEntitlement(undefined, true);
    const policy = this.resolveRenderPolicy(ent);

    // Enforce 20s minimum and 40s maximum
    const clampedDuration = Math.min(40, Math.max(20, durationSec));
    const now = Date.now();
    const clipEndMs = now - 1000;
    const clipStartMs = clipEndMs - (clampedDuration * 1000);

    const cleanChannel = (this.config?.channelOrUrl ?? 'manual')
      .replace(/https?:\/\//, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');

    const title = `${cleanChannel}_manual`;
    const hookTitleText = this.config?.hookTitleText?.trim() || undefined;

    const result = await this.buffer.extractClip(clipStartMs, clipEndMs, {
      title,
      layout: policy.layout,
      facecamPosition: this.config?.facecamPosition ?? 'auto',
      captionStyle: policy.captionStyle,
      watermarkText: policy.watermarkText,
      hookTitleText,
      audioNormalize: this.config?.audioNormalize,
      maxResolution: policy.maxResolution,
    });

    const virality = calculateViralityScore({
      durationSec: result.durationSec,
      hasFacecam: result.hasFacecam,
      hasCaptions: result.hasCaptions,
    });

    const clipId = crypto.randomUUID();
    const jobId = `manual_${cleanChannel}`;

    insertClip({
      id: clipId,
      jobId,
      title,
      description: `Manual clip (${clampedDuration}s)`,
      startSec: 0,
      endSec: result.durationSec,
      durationSec: result.durationSec,
      filePath: result.filePath,
      fileSizeBytes: result.fileSizeBytes,
      viralityScore: virality.score,
      viralityReason: virality.reason,
      captionsStyle: policy.captionStyle,
      layout: policy.layout,
      sourcePlatform: this.config?.platform ?? 'twitch',
    });

    this.recentClips.push({
      id: clipId,
      filePath: result.filePath,
      timestamp: new Date().toISOString(),
    });

    void this.notifyClip(title, result.filePath, result.fileSizeBytes);

    return { id: clipId, filePath: result.filePath };
  }

  private async notifyClip(title: string, filePath: string, bytes: number): Promise<void> {
    try {
      const url = process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:4003';
      await fetch(`${url}/api/notifications/clip-ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipTitle: `💥 ${title}`,
          filePath,
          fileSizeMb: (bytes / 1e6).toFixed(1),
        }),
      });
    } catch {}
  }
}

export const liveManager = new LiveManager();
