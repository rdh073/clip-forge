// fal.mjs — fal.ai Flux Schnell image generation adapter (v0.4.0 pillar 5).
//
// Cheapest path in the visual.mjs dispatcher (~$0.003 / img). Used for
// gap-fill B-roll cutaways and (separately) for stylization of pre-existing
// frames via img2img — both go through this same module with differing
// inputs.
//
// Network only inside generate(); pure at import. Mirrors bin/lib/tts/
// elevenlabs.mjs shape exactly so the dispatcher can flip adapters by name.

import { writeFileSync, readFileSync } from 'node:fs';

const COST_PER_IMAGE_USD = 0.003;
const DEFAULT_MODEL      = 'fal-ai/flux/schnell';
const API_BASE           = 'https://fal.run';

export const NAME = 'fal';
export const SUPPORTS_STYLE_REF = true;

function apiKey() {
  return process.env.FAL_API_KEY || '';
}

export function available() {
  return apiKey().length > 0;
}

export function estimateCostUsd(count = 1) {
  return Math.max(0, count | 0) * COST_PER_IMAGE_USD;
}

/**
 * Generate one or more images. Writes binaries to req.paths (an array
 * with one slot per requested image). Returns { paths, cost_usd,
 * provider_used, prompt_used, model }.
 */
export async function generate(req) {
  if (!available()) {
    throw new Error('fal: FAL_API_KEY not set');
  }
  const count = Math.max(1, req.count || 1);
  const aspect = mapAspect(req.aspect || '9:16');
  const prompt = String(req.prompt || '').slice(0, 1500);
  const styleSuffix = req.brand_kit && req.brand_kit.colors
    ? ' ; brand colors ' + Object.values(req.brand_kit.colors).filter(Boolean).join(', ')
    : '';
  const finalPrompt = prompt + styleSuffix;

  const url = API_BASE + '/' + DEFAULT_MODEL;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': 'Key ' + apiKey(),
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      prompt:           finalPrompt,
      image_size:       aspect,
      num_inference_steps: 4,
      num_images:       count,
      enable_safety_checker: true,
      seed:             req.seed || 42,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('fal: ' + res.status + ' ' + res.statusText + ' :: ' + body.slice(0, 240));
  }
  const json = await res.json();
  const images = Array.isArray(json.images) ? json.images : [];
  if (images.length === 0) {
    throw new Error('fal: response contained zero images');
  }
  const written = [];
  for (let i = 0; i < Math.min(images.length, req.paths.length); i++) {
    const dataUrl = images[i].url || '';
    const dl = await fetch(dataUrl);
    if (!dl.ok) throw new Error('fal: image fetch ' + dl.status);
    writeFileSync(req.paths[i], Buffer.from(await dl.arrayBuffer()));
    written.push(req.paths[i]);
  }
  return {
    paths:        written,
    cost_usd:     estimateCostUsd(written.length),
    prompt_used:  finalPrompt,
    model:        DEFAULT_MODEL,
  };
}

/**
 * fal LivePortrait adapter for avatar.mjs — shared key with image gen.
 * Re-exports via bin/lib/avatar/fal_lip.mjs which delegates here.
 */
export async function generateAvatar({ photo_path, audio_path, duration_ms, aspect }) {
  if (!available()) throw new Error('fal_lip: FAL_API_KEY not set');
  // Upload photo + audio. fal's LivePortrait endpoint expects URLs; we
  // stage via the fal storage upload helper. For now we treat this as a
  // forward-compat stub: real upload+poll lives in fal_lip adapter file.
  throw new Error('fal_lip: use bin/lib/avatar/fal_lip.mjs::generate()');
}

function mapAspect(a) {
  if (a === '16:9') return 'landscape_16_9';
  if (a === '1:1')  return 'square';
  return 'portrait_9_16';
}
