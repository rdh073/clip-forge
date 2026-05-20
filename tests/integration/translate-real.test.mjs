// translate-real.test.mjs — gated integration test for the real Groq
// translate path wired in bin/lib/translate.mjs (pillar 2 reviewer fix).
//
// SKIPS unless BOTH env vars are set:
//   GROQ_API_KEY                — your Groq API key (BYO)
//   CF_TRANSLATE_REAL_E2E=1     — explicit opt-in (avoids accidental spend
//                                 during routine `npm test`)
//
// Cost: ~$0.0001 per run (one small Llama 3.3 70B call). Default skip
// keeps CI free of unintentional spend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateTranscript } from '../../bin/lib/translate.mjs';

const HAS_KEY     = !!process.env.GROQ_API_KEY;
const OPT_IN      = process.env.CF_TRANSLATE_REAL_E2E === '1';
const SKIP_REASON = !HAS_KEY ? 'GROQ_API_KEY unset'
                   : !OPT_IN  ? 'CF_TRANSLATE_REAL_E2E=1 not set (opt-in to spend)'
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
