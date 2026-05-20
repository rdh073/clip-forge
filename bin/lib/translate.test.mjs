// translate.test.mjs — unit tests for the multilingual transcript
// translation lib (pillar 2 Groq + pillar 4 Anthropic).
//
// Pure-logic and mock-injection paths only — live API tests live in
// tests/integration/translate-real.test.mjs (CF_TRANSLATE_REAL_E2E gated).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { translateTranscript, estimateTranslateCostUsd } from './translate.mjs';

function withClearedEnv(fn) {
  const saved = {
    GROQ_API_KEY:           process.env.GROQ_API_KEY,
    ANTHROPIC_API_KEY:      process.env.ANTHROPIC_API_KEY,
    CF_TRANSLATE_PROVIDER:  process.env.CF_TRANSLATE_PROVIDER,
    CF_TRANSLATE_MOCK:      process.env.CF_TRANSLATE_MOCK,
  };
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CF_TRANSLATE_PROVIDER;
  delete process.env.CF_TRANSLATE_MOCK;
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function makeTranscript() {
  return {
    version: 1, engine: 'mock', language: 'en', duration_s: 2.0,
    speakers: [{ id: 0, label: 'Host' }],
    words: [
      { w: 'Hello', start_ms: 0,    end_ms: 500,  speaker: 0, confidence: 0.99 },
      { w: 'world', start_ms: 500,  end_ms: 1000, speaker: 0, confidence: 0.99 },
      { w: 'how',   start_ms: 1000, end_ms: 1500, speaker: 0, confidence: 0.99 },
      { w: 'are',   start_ms: 1500, end_ms: 2000, speaker: 0, confidence: 0.99 },
    ],
  };
}

test('translate: no keys, no mock → fallback no_translate_provider', async () => {
  await withClearedEnv(async () => {
    const r = await translateTranscript({
      transcript: makeTranscript(), source_lang: 'en', target_lang: 'id',
    });
    assert.equal(r.fallback_used, true);
    assert.equal(r.fallback_reason, 'no_translate_provider');
    assert.equal(r.cost_usd, 0);
  });
});

test('translate: missing transcript → graceful transcript_missing', async () => {
  await withClearedEnv(async () => {
    const r = await translateTranscript({ source_lang: 'en', target_lang: 'id' });
    assert.equal(r.fallback_used, true);
    assert.equal(r.fallback_reason, 'transcript_missing');
  });
});

test('translate: CF_TRANSLATE_PROVIDER=anthropic but no key → anthropic_key_missing', async () => {
  await withClearedEnv(async () => {
    process.env.CF_TRANSLATE_PROVIDER = 'anthropic';
    const r = await translateTranscript({
      transcript: makeTranscript(), source_lang: 'en', target_lang: 'id',
    });
    assert.equal(r.fallback_used, true);
    assert.equal(r.fallback_reason, 'anthropic_key_missing');
    assert.equal(r.provider_used, 'anthropic');
  });
});

test('translate: CF_TRANSLATE_PROVIDER=groq but no key → groq_key_missing', async () => {
  await withClearedEnv(async () => {
    process.env.CF_TRANSLATE_PROVIDER = 'groq';
    const r = await translateTranscript({
      transcript: makeTranscript(), source_lang: 'en', target_lang: 'id',
    });
    assert.equal(r.fallback_used, true);
    assert.equal(r.fallback_reason, 'groq_key_missing');
    assert.equal(r.provider_used, 'groq');
  });
});

test('translate: precedence — both keys set → groq wins', async () => {
  // We don't have a real key; we just verify provider precedence by checking
  // the fallback_reason structure (it routes to groq path which then complains
  // about the placeholder key).
  await withClearedEnv(async () => {
    process.env.GROQ_API_KEY      = 'gsk_test_placeholder';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder';
    const r = await translateTranscript({
      transcript: makeTranscript(), source_lang: 'en', target_lang: 'id',
    });
    // Either http_<status> or network_error depending on the test
    // environment. Either way the provider attempted is 'groq', not 'anthropic'.
    assert.equal(r.provider_used, 'groq',
      'precedence: groq must win when both keys set; got ' + r.provider_used);
  });
});

test('translate: precedence — ANTHROPIC only → anthropic adapter selected', async () => {
  await withClearedEnv(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder';
    const r = await translateTranscript({
      transcript: makeTranscript(), source_lang: 'en', target_lang: 'id',
    });
    assert.equal(r.provider_used, 'anthropic',
      'fallback: anthropic must be selected when only ANTHROPIC_API_KEY set; got ' + r.provider_used);
  });
});

test('translate: CF_TRANSLATE_MOCK path bypasses provider precedence', async () => {
  await withClearedEnv(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-tx-mock-'));
    const mock = join(dir, 'mock.mjs');
    writeFileSync(mock, `
      let data = '';
      process.stdin.on('data', (b) => { data += b; });
      process.stdin.on('end', () => {
        const brief = JSON.parse(data);
        const tx = brief.transcript;
        const translated = (tx.words || []).map((w) => 'X' + w.w).join(' ');
        process.stdout.write(JSON.stringify({
          transcript: { ...tx, language: brief.target_lang, text: translated,
                        words: (tx.words || []).map((w) => ({ ...w, w: 'X' + w.w })) },
        }));
      });
    `);
    try {
      process.env.CF_TRANSLATE_MOCK = mock;
      const r = await translateTranscript({
        transcript: makeTranscript(), source_lang: 'en', target_lang: 'id',
      });
      assert.equal(r.fallback_used, undefined);
      assert.equal(r.provider_used, 'mock');
      assert.equal(r.transcript.language, 'id');
      assert.ok(r.transcript.text.startsWith('XHello'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test('estimateTranslateCostUsd: anthropic pricing higher than groq', () => {
  const txt = 'a'.repeat(4000);
  const g = estimateTranslateCostUsd(txt, 'groq');
  const a = estimateTranslateCostUsd(txt, 'anthropic');
  assert.ok(a > g, 'anthropic must price higher than groq; got groq=' + g + ' anthropic=' + a);
});

test('estimateTranslateCostUsd: empty text → 0', () => {
  assert.equal(estimateTranslateCostUsd('', 'groq'), 0);
});
