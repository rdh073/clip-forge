// enhance-render.test.mjs — cross-pillar guard for audio_source render handoff.
//
// This protects the seam Pillar A will also touch: cf-enhance supplies a
// normalized WAV through edit.json.audio_source, while cf-ffmpeg must keep the
// video stream identical to the same render without audio_source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const CF_ENHANCE = resolve(PLUGIN_ROOT, 'bin/cf-enhance');
const CF_FFMPEG = resolve(PLUGIN_ROOT, 'bin/cf-ffmpeg');
const FIXTURE = resolve(PLUGIN_ROOT, 'tests/fixtures/noisy-speech-5s.mp4');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

const HAS_FFMPEG = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const HAS_FIXTURE = existsSync(FIXTURE);
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing'
  : !HAS_FFPROBE ? 'ffprobe missing'
  : !HAS_FIXTURE ? 'fixture missing: ' + FIXTURE
  : null;

function writeMinimalCrop(path) {
  writeFileSync(path, JSON.stringify({
    version: 2,
    source_w: 320,
    source_h: 240,
    target_w: 1080,
    target_h: 1920,
    samples: [],
    interp: 'linear',
    mode: 'center',
    detector: 'identity',
    fallback_used: false,
    fallback_reason: null,
  }, null, 2) + '\n');
}

function writeEdit(path, { cropPath, output, audioSource = null }) {
  const edit = {
    version: 1,
    clip_id: audioSource ? 'enhanced-audio' : 'source-audio',
    start_ms: 0,
    end_ms: 5000,
    source: FIXTURE,
    crop_path: cropPath,
    output,
    quality: 'fast',
  };
  if (audioSource) edit.audio_source = audioSource;
  writeFileSync(path, JSON.stringify(edit, null, 2) + '\n');
}

function runRender(editPath) {
  const r = spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editPath], {
    encoding: 'utf-8',
    cwd: PLUGIN_ROOT,
    env: { ...process.env, CF_RENDER_DETERMINISTIC: '1' },
  });
  assert.equal(r.status, 0, 'cf-ffmpeg render should succeed: ' + r.stderr);
}

function loudnormProbe(file) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', file,
    '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
    '-f', 'null', '-',
  ], { encoding: 'utf-8', maxBuffer: 12 * 1024 * 1024 });
  assert.equal(r.status, 0, 'ffmpeg loudnorm probe failed: ' + r.stderr);
  const m = r.stderr.match(/\{[\s\S]*\}/m);
  assert.ok(m, 'could not parse loudnorm JSON from stderr:\n' + r.stderr);
  return JSON.parse(m[0]);
}

function videoBitstreamHash(file) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-map', '0:v',
    '-c:v', 'copy',
    '-f', 'rawvideo',
    'pipe:1',
  ], { maxBuffer: 80 * 1024 * 1024 });
  assert.equal(r.status, 0, 'ffmpeg video bitstream extraction failed: ' + r.stderr.toString());
  return createHash('sha256').update(r.stdout).digest('hex');
}

test('enhance-render: audio_source preserves video bitstream and rendered audio stays normalized',
  { skip: SKIP || false, timeout: 90_000 }, () => {
    const work = join(tmpdir(), 'cf-enhance-render-contract-' + Date.now());
    try {
      mkdirSync(work, { recursive: true });
      const audioNorm = join(work, 'audio.norm.wav');
      const enhanceJson = join(work, 'enhance.json');
      const cropPath = join(work, 'crop.json');
      const editEnhanced = join(work, 'edit-enhanced.json');
      const editBaseline = join(work, 'edit-baseline.json');
      const outEnhanced = join(work, 'out-enhanced.mp4');
      const outBaseline = join(work, 'out-baseline.mp4');

      const enhance = spawnSync('node', [
        CF_ENHANCE,
        '--in', FIXTURE,
        '--out', audioNorm,
        '--report', enhanceJson,
      ], { encoding: 'utf-8', cwd: PLUGIN_ROOT });
      assert.equal(enhance.status, 0, 'cf-enhance should succeed: ' + enhance.stderr);
      const report = JSON.parse(readFileSync(enhanceJson, 'utf-8'));
      assert.equal(report.output, audioNorm, 'enhance report must point at audio.norm.wav');
      assert.ok(report.true_peak <= -1.0, 'enhanced WAV true peak must be <= -1.0 dBTP');

      writeMinimalCrop(cropPath);
      writeEdit(editEnhanced, { cropPath, output: outEnhanced, audioSource: audioNorm });
      writeEdit(editBaseline, { cropPath, output: outBaseline });

      runRender(editEnhanced);
      runRender(editBaseline);

      const renderedAudio = loudnormProbe(outEnhanced);
      const lufs = parseFloat(renderedAudio.input_i);
      const truePeak = parseFloat(renderedAudio.input_tp);
      assert.ok(Math.abs(lufs - (-14)) <= 1.0,
        'rendered MP4 audio loudness must be -14 ± 1.0 LUFS; got ' + lufs);
      assert.ok(truePeak <= -1.0,
        'rendered MP4 audio true peak must be <= -1.0 dBTP; got ' + truePeak);

      assert.equal(videoBitstreamHash(outEnhanced), videoBitstreamHash(outBaseline),
        'audio_source must not change rendered video bitstream');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });
