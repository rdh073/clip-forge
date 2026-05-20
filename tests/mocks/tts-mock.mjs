#!/usr/bin/env node
// tts-mock.mjs — realistic-mock TTS for cf-dub / cf-voice-clone integration
// tests. Reads a brief JSON from stdin:
//
//   { text, voice_id, language, provider, audio_path }
//
// Writes a placeholder WAV at audio_path whose duration matches
// "1 word ≈ 400 ms" (per PLAN-v0.4.0 §4 realistic-mock contract — within
// ±50ms of the expected dubbed duration). Emits JSON on stdout:
//
//   { audio_path, duration_ms, cost_usd: 0.0001 }
//
// Deterministic — no Math.random, no Date.now. Same input → byte-identical
// output. Required for idempotency tests.

import { readFileSync } from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_WAV = resolvePath(__dirname, '..', '..', 'bin', 'lib', 'tts', 'wav.mjs');

const { buildPlaceholderWav } = await import(LIB_WAV);

const stdin = readFileSync(0, 'utf-8');
let brief;
try { brief = JSON.parse(stdin); }
catch (e) {
  process.stderr.write('tts-mock: bad JSON on stdin: ' + e.message + '\n');
  process.exit(1);
}

if (!brief.audio_path) {
  process.stderr.write('tts-mock: brief.audio_path required\n');
  process.exit(2);
}

const text = String(brief.text || '');
const { buf, duration_ms } = buildPlaceholderWav(text, { ms_per_word: 400 });
mkdirSync(dirname(brief.audio_path), { recursive: true });
writeFileSync(brief.audio_path, buf);

const out = {
  audio_path:    brief.audio_path,
  duration_ms,
  cost_usd:      0.0001 * Math.max(1, text.length),
  model:         'mock-' + (brief.provider || 'tts'),
  voice_id:      brief.voice_id || 'mock-voice',
};
process.stdout.write(JSON.stringify(out) + '\n');
