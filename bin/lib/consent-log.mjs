// consent-log.mjs — avatar consent state machine (v0.4.0 pillar 5, §7 Q3).
//
// Two-gate consent model:
//   Gate 1 — one-time per machine. User confirms they only use photos with
//            subject permission. Recorded once in ~/.clip-forge/.consent-log
//            with a hashed machine_id. CF_AVATAR_CONSENT=1 env var bypasses
//            the interactive prompt (CI/headless friendly).
//   Gate 2 — per-photo sha256 cache. Re-used photos skip the prompt;
//            new photos trigger a fresh AskUserQuestion gate.
//
// State file: ~/.clip-forge/.consent-log (single file, global scope ONLY —
// avatar consent is a human contract, not a per-project setting).
//
// Atomic writes: mirror render-manifest.mjs pattern — write to <path>.tmp,
// fsync, rename. Crash mid-write leaves either the previous file intact OR
// no file (cold-start re-prompts).

import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  openSync, fsyncSync, closeSync, renameSync, statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';

export const CONSENT_SCHEMA_VERSION = 1;

export function defaultLogPath() {
  return join(homedir(), '.clip-forge', '.consent-log');
}

/**
 * Hash the machine identity. Only stored as sha256 → no user-identifying
 * bytes leave the local machine even in shared backups.
 */
export function machineIdHash() {
  let user = 'unknown';
  try { user = userInfo().username || 'unknown'; } catch { /* fall back */ }
  return 'sha256:' + createHash('sha256')
    .update(String(hostname() || '') + '|' + String(user))
    .digest('hex');
}

export function photoHash(photoPath) {
  if (!photoPath || !existsSync(photoPath)) return null;
  try {
    if (!statSync(photoPath).isFile()) return null;
    return 'sha256:' + createHash('sha256').update(readFileSync(photoPath)).digest('hex');
  } catch { return null; }
}

function emptyLog() {
  return {
    version:           CONSENT_SCHEMA_VERSION,
    consented_at:      null,
    machine_id_hash:   null,
    photos:            {},
  };
}

export function loadLog(path) {
  const p = path || defaultLogPath();
  if (!existsSync(p)) return emptyLog();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object') return emptyLog();
    if (typeof raw.version !== 'number')        raw.version = CONSENT_SCHEMA_VERSION;
    if (!raw.photos || typeof raw.photos !== 'object') raw.photos = {};
    return raw;
  } catch { return emptyLog(); }
}

export function saveLogAtomic(log, path) {
  const p = path || defaultLogPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + '.tmp.' + process.pid + '.' + Date.now();
  const body = JSON.stringify(log, null, 2) + '\n';
  writeFileSync(tmp, body);
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, p);
  return p;
}

/**
 * Gate 1 check. Returns one of:
 *   { state: 'consented' }           — log carries a machine_id_hash, proceed
 *   { state: 'env_bypass' }          — CF_AVATAR_CONSENT=1 set; treat as consented
 *   { state: 'needs_prompt' }        — first run; caller asks user
 */
export function checkGate1(log) {
  if (process.env.CF_AVATAR_CONSENT === '1') return { state: 'env_bypass' };
  if (log && log.machine_id_hash && log.consented_at) return { state: 'consented' };
  return { state: 'needs_prompt' };
}

/**
 * Record gate-1 consent. Caller invokes this AFTER the AskUserQuestion
 * returned yes (or under CF_AVATAR_CONSENT=1).
 */
export function recordGate1(log) {
  log.consented_at    = new Date().toISOString();
  log.machine_id_hash = machineIdHash();
  return log;
}

/**
 * Gate 2 check. Returns one of:
 *   { state: 'consented', hash, entry }  — photo previously consented
 *   { state: 'needs_prompt', hash }      — new photo; caller asks user
 *   { state: 'photo_missing' }           — file not found / unreadable
 */
export function checkGate2(log, photoPath) {
  const hash = photoHash(photoPath);
  if (!hash) return { state: 'photo_missing' };
  const entry = log.photos[hash];
  if (entry) return { state: 'consented', hash, entry };
  return { state: 'needs_prompt', hash };
}

/**
 * Record gate-2 consent. Caller invokes this AFTER the AskUserQuestion
 * returned yes for a never-before-seen photo.
 */
export function recordGate2(log, hash) {
  if (!hash) return log;
  const now = new Date().toISOString();
  const prev = log.photos[hash];
  if (prev) {
    prev.last_used_at = now;
    prev.use_count    = (prev.use_count || 0) + 1;
  } else {
    log.photos[hash] = {
      consented_at: now,
      last_used_at: now,
      use_count:    1,
    };
  }
  return log;
}

/**
 * Convenience — bump use_count + last_used_at on a cache hit (the
 * "re-using same photo" path). No-op when entry absent.
 */
export function bumpUseCount(log, hash) {
  if (!hash) return log;
  const prev = log.photos[hash];
  if (!prev) return log;
  prev.use_count    = (prev.use_count || 0) + 1;
  prev.last_used_at = new Date().toISOString();
  return log;
}

/**
 * Bilingual prompt strings, per §7 Q3. Caller passes these into
 * AskUserQuestion verbatim.
 */
export const GATE1_PROMPT_EN = 'Avatar generation requires explicit consent. I confirm I only use photos of people with their permission.';
export const GATE1_PROMPT_ID = 'Generasi avatar memerlukan persetujuan eksplisit. Saya konfirmasi bahwa saya hanya menggunakan foto orang yang telah memberikan izin.';
export const GATE2_PROMPT_EN = 'First time using this photo. Subject has given permission? (y/N)';
export const GATE2_PROMPT_ID = 'Foto ini pertama kali digunakan. Subjek telah memberi izin? (y/T)';
