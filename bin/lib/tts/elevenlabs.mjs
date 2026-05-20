// elevenlabs.mjs — ElevenLabs TTS adapter. BYO key (ELEVENLABS_API_KEY).
//
// Pure-logic at import; network only inside synthesize() / cloneVoice().
// Voice clone is FULLY SUPPORTED (gold tier per PLAN §0).
//
// Per-character cost estimate uses the public mid-tier rate (~$0.30 / 1k chars
// for the Creator plan as of 2026-05). The estimate is intentionally
// conservative — real billing happens on the user's account.

import { writeFileSync, readFileSync } from 'node:fs';

const COST_PER_CHAR_USD   = 0.0003;
const COST_PER_CLONE_USD  = 0.00; // included in plan; clone itself is "free"
const DEFAULT_MODEL       = 'eleven_multilingual_v2';
const DEFAULT_VOICE_ID    = 'pNInz6obpgDQGcFmaJgB'; // ElevenLabs "Adam" — public
const API_BASE            = 'https://api.elevenlabs.io/v1';

export const NAME = 'elevenlabs';
export const SUPPORTS_VOICE_CLONE = true;

function apiKey() {
  return process.env.ELEVENLABS_API_KEY || '';
}

export function available() {
  return apiKey().length > 0;
}

export function estimateCostUsd(text) {
  return Math.max(0, String(text || '').length) * COST_PER_CHAR_USD;
}

/**
 * Synthesize speech to a WAV file on disk.
 *
 * @param {{text:string, voice_id?:string, language?:string, audio_path:string, model?:string}} req
 * @returns {Promise<{audio_path:string, cost_usd:number, model:string, voice_id:string}>}
 */
export async function synthesize(req) {
  if (!available()) {
    throw new Error('elevenlabs: ELEVENLABS_API_KEY not set');
  }
  const text = String(req.text || '');
  if (text.length === 0) {
    // Hallucination guard: empty text → 0-byte file (caller handles).
    writeFileSync(req.audio_path, Buffer.alloc(0));
    return { audio_path: req.audio_path, cost_usd: 0, model: req.model || DEFAULT_MODEL, voice_id: req.voice_id || DEFAULT_VOICE_ID };
  }
  const voiceId = req.voice_id || DEFAULT_VOICE_ID;
  const model   = req.model || DEFAULT_MODEL;
  const url = API_BASE + '/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=pcm_22050';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept':      'audio/wav',
      'xi-api-key':  apiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('elevenlabs: ' + res.status + ' ' + res.statusText + ' :: ' + body.slice(0, 240));
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

/**
 * Upload a voice sample to ElevenLabs and return its provider-assigned id.
 *
 * @param {{name:string, sample_path:string, description?:string}} req
 * @returns {Promise<{voice_id:string, cost_usd:number, provider:'elevenlabs'}>}
 */
export async function cloneVoice(req) {
  if (!available()) {
    throw new Error('elevenlabs: ELEVENLABS_API_KEY not set');
  }
  const url = API_BASE + '/voices/add';
  const form = new FormData();
  form.append('name', req.name);
  if (req.description) form.append('description', req.description);
  const sample = readFileSync(req.sample_path);
  // Use the basename so the provider sees a sensible filename in its UI.
  const blob = new Blob([sample], { type: 'audio/wav' });
  form.append('files', blob, req.name + '.wav');
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'xi-api-key': apiKey() },
    body:    form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('elevenlabs: voice clone failed ' + res.status + ' :: ' + body.slice(0, 240));
  }
  const json = await res.json();
  return { voice_id: json.voice_id, cost_usd: COST_PER_CLONE_USD, provider: 'elevenlabs' };
}
