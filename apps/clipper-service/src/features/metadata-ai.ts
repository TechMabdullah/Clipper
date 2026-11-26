import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { THUMBS_DIR } from '../storage.js';

const FFMPEG = process.env.FFMPEG_BIN_PATH ?? 'ffmpeg';
const THUMB_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 15_000;

export interface ExtractThumbnailResult {
  thumbPath: string;
}

export interface GenerateSocialMetadataParams {
  title: string;
  description?: string;
  platform?: string;
  viralityScore?: number;
}

export interface SocialMetadataResult {
  socialTitle: string;
  socialDescription: string;
  hashtags: string[];
}

function runFfmpegThumbnail(videoPath: string, seekSec: number, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      FFMPEG,
      [
        '-y',
        '-ss', seekSec.toFixed(2),
        '-i', videoPath,
        '-vframes', '1',
        '-q:v', '3',
        outPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      if (!settled) {
        settled = true;
        reject(new Error('FFmpeg thumbnail extraction timed out after 30s'));
      }
    }, THUMB_TIMEOUT_MS);

    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(err.slice(-300) || `FFmpeg thumbnail failed (${code})`));
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

/**
 * Extracts a single JPEG cover frame from `videoPath` into `THUMBS_DIR/<clipId>.jpg`.
 * Automatically falls back to timestamp 0 if `seekSec` lands past the end of a short clip.
 */
export async function extractClipThumbnail(
  videoPath: string,
  clipId: string,
  seekSec = 2,
): Promise<ExtractThumbnailResult> {
  if (!videoPath?.trim() || !fs.existsSync(videoPath)) {
    throw new Error(`Source video not found: ${videoPath}`);
  }
  const safeId = clipId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) {
    throw new Error('Invalid clipId for thumbnail extraction');
  }

  if (!fs.existsSync(THUMBS_DIR)) {
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
  }

  const thumbPath = path.join(THUMBS_DIR, `${safeId}.jpg`);
  const safeSeek = Number.isFinite(seekSec) ? Math.max(0, seekSec) : 2;

  await runFfmpegThumbnail(videoPath, safeSeek, thumbPath);

  if ((!fs.existsSync(thumbPath) || fs.statSync(thumbPath).size === 0) && safeSeek > 0) {
    await runFfmpegThumbnail(videoPath, 0, thumbPath);
  }

  if (!fs.existsSync(thumbPath) || fs.statSync(thumbPath).size === 0) {
    throw new Error('Failed to generate thumbnail image from video');
  }

  return { thumbPath };
}

function normalizeHashtag(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#+/, '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!cleaned || cleaned.length < 2) return null;
  return `#${cleaned.toLowerCase()}`;
}

function normalizeMetadataResult(
  raw: Partial<SocialMetadataResult>,
  fallback: SocialMetadataResult,
): SocialMetadataResult {
  const socialTitle = typeof raw.socialTitle === 'string' && raw.socialTitle.trim()
    ? raw.socialTitle.trim().slice(0, 100)
    : fallback.socialTitle;

  const socialDescription = typeof raw.socialDescription === 'string' && raw.socialDescription.trim()
    ? raw.socialDescription.trim().slice(0, 500)
    : fallback.socialDescription;

  const rawTags = Array.isArray(raw.hashtags) ? raw.hashtags : fallback.hashtags;
  const deduped = new Set<string>();
  for (const t of rawTags) {
    if (typeof t !== 'string') continue;
    const tag = normalizeHashtag(t);
    if (tag) deduped.add(tag);
    if (deduped.size >= 10) break;
  }

  return {
    socialTitle,
    socialDescription,
    hashtags: deduped.size > 0 ? Array.from(deduped) : fallback.hashtags,
  };
}

function buildLocalSocialMetadata(params: GenerateSocialMetadataParams): SocialMetadataResult {
  const rawTitle = (params.title || 'Insane Stream Moment')
    .replace(/\(\d+:\d+(?::\d+)?\s*[–-]\s*\d+:\d+(?::\d+)?\)/g, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const score = Number.isFinite(params.viralityScore) ? Number(params.viralityScore) : 0;
  const desc = (params.description ?? '').trim();
  const combinedLower = `${rawTitle} ${desc}`.toLowerCase();
  const platform = (params.platform ?? '').toLowerCase();

  let prefix = '';
  if (score >= 85 && !/^🔥|^😱|^💀/.test(rawTitle)) {
    prefix = '🔥 ';
  } else if (score >= 70 && !rawTitle.includes('!') && !rawTitle.includes('?')) {
    prefix = 'Wait for it: ';
  }

  let baseTitle = rawTitle || 'Unbelievable Live Stream Moment';
  if (baseTitle.length < 18 && !prefix) {
    baseTitle = `${baseTitle} — Wait For The Reaction`;
  }
  const socialTitle = `${prefix}${baseTitle}`.trim().slice(0, 95);

  const cta = combinedLower.includes('chat') || combinedLower.includes('spike')
    ? 'Chat completely lost it at this moment 💀'
    : 'Watch till the end for the reaction 👀';
  const socialDescription = desc
    ? `${desc.replace(/\.+$/, '')}. ${cta}`
    : `${baseTitle} — ${cta}`;

  const tagSet = new Set<string>(['#shorts', '#viral', '#fyp']);

  if (platform.includes('twitch')) {
    tagSet.add('#twitch');
    tagSet.add('#twitchclips');
  } else if (platform.includes('kick')) {
    tagSet.add('#kick');
    tagSet.add('#kickclips');
  } else if (platform.includes('youtube')) {
    tagSet.add('#youtube');
    tagSet.add('#youtubeshorts');
  } else {
    tagSet.add('#clips');
  }

  const keywordMap: Array<[RegExp, string]> = [
    [/\b(clutch|ace|1v\d|win|victory)\b/i, '#clutch'],
    [/\b(rage|angry|mad|scream|yell)\b/i, '#rage'],
    [/\b(laugh|funny|lmao|kekw|haha|hilarious)\b/i, '#funny'],
    [/\b(fail|whiff|choke|rip)\b/i, '#gamingfails'],
    [/\b(valorant|val)\b/i, '#valorant'],
    [/\b(fortnite)\b/i, '#fortnite'],
    [/\b(gta|rp|fivem)\b/i, '#gtarp'],
    [/\b(minecraft)\b/i, '#minecraft'],
    [/\b(cs2|csgo|counter-?strike)\b/i, '#cs2'],
    [/\b(apex)\b/i, '#apexlegends'],
    [/\b(reaction|react|chat)\b/i, '#reaction'],
  ];

  for (const [pattern, tag] of keywordMap) {
    if (pattern.test(combinedLower)) {
      tagSet.add(tag);
    }
  }

  if (tagSet.size < 6) {
    tagSet.add('#gaming');
    tagSet.add('#livestream');
  }

  return {
    socialTitle,
    socialDescription: socialDescription.slice(0, 400),
    hashtags: Array.from(tagSet).slice(0, 8),
  };
}

/**
 * Generates high-retention short-form social title, caption description, and `#hashtags`.
 * Uses Gemini or OpenAI when `LLM_API_KEY` (or provider-specific key) is configured,
 * falling back cleanly to a smart local hook generator.
 */
export async function generateSocialMetadata(
  params: GenerateSocialMetadataParams,
): Promise<SocialMetadataResult> {
  const localFallback = buildLocalSocialMetadata(params);

  const providerEnv = (process.env.LLM_PROVIDER ?? '').trim().toLowerCase();
  const llmKey = process.env.LLM_API_KEY?.trim() ?? '';
  const geminiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? '';

  if (providerEnv === 'mock') {
    return localFallback;
  }

  const useGemini =
    providerEnv === 'gemini' ||
    Boolean(geminiKey) ||
    (Boolean(llmKey) && !llmKey.startsWith('sk-') && providerEnv !== 'openai');
  const useOpenAi =
    !useGemini &&
    (providerEnv === 'openai' || Boolean(openaiKey) || llmKey.startsWith('sk-'));

  const prompt = [
    'Generate viral YouTube Shorts / TikTok / Instagram Reels metadata for a stream clip.',
    'Return ONLY valid JSON with keys: "socialTitle" (punchy <= 80 chars), "socialDescription" (engaging 1-2 sentences <= 280 chars), "hashtags" (array of 5-8 strings starting with #).',
    `Clip Title: ${params.title}`,
    params.description ? `Context: ${params.description}` : '',
    params.platform ? `Source Platform: ${params.platform}` : '',
    params.viralityScore !== undefined ? `Virality Score: ${params.viralityScore}/100` : '',
  ].filter(Boolean).join('\n');

  if (useGemini) {
    const key = llmKey || geminiKey;
    if (key) {
      const model = process.env.LLM_MODEL?.trim() || 'gemini-2.5-flash';
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.6, responseMimeType: 'application/json' },
          }),
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
          const parsed = JSON.parse(text) as Partial<SocialMetadataResult>;
          return normalizeMetadataResult(parsed, localFallback);
        }
      } catch (err) {
        console.warn('[metadata-ai] Gemini metadata warning, using local generator:', err);
      }
    }
  }

  if (useOpenAi) {
    const key = llmKey || openaiKey;
    if (key) {
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: 'You are a short-form viral social media strategist. Return strictly JSON.',
              },
              { role: 'user', content: prompt },
            ],
          }),
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = data.choices?.[0]?.message?.content ?? '{}';
          const parsed = JSON.parse(text) as Partial<SocialMetadataResult>;
          return normalizeMetadataResult(parsed, localFallback);
        }
      } catch (err) {
        console.warn('[metadata-ai] OpenAI metadata warning, using local generator:', err);
      }
    }
  }

  return localFallback;
}
