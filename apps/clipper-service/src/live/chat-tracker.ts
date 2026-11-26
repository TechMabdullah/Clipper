import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export type LivePlatform = 'twitch' | 'youtube' | 'kick';

export interface ChatMessage {
  author: string;
  text: string;
  timestampMs: number;
}

export interface LiveChatFeedMessage extends ChatMessage {
  id: string;
  isHype: boolean;
  isTrigger?: boolean;
}

export interface ChatExplosionEvent {
  timestampMs: number;
  velocity: number;      // Current messages per second
  baseline: number;      // Rolling 60s average velocity
  multiplier: number;    // velocity / baseline
  sampleMessages: string[];
  triggerReason?: 'velocity' | 'trigger_keyword';
  triggerCount?: number;
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
  /** Custom chat keywords/commands that trigger a clip when typed >= 2 times in 6s */
  triggerKeywords?: string[];
}

const DEFAULT_TRIGGER_KEYWORDS = ['!clip', 'clip it', 'clipped'];

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
  private triggerKeywords: string[];

  private messageTimestamps: number[] = [];
  private triggerTimestamps: number[] = [];
  private recentMessages: { text: string; time: number; isTrigger: boolean }[] = [];
  private chatFeed: LiveChatFeedMessage[] = [];
  private lastExplosionTime = 0;
  private isRunning = false;
  private ws: WebSocket | null = null;
  private ytChat: any = null;
  private intervalTimer: NodeJS.Timeout | null = null;

  public currentVelocity = 0;
  public baselineVelocity = 0;
  public triggerCount = 0;

  constructor(options: ChatTrackerOptions) {
    super();
    this.platform = options.platform;
    this.channelOrUrl = options.channelOrUrl;
    this.spikeMultiplier = options.spikeMultiplier ?? 2.5;
    this.minSpikeThreshold = options.minSpikeThreshold ?? 4.0;
    this.cooldownMs = options.cooldownMs ?? 35_000;
    const rawTriggers = options.triggerKeywords ?? DEFAULT_TRIGGER_KEYWORDS;
    this.triggerKeywords = rawTriggers
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    if (this.platform === 'twitch') {
      this.startTwitch();
    } else if (this.platform === 'youtube') {
      await this.startYouTube();
    } else if (this.platform === 'kick') {
      await this.startKick();
    }

    // Velocity evaluator runs every 1000ms
    this.intervalTimer = setInterval(() => this.evaluateVelocity(), 1000);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    if (this.ytChat) {
      try { this.ytChat.stop(); } catch {}
      this.ytChat = null;
    }
  }

  public getRecentChat(limit = 40): LiveChatFeedMessage[] {
    return this.chatFeed.slice(-limit);
  }

  public getTriggerKeywords(): string[] {
    return [...this.triggerKeywords];
  }

  private pruneOldWindows(cutoff: number): void {
    while (this.messageTimestamps.length > 0 && this.messageTimestamps[0]! < cutoff) {
      this.messageTimestamps.shift();
    }
    while (this.recentMessages.length > 0 && this.recentMessages[0]!.time < cutoff) {
      this.recentMessages.shift();
    }
    while (this.triggerTimestamps.length > 0 && this.triggerTimestamps[0]! < cutoff) {
      this.triggerTimestamps.shift();
    }
  }

  private handleMessage(msg: ChatMessage): void {
    const now = msg.timestampMs;
    const lower = msg.text.toLowerCase();
    const isTrigger = this.triggerKeywords.length > 0 && this.triggerKeywords.some(k => lower.includes(k));
    const isHype = HYPE_KEYWORDS.some(k => lower.includes(k)) || isTrigger;

    this.messageTimestamps.push(now);
    this.recentMessages.push({ text: msg.text, time: now, isTrigger });
    if (isTrigger) {
      this.triggerTimestamps.push(now);
      this.triggerCount += 1;
    }

    const feedEntry: LiveChatFeedMessage = {
      id: crypto.randomUUID(),
      author: msg.author,
      text: msg.text,
      timestampMs: now,
      isHype,
      isTrigger,
    };
    this.chatFeed.push(feedEntry);
    if (this.chatFeed.length > 60) {
      this.chatFeed.shift();
    }

    // Prune messages & trigger timestamps older than 60s
    this.pruneOldWindows(now - 60_000);

    this.emit('message', msg);
    this.emit('chat', feedEntry);
  }

  private evaluateVelocity(): void {
    const now = Date.now();
    this.pruneOldWindows(now - 60_000);

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

    // Trigger keywords in the last 6 seconds (enables low-viewer streams to trigger via !clip etc.)
    const window6s = now - 6_000;
    let recentTriggerCount = 0;
    for (let i = this.triggerTimestamps.length - 1; i >= 0; i--) {
      const ts = this.triggerTimestamps[i]!;
      if (ts >= window6s && ts > this.lastExplosionTime) {
        recentTriggerCount++;
      } else if (ts < window6s) {
        break;
      }
    }

    // Check explosion criteria
    const meetsMultiplier = ratio >= this.spikeMultiplier;
    const meetsMinThreshold = this.currentVelocity >= this.minSpikeThreshold;
    const meetsVelocityExplosion = meetsMultiplier && meetsMinThreshold;
    const meetsKeywordTrigger = recentTriggerCount >= 2;
    const offCooldown = (now - this.lastExplosionTime) > this.cooldownMs;

    if ((meetsVelocityExplosion || meetsKeywordTrigger) && offCooldown) {
      this.lastExplosionTime = now;
      const triggerMsgs6s = this.recentMessages.filter(m => m.time >= window6s && m.isTrigger);
      const otherMsgs3s = last3sMsgs.filter(m => !m.isTrigger);
      const sample = triggerMsgs6s.length > 0
        ? [...triggerMsgs6s.slice(-3), ...otherMsgs3s.slice(-3)].slice(0, 5).map(m => m.text)
        : last3sMsgs.slice(-5).map(m => m.text);

      const triggerReason: ChatExplosionEvent['triggerReason'] = meetsVelocityExplosion
        ? 'velocity'
        : 'trigger_keyword';

      const explosionEvent: ChatExplosionEvent = {
        timestampMs: now,
        velocity: Number(this.currentVelocity.toFixed(1)),
        baseline: Number(this.baselineVelocity.toFixed(1)),
        multiplier: Number(ratio.toFixed(2)),
        sampleMessages: sample,
        triggerReason,
        triggerCount: recentTriggerCount,
      };

      if (triggerReason === 'trigger_keyword') {
        console.log(
          `[chat-tracker] 🎯 TRIGGER KEYWORD CLIP! (${recentTriggerCount} matches in 6s: ${sample.slice(0, 2).join(' | ')})`
        );
      } else {
        console.log(
          `[chat-tracker] 💥 CHAT EXPLOSION DETECTED! Velocity: ${explosionEvent.velocity} msg/s ` +
          `(Baseline: ${explosionEvent.baseline} msg/s, Spike: ${explosionEvent.multiplier}x)`
        );
      }

      this.emit('explosion', explosionEvent);
    }
  }

  // ── Twitch IRC over WebSocket (Anonymous, zero-API) ─────────────────────
  private startTwitch(): void {
    let channel = this.channelOrUrl.toLowerCase().trim();
    if (channel.includes('twitch.tv/')) {
      channel = channel.split('twitch.tv/')[1]!.split(/[/?#]/)[0]!;
    }
    channel = channel.replace(/^#/, '').replace(/[^a-z0-9_]/g, '');
    if (!channel) {
      console.error('[chat-tracker] Invalid Twitch channel name.');
      return;
    }

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

  // ── Kick Live Chat (Guest Centrifugo WebSocket) ────────────────────────
  private async startKick(): Promise<void> {
    const channel = this.channelOrUrl
      .replace(/^https?:\/\/(?:www\.)?kick\.com\//i, '')
      .replace(/\/.*$/, '')
      .replace(/[\r\n\s]+/g, '')
      .trim();
    if (!channel || !/^[a-zA-Z0-9_-]{1,64}$/.test(channel)) {
      console.error('[chat-tracker] Invalid Kick channel slug.');
      return;
    }

    console.log(`[chat-tracker] Connecting to Kick chat for: ${channel}...`);

    try {
      // 1. Fetch channel info to obtain chatroom ID
      const chRes = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!chRes.ok) {
        throw new Error(`Failed to fetch Kick channel info (${chRes.status}): ${channel}`);
      }
      const chData: any = await chRes.json();
      const chatroomId = chData?.chatroom?.id;
      if (!chatroomId) {
        throw new Error(`Kick chatroom ID not found for channel: ${channel}`);
      }

      // 2. Request guest auth token for Kick Centrifugo connection
      const clientId = crypto.randomUUID();
      const authRes = await fetch('https://web.kick.com/api/v1/realtime/auth/connection', {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://kick.com',
          'Referer': `https://kick.com/${channel}`
        },
        body: JSON.stringify({ client_id: clientId })
      });
      const authData: any = await authRes.json();
      const token = authData?.data?.token;

      // 3. Connect to Kick Centrifugo WebSocket
      const wsUrl = 'wss://realtime.us-east-1.platform.kick.com/connection/websocket';
      this.ws = new WebSocket(wsUrl);
      let msgId = 1;

      this.ws.onopen = () => {
        console.log(`[chat-tracker] Connected to Kick realtime WebSocket. Authenticating...`);
        this.ws?.send(JSON.stringify({
          id: msgId++,
          connect: token ? { token } : {}
        }));
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString();
          const packet = JSON.parse(raw);

          // Handle heartbeat frame
          if (Object.keys(packet).length === 0) {
            this.ws?.send(JSON.stringify({}));
            return;
          }

          // On connect confirmation, subscribe to chatroom channel
          if (packet.id === 1 && packet.connect) {
            console.log(`[chat-tracker] Kick auth verified. Subscribing to chatrooms.${chatroomId}.v2...`);
            this.ws?.send(JSON.stringify({
              id: msgId++,
              subscribe: {
                channel: `chatrooms.${chatroomId}.v2`
              }
            }));
            return;
          }

          // On publication frame: extract message
          if (packet.push?.pub?.data) {
            const pubData = packet.push.pub.data;
            let msgObj = pubData;
            if (pubData.event === 'App\\Events\\ChatMessageEvent' && typeof pubData.data === 'string') {
              try { msgObj = JSON.parse(pubData.data); } catch {}
            }

            const author = msgObj?.sender?.username ?? 'viewer';
            const text = msgObj?.content ?? (typeof msgObj === 'string' ? msgObj : '');
            if (text) {
              this.handleMessage({
                author,
                text,
                timestampMs: Date.now()
              });
            }
          }
        } catch {
          // Ignore malformed frame
        }
      };

      this.ws.onerror = (err) => {
        console.error('[chat-tracker] Kick WebSocket error:', err);
      };

      this.ws.onclose = () => {
        if (this.isRunning) {
          console.warn('[chat-tracker] Kick WebSocket disconnected — reconnecting in 5s...');
          setTimeout(() => { if (this.isRunning) void this.startKick(); }, 5000);
        }
      };
    } catch (err) {
      console.error('[chat-tracker] Failed to start Kick chat tracker:', err);
    }
  }
}
