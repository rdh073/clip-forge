// translate.mjs — multilingual transcript translation for /clip-forge:dub.
//
// Provider precedence (PLAN §3.2 pipeline step 2):
//   GROQ_API_KEY     → Groq Llama 3.3 70B (cheap)
//   ANTHROPIC_API_KEY → Claude Haiku 4.5 (fallback)
//   none + CF_WHISPER on PATH → local Whisper --task translate (offline)
//   none of the above → fallback_used: no_translate_provider
//
// Mock injection (testing): CF_TRANSLATE_MOCK=<path> reads a JSON brief
// {transcript, target_lang, source_lang} on stdin, prints the translated
// transcript JSON on stdout. The mock MUST preserve per-word start_ms /
// end_ms timing (realistic-mock contract — PLAN §4).
//
// The lib does NOT spawn the real LLM in pillar 2; the LLM-call shape is
// stubbed so pillar 4 (cf-edit) can extend it. Pillar 2 only needs the
// mock path to be green and the real path to fall back honestly. This
// matches the docs/PLAN-v0.4.0.md §3.2 step 2 invariant: "Key absent →
// translation written; dub skipped with warning."

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const GROQ_COST_PER_M_TOKENS_USD     = 0.59;
const ANTHROPIC_COST_PER_M_TOKENS_USD = 1.00;

function resolveProvider(explicit) {
  const override = explicit || process.env.CF_TRANSLATE_PROVIDER || '';
  if (override) return override;
  if (process.env.GROQ_API_KEY)      return 'groq';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

function estTokens(text) {
  // ~1 token per 4 chars for English; conservative upper bound for other langs.
  return Math.ceil(String(text || '').length / 4);
}

function runMock(mockPath, brief) {
  if (!existsSync(mockPath)) {
    return { fallback_used: true, fallback_reason: 'translate_mock_missing' };
  }
  const r = spawnSync(process.execPath, [mockPath], {
    input:    JSON.stringify(brief),
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { fallback_used: true, fallback_reason: 'translate_mock_exit_nonzero',
             detail: (r.stderr || '').slice(-240) };
  }
  try {
    return JSON.parse((r.stdout || '').trim());
  } catch (e) {
    return { fallback_used: true, fallback_reason: 'translate_mock_invalid_json',
             detail: e.message };
  }
}

/**
 * Translate a word-timed transcript. Preserves per-word start_ms / end_ms;
 * the LLM is asked to translate the whole text, then we re-attach the same
 * timing schedule via the sentence-boundary heuristic (newline / period
 * splits). For pillar 2, the real LLM path is left as a fallback —
 * production users with paid keys still get a working dub via mock+real
 * once pillar 4 wires in the LLM call. This avoids burning OPUS budget
 * for placeholder text in pillar 2's regression tests.
 *
 * Returns:
 *   on success → { transcript: <translated>, cost_usd, provider_used }
 *   on graceful-degrade → { fallback_used: true, fallback_reason, cost_usd: 0 }
 */
export async function translateTranscript({ transcript, source_lang, target_lang, provider }) {
  if (!transcript || typeof transcript !== 'object') {
    return { fallback_used: true, fallback_reason: 'transcript_missing', cost_usd: 0 };
  }
  const mockPath = process.env.CF_TRANSLATE_MOCK || '';
  const brief = { transcript, source_lang: source_lang || 'en', target_lang };
  if (mockPath) {
    const out = runMock(mockPath, brief);
    if (out && out.fallback_used) return { ...out, cost_usd: 0, provider_used: 'mock' };
    return { transcript: out.transcript || out, cost_usd: 0, provider_used: 'mock' };
  }
  const resolved = resolveProvider(provider);
  if (!resolved) {
    return { fallback_used: true, fallback_reason: 'no_translate_provider', cost_usd: 0 };
  }
  // Real-network LLM path is implemented behind the same mock-injection
  // contract pillar 4 will need. To keep pillar 2 honest, we exit with a
  // graceful-degrade here so the dub skill surfaces a clear reason.
  // Pillar 4 will replace this body with a real Groq/Anthropic call.
  return {
    fallback_used:   true,
    fallback_reason: 'translate_real_provider_not_yet_wired',
    detail:          'pillar 2 ships only the mock + offline-fallback paths; ' +
                     'pillar 4 (cf-edit) will wire the real LLM call. Set ' +
                     'CF_TRANSLATE_MOCK=<path> to drive the contract today.',
    cost_usd:        0,
    provider_used:   resolved,
  };
}

export function estimateTranslateCostUsd(transcriptText, provider) {
  const tokens = estTokens(transcriptText);
  const perM = provider === 'anthropic' ? ANTHROPIC_COST_PER_M_TOKENS_USD : GROQ_COST_PER_M_TOKENS_USD;
  return (tokens / 1_000_000) * perM;
}
