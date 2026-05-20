// voices.mjs — pure-logic voice library loader/saver.
//
// Two-tier scope (PLAN-v0.4.0 §3.2 Q2):
//
//   1. ./uploads/<slug>/voices.json — per-project (wins)
//   2. ~/.clip-forge/voices.json     — user-global (default)
//
// Schema (v1):
//   {
//     "version": 1,
//     "default": "creator-main",
//     "voices": {
//       "<slug>": {
//         "provider":    "elevenlabs",
//         "voice_id":    "abc123",
//         "sample_path": "/abs/path/sample.wav",
//         "created_at":  "2026-05-21T...",
//         "uses":        ["hook", "outro", "dub-id", "dub-en"]
//       }
//     }
//   }
//
// resolveVoiceForUse(library, useTag) picks the first voice whose `uses[]`
// includes useTag, falling back to library.default, then to the first
// voice in the map. Returns null when no voices exist.
//
// SoC: no provider calls here — that's tts.mjs's job. This module only
// owns persistence + lookup logic.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

function emptyLibrary() {
  return { version: SCHEMA_VERSION, default: null, voices: {} };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normaliseLibrary(raw) {
  if (!isObject(raw)) return { ok: false, library: emptyLibrary(), warning: 'voices_unreadable' };
  const out = emptyLibrary();
  if (typeof raw.default === 'string' && raw.default.length > 0) out.default = raw.default;
  if (isObject(raw.voices)) {
    for (const [k, v] of Object.entries(raw.voices)) {
      if (!isObject(v)) continue;
      const provider    = typeof v.provider    === 'string' ? v.provider    : null;
      const voiceId     = typeof v.voice_id    === 'string' ? v.voice_id    : null;
      const samplePath  = typeof v.sample_path === 'string' ? v.sample_path : null;
      const createdAt   = typeof v.created_at  === 'string' ? v.created_at  : null;
      const uses        = Array.isArray(v.uses) ? v.uses.filter((s) => typeof s === 'string') : [];
      if (!provider || !voiceId) continue;
      out.voices[k] = { provider, voice_id: voiceId, sample_path: samplePath, created_at: createdAt, uses };
    }
  }
  return { ok: true, library: out, warning: null };
}

export function loadLibraryFile(path) {
  if (!path || !existsSync(path)) {
    return { ok: false, library: emptyLibrary(), warning: 'voices_file_missing', path };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    return { ok: false, library: emptyLibrary(), warning: 'voices_unreadable: ' + e.message, path };
  }
  const r = normaliseLibrary(raw);
  return { ok: r.ok, library: r.library, warning: r.warning, path };
}

/**
 * Load with per-project precedence. The per-project file (when it exists
 * AND parses) wins entirely — no merge — to match the PLAN §3.2 Q2 decision
 * ("per-project wins, global default optional"). Returns a structured
 * result so callers can surface which file was used.
 */
export function loadLibrary({ globalPath, projectPath } = {}) {
  if (projectPath && existsSync(projectPath)) {
    const r = loadLibraryFile(projectPath);
    if (r.ok) {
      return { library: r.library, source: 'project', path: projectPath, warning: null };
    }
    // Per-project file present but unreadable → degrade to global with a
    // recorded soft warning so the skill can echo it back to the user.
    if (globalPath && existsSync(globalPath)) {
      const g = loadLibraryFile(globalPath);
      return { library: g.library, source: 'global', path: globalPath, warning: 'project_voices_unreadable_fellback_to_global' };
    }
    return { library: emptyLibrary(), source: null, path: null, warning: 'project_voices_unreadable_and_no_global' };
  }
  if (globalPath && existsSync(globalPath)) {
    const g = loadLibraryFile(globalPath);
    return { library: g.library, source: 'global', path: globalPath, warning: g.ok ? null : g.warning };
  }
  return { library: emptyLibrary(), source: null, path: null, warning: null };
}

/**
 * Pick a voice for a given use-tag. Order:
 *   1. voices[].uses[] includes useTag
 *   2. library.default
 *   3. first voice in alphabetical key order
 *   4. null
 */
export function resolveVoiceForUse(library, useTag) {
  if (!isObject(library) || !isObject(library.voices)) return null;
  const keys = Object.keys(library.voices).sort();
  if (keys.length === 0) return null;
  if (useTag) {
    for (const k of keys) {
      const v = library.voices[k];
      if (Array.isArray(v.uses) && v.uses.includes(useTag)) {
        return { key: k, ...v };
      }
    }
  }
  if (library.default && library.voices[library.default]) {
    return { key: library.default, ...library.voices[library.default] };
  }
  return { key: keys[0], ...library.voices[keys[0]] };
}

/**
 * Add or replace a voice entry. Returns a new library object — does not
 * mutate the input. Caller is responsible for writing to disk.
 */
export function upsertVoice(library, key, entry) {
  const next = { version: SCHEMA_VERSION, default: library.default ?? null,
                 voices: { ...(library.voices || {}) } };
  next.voices[key] = {
    provider:    entry.provider,
    voice_id:    entry.voice_id,
    sample_path: entry.sample_path ?? null,
    created_at:  entry.created_at  ?? new Date().toISOString(),
    uses:        Array.isArray(entry.uses) ? entry.uses.slice() : [],
  };
  if (!next.default) next.default = key;
  return next;
}

export function saveLibraryFile(path, library) {
  mkdirSync(dirname(path), { recursive: true });
  const body = {
    version: SCHEMA_VERSION,
    default: library.default ?? null,
    voices:  library.voices  ?? {},
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  return path;
}

export { SCHEMA_VERSION };
