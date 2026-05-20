// tts.test.mjs — unit tests for the TTS dispatcher (bin/lib/tts.mjs).
//
// Coverage:
//   - resolveProvider precedence (env-driven, explicit override)
//   - CF_TTS_PROVIDER honored over precedence
//   - brand_voice_override slot is forward-compat (carries voice_id, provider)
//   - synthesize() empty-text → 0-byte file + duration_ms 0
//   - synthesize() mock injection path returns the mock's audio + duration
//   - cloneVoice() routes through provider's cloneVoice, surfaces warnings
//
// Pure-logic + cheap I/O (tmp WAV files). No network. Mirrors the pattern
// in bin/lib/vocab.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  resolveProvider, synthesize, cloneVoice, PRECEDENCE, PROVIDERS,
  buildPlaceholderWav,
} from './tts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TTS_MOCK  = resolve(__dirname, '..', '..', 'tests', 'mocks', 'tts-mock.mjs');

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-tts-test-')); }

function withEnv(overrides, fn) {
  const prior = {};
  for (const k of Object.keys(overrides)) {
    prior[k] = process.env[k];
    if (overrides[k] === null || overrides[k] === undefined) delete process.env[k];
    else process.env[k] = String(overrides[k]);
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(prior)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

test('resolveProvider: no keys set → falls through to piper', () => {
  withEnv({
    ELEVENLABS_API_KEY: null, CARTESIA_API_KEY: null, GROQ_API_KEY: null,
    CF_TTS_PROVIDER: null,
  }, () => {
    const r = resolveProvider();
    assert.equal(r.name, 'piper');
  });
});

test('resolveProvider: ELEVENLABS_API_KEY only → elevenlabs', () => {
  withEnv({
    ELEVENLABS_API_KEY: 'sk-test', CARTESIA_API_KEY: null,
    GROQ_API_KEY: null, CF_TTS_PROVIDER: null,
  }, () => {
    const r = resolveProvider();
    assert.equal(r.name, 'elevenlabs');
  });
});

test('resolveProvider: CARTESIA_API_KEY only → cartesia (skips missing elevenlabs)', () => {
  withEnv({
    ELEVENLABS_API_KEY: null, CARTESIA_API_KEY: 'sk-test',
    GROQ_API_KEY: null, CF_TTS_PROVIDER: null,
  }, () => {
    const r = resolveProvider();
    assert.equal(r.name, 'cartesia');
  });
});

test('resolveProvider: GROQ_API_KEY only → groq', () => {
  withEnv({
    ELEVENLABS_API_KEY: null, CARTESIA_API_KEY: null,
    GROQ_API_KEY: 'sk-test', CF_TTS_PROVIDER: null,
  }, () => {
    const r = resolveProvider();
    assert.equal(r.name, 'groq');
  });
});

test('resolveProvider: all keys set → elevenlabs wins precedence', () => {
  withEnv({
    ELEVENLABS_API_KEY: 'a', CARTESIA_API_KEY: 'b',
    GROQ_API_KEY: 'c', CF_TTS_PROVIDER: null,
  }, () => {
    const r = resolveProvider();
    assert.equal(r.name, 'elevenlabs');
  });
});

test('resolveProvider: CF_TTS_PROVIDER=groq overrides precedence even when ELEVENLABS_API_KEY set', () => {
  withEnv({
    ELEVENLABS_API_KEY: 'a', CARTESIA_API_KEY: 'b',
    GROQ_API_KEY: 'c', CF_TTS_PROVIDER: 'groq',
  }, () => {
    const r = resolveProvider();
    assert.equal(r.name, 'groq');
  });
});

test('resolveProvider: explicit arg beats env var', () => {
  withEnv({
    ELEVENLABS_API_KEY: 'a', CF_TTS_PROVIDER: 'groq',
  }, () => {
    const r = resolveProvider('cartesia');
    assert.equal(r.name, 'cartesia');
  });
});

test('resolveProvider: unknown CF_TTS_PROVIDER throws', () => {
  withEnv({ CF_TTS_PROVIDER: 'nope', ELEVENLABS_API_KEY: null,
             CARTESIA_API_KEY: null, GROQ_API_KEY: null }, () => {
    assert.throws(() => resolveProvider(), /unknown provider/);
  });
});

test('PRECEDENCE export matches PLAN-v0.4.0 §3.2 Q1 order', () => {
  assert.deepEqual(PRECEDENCE, ['elevenlabs', 'cartesia', 'groq', 'piper']);
});

test('synthesize: empty text → 0-byte WAV + duration 0 (hallucination guard)', async () => {
  const d = tmp();
  try {
    const out = join(d, 'empty.wav');
    const r = await withEnv({
      ELEVENLABS_API_KEY: null, CARTESIA_API_KEY: null,
      GROQ_API_KEY: null, CF_TTS_PROVIDER: 'piper', CF_TTS_MOCK: null,
    }, () => synthesize({ text: '', audio_path: out }));
    assert.equal(r.duration_ms, 0);
    assert.ok(existsSync(out), 'audio_path created even on empty text');
    assert.equal(statSync(out).size, 0, '0-byte WAV (no spurious words injected)');
    assert.equal(r.fallback_used, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('synthesize: mock injection emits realistic-duration WAV (1 word ≈ 400 ms)', async () => {
  if (!existsSync(TTS_MOCK)) {
    return;  // skip when mock missing (fresh checkout)
  }
  const d = tmp();
  try {
    const out = join(d, 'mock.wav');
    const text = 'one two three four five';  // 5 words → 2000 ms expected
    const r = await withEnv({
      CF_TTS_MOCK: TTS_MOCK,
      ELEVENLABS_API_KEY: 'a',  // any provider — mock takes precedence
    }, () => synthesize({ text, audio_path: out }));
    assert.equal(r.fallback_used, false);
    assert.ok(existsSync(out), 'mock WAV written');
    // The mock reports duration_ms = 5 * 400 = 2000.
    assert.equal(r.duration_ms, 2000,
      'realistic-mock contract: 1 word ≈ 400 ms (±50 ms tolerance)');
    assert.ok(r.provider_used.startsWith('mock:'),
      'provider_used flagged as mock for telemetry');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('synthesize: mock missing → graceful degrade with fallback_reason', async () => {
  const d = tmp();
  try {
    const out = join(d, 'nope.wav');
    const r = await withEnv({
      CF_TTS_MOCK: join(d, 'does-not-exist.mjs'),
      ELEVENLABS_API_KEY: 'a',
    }, () => synthesize({ text: 'hello', audio_path: out }));
    assert.equal(r.fallback_used, true);
    assert.match(r.fallback_reason, /mock_missing/);
    assert.equal(r.audio_path, null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('synthesize: brand_voice_override forces provider + voice_id', async () => {
  if (!existsSync(TTS_MOCK)) return;
  const d = tmp();
  try {
    const out = join(d, 'override.wav');
    const r = await withEnv({
      CF_TTS_MOCK: TTS_MOCK,
      ELEVENLABS_API_KEY: 'a', CARTESIA_API_KEY: 'b',
      CF_TTS_PROVIDER: 'elevenlabs',
    }, () => synthesize({
      text: 'hello world',
      audio_path: out,
      brand_voice_override: { provider: 'cartesia', voice_id: 'brand-X' },
    }));
    assert.equal(r.fallback_used, false);
    // The mock returns the voice_id back verbatim.
    assert.equal(r.voice_id, 'brand-X');
    assert.equal(r.provider_used, 'mock:cartesia');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('cloneVoice: non-cloning provider (groq) returns voice_clone_supported=false', async () => {
  const d = tmp();
  try {
    const samplePath = join(d, 'sample.wav');
    writeFileSync(samplePath, buildPlaceholderWav('hi', { ms_per_word: 400 }).buf);
    const r = await withEnv({
      GROQ_API_KEY: 'sk-test', CF_TTS_PROVIDER: 'groq',
    }, () => cloneVoice({ name: 'mock', sample_path: samplePath, provider: 'groq' }));
    assert.equal(r.voice_clone_supported, false);
    assert.equal(r.provider_used, 'groq');
    assert.match(r.warning || '', /voice_clone_disabled_groq/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('buildPlaceholderWav: 1 word → ~400 ms WAV (sanity)', () => {
  const { buf, duration_ms } = buildPlaceholderWav('hello', { ms_per_word: 400 });
  assert.equal(duration_ms, 400);
  // 22050 Hz × 0.4 s × 2 bytes = 17640 PCM bytes + 44 header = 17684 file bytes.
  assert.equal(buf.length, 22050 * 0.4 * 2 + 44);
  // Verify RIFF magic.
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buf.subarray(8, 12).toString('ascii'), 'WAVE');
});
