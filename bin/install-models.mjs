#!/usr/bin/env node
// install-models.mjs — idempotent downloader for the MediaPipe BlazeFace
// short-range model used by bin/cf-reframe. Run once per checkout (or whenever
// you wipe bin/models/). The model is ~230 KB and tracked outside git.
//
// Usage:
//   node bin/install-models.mjs           # default model
//   node bin/install-models.mjs --force   # redownload even if file exists
//   node bin/install-models.mjs --quiet   # no progress output

import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const MODELS_DIR = join(ROOT, 'bin', 'models');

const MODELS = [
  {
    name: 'face_detector.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
    expected_min_bytes: 200_000,
    expected_max_bytes: 400_000,
    // Known sha256 of the float16 short-range model as of 2024-06.
    // Mismatch prints a warning but does NOT abort — Google may publish
    // updated weights, and we'd rather degrade gracefully than refuse to install.
    sha256: '1f6bb7a1f1f019b6f86feaa6ce15b27f1ddc2db6ff03f3b0d4d7a8c0826d8d1e',
  },
];

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const QUIET = args.has('--quiet');

function log(...a) { if (!QUIET) process.stderr.write('[install-models] ' + a.join(' ') + '\n'); }
function logJSON(obj) { if (!QUIET) process.stdout.write(JSON.stringify(obj) + '\n'); }

async function sha256File(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('error', rej);
    s.on('data', (c) => h.update(c));
    s.on('end', () => res(h.digest('hex')));
  });
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('GET ' + url + ' → ' + res.status + ' ' + res.statusText);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return buf.length;
}

async function installOne(model) {
  const dest = join(MODELS_DIR, model.name);
  const alreadyOk = !FORCE && existsSync(dest) &&
    statSync(dest).size >= model.expected_min_bytes &&
    statSync(dest).size <= model.expected_max_bytes;
  if (alreadyOk) {
    logJSON({ event: 'cached', name: model.name, path: dest, bytes: statSync(dest).size });
    return { name: model.name, status: 'cached' };
  }

  log('downloading', model.name);
  let bytes;
  try {
    bytes = await download(model.url, dest);
  } catch (e) {
    logJSON({ event: 'error', name: model.name, error: e.message, hint: 'check network or use --force after fixing' });
    return { name: model.name, status: 'failed', error: e.message };
  }

  if (bytes < model.expected_min_bytes || bytes > model.expected_max_bytes) {
    log('⚠  ' + model.name + ' downloaded but size is unexpected (' + bytes + ' bytes)');
  }
  try {
    const got = await sha256File(dest);
    if (got !== model.sha256) {
      log('⚠  sha256 mismatch for ' + model.name + ' (got ' + got.slice(0, 12) + '… expected ' + model.sha256.slice(0, 12) + '…) — continuing anyway');
    }
  } catch { /* hashing failure shouldn't block install */ }

  logJSON({ event: 'installed', name: model.name, path: dest, bytes });
  return { name: model.name, status: 'installed', bytes };
}

(async () => {
  mkdirSync(MODELS_DIR, { recursive: true });
  const results = [];
  for (const m of MODELS) results.push(await installOne(m));
  const ok = results.every((r) => r.status === 'cached' || r.status === 'installed');
  logJSON({ event: 'summary', ok, results });
  process.exit(ok ? 0 : 4);
})();
