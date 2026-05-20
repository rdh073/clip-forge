// replicate.mjs — Replicate fallback adapter for img-gen + img2img.
//
// Variable per-image cost (depends on chosen model); we estimate $0.01 and
// rely on Replicate's billing API for accuracy if needed. Picked when
// REPLICATE_API_TOKEN is set AND no fal/nanobanana key is set, OR via
// CF_VISUAL_PROVIDER=replicate override.

import { writeFileSync } from 'node:fs';

const COST_PER_IMAGE_USD = 0.01;
const DEFAULT_MODEL      = 'black-forest-labs/flux-schnell';
const API_BASE           = 'https://api.replicate.com/v1';

export const NAME = 'replicate';
export const SUPPORTS_STYLE_REF = false;

function apiKey() {
  return process.env.REPLICATE_API_TOKEN || '';
}

export function available() {
  return apiKey().length > 0;
}

export function estimateCostUsd(count = 1) {
  return Math.max(0, count | 0) * COST_PER_IMAGE_USD;
}

export async function generate(req) {
  if (!available()) throw new Error('replicate: REPLICATE_API_TOKEN not set');
  const count = Math.max(1, req.count || 1);
  const prompt = String(req.prompt || '').slice(0, 1500);
  const aspect = mapAspect(req.aspect || '9:16');

  // Create prediction (sync API for hosted models).
  const createRes = await fetch(API_BASE + '/models/' + DEFAULT_MODEL + '/predictions', {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey(),
      'Content-Type':  'application/json',
      'Prefer':        'wait',
    },
    body: JSON.stringify({
      input: {
        prompt, aspect_ratio: aspect, num_outputs: count, seed: req.seed || 42,
      },
    }),
  });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => '');
    throw new Error('replicate: ' + createRes.status + ' :: ' + body.slice(0, 240));
  }
  const json = await createRes.json();
  const urls = Array.isArray(json.output) ? json.output : [json.output].filter(Boolean);
  if (urls.length === 0) throw new Error('replicate: empty output');
  const written = [];
  for (let i = 0; i < Math.min(urls.length, req.paths.length); i++) {
    const dl = await fetch(urls[i]);
    if (!dl.ok) throw new Error('replicate: image fetch ' + dl.status);
    writeFileSync(req.paths[i], Buffer.from(await dl.arrayBuffer()));
    written.push(req.paths[i]);
  }
  return {
    paths:       written,
    cost_usd:    estimateCostUsd(written.length),
    prompt_used: prompt,
    model:       DEFAULT_MODEL,
  };
}

function mapAspect(a) {
  if (a === '16:9') return '16:9';
  if (a === '1:1')  return '1:1';
  return '9:16';
}
