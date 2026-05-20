// tts.mjs — TTS provider-abstraction dispatcher (v0.4.0 pillar 2).
//
// Routes synthesize() / cloneVoice() requests through one of four adapters:
//
//   elevenlabs → cartesia → groq → piper          (default precedence)
//
// Override via CF_TTS_PROVIDER=<name>. Mock injection via CF_TTS_MOCK=<path>:
// the dispatcher execs the mock with a JSON brief on stdin and reads
// {audio_path, duration_ms, ...} JSON back on stdout. Used by tests to
// exercise the contract without spending paid keys.
//
// SoC contract (CLAUDE.md): adapters own provider I/O; this file owns
// provider selection, fallback chaining, and mock-injection only. No I/O
// at import-time — only inside resolveProvider() / synthesize().
//
// brand_voice_override (pillar 3 forward-compat): the synthesize() request
// shape carries an optional brand_voice_override?: {provider, voice_id}
// field that, when present, replaces the resolved provider + voice_id at
// dispatch time without re-running precedence. Pillar 3 will populate this
// from ~/.clip-forge/brand-kit.json; pillar 2 leaves the slot open.

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import * as ElevenLabs from './tts/elevenlabs.mjs';
import * as Cartesia   from './tts/cartesia.mjs';
import * as Groq       from './tts/groq.mjs';
import * as Piper      from './tts/piper.mjs';
import { buildPlaceholderWav, buildSilentWav } from './tts/wav.mjs';

const PROVIDERS = {
  elevenlabs: ElevenLabs,
  cartesia:   Cartesia,
  groq:       Groq,
  piper:      Piper,
};

const PRECEDENCE = ['elevenlabs', 'cartesia', 'groq', 'piper'];

/**
 * Resolve which adapter should handle a synthesize() request.
 * Pure-logic (only env reads, no I/O). Returns the adapter module reference
 * and the resolved name. Throws only when an explicit override names a
 * provider this build doesn't know about.
 */
export function resolveProvider(explicit) {
  const override = explicit || process.env.CF_TTS_PROVIDER || '';
  if (override) {
    if (!PROVIDERS[override]) {
      throw new Error('tts: unknown provider in CF_TTS_PROVIDER/explicit: ' + override);
    }
    return { name: override, adapter: PROVIDERS[override] };
  }
  for (const name of PRECEDENCE) {
    if (PROVIDERS[name].available()) {
      return { name, adapter: PROVIDERS[name] };
    }
  }
  // Piper.available() always returns true so PRECEDENCE always picks
  // something. Defensive return:
  return { name: 'piper', adapter: Piper };
}

/**
 * Probe ffmpeg for the duration of a freshly written audio file. Returns
 * 0 when ffprobe is missing or the file can't be parsed — the caller can
 * decide whether 0-ms is a fatal condition.
 */
export function probeDurationMs(audioPath) {
  if (!audioPath || !existsSync(audioPath)) return 0;
  try {
    if (statSync(audioPath).size === 0) return 0;
  } catch { return 0; }
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', audioPath,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) return 0;
  const sec = parseFloat((r.stdout || '').trim());
  if (!Number.isFinite(sec)) return 0;
  return Math.round(sec * 1000);
}

/**
 * Mock-injection path. CF_TTS_MOCK=<path> set → exec the mock script with
 * the brief JSON on stdin, expect {audio_path, ...} JSON on stdout. The
 * mock is responsible for actually writing the WAV (use buildPlaceholderWav
 * from ./tts/wav.mjs for realistic durations).
 */
function runMock(mockPath, req) {
  if (!existsSync(mockPath)) {
    return {
      fallback_used:   true,
      fallback_reason: 'mock_missing',
      detail:          'CF_TTS_MOCK script not found: ' + mockPath,
    };
  }
  const r = spawnSync(process.execPath, [mockPath], {
    input:     JSON.stringify(req),
    encoding:  'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return {
      fallback_used:   true,
      fallback_reason: 'mock_exit_nonzero',
      detail:          (r.stderr || '').slice(-240) || ('exit ' + r.status),
    };
  }
  const trimmed = (r.stdout || '').trim();
  if (!trimmed) {
    return {
      fallback_used:   true,
      fallback_reason: 'mock_empty_output',
      detail:          'mock produced no stdout',
    };
  }
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return {
      fallback_used:   true,
      fallback_reason: 'mock_invalid_json',
      detail:          e.message + ' :: ' + trimmed.slice(0, 240),
    };
  }
}

/**
 * Synthesize a chunk of text. Resolves provider per precedence,
 * applies brand_voice_override if present, dispatches.
 *
 * Returns:
 *   on success → { audio_path, duration_ms, provider_used, voice_id, cost_usd }
 *   on graceful-degrade → { audio_path: null, fallback_used: true,
 *                           fallback_reason: '...', provider_used: '...',
 *                           cost_usd: 0 }
 *
 * NEVER throws on documented failure modes — the dub/voice-clone skills
 * decide whether to continue.
 */
export async function synthesize(req) {
  if (!req || typeof req !== 'object') {
    throw new Error('tts.synthesize: req must be an object');
  }
  const text = String(req.text == null ? '' : req.text);
  if (!req.audio_path) {
    throw new Error('tts.synthesize: req.audio_path required');
  }
  mkdirSync(dirname(req.audio_path), { recursive: true });

  // Honor brand_voice_override before precedence resolution.
  const override = req.brand_voice_override || null;
  const explicit = req.provider || (override && override.provider) || '';
  let chosen;
  try {
    chosen = resolveProvider(explicit);
  } catch (e) {
    return {
      audio_path:      null,
      duration_ms:     0,
      cost_usd:        0,
      provider_used:   null,
      voice_id:        null,
      fallback_used:   true,
      fallback_reason: e.message,
    };
  }
  const voiceId = (override && override.voice_id) || req.voice_id || null;

  // Mock injection — CF_TTS_MOCK overrides every real network path. The mock
  // is responsible for honoring the realistic-duration contract.
  const mockPath = process.env.CF_TTS_MOCK || '';
  if (mockPath) {
    const mockReq = {
      text, voice_id: voiceId, language: req.language || 'en',
      provider: chosen.name, audio_path: req.audio_path,
    };
    const out = runMock(mockPath, mockReq);
    if (out && out.fallback_used) {
      return {
        audio_path:      null,
        duration_ms:     0,
        cost_usd:        0,
        provider_used:   chosen.name,
        voice_id:        voiceId,
        fallback_used:   true,
        fallback_reason: out.fallback_reason || 'mock_failed',
      };
    }
    const dur = typeof out.duration_ms === 'number'
      ? out.duration_ms
      : probeDurationMs(out.audio_path || req.audio_path);
    return {
      audio_path:    out.audio_path || req.audio_path,
      duration_ms:   dur,
      cost_usd:      typeof out.cost_usd === 'number' ? out.cost_usd : 0,
      provider_used: 'mock:' + chosen.name,
      voice_id:      voiceId,
      fallback_used: false,
    };
  }

  // Empty text → write empty file, return 0ms. Hallucination guard at the
  // dispatcher level (every adapter mirrors this — belt + suspenders).
  if (text.length === 0) {
    writeFileSync(req.audio_path, Buffer.alloc(0));
    return {
      audio_path:    req.audio_path,
      duration_ms:   0,
      cost_usd:      0,
      provider_used: chosen.name,
      voice_id:      voiceId,
      fallback_used: false,
    };
  }

  let result;
  try {
    result = await chosen.adapter.synthesize({
      text, voice_id: voiceId, language: req.language || 'en',
      audio_path: req.audio_path,
    });
  } catch (e) {
    return {
      audio_path:      null,
      duration_ms:     0,
      cost_usd:        0,
      provider_used:   chosen.name,
      voice_id:        voiceId,
      fallback_used:   true,
      fallback_reason: e.message,
    };
  }
  if (result && result.fallback_used) {
    return {
      audio_path:      null,
      duration_ms:     0,
      cost_usd:        0,
      provider_used:   chosen.name,
      voice_id:        voiceId,
      fallback_used:   true,
      fallback_reason: result.fallback_reason,
      fallback_detail: result.fallback_detail || null,
    };
  }
  return {
    audio_path:    result.audio_path,
    duration_ms:   probeDurationMs(result.audio_path),
    cost_usd:      result.cost_usd || 0,
    provider_used: chosen.name,
    voice_id:      result.voice_id || voiceId,
    model:         result.model || null,
    fallback_used: false,
  };
}

export async function cloneVoice(req) {
  if (!req || !req.sample_path) {
    throw new Error('tts.cloneVoice: req.sample_path required');
  }
  let chosen;
  try {
    chosen = resolveProvider(req.provider);
  } catch (e) {
    return { fallback_used: true, fallback_reason: e.message, provider_used: null };
  }
  if (!chosen.adapter.SUPPORTS_VOICE_CLONE) {
    // Best-effort — provider returns a generic-voice voice_id + warning.
    const r = await chosen.adapter.cloneVoice(req);
    return { ...r, provider_used: chosen.name, voice_clone_supported: false };
  }
  try {
    const r = await chosen.adapter.cloneVoice(req);
    return { ...r, provider_used: chosen.name, voice_clone_supported: true };
  } catch (e) {
    return {
      fallback_used:   true,
      fallback_reason: e.message,
      provider_used:   chosen.name,
      voice_clone_supported: chosen.adapter.SUPPORTS_VOICE_CLONE,
    };
  }
}

export { PROVIDERS, PRECEDENCE };
// Re-export the WAV helpers so tests and mocks have one import path.
export { buildPlaceholderWav, buildSilentWav };
