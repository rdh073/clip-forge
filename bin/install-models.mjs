#!/usr/bin/env node
// install-models.mjs — fetches the ONNX models cf-reframe needs at runtime.
//
// v0.2.0:
//   • bin/models/face_detector.onnx   — Ultraface RFB-320 (~1.3 MB, MIT)
//   • bin/models/face_landmark.onnx   — PFLD 68-point (~2.9 MB, see notes)
//
// Licensing notes for face_landmark.onnx:
// We fetch the PFLD 68-point ONNX **directly from the upstream repo**
// (cunjian/pytorch_face_landmark) on every install rather than rebundling it
// here. That repo currently does not ship a LICENSE file. We use it under
// fair-use research / preview interpretation pending a verified Apache-2.0
// or MIT alternative (tracked in docs/ROADMAP.md → v0.3.0 "License
// hardening"). Users who'd prefer a different source can point at one by
// setting CF_PFLD_MODEL_URL=<your-url> before running this script.
//
// Usage:
//   node bin/install-models.mjs                       # fetch what's missing
//   CF_PFLD_MODEL_URL=https://... npm run install-models  # custom source
//   node bin/install-models.mjs --force               # redownload everything
//   node bin/install-models.mjs --quiet               # JSON events only

import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const MODELS_DIR = join(ROOT, 'bin', 'models');

const PFLD_DEFAULT_URL = 'https://raw.githubusercontent.com/cunjian/pytorch_face_landmark/master/onnx/pfld.onnx';
const PFLD_PINNED_SHA256 = '7d7bbd5c6a1d9272e58d9773898284a1905d872eba9a662df9b5f20f1ba6f83e';

const MODELS = [
  {
    key: 'detector',
    name: 'face_detector.onnx',
    url: 'https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx',
    expected_min_bytes: 700_000,
    expected_max_bytes: 2_500_000,
    license: 'MIT (Linzaer/Ultra-Light-Fast-Generic-Face-Detector)',
  },
  {
    key: 'landmark',
    name: 'face_landmark.onnx',
    url: process.env.CF_PFLD_MODEL_URL || PFLD_DEFAULT_URL,
    expected_min_bytes: 1_500_000,
    expected_max_bytes: 5_000_000,
    license: process.env.CF_PFLD_MODEL_URL
      ? '(custom URL — caller-supplied; verify license yourself)'
      : 'None stated (cunjian/pytorch_face_landmark) — see install-models.mjs header + docs/ROADMAP.md v0.3.0',
    pinned_sha256: process.env.CF_PFLD_MODEL_URL ? null : PFLD_PINNED_SHA256,
    notice: process.env.CF_PFLD_MODEL_URL
      ? null
      : 'Downloading PFLD landmark model from cunjian/pytorch_face_landmark.\n  License: not explicitly stated by upstream; used under fair-use research/preview\n  interpretation pending a v0.3.0 swap to a verified Apache/MIT alternative.\n  To pin your own model: set CF_PFLD_MODEL_URL=<your-url> before this script.',
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
  if (!FORCE && sizeOk(dest, model.expected_min_bytes, model.expected_max_bytes)) {
    logJSON({ event: 'cached', name: model.name, path: dest, bytes: statSync(dest).size });
    return { name: model.name, status: 'cached' };
  }
  if (model.notice) log(model.notice);
  log('downloading', model.name, '←', model.url);
  try {
    const bytes = await download(model.url, dest);
    if (bytes < model.expected_min_bytes || bytes > model.expected_max_bytes) {
      log('⚠  ' + model.name + ' downloaded but size is unexpected (' + bytes + ' bytes)');
    }
    if (model.pinned_sha256) {
      try {
        const got = await sha256File(dest);
        if (got !== model.pinned_sha256) {
          log('⚠  ' + model.name + ' sha256 mismatch — upstream may have updated the file.');
          log('   pinned : ' + model.pinned_sha256);
          log('   got    : ' + got);
          log('   Continuing anyway (fail-soft). If the model breaks, pin a new sha or use CF_PFLD_MODEL_URL.');
        }
      } catch { /* hash failure shouldn't block */ }
    }
    logJSON({ event: 'installed', name: model.name, path: dest, bytes, license: model.license, source: model.url });
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
