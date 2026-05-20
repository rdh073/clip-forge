// groq.mjs — Groq PlayAI TTS adapter. BYO key (GROQ_API_KEY).
//
// PlayAI on Groq is a generic-voice TTS — NO voice clone support.
// Voice clone requests degrade gracefully to the default voice with a warning.
// Per-char cost ~ $0.05 / 1M chars on the public beta (very cheap).

import { writeFileSync } from 'node:fs';

const COST_PER_CHAR_USD  = 0.00000005;
const DEFAULT_MODEL      = 'playai-tts';
const DEFAULT_VOICE_ID   = 'Fritz-PlayAI';
const API_BASE           = 'https://api.groq.com/openai/v1';

export const NAME = 'groq';
export const SUPPORTS_VOICE_CLONE = false;

function apiKey() {
  return process.env.GROQ_API_KEY || '';
}

export function available() {
  return apiKey().length > 0;
}

export function estimateCostUsd(text) {
  return Math.max(0, String(text || '').length) * COST_PER_CHAR_USD;
}

export async function synthesize(req) {
  if (!available()) {
    throw new Error('groq: GROQ_API_KEY not set');
  }
  const text = String(req.text || '');
  if (text.length === 0) {
    writeFileSync(req.audio_path, Buffer.alloc(0));
    return { audio_path: req.audio_path, cost_usd: 0, model: req.model || DEFAULT_MODEL, voice_id: req.voice_id || DEFAULT_VOICE_ID };
  }
  // Groq PlayAI does not accept arbitrary cloned voice_ids — only the
  // catalog list. A non-catalog voice_id falls back to DEFAULT_VOICE_ID.
  // The dub skill surfaces this in dub_report.warnings.
  const voiceId = req.voice_id && req.voice_id.match(/-PlayAI$/) ? req.voice_id : DEFAULT_VOICE_ID;
  const model = req.model || DEFAULT_MODEL;
  const url = API_BASE + '/audio/speech';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey(),
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model,
      input:    text,
      voice:    voiceId,
      response_format: 'wav',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('groq: ' + res.status + ' ' + res.statusText + ' :: ' + body.slice(0, 240));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(req.audio_path, buf);
  return {
    audio_path: req.audio_path,
    cost_usd:   estimateCostUsd(text),
    model,
    voice_id:   voiceId,
  };
}

export async function cloneVoice(/* req */) {
  // Surfaced through the dispatcher; voice-clone skill prints the bilingual
  // warning. We never throw from this path — the caller falls back to a
  // generic-voice voices.json entry.
  return {
    voice_id: DEFAULT_VOICE_ID,
    cost_usd: 0,
    provider: 'groq',
    warning:  'voice_clone_disabled_groq',
  };
}
