// translate-real.test.mjs — gated integration tests for the real-network
// translate paths wired in bin/lib/translate.mjs (Groq from pillar 2,
// Anthropic completed in pillar 4).
//
// SKIPS unless CF_TRANSLATE_REAL_E2E=1 is set:
//   - Groq tests run when GROQ_API_KEY is also set (~$0.0001 per call)
//   - Anthropic tests run when ANTHROPIC_API_KEY is also set (~$0.001 per call)
// Default skip keeps CI free of unintentional spend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateTranscript } from '../../bin/lib/translate.mjs';

const HAS_GROQ_KEY      = !!process.env.GROQ_API_KEY;
const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY;
const OPT_IN            = process.env.CF_TRANSLATE_REAL_E2E === '1';
const SKIP_REASON       = !HAS_GROQ_KEY ? 'GROQ_API_KEY unset'
                         : !OPT_IN       ? 'CF_TRANSLATE_REAL_E2E=1 not set (opt-in to spend)'
                         : null;
const ANTHROPIC_SKIP    = !HAS_ANTHROPIC_KEY ? 'ANTHROPIC_API_KEY unset'
                         : !OPT_IN            ? 'CF_TRANSLATE_REAL_E2E=1 not set (opt-in to spend)'
                         : null;

function makeTranscript() {
  return {
    version: 1, engine: 'mock', language: 'en', duration_s: 3.0,
    speakers: [{ id: 0, label: 'Host' }],
    words: [
      { w: 'Hello',  start_ms: 0,    end_ms: 500,  speaker: 0, confidence: 0.99 },
      { w: 'world,', start_ms: 500,  end_ms: 1000, speaker: 0, confidence: 0.99 },
      { w: 'how',    start_ms: 1000, end_ms: 1300, speaker: 0, confidence: 0.99 },
      { w: 'are',    start_ms: 1300, end_ms: 1600, speaker: 0, confidence: 0.99 },
      { w: 'you',    start_ms: 1600, end_ms: 2000, speaker: 0, confidence: 0.99 },
      { w: 'today',  start_ms: 2000, end_ms: 2500, speaker: 0, confidence: 0.99 },
    ],
  };
}

test('translate-real: Groq EN→ID produces a non-empty Indonesian transcript',
  { skip: SKIP_REASON || false, timeout: 30_000 }, async () => {
    const result = await translateTranscript({
      transcript:  makeTranscript(),
      source_lang: 'en',
      target_lang: 'id',
    });
    assert.equal(result.fallback_used, undefined,
      'real Groq path must not fallback when key is set; got fallback_reason=' +
      result.fallback_reason);
    assert.equal(result.provider_used, 'groq');
    assert.ok(typeof result.cost_usd === 'number' && result.cost_usd > 0,
      'cost_usd must be reported as a positive number; got ' + result.cost_usd);
    assert.ok(result.transcript && result.transcript.text,
      'translated transcript text must be non-empty');
    assert.equal(result.transcript.language, 'id');
    assert.ok(Array.isArray(result.transcript.words) && result.transcript.words.length > 0,
      'translated transcript must have words[]; got ' + result.transcript.words?.length);
    // Indonesian "halo" / "dunia" / "apa" / "kabar" — at least one must appear.
    // We don't pin a specific translation (Llama may vary), but assert it's
    // CLEARLY not just the English passthrough.
    const lower = result.transcript.text.toLowerCase();
    const englishMarker = /\b(hello|world|how are you|today)\b/.test(lower);
    assert.ok(!englishMarker,
      'translated text should not contain raw English markers; got: ' + result.transcript.text);
    // Per-word timing reattached — first word starts at original 0ms, last
    // word ends at original 2500ms.
    const firstWord = result.transcript.words[0];
    const lastWord  = result.transcript.words[result.transcript.words.length - 1];
    assert.equal(firstWord.start_ms, 0,
      'first translated word must inherit original start_ms=0; got ' + firstWord.start_ms);
    assert.equal(lastWord.end_ms, 2500,
      'last translated word must inherit original end_ms=2500; got ' + lastWord.end_ms);
  });

test('translate-real: no GROQ_API_KEY → graceful degrade with structured reason',
  { skip: SKIP_REASON || false, timeout: 10_000 }, async () => {
    // Temporarily blank the key — exercises the inside-function guard.
    const saved = process.env.GROQ_API_KEY;
    try {
      delete process.env.GROQ_API_KEY;
      const result = await translateTranscript({
        transcript:  makeTranscript(),
        source_lang: 'en',
        target_lang: 'id',
        provider:    'groq',  // force the groq path
      });
      assert.equal(result.fallback_used, true,
        'no key must fallback honestly; got fallback_used=' + result.fallback_used);
      assert.equal(result.fallback_reason, 'groq_key_missing',
        'fallback_reason must be groq_key_missing; got ' + result.fallback_reason);
      assert.equal(result.cost_usd, 0);
    } finally {
      if (saved !== undefined) process.env.GROQ_API_KEY = saved;
    }
  });

// ============================================================
// v0.4.0 pillar 4 — Anthropic translate completion
// ============================================================

test('translate-real: Anthropic EN→ID produces a non-empty Indonesian transcript',
  { skip: ANTHROPIC_SKIP || false, timeout: 60_000 }, async () => {
    const result = await translateTranscript({
      transcript:  makeTranscript(),
      source_lang: 'en',
      target_lang: 'id',
      provider:    'anthropic',
    });
    assert.equal(result.fallback_used, undefined,
      'real Anthropic path must not fallback when key is set; got fallback_reason=' +
      result.fallback_reason);
    assert.equal(result.provider_used, 'anthropic');
    assert.ok(typeof result.cost_usd === 'number' && result.cost_usd > 0,
      'cost_usd must be reported as a positive number; got ' + result.cost_usd);
    assert.ok(result.transcript && result.transcript.text,
      'translated transcript text must be non-empty');
    assert.equal(result.transcript.language, 'id');
    assert.ok(Array.isArray(result.transcript.words) && result.transcript.words.length > 0,
      'translated transcript must have words[]');
    const lower = result.transcript.text.toLowerCase();
    const englishMarker = /\b(hello|world|how are you|today)\b/.test(lower);
    assert.ok(!englishMarker,
      'translated text should not contain raw English markers; got: ' + result.transcript.text);
    const firstWord = result.transcript.words[0];
    const lastWord  = result.transcript.words[result.transcript.words.length - 1];
    assert.equal(firstWord.start_ms, 0,
      'first translated word must inherit original start_ms=0');
    assert.equal(lastWord.end_ms, 2500,
      'last translated word must inherit original end_ms=2500');
  });

test('translate-real: ANTHROPIC_API_KEY only + provider=anthropic → uses Anthropic path',
  { skip: ANTHROPIC_SKIP || false, timeout: 60_000 }, async () => {
    const savedGroq = process.env.GROQ_API_KEY;
    try {
      delete process.env.GROQ_API_KEY;
      const result = await translateTranscript({
        transcript:  makeTranscript(),
        source_lang: 'en',
        target_lang: 'id',
        provider:    'anthropic',
      });
      assert.equal(result.fallback_used, undefined,
        'Anthropic path must succeed when key is set and provider forced; got ' +
        result.fallback_reason);
      assert.equal(result.provider_used, 'anthropic');
    } finally {
      if (savedGroq !== undefined) process.env.GROQ_API_KEY = savedGroq;
    }
  });

test('translate-real: no GROQ + no ANTHROPIC → no_translate_provider (regression guard for pillar-2 behavior)',
  { timeout: 5_000 }, async () => {
    const savedGroq      = process.env.GROQ_API_KEY;
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.GROQ_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const result = await translateTranscript({
        transcript:  makeTranscript(),
        source_lang: 'en',
        target_lang: 'id',
      });
      assert.equal(result.fallback_used, true);
      assert.equal(result.fallback_reason, 'no_translate_provider');
      assert.equal(result.cost_usd, 0);
    } finally {
      if (savedGroq      !== undefined) process.env.GROQ_API_KEY      = savedGroq;
      if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
    }
  });
