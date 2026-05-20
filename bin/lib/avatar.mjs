// avatar.mjs — talking-head avatar dispatcher (v0.4.0 pillar 5).
//
// Provider resolution (PLAN-v0.4.0 §3.5):
//   CF_AVATAR_PROVIDER=<name>     → explicit override (heygen | did | fal_lip)
//   HEYGEN_API_KEY         set    → HeyGen (~$1.00/clip, best quality)
//   DID_API_KEY            set    → D-ID (~$0.30/clip)
//   FAL_API_KEY            set    → fal LivePortrait (~$0.10/clip, OSS)
//   none                          → { fallback_used: true, fallback_reason: 'no_avatar_provider' }
//
// Mock injection: CF_AVATAR_MOCK=<path> bypasses every network adapter
// (mirrors CF_TTS_MOCK / CF_VISUAL_MOCK shape).
//
// Hard cap on duration: 5000 ms. Refused at the dispatcher layer; the
// cf-avatar dispatcher applies an additional refusal at its own gate so a
// caller that bypasses this dispatcher still gets caught.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import * as HeyGen from './avatar/heygen.mjs';
import * as DId    from './avatar/did.mjs';
import * as FalLip from './avatar/fal_lip.mjs';

const PROVIDERS = { heygen: HeyGen, did: DId, fal_lip: FalLip };
const PRECEDENCE = ['heygen', 'did', 'fal_lip'];

export const DURATION_HARD_CAP_MS = 5000;

export function resolveProvider(explicit) {
  const override = explicit || process.env.CF_AVATAR_PROVIDER || '';
  if (override) {
    if (!PROVIDERS[override]) {
      throw new Error('avatar: unknown provider in CF_AVATAR_PROVIDER/explicit: ' + override);
    }
    return { name: override, adapter: PROVIDERS[override] };
  }
  for (const name of PRECEDENCE) {
    if (PROVIDERS[name].available()) {
      return { name, adapter: PROVIDERS[name] };
    }
  }
  return null;
}

function runMock(mockPath, brief) {
  if (!existsSync(mockPath)) {
    return { fallback_used: true, fallback_reason: 'avatar_mock_missing', cost_usd: 0 };
  }
  const r = spawnSync(process.execPath, [mockPath], {
    input:     JSON.stringify(brief),
    encoding:  'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { fallback_used: true, fallback_reason: 'avatar_mock_exit_nonzero',
             detail: (r.stderr || '').slice(-240), cost_usd: 0 };
  }
  const trimmed = (r.stdout || '').trim();
  if (!trimmed) {
    return { fallback_used: true, fallback_reason: 'avatar_mock_empty_output', cost_usd: 0 };
  }
  try { return JSON.parse(trimmed); }
  catch (e) {
    return { fallback_used: true, fallback_reason: 'avatar_mock_invalid_json',
             detail: e.message, cost_usd: 0 };
  }
}

/**
 * Generate one avatar video.
 *
 * @param {{photo_path:string, audio_path:string, duration_ms:number,
 *          aspect?:string, video_path:string, provider?:string}} req
 * @returns {Promise<{video_path:string, cost_usd:number, provider_used:string} |
 *                    {fallback_used:true, fallback_reason:string}>}
 */
export async function generate(req) {
  if (!req || typeof req !== 'object') {
    throw new Error('avatar.generate: req must be an object');
  }
  if (!req.video_path) {
    throw new Error('avatar.generate: req.video_path required');
  }
  if (typeof req.duration_ms === 'number' && req.duration_ms > DURATION_HARD_CAP_MS) {
    return { fallback_used: true, fallback_reason: 'avatar_duration_capped',
             detail: 'duration_ms ' + req.duration_ms + ' exceeds ' + DURATION_HARD_CAP_MS + 'ms cap',
             cost_usd: 0, provider_used: null };
  }
  const mockPath = process.env.CF_AVATAR_MOCK || '';
  if (mockPath) {
    const out = runMock(mockPath, req);
    if (out.fallback_used) return { ...out, provider_used: 'mock' };
    return {
      video_path:    String(out.video_path || req.video_path),
      cost_usd:      typeof out.cost_usd === 'number' ? out.cost_usd : 0,
      provider_used: 'mock',
      model:         out.model || 'mock',
    };
  }
  const chosen = resolveProvider(req.provider);
  if (!chosen) {
    return { fallback_used: true, fallback_reason: 'no_avatar_provider', cost_usd: 0,
             provider_used: null };
  }
  let result;
  try {
    result = await chosen.adapter.generate(req);
  } catch (e) {
    return { fallback_used: true, fallback_reason: chosen.name + '_throw',
             detail: e.message, cost_usd: 0, provider_used: chosen.name };
  }
  return { ...result, provider_used: chosen.name };
}

export { PROVIDERS, PRECEDENCE };
