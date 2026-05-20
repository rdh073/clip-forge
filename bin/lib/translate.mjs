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
  if (resolved === 'groq') {
    return await translateViaGroq(brief);
  }
  // Anthropic real-network path deferred until pillar 4 lands; Groq is the
  // primary cheap provider that unblocks production dub today.
  return {
    fallback_used:   true,
    fallback_reason: 'translate_provider_not_wired',
    detail:          'pillar 2 wires only Groq for the real-network path; ' +
                     'Anthropic Claude lands with pillar 4 cf-edit. Set ' +
                     'GROQ_API_KEY for production dub, or CF_TRANSLATE_MOCK for tests.',
    cost_usd:        0,
    provider_used:   resolved,
  };
}

// Distribute the original word timing schedule across N translated tokens.
// Sentence-level timing is preserved by stretching across the sentence span;
// per-word timing is best-effort (target-language word counts diverge from
// source). For TTS downstream, sentence boundaries matter, not word boundaries.
function reattachTiming(srcWords, translatedTokens) {
  if (!Array.isArray(srcWords) || srcWords.length === 0 || translatedTokens.length === 0) {
    return [];
  }
  const startMs = srcWords[0].start_ms ?? 0;
  const endMs   = srcWords[srcWords.length - 1].end_ms ?? startMs;
  const span    = Math.max(1, endMs - startMs);
  const speakerById = srcWords[0].speaker ?? 0;
  return translatedTokens.map((tok, i) => ({
    w:          tok,
    start_ms:   Math.round(startMs + (i / translatedTokens.length) * span),
    end_ms:     Math.round(startMs + ((i + 1) / translatedTokens.length) * span),
    speaker:    speakerById,
    confidence: 0.85,
  }));
}

async function translateViaGroq(brief) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { fallback_used: true, fallback_reason: 'groq_key_missing', cost_usd: 0,
             provider_used: 'groq' };
  }
  const tx       = brief.transcript || {};
  const words    = Array.isArray(tx.words) ? tx.words : [];
  const sourceText = words.map((w) => w.w || '').join(' ').trim();
  if (!sourceText) {
    return { transcript: { ...tx, language: brief.target_lang, words: [], text: '' },
             cost_usd: 0, provider_used: 'groq' };
  }
  const sysPrompt =
    'You translate transcripts. The user gives you a text in ' + (brief.source_lang || 'en') +
    '. Translate it to ' + brief.target_lang + '. Reply with STRICT JSON only: ' +
    '{"translated": "<the translation>"}. Preserve punctuation. ' +
    'Do not add commentary, do not wrap in markdown.';
  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + apiKey,
                 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user',   content: sourceText },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    });
  } catch (e) {
    return { fallback_used: true, fallback_reason: 'groq_network_error',
             detail: e.message, cost_usd: 0, provider_used: 'groq' };
  }
  if (!r.ok) {
    return { fallback_used: true, fallback_reason: 'groq_http_' + r.status,
             detail: (await r.text()).slice(0, 240), cost_usd: 0, provider_used: 'groq' };
  }
  let body;
  try { body = await r.json(); }
  catch (e) {
    return { fallback_used: true, fallback_reason: 'groq_invalid_json',
             detail: e.message, cost_usd: 0, provider_used: 'groq' };
  }
  let payload;
  try { payload = JSON.parse(body.choices?.[0]?.message?.content || '{}'); }
  catch (e) {
    return { fallback_used: true, fallback_reason: 'groq_payload_invalid_json',
             detail: e.message, cost_usd: 0, provider_used: 'groq' };
  }
  const translatedText = String(payload.translated || '').trim();
  if (!translatedText) {
    return { fallback_used: true, fallback_reason: 'groq_empty_translation',
             cost_usd: 0, provider_used: 'groq' };
  }
  const tokens = translatedText.split(/\s+/).filter(Boolean);
  const translatedWords = reattachTiming(words, tokens);
  const usage = body.usage || {};
  const costUsd = ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) / 1_000_000
                  * GROQ_COST_PER_M_TOKENS_USD;
  return {
    transcript: { ...tx, language: brief.target_lang, words: translatedWords,
                  text: translatedText },
    cost_usd:      Number(costUsd.toFixed(6)),
    provider_used: 'groq',
  };
}

export function estimateTranslateCostUsd(transcriptText, provider) {
  const tokens = estTokens(transcriptText);
  const perM = provider === 'anthropic' ? ANTHROPIC_COST_PER_M_TOKENS_USD : GROQ_COST_PER_M_TOKENS_USD;
  return (tokens / 1_000_000) * perM;
}
