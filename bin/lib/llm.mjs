// llm.mjs — LLM dispatcher for cf-edit prompt mode (v0.4.0 pillar 4).
//
// Provider resolution (PLAN-v0.4.0 §7 Q6):
//   CF_LLM_PROVIDER=<name>     → explicit override (groq | anthropic)
//   GROQ_API_KEY      set      → groq llama-3.3-70b-versatile (~$0.001/edit)
//   ANTHROPIC_API_KEY set      → claude-haiku-4-5-20251001  (~$0.02/edit)
//   neither set                → { fallback_used: true, fallback_reason: 'no_llm_provider' }
//
// Mock injection: CF_LLM_MOCK=<path> bypasses every network adapter. The
// mock receives the request brief on stdin and prints {text, ...} JSON on
// stdout. Same shape as CF_TTS_MOCK / CF_TRANSLATE_MOCK — see PLAN §4
// mock injection table.
//
// SoC: adapters under bin/lib/llm/* own provider I/O. This file owns
// precedence resolution, mock injection, and the unified return shape.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import * as Groq      from './llm/groq.mjs';
import * as Anthropic from './llm/anthropic.mjs';

const PROVIDERS = { groq: Groq, anthropic: Anthropic };
const PRECEDENCE = ['groq', 'anthropic'];

export function resolveProvider(explicit) {
  const override = explicit || process.env.CF_LLM_PROVIDER || '';
  if (override) {
    if (!PROVIDERS[override]) {
      throw new Error('llm: unknown provider in CF_LLM_PROVIDER/explicit: ' + override);
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
    return { fallback_used: true, fallback_reason: 'llm_mock_missing', cost_usd: 0 };
  }
  const r = spawnSync(process.execPath, [mockPath], {
    input:     JSON.stringify(brief),
    encoding:  'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { fallback_used: true, fallback_reason: 'llm_mock_exit_nonzero',
             detail: (r.stderr || '').slice(-240), cost_usd: 0 };
  }
  const trimmed = (r.stdout || '').trim();
  if (!trimmed) {
    return { fallback_used: true, fallback_reason: 'llm_mock_empty_output', cost_usd: 0 };
  }
  try { return JSON.parse(trimmed); }
  catch (e) {
    return { fallback_used: true, fallback_reason: 'llm_mock_invalid_json',
             detail: e.message, cost_usd: 0 };
  }
}

/**
 * Issue an LLM completion request. Returns:
 *   on success → { text, cost_usd, provider_used, usage? }
 *   on degrade → { fallback_used: true, fallback_reason, cost_usd: 0,
 *                   provider_used? }
 *
 * NEVER throws on documented failure modes — callers decide whether to
 * retry, prompt the user manually, or abort the skill.
 */
export async function complete(req) {
  if (!req || typeof req !== 'object') {
    throw new Error('llm.complete: req must be an object');
  }
  const mockPath = process.env.CF_LLM_MOCK || '';
  if (mockPath) {
    const out = runMock(mockPath, req);
    if (out.fallback_used) return { ...out, provider_used: 'mock' };
    return {
      text:          String(out.text || ''),
      cost_usd:      typeof out.cost_usd === 'number' ? out.cost_usd : 0,
      provider_used: 'mock',
      usage:         out.usage || null,
    };
  }
  const chosen = resolveProvider(req.provider);
  if (!chosen) {
    return { fallback_used: true, fallback_reason: 'no_llm_provider', cost_usd: 0,
             provider_used: null };
  }
  let result;
  try {
    result = await chosen.adapter.complete({
      system:     req.system,
      user:       req.user,
      max_tokens: req.max_tokens,
      model:      req.model,
    });
  } catch (e) {
    return { fallback_used: true, fallback_reason: chosen.name + '_throw',
             detail: e.message, cost_usd: 0, provider_used: chosen.name };
  }
  if (result.fallback_used) {
    return { ...result, provider_used: chosen.name };
  }
  return { ...result, provider_used: chosen.name };
}

export { PROVIDERS, PRECEDENCE };
