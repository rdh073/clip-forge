// cartesia.mjs — Cartesia (Sonic) TTS adapter. BYO key (CARTESIA_API_KEY).
//
// Voice clone via the /voices/clone endpoint. Per-char cost estimate uses
// Cartesia's published rate (~$0.04 / 1k chars for the Pro tier).

import { writeFileSync, readFileSync } from 'node:fs';

const COST_PER_CHAR_USD   = 0.00004;
const COST_PER_CLONE_USD  = 0.00;
const DEFAULT_MODEL       = 'sonic-2';
const DEFAULT_VOICE_ID    = 'a0e99841-438c-4a64-b679-ae501e7d6091';
const API_BASE            = 'https://api.cartesia.ai';
const API_VERSION         = '2024-11-13';

export const NAME = 'cartesia';
export const SUPPORTS_VOICE_CLONE = true;

function apiKey() {
  return process.env.CARTESIA_API_KEY || '';
}

export function available() {
  return apiKey().length > 0;
}

export function estimateCostUsd(text) {
  return Math.max(0, String(text || '').length) * COST_PER_CHAR_USD;
}

export async function synthesize(req) {
  if (!available()) {
    throw new Error('cartesia: CARTESIA_API_KEY not set');
  }
  const text = String(req.text || '');
  if (text.length === 0) {
    writeFileSync(req.audio_path, Buffer.alloc(0));
    return { audio_path: req.audio_path, cost_usd: 0, model: req.model || DEFAULT_MODEL, voice_id: req.voice_id || DEFAULT_VOICE_ID };
  }
  const voiceId = req.voice_id || DEFAULT_VOICE_ID;
  const model   = req.model || DEFAULT_MODEL;
  const language = req.language || 'en';
  const url = API_BASE + '/tts/bytes';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-Key':       apiKey(),
      'Cartesia-Version': API_VERSION,
      'Content-Type':    'application/json',
    },
    body: JSON.stringify({
      model_id:        model,
      transcript:      text,
      voice:           { mode: 'id', id: voiceId },
      output_format:   { container: 'wav', encoding: 'pcm_s16le', sample_rate: 22050 },
      language,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('cartesia: ' + res.status + ' ' + res.statusText + ' :: ' + body.slice(0, 240));
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

export async function cloneVoice(req) {
  if (!available()) {
    throw new Error('cartesia: CARTESIA_API_KEY not set');
  }
  const url = API_BASE + '/voices/clone';
  const form = new FormData();
  form.append('name', req.name);
  if (req.description) form.append('description', req.description);
  form.append('mode', 'similarity');
  const sample = readFileSync(req.sample_path);
  const blob = new Blob([sample], { type: 'audio/wav' });
  form.append('clip', blob, req.name + '.wav');
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'X-API-Key': apiKey(), 'Cartesia-Version': API_VERSION },
    body:    form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('cartesia: voice clone failed ' + res.status + ' :: ' + body.slice(0, 240));
  }
  const json = await res.json();
  return { voice_id: json.id, cost_usd: COST_PER_CLONE_USD, provider: 'cartesia' };
}
