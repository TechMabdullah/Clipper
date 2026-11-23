import { EventEmitter } from 'node:events';

export type LivePlatform = 'twitch' | 'youtube';

export interface ChatMessage {
  author: string;
  text: string;
  timestampMs: number;
}

export interface ChatExplosionEvent {
  timestampMs: number;
  velocity: number;      // Current messages per second
  baseline: number;      // Rolling 60s average velocity
  multiplier: number;    // velocity / baseline
  sampleMessages: string[];
}

export interface ChatTrackerOptions {
  platform: LivePlatform;
  channelOrUrl: string;
  /** Multiplier above rolling average to trigger explosion (default: 2.5) */
  spikeMultiplier?: number;
  /** Minimum messages/sec to count as an explosion even if multiplier hits (default: 4.0) */
  minSpikeThreshold?: number;
  /** Cooldown in ms after an explosion before another can trigger (default: 35000 = 35s) */
  cooldownMs?: number;
}

const HYPE_KEYWORDS = [
  'lmao', 'kekw', 'omegalul', 'pog', 'poggers', 'holy', 'wtf', 'w', 'l',
  'clip', 'sheesh', 'gg', 'omg', 'bro', 'no way', 'haha', '💀', '😭', '🔥', '😱'
];

export class ChatTracker extends EventEmitter {
  private platform: LivePlatform;
  private channelOrUrl: string;
  private spikeMultiplier: number;
  private minSpikeThreshold: number;
  private cooldownMs: number;

  private messageTimestamps: number[] = [];
  private recentMessages: { text: string; time: number }[] = [];
  private lastExplosionTime = 0;
  private isRunning = false;
  private ws: WebSocket | null = null;
  private ytChat: any = null;
  private intervalTimer: NodeJS.Timeout | null = null;

  public currentVelocity = 0;
  public baselineVelocity = 0;

  constructor(options: ChatTrackerOptions) {
    super();
    this.platform = options.platform;
    this.channelOrUrl = options.channelOrUrl;
    this.spikeMultiplier = options.spikeMultiplier ?? 2.5;
    this.minSpikeThreshold = options.minSpikeThreshold ?? 4.0;
    this.cooldownMs = options.cooldownMs ?? 35_000;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    if (this.platform === 'twitch') {
      this.startTwitch();
    } else if (this.platform === 'youtube') {
      await this.startYouTube();
    }

    // Velocity evaluator runs every 1000ms
    this.intervalTimer = setInterval(() => this.evaluateVelocity(), 1000);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    if (this.ytChat) {
      try { this.ytChat.stop(); } catch {}
      this.ytChat = null;
    }
  }

  private handleMessage(msg: ChatMessage): void {
    const now = msg.timestampMs;
    this.messageTimestamps.push(now);
    this.recentMessages.push({ text: msg.text, time: now });

    // Prune messages older than 60s
    const cutoff = now - 60_000;
    while (this.messageTimestamps.length > 0 && this.messageTimestamps[0]! < cutoff) {
      this.messageTimestamps.shift();
    }
    while (this.recentMessages.length > 0 && this.recentMessages[0]!.time < cutoff) {
      this.recentMessages.shift();
    }

    this.emit('message', msg);
  }

  private evaluateVelocity(): void {
    const now = Date.now();
    // Messages in last 3 seconds
    const window3s = now - 3_000;
    let count3s = 0;
    for (let i = this.messageTimestamps.length - 1; i >= 0; i--) {
      if (this.messageTimestamps[i]! >= window3s) count3s++;
      else break;
    }

    // Current MPS (Messages Per Second)
    this.currentVelocity = count3s / 3.0;

    // Baseline MPS over last 60 seconds (or available time)
    const totalCount = this.messageTimestamps.length;
    const windowDuration = this.messageTimestamps.length > 1
      ? Math.max(5, (now - this.messageTimestamps[0]!) / 1000)
      : 5;
    this.baselineVelocity = Math.max(0.5, totalCount / windowDuration);

    // Calculate hype emote bonus in the last 3s
    const last3sMsgs = this.recentMessages.filter(m => m.time >= window3s);
    let hypeMatches = 0;
    for (const m of last3sMsgs) {
      const lower = m.text.toLowerCase();
      if (HYPE_KEYWORDS.some(k => lower.includes(k))) hypeMatches++;
    }
    const hypeRatio = last3sMsgs.length > 0 ? (hypeMatches / last3sMsgs.length) : 0;
    // Hype emote boost: up to 1.5x effective velocity if chat is full of laughing/hype emotes
    const effectiveVelocity = this.currentVelocity * (1 + hypeRatio * 0.5);

    const ratio = effectiveVelocity / this.baselineVelocity;

    // Check explosion criteria
    const meetsMultiplier = ratio >= this.spikeMultiplier;
    const meetsMinThreshold = this.currentVelocity >= this.minSpikeThreshold;
    const offCooldown = (now - this.lastExplosionTime) > this.cooldownMs;

    if (meetsMultiplier && meetsMinThreshold && offCooldown) {
      this.lastExplosionTime = now;
      const sample = last3sMsgs.slice(-5).map(m => m.text);

      const explosionEvent: ChatExplosionEvent = {
        timestampMs: now,
        velocity: Number(this.currentVelocity.toFixed(1)),
        baseline: Number(this.baselineVelocity.toFixed(1)),
        multiplier: Number(ratio.toFixed(2)),
        sampleMessages: sample,
      };

      console.log(
        `[chat-tracker] 💥 CHAT EXPLOSION DETECTED! Velocity: ${explosionEvent.velocity} msg/s ` +
        `(Baseline: ${explosionEvent.baseline} msg/s, Spike: ${explosionEvent.multiplier}x)`
      );

      this.emit('explosion', explosionEvent);
    }
  }

  // ── Twitch IRC over WebSocket (Anonymous, zero-API) ─────────────────────
  private startTwitch(): void {
    let channel = this.channelOrUrl.toLowerCase().trim();
    if (channel.includes('twitch.tv/')) {
      channel = channel.split('twitch.tv/')[1]!.split(/[/?#]/)[0]!;
    }
    channel = channel.replace(/^#/, '');

    const url = 'wss://irc-ws.chat.twitch.tv:443';
    console.log(`[chat-tracker] Connecting anonymously to Twitch chat: #${channel}...`);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      if (!this.ws) return;
      this.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      this.ws.send('PASS SCHMOOPIE');
      const randomNick = `justinfan${Math.floor(10000 + Math.random() * 90000)}`;
      this.ws.send(`NICK ${randomNick}`);
      this.ws.send(`JOIN #${channel}`);
      console.log(`[chat-tracker] Joined #${channel} as ${randomNick}`);
    };

    this.ws.onmessage = (event) => {
      const raw = String(event.data);
      if (raw.startsWith('PING')) {
        this.ws?.send('PONG :tmi.twitch.tv');
        return;
      }

      // Parse PRIVMSG
      const lines = raw.split('\r\n');
      for (const line of lines) {
        if (!line.includes('PRIVMSG')) continue;

        // Extract author and message
        const match = line.match(/:([^!]+)![^@]+@[^.]+\.tmi\.twitch\.tv PRIVMSG #[^ ]+ :(.+)/);
        if (match) {
          const author = match[1] ?? 'user';
          const text = match[2] ?? '';
          this.handleMessage({ author, text, timestampMs: Date.now() });
        }
      }
    };

    this.ws.onerror = (err) => {
      console.error('[chat-tracker] Twitch WebSocket error:', err);
    };

    this.ws.onclose = () => {
      if (this.isRunning) {
        console.warn('[chat-tracker] Twitch WebSocket disconnected — reconnecting in 3s...');
        setTimeout(() => { if (this.isRunning) this.startTwitch(); }, 3000);
      }
    };
  }

  // ── YouTube Live Chat (Zero-API using youtube-chat package) ─────────────
  private async startYouTube(): Promise<void> {
    try {
      const { LiveChat } = await import('youtube-chat');
      let target = this.channelOrUrl.trim();
      let options: any = {};

      if (target.includes('watch?v=')) {
        options.liveId = target.split('watch?v=')[1]!.split('&')[0]!;
      } else if (target.includes('youtube.com/live/')) {
        options.liveId = target.split('/live/')[1]!.split(/[/?#]/)[0]!;
      } else if (target.startsWith('UC') && target.length === 24) {
        options.channelId = target;
      } else {
        options.channelId = target;
      }

      console.log(`[chat-tracker] Connecting to YouTube live chat (${JSON.stringify(options)})...`);
      this.ytChat = new LiveChat(options);

      this.ytChat.on('chat', (chatItem: any) => {
        const author = chatItem.author?.name ?? 'viewer';
        const text = chatItem.message?.map((m: any) => m.text ?? '').join('') ?? '';
        this.handleMessage({ author, text, timestampMs: Date.now() });
      });

      this.ytChat.on('error', (err: any) => {
        console.error('[chat-tracker] YouTube chat error:', err);
      });

      const ok = await this.ytChat.start();
      if (!ok) {
        console.warn('[chat-tracker] Failed to find active YouTube live chat for target.');
      } else {
        console.log('[chat-tracker] Connected to YouTube live chat.');
      }
    } catch (err) {
      console.error('[chat-tracker] Error initializing YouTube chat:', err);
    }
  }
}
