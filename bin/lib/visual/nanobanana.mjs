// nanobanana.mjs — Google Gemini 2.5 Flash Image ("Nano Banana") adapter.
//
// Higher per-image cost (~$0.04) but better brand-consistency than Flux
// Schnell. Picked when GEMINI_API_KEY is set OR explicit override via
// CF_VISUAL_PROVIDER=nanobanana.

import { writeFileSync } from 'node:fs';

const COST_PER_IMAGE_USD = 0.04;
const DEFAULT_MODEL      = 'gemini-2.5-flash-image-preview';
const API_BASE           = 'https://generativelanguage.googleapis.com/v1beta';

export const NAME = 'nanobanana';
export const SUPPORTS_STYLE_REF = true;

function apiKey() {
  return process.env.GEMINI_API_KEY || '';
}

export function available() {
  return apiKey().length > 0;
}

export function estimateCostUsd(count = 1) {
  return Math.max(0, count | 0) * COST_PER_IMAGE_USD;
}

export async function generate(req) {
  if (!available()) throw new Error('nanobanana: GEMINI_API_KEY not set');
  const count = Math.max(1, req.count || 1);
  const prompt = String(req.prompt || '').slice(0, 1500);
  const brandHint = req.brand_kit && req.brand_kit.colors
    ? ' Use brand palette: ' + Object.values(req.brand_kit.colors).filter(Boolean).join(', ') + '.'
    : '';
  const finalPrompt = prompt + brandHint;

  const url = API_BASE + '/models/' + DEFAULT_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey());
  const written = [];
  for (let i = 0; i < Math.min(count, req.paths.length); i++) {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: finalPrompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          temperature: 0.4,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('nanobanana: ' + res.status + ' :: ' + body.slice(0, 240));
    }
    const json = await res.json();
    const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
    const imagePart = parts.find((p) => p.inlineData && p.inlineData.data);
    if (!imagePart) throw new Error('nanobanana: response missing inlineData image');
    writeFileSync(req.paths[i], Buffer.from(imagePart.inlineData.data, 'base64'));
    written.push(req.paths[i]);
  }
  return {
    paths:       written,
    cost_usd:    estimateCostUsd(written.length),
    prompt_used: finalPrompt,
    model:       DEFAULT_MODEL,
  };
}
