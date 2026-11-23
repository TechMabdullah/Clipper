import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { ChatTracker, type ChatExplosionEvent, type LivePlatform } from './chat-tracker.js';
import { StreamBuffer } from './stream-buffer.js';
import { db } from '../db.js';

export interface LiveSessionConfig {
  platform: LivePlatform;
  channelOrUrl: string;
  vertical?: boolean;
  spikeMultiplier?: number;
  minSpikeThreshold?: number;
  cooldownMs?: number;
}

export class LiveManager extends EventEmitter {
  private tracker: ChatTracker | null = null;
  private buffer: StreamBuffer | null = null;
  private config: LiveSessionConfig | null = null;
  private isRunning = false;
  private recentClips: Array<{ id: string; filePath: string; timestamp: string }> = [];

  public getStatus() {
    return {
      active: this.isRunning,
      platform: this.config?.platform ?? null,
      channelOrUrl: this.config?.channelOrUrl ?? null,
      vertical: this.config?.vertical ?? true,
      currentVelocity: this.tracker?.currentVelocity ?? 0,
      baselineVelocity: this.tracker?.baselineVelocity ?? 0,
      recentClips: this.recentClips.slice(-10),
    };
  }

  public async startSession(config: LiveSessionConfig): Promise<void> {
    if (this.isRunning) {
      await this.stopSession();
    }

    this.config = config;
    this.isRunning = true;

    console.log(`[live-manager] Starting live clip monitor for ${config.platform}: ${config.channelOrUrl}`);

    // 1. Initialize rolling stream buffer
    this.buffer = new StreamBuffer({
      channelOrUrl: config.channelOrUrl,
      quality: '720p60,720p,best',
      bufferWindowSec: 240, // 4-minute rolling buffer
    });
    await this.buffer.start();

    // 2. Initialize real-time chat explosion tracker
    this.tracker = new ChatTracker({
      platform: config.platform,
      channelOrUrl: config.channelOrUrl,
      spikeMultiplier: config.spikeMultiplier ?? 2.5,
      minSpikeThreshold: config.minSpikeThreshold ?? 4.0,
      cooldownMs: config.cooldownMs ?? 35_000,
    });

    this.tracker.on('explosion', (evt: ChatExplosionEvent) => {
      this.handleExplosion(evt);
    });

    await this.tracker.start();
  }

  public async stopSession(): Promise<void> {
    this.isRunning = false;
    if (this.tracker) {
      this.tracker.stop();
      this.tracker = null;
    }
    if (this.buffer) {
      this.buffer.stop();
      this.buffer = null;
    }
    this.config = null;
    console.log('[live-manager] Live session stopped.');
  }

  /**
   * Handles chat explosion event:
   * Clips 10 seconds before and 10 seconds after the spike.
   */
  private handleExplosion(evt: ChatExplosionEvent): void {
    if (!this.buffer) return;

    const spikeTime = evt.timestampMs;
    // Exactly 10s before and 10s after (20s total clip)
    const clipStartMs = spikeTime - 10_000;
    const clipEndMs = spikeTime + 10_000;

    console.log(
      `[live-manager] 🎯 Scheduling clip extraction for spike at ${new Date(spikeTime).toLocaleTimeString()}` +
      ` (Window: -10s to +10s)`
    );

    // Wait until the +10s video is recorded + 3s buffer delay
    const delayMs = Math.max(1000, (clipEndMs + 3000) - Date.now());

    setTimeout(async () => {
      try {
        if (!this.buffer) return;

        const cleanChannel = (this.config?.channelOrUrl ?? 'stream')
          .replace(/https?:\/\//, '')
          .replace(/[^a-zA-Z0-9_-]/g, '_');

        const title = `${cleanChannel}_explosion_${evt.velocity.toFixed(0)}mps`;
        const result = await this.buffer.extractClip(clipStartMs, clipEndMs, {
          title,
          vertical: this.config?.vertical ?? true,
        });

        // Insert into SQLite database clips table
        const clipId = crypto.randomUUID();
        const description = `Chat exploded to ${evt.velocity} msg/s (${evt.multiplier}x baseline). Sample: ${evt.sampleMessages.slice(0, 3).join(' | ')}`;

        db.prepare(`
          INSERT INTO clips (id, job_id, title, description, start_sec, end_sec, duration_sec, file_path, file_size_bytes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          clipId,
          `live_${cleanChannel}`,
          title,
          description,
          0,
          result.durationSec,
          result.durationSec,
          result.filePath,
          result.fileSizeBytes
        );

        this.recentClips.push({
          id: clipId,
          filePath: result.filePath,
          timestamp: new Date().toISOString(),
        });

        // Notify Discord/Telegram / Desktop
        void this.notifyClip(title, result.filePath, result.fileSizeBytes);

        this.emit('clip', {
          id: clipId,
          filePath: result.filePath,
          event: evt,
        });
      } catch (err) {
        console.error('[live-manager] Failed to extract explosion clip:', err);
      }
    }, delayMs);
  }

  /**
   * Manual trigger: clip the last N seconds on demand.
   */
  public async manualClip(durationSec = 20): Promise<{ id: string; filePath: string }> {
    if (!this.buffer) throw new Error('No live buffer active');

    const now = Date.now();
    const clipEndMs = now - 1000; // 1s ago to ensure segment flushed
    const clipStartMs = clipEndMs - (durationSec * 1000);

    const cleanChannel = (this.config?.channelOrUrl ?? 'manual')
      .replace(/https?:\/\//, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');

    const title = `${cleanChannel}_manual`;
    const result = await this.buffer.extractClip(clipStartMs, clipEndMs, {
      title,
      vertical: this.config?.vertical ?? true,
    });

    const clipId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO clips (id, job_id, title, description, start_sec, end_sec, duration_sec, file_path, file_size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clipId,
      `manual_${cleanChannel}`,
      title,
      `Manual clip (${durationSec}s)`,
      0,
      result.durationSec,
      result.durationSec,
      result.filePath,
      result.fileSizeBytes
    );

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
