#!/usr/bin/env node
// install-models.mjs — fetches the ONNX models cf-reframe needs at runtime.
//
// v0.2.0:
//   • bin/models/face_detector.onnx  — Ultraface RFB-320 (~1.5 MB)
//   • bin/models/face_landmark.onnx  — PFLD 68-point (added in Phase 2B)
//
// Usage:
//   node bin/install-models.mjs           # fetch what's missing
//   node bin/install-models.mjs --force   # redownload everything
//   node bin/install-models.mjs --quiet   # JSON events only, no log lines

import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const MODELS_DIR = join(ROOT, 'bin', 'models');

const MODELS = [
  {
    name: 'face_detector.onnx',
    url: 'https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx',
    expected_min_bytes: 700_000,
    expected_max_bytes: 2_500_000,
  },
];

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const QUIET = args.has('--quiet');

function log(...a) { if (!QUIET) process.stderr.write('[install-models] ' + a.join(' ') + '\n'); }
function logJSON(obj) { if (!QUIET) process.stdout.write(JSON.stringify(obj) + '\n'); }

function sizeOk(path, min, max) {
  try {
    const sz = statSync(path).size;
    return sz >= min && sz <= max;
  } catch { return false; }
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
  if (!FORCE && sizeOk(dest, model.expected_min_bytes, model.expected_max_bytes)) {
    logJSON({ event: 'cached', name: model.name, path: dest, bytes: statSync(dest).size });
    return { name: model.name, status: 'cached' };
  }
  log('downloading', model.name);
  try {
    const bytes = await download(model.url, dest);
    if (bytes < model.expected_min_bytes || bytes > model.expected_max_bytes) {
      log('⚠  ' + model.name + ' downloaded but size is unexpected (' + bytes + ' bytes)');
    }
    logJSON({ event: 'installed', name: model.name, path: dest, bytes });
    return { name: model.name, status: 'installed', bytes };
  } catch (e) {
    logJSON({ event: 'error', name: model.name, error: e.message });
    return { name: model.name, status: 'failed', error: e.message };
  }
}

(async () => {
  mkdirSync(MODELS_DIR, { recursive: true });
  const results = [];
  for (const m of MODELS) results.push(await installOne(m));
  const ok = results.every((r) => r.status === 'cached' || r.status === 'installed');
  logJSON({ event: 'summary', ok, results });
  process.exit(ok ? 0 : 4);
})();
