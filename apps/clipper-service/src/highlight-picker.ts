import type { Segment } from './transcriber.js';

const LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'mock';
const LLM_API_KEY  = process.env.LLM_API_KEY ?? '';
const LLM_MODEL    = process.env.LLM_MODEL ?? 'gemini-2.5-flash';

export interface Highlight {
  title: string;
  description: string;
  startSec: number;
  endSec: number;
}

const SYSTEM_PROMPT = `You are a viral short-form video editor.
Given a timestamped transcript, identify 2-5 highlight clips suitable for 9:16 short-form video.
Each clip should be 20–90 seconds, self-contained, and emotionally engaging.
Return ONLY valid JSON: { "highlights": [{ "title": string, "description": string, "startSec": number, "endSec": number }] }`;

export async function pickHighlights(segments: Segment[]): Promise<Highlight[]> {
  const transcript = segments
    .map((s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text}`)
    .join('\n');

  if (LLM_API_KEY && LLM_PROVIDER === 'gemini') return callGemini(transcript);
  if (LLM_API_KEY && LLM_PROVIDER === 'openai') return callOpenAI(transcript);

  console.log('[highlight-picker] No LLM key — using rule-based fallback');
  return ruleBasedPicker(segments);
}

function ruleBasedPicker(segments: Segment[]): Highlight[] {
  if (!segments.length) return [];
  const CLIP_TARGET_SEC = 55;
  const highlights: Highlight[] = [];
  const scored = segments
    .map((s, i) => ({ i, words: s.text.split(/\s+/).length, start: s.start, end: s.end }))
    .sort((a, b) => b.words - a.words);

  const used = new Set<number>();
  for (const top of scored.slice(0, 5)) {
    if (used.has(top.i)) continue;
    let clipStart = top.start;
    let clipEnd = top.end;
    let j = top.i;
    while (j < segments.length - 1 && clipEnd - clipStart < CLIP_TARGET_SEC) {
      j++;
      if (!used.has(j)) clipEnd = segments[j]!.end;
    }
    let overlaps = false;
    for (const h of highlights) {
      if (clipStart < h.endSec && clipEnd > h.startSec) { overlaps = true; break; }
    }
    if (overlaps) continue;
    for (let k = top.i; k <= j; k++) used.add(k);
    highlights.push({
      title: `Clip ${highlights.length + 1}`,
      description: `Auto-picked (${clipStart.toFixed(0)}s–${clipEnd.toFixed(0)}s)`,
      startSec: Math.max(0, clipStart - 1),
      endSec: clipEnd + 1,
    });
    if (highlights.length >= 3) break;
  }
  return highlights;
}

async function callGemini(transcript: string): Promise<Highlight[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}:generateContent?key=${LLM_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nTranscript:\n${transcript}` }] }],
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
    }),
  });
  const json = (await res.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  return (JSON.parse(text) as { highlights: Highlight[] }).highlights ?? [];
}

async function callOpenAI(transcript: string): Promise<Highlight[]> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Transcript:\n${transcript}` },
      ],
    }),
  });
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const text = json.choices?.[0]?.message?.content ?? '{}';
  return (JSON.parse(text) as { highlights: Highlight[] }).highlights ?? [];
}
