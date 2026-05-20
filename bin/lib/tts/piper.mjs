// piper.mjs — Piper TTS local fallback adapter.
//
// Piper is the offline last-resort. No voice clone; uses generic voice models
// stored under ~/.clip-forge/piper/voices/<lang>-<name>.onnx (fetched lazily
// by `bin/install-models.mjs --piper`).
//
// Provider resolution priority: lowest. The dispatcher only routes here when
// no paid keys are set, or when CF_TTS_PROVIDER=piper is forced.
//
// When the Piper binary is not installed, synthesize() does NOT throw — it
// returns a structured fallback_used object so the dub skill can degrade
// gracefully (exit 0, telemetry carries fallback_reason).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const COST_PER_CHAR_USD = 0;
const DEFAULT_LANG      = 'en';
const PIPER_HOME        = join(homedir(), '.clip-forge', 'piper');
const PIPER_BIN_PATH    = process.env.CF_PIPER_BIN || join(PIPER_HOME, 'piper');
const PIPER_VOICES_DIR  = process.env.CF_PIPER_VOICES_DIR || join(PIPER_HOME, 'voices');

export const NAME = 'piper';
export const SUPPORTS_VOICE_CLONE = false;
export { PIPER_HOME, PIPER_BIN_PATH, PIPER_VOICES_DIR };

function which(bin) {
  const r = spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function binAvailable() {
  if (existsSync(PIPER_BIN_PATH)) {
    try {
      return statSync(PIPER_BIN_PATH).isFile();
    } catch { return false; }
  }
  return which('piper') !== null;
}

export function listVoices() {
  if (!existsSync(PIPER_VOICES_DIR)) return [];
  try {
    return readdirSync(PIPER_VOICES_DIR)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => join(PIPER_VOICES_DIR, f));
  } catch {
    return [];
  }
}

function pickVoiceFor(lang) {
  const voices = listVoices();
  if (voices.length === 0) return null;
  const wanted = (lang || DEFAULT_LANG).toLowerCase();
  const langMatch = voices.find((p) => {
    const base = p.split('/').pop().toLowerCase();
    return base.startsWith(wanted + '-') || base.startsWith(wanted + '_');
  });
  return langMatch || voices[0];
}

export function available() {
  // "available" semantically means "the dispatcher CAN reach this provider".
  // Piper is the last-resort fallback — we say available() = true so the
  // dispatcher resolves here when no paid keys are set, then the synthesize
  // call itself returns fallback_used when the binary isn't on disk.
  return true;
}

export function estimateCostUsd(/* text */) {
  return COST_PER_CHAR_USD;
}

/**
 * Invoke the piper binary. Returns either a successful audio result or a
 * structured fallback_used object — never throws on documented failure
 * modes (binary missing, no voices on disk, exec failed).
 */
export async function synthesize(req) {
  const text = String(req.text || '');
  if (text.length === 0) {
    writeFileSync(req.audio_path, Buffer.alloc(0));
    return { audio_path: req.audio_path, cost_usd: 0, model: 'piper', voice_id: 'silence' };
  }
  if (!binAvailable()) {
    return {
      fallback_used:   true,
      fallback_reason: 'piper_not_installed',
      audio_path:      null,
      cost_usd:        0,
      model:           'piper',
      voice_id:        null,
    };
  }
  const voicePath = pickVoiceFor(req.language || DEFAULT_LANG);
  if (!voicePath) {
    return {
      fallback_used:   true,
      fallback_reason: 'piper_voice_missing',
      audio_path:      null,
      cost_usd:        0,
      model:           'piper',
      voice_id:        null,
    };
  }
  const binCmd = existsSync(PIPER_BIN_PATH) ? PIPER_BIN_PATH : 'piper';
  const r = spawnSync(binCmd, [
    '--model',  voicePath,
    '--output_file', req.audio_path,
  ], {
    input:    text,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return {
      fallback_used:   true,
      fallback_reason: 'piper_exec_failed',
      fallback_detail: (r.stderr && r.stderr.toString().slice(-240)) || ('exit ' + r.status),
      audio_path:      null,
      cost_usd:        0,
      model:           'piper',
      voice_id:        null,
    };
  }
  return {
    audio_path: req.audio_path,
    cost_usd:   0,
    model:      'piper',
    voice_id:   voicePath.split('/').pop().replace(/\.onnx$/, ''),
  };
}

export async function cloneVoice(req) {
  // Piper has no clone capability; copy the sample into the voices dir as
  // a "metadata" record so voices.json still has a sensible sample_path
  // and the dub skill can show the canonical bilingual warning.
  if (req && req.sample_path && existsSync(req.sample_path)) {
    try {
      const dst = join(PIPER_VOICES_DIR, (req.name || 'sample') + '.wav');
      copyFileSync(req.sample_path, dst);
    } catch { /* non-fatal */ }
  }
  return {
    voice_id: 'piper-generic',
    cost_usd: 0,
    provider: 'piper',
    warning:  'voice_clone_disabled_piper',
  };
}
