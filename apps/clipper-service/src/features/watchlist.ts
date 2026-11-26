import crypto from 'node:crypto';
import { db } from '../db.js';
import type { LivePlatform } from '../live/chat-tracker.js';
import type { ClipLayout, FacecamPosition } from '../live/layout-utils.js';
import type { CaptionStyle } from './captions.js';

export interface WatchlistEntry {
  id: string;
  platform: LivePlatform;
  channel: string;
  layout: ClipLayout;
  facecam_position: FacecamPosition;
  caption_style: CaptionStyle;
  auto_clip: number;
  enabled: number;
  is_currently_live: number;
  last_checked_at: string;
  created_at: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

export function listWatchlist(): WatchlistEntry[] {
  return db.prepare(`SELECT * FROM stream_watchlist ORDER BY created_at DESC`).all() as unknown as WatchlistEntry[];
}

export function normalizeWatchlistChannel(platform: LivePlatform, rawChannel: string): string {
  let input = String(rawChannel ?? '').trim();
  if (!input) throw new Error('Channel name is required');

  // Prepend https:// for scheme-less URLs like twitch.tv/name, kick.com/name, youtube.com/@handle
  if (
    !/^https?:\/\//i.test(input) &&
    /^(?:www\.|m\.)?(?:twitch\.tv|kick\.com|youtube\.com|youtu\.be)\//i.test(input)
  ) {
    input = `https://${input}`;
  }

  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error('Invalid channel URL');
    }

    const segments = url.pathname.split('/').filter(Boolean);

    if (platform === 'youtube' || /(?:^|\.)(?:youtube\.com|youtu\.be)$/i.test(url.hostname)) {
      if (/(?:^|\.)youtu\.be$/i.test(url.hostname) && segments[0]) {
        return `https://www.youtube.com/watch?v=${segments[0]}`;
      }
      const vParam = url.searchParams.get('v')?.trim();
      if (vParam) {
        return `https://www.youtube.com/watch?v=${vParam}`;
      }
      if (segments[0] === 'live' && segments[1]) {
        return `https://www.youtube.com/watch?v=${segments[1]}`;
      }
      if (segments[0] === 'channel' && segments[1]) {
        return segments[1];
      }
      if (segments[0]?.startsWith('@')) {
        return segments[0];
      }
      if ((segments[0] === 'c' || segments[0] === 'user') && segments[1]) {
        return `https://www.youtube.com/${segments[0]}/${segments[1]}/live`;
      }
      if (segments[0]) {
        return `@${segments[0].replace(/^@/, '')}`;
      }
      throw new Error('Invalid YouTube channel or video URL');
    }

    const slug = (segments[0] ?? '').replace(/^[@#]/, '').trim().toLowerCase();
    if (!slug) throw new Error('Channel name is required');
    return slug;
  }

  if (platform === 'youtube') {
    if (input.startsWith('watch?v=')) {
      const v = new URLSearchParams(input.slice('watch?'.length)).get('v')?.trim();
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    }
    if (/^UC[A-Za-z0-9_-]{20,}$/.test(input)) {
      return input;
    }
    const stripped = input.replace(/^[@#]/, '').replace(/\/.*$/, '').trim();
    if (!stripped) throw new Error('Channel name is required');
    return `@${stripped}`;
  }

  const cleanSlug = input.replace(/^[@#]/, '').replace(/\/.*$/, '').trim().toLowerCase();
  if (!cleanSlug) throw new Error('Channel name is required');
  return cleanSlug;
}

function channelDedupeKey(platform: LivePlatform, channel: string): string {
  if (platform === 'youtube') {
    if (channel.startsWith('UC') || /^https?:\/\//i.test(channel)) {
      return channel;
    }
    return channel.replace(/^@/, '').toLowerCase();
  }
  return channel.toLowerCase();
}

export function addWatchlistChannel(input: {
  platform: LivePlatform;
  channel: string;
  layout?: ClipLayout;
  facecamPosition?: FacecamPosition;
  captionStyle?: CaptionStyle;
  autoClip?: boolean;
}): WatchlistEntry {
  const cleanChannel = normalizeWatchlistChannel(input.platform, input.channel);
  const newKey = channelDedupeKey(input.platform, cleanChannel);

  const existing = db
    .prepare(`SELECT id, channel FROM stream_watchlist WHERE platform=?`)
    .all(input.platform) as Array<{ id: string; channel: string }>;

  if (existing.some((row) => channelDedupeKey(input.platform, row.channel) === newKey)) {
    throw new Error(`Channel "${cleanChannel}" is already on the ${input.platform} watchlist.`);
  }

  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO stream_watchlist (id, platform, channel, layout, facecam_position, caption_style, auto_clip, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id,
    input.platform,
    cleanChannel,
    input.layout ?? 'split',
    input.facecamPosition ?? 'auto',
    input.captionStyle ?? 'none',
    input.autoClip ? 1 : 0
  );

  return db.prepare(`SELECT * FROM stream_watchlist WHERE id=?`).get(id) as unknown as WatchlistEntry;
}

export function removeWatchlistChannel(id: string): void {
  db.prepare(`DELETE FROM stream_watchlist WHERE id=?`).run(id);
}

export function toggleWatchlistAutoClip(id: string, autoClip: boolean): void {
  db.prepare(`UPDATE stream_watchlist SET auto_clip=? WHERE id=?`).run(autoClip ? 1 : 0, id);
}

export async function isChannelLive(platform: LivePlatform, channel: string): Promise<boolean> {
  const clean = channel?.trim();
  if (!clean) return false;

  try {
    if (platform === 'kick') {
      const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(clean)}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { livestream?: unknown };
      return Boolean(data?.livestream);
    }

    if (platform === 'twitch') {
      const res = await fetch(`https://www.twitch.tv/${encodeURIComponent(clean)}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return false;
      const html = await res.text();
      return html.includes('"isLiveBroadcast":true');
    }

    if (platform === 'youtube') {
      let targetUrl: string;
      if (/^https?:\/\//i.test(clean)) {
        const parsed = new URL(clean);
        if (!/(?:^|\.)(?:youtube\.com|youtu\.be)$/i.test(parsed.hostname)) {
          return false;
        }
        targetUrl = parsed.toString();
      } else if (clean.startsWith('watch?v=')) {
        const vid = new URLSearchParams(clean.slice('watch?'.length)).get('v');
        if (!vid) return false;
        targetUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`;
      } else if (/^UC[A-Za-z0-9_-]{20,}$/.test(clean)) {
        targetUrl = `https://www.youtube.com/channel/${encodeURIComponent(clean)}/live`;
      } else {
        targetUrl = `https://www.youtube.com/@${encodeURIComponent(clean.replace(/^@/, ''))}/live`;
      }

      const res = await fetch(targetUrl, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return false;
      const html = await res.text();
      if (/"isLiveNow":true/.test(html)) return true;
      return /"isLiveBroadcast":true/.test(html) && !/"isLiveNow":false/.test(html);
    }
  } catch {
    return false;
  }
  return false;
}

export async function pollWatchlistStatuses(
  onAutoStartRequested?: (entry: WatchlistEntry) => Promise<void>,
): Promise<WatchlistEntry[]> {
  const entries = listWatchlist();
  const nowIso = new Date().toISOString();

  for (const entry of entries) {
    if (!entry.enabled) continue;
    const liveNow = await isChannelLive(entry.platform, entry.channel);
    db.prepare(`UPDATE stream_watchlist SET is_currently_live=?, last_checked_at=? WHERE id=?`)
      .run(liveNow ? 1 : 0, nowIso, entry.id);

    if (liveNow && entry.auto_clip && onAutoStartRequested) {
      await onAutoStartRequested(entry);
    }
  }

  return listWatchlist();
}
