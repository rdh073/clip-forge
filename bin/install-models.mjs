#!/usr/bin/env node
// install-models.mjs — fetches the ONNX models cf-reframe needs at runtime.
//
// v0.2.0:
//   • bin/models/face_detector.onnx   — Ultraface RFB-320 (~1.3 MB, MIT)
//   • bin/models/face_landmark.onnx   — PFLD 68-point (~2.9 MB, see notes)
// v0.3.0:
//   • bin/models/cb.rnnn              — FFmpeg arnndn speech denoise model
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

import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync, createReadStream, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const MODELS_DIR = join(ROOT, 'bin', 'models');
const PIPER_HOME = join(homedir(), '.clip-forge', 'piper');

const PFLD_DEFAULT_URL = 'https://raw.githubusercontent.com/cunjian/pytorch_face_landmark/master/onnx/pfld.onnx';
const PFLD_PINNED_SHA256 = '7d7bbd5c6a1d9272e58d9773898284a1905d872eba9a662df9b5f20f1ba6f83e';
const RNNOISE_DEFAULT_URL = 'https://raw.githubusercontent.com/GregorR/rnnoise-models/refs/heads/master/conjoined-burgers-2018-08-28/cb.rnnn';
const RNNOISE_PINNED_SHA256 = 'f1357c4e5be9dee8467bead486dfced2d75b640c26ad0b594fa7f102322371d9';

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
  {
    key: 'rnnoise',
    name: 'cb.rnnn',
    url: process.env.CF_RNNOISE_MODEL_URL || RNNOISE_DEFAULT_URL,
    expected_min_bytes: 250_000,
    expected_max_bytes: 400_000,
    license: process.env.CF_RNNOISE_MODEL_URL
      ? '(custom URL — caller-supplied; verify license yourself)'
      : 'GregorR/rnnoise-models README says model files are not subject to copyright; pinned sha256',
    pinned_sha256: process.env.CF_RNNOISE_MODEL_URL ? null : RNNOISE_PINNED_SHA256,
  },
];

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const QUIET = args.has('--quiet');
const PIPER = args.has('--piper');
const ONLY_PIPER = args.has('--piper-only');

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
          const envName = model.key === 'landmark' ? 'CF_PFLD_MODEL_URL' : 'CF_RNNOISE_MODEL_URL';
          log('   Continuing anyway (fail-soft). If the model breaks, pin a new sha or use ' + envName + '.');
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

// ----- v0.4.0 pillar 2 — Piper TTS local fallback installer -----
//
// Fetches the Piper release tarball for the host architecture into
// ~/.clip-forge/piper/ and stages one generic English voice (~50 MB total)
// so the dub skill can degrade to a working offline TTS path. Skipped
// unless --piper or --piper-only is passed.
//
// Tarball URLs are pinned to a release tag for reproducibility; if the URL
// returns 404, the installer logs a soft warning rather than failing — the
// dub skill's graceful-degrade contract handles a missing binary.

const PIPER_RELEASES = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2';
const PIPER_ASSET_BY_PLATFORM = {
  'linux-x64':   'piper_linux_x86_64.tar.gz',
  'linux-arm64': 'piper_linux_aarch64.tar.gz',
  'darwin-x64':  'piper_macos_x64.tar.gz',
  'darwin-arm64': 'piper_macos_aarch64.tar.gz',
};
const PIPER_VOICE_NAME = 'en_US-lessac-medium';
const PIPER_VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/';

function platformKey() {
  const p = process.platform === 'darwin' ? 'darwin' : 'linux';
  const a = process.arch === 'arm64' ? 'arm64' : 'x64';
  return p + '-' + a;
}

async function downloadIfMissing(url, dest, minBytes) {
  if (existsSync(dest) && statSync(dest).size >= (minBytes || 1024)) return false;
  log('downloading', dest, '←', url);
  await download(url, dest);
  return true;
}

async function installPiper() {
  mkdirSync(PIPER_HOME, { recursive: true });
  const key = platformKey();
  const asset = PIPER_ASSET_BY_PLATFORM[key];
  if (!asset) {
    log('⚠ unsupported platform for Piper:', key);
    logJSON({ event: 'piper_install', ok: false, reason: 'unsupported_platform', platform: key });
    return { ok: false };
  }
  const url = PIPER_RELEASES + '/' + asset;
  const tarPath = join(PIPER_HOME, asset);
  try {
    await downloadIfMissing(url, tarPath, 1_000_000);
  } catch (e) {
    log('⚠ piper download failed:', e.message);
    logJSON({ event: 'piper_install', ok: false, reason: 'binary_download_failed', detail: e.message });
    return { ok: false };
  }
  // Unpack with system tar — Node has no built-in tar reader, and tar is
  // a hard prereq of every Linux/macOS box ClipForge supports.
  const tar = await import('node:child_process').then((m) => m.spawnSync);
  const r = tar('tar', ['-xzf', tarPath, '-C', PIPER_HOME, '--strip-components=1']);
  if (r.status !== 0) {
    log('⚠ piper untar failed; bundle left at', tarPath);
    logJSON({ event: 'piper_install', ok: false, reason: 'untar_failed' });
    return { ok: false };
  }
  const piperBin = join(PIPER_HOME, 'piper');
  if (existsSync(piperBin)) {
    try { chmodSync(piperBin, 0o755); } catch {}
  }
  // Stage one English voice model + its .json sidecar.
  const voicesDir = join(PIPER_HOME, 'voices');
  mkdirSync(voicesDir, { recursive: true });
  const onnxDst = join(voicesDir, PIPER_VOICE_NAME + '.onnx');
  const jsonDst = join(voicesDir, PIPER_VOICE_NAME + '.onnx.json');
  try {
    await downloadIfMissing(PIPER_VOICE_BASE + PIPER_VOICE_NAME + '.onnx',      onnxDst, 50_000_000);
    await downloadIfMissing(PIPER_VOICE_BASE + PIPER_VOICE_NAME + '.onnx.json', jsonDst, 1_000);
  } catch (e) {
    log('⚠ piper voice download failed:', e.message);
  }
  logJSON({ event: 'piper_install', ok: true, home: PIPER_HOME, bin: piperBin, voice: onnxDst });
  return { ok: true };
}

(async () => {
  mkdirSync(MODELS_DIR, { recursive: true });
  const results = [];
  if (!ONLY_PIPER) {
    for (const m of MODELS) results.push(await installOne(m));
  }
  if (PIPER || ONLY_PIPER) {
    const r = await installPiper();
    results.push({ name: 'piper', status: r.ok ? 'installed' : 'skipped' });
  }
  const ok = results.every((r) => r.status === 'cached' || r.status === 'installed' || r.status === 'skipped');
  logJSON({ event: 'summary', ok, results });
  process.exit(ok ? 0 : 4);
})();
