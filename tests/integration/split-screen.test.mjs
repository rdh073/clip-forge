// split-screen.test.mjs — integration tests for v0.4.0 pillar 6
// speaker-aware reframe + split-screen rendering.
//
// Approach:
//   - Synthesize a 2-color source MP4 via lavfi (left-half blue,
//     right-half red) so per-half luminance differs reliably.
//   - Pair with a deterministic dual-speaker transcript fixture
//     (tests/fixtures/dual-speaker-10s.transcript.json).
//   - Run cf-reframe with `--speaker-route=auto` and assert crop_path.json
//     v3 with ≥1 split_screen sample + speaker_timeline block populated.
//   - Render the resulting crop_path with cf-ffmpeg and assert the output
//     MP4 carries distinct top-vs-bottom (or left-vs-right) halves.
//
// No face fixtures needed — split-screen takes a different code path
// from face detection. The speaker→position mapping uses an explicit
// --speaker-map with the source's actual color regions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PLUGIN_ROOT = resolvePath(fileURLToPath(import.meta.url), '../../..');
const CF_REFRAME = join(PLUGIN_ROOT, 'bin', 'cf-reframe');
const CF_FFMPEG  = join(PLUGIN_ROOT, 'bin', 'cf-ffmpeg');
const DUAL_TX    = join(PLUGIN_ROOT, 'tests', 'fixtures', 'dual-speaker-10s.transcript.json');
const SINGLE_TX  = join(PLUGIN_ROOT, 'tests', 'fixtures', 'single-speaker-10s.transcript.json');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore','pipe','ignore'] }).toString().trim(); }
  catch { return null; }
}
const HAS_FFMPEG  = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing'
           : !HAS_FFPROBE ? 'ffprobe missing'
           : !existsSync(DUAL_TX) ? 'dual transcript fixture missing — run npm run build-fixtures'
           : false;

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-pillar6-')); }

function buildDualPanelMp4(dir, durS, w = 1920, h = 1080) {
  // Left half = blue, right half = red. lavfi gradients differ enough that
  // hstack rendering shows clearly distinguishable left vs right luminance.
  mkdirSync(dir, { recursive: true });
  const mp4 = join(dir, 'dual.mp4');
  const halfW = Math.floor(w / 2);
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=' + halfW + 'x' + h + ':r=24:d=' + durS,
    '-f', 'lavfi', '-i', 'color=c=red:s=' + halfW + 'x' + h + ':r=24:d=' + durS,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + durS + ':sample_rate=22050',
    '-filter_complex', '[0:v][1:v]hstack[v]',
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', mp4,
  ]);
  if (r.status !== 0) throw new Error('buildDualPanelMp4: ' + (r.stderr ? r.stderr.toString() : 'exit ' + r.status));
  return mp4;
}

function probeDims(path) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height',
    '-of', 'json', path,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  const j = JSON.parse(r.stdout);
  const s = j.streams && j.streams[0];
  return s ? { w: s.width, h: s.height } : null;
}

// Extract a single frame at `tS` seconds, return mean luma of a region.
function regionLuma(mp4, tS, region) {
  const pgmPath = mp4 + '.frame.pgm';
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', tS.toFixed(3), '-i', mp4,
    '-vf', 'crop=' + region.w + ':' + region.h + ':' + region.x + ':' + region.y + ',format=gray',
    '-vframes', '1', pgmPath,
  ]);
  if (r.status !== 0) return null;
  // Parse PGM: P5 header then binary.
  const buf = readFileSync(pgmPath);
  try { rmSync(pgmPath); } catch {}
  let pos = 0;
  function readLine() {
    let start = pos;
    while (pos < buf.length && buf[pos] !== 0x0a) pos++;
    const line = buf.slice(start, pos).toString().trim();
    pos++;
    return line;
  }
  const magic = readLine();
  if (magic !== 'P5') return null;
  let dims = readLine();
  while (dims.startsWith('#')) dims = readLine();
  const [, ] = dims.split(/\s+/).map(Number);
  readLine(); // maxval
  let sum = 0; let n = 0;
  for (let i = pos; i < buf.length; i++) { sum += buf[i]; n++; }
  return n > 0 ? sum / n : 0;
}

test('cf-reframe --speaker-route=auto with dual transcript → v3 crop_path with split_screen samples',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src = buildDualPanelMp4(work, 6);
      const outCrop = join(work, 'crop.json');
      const r = spawnSync('node', [
        CF_REFRAME, src,
        '--output', outCrop,
        '--target-aspect', '9:16',
        '--sample-fps', '4',
        '--transcript', DUAL_TX,
        '--speaker-map', '0:0.25,0.5,1:0.75,0.5',
        '--speaker-route', 'auto',
      ], { encoding: 'utf-8' });
      assert.equal(r.status, 0, 'cf-reframe must exit 0; stderr=' + r.stderr);

      const out = JSON.parse(readFileSync(outCrop, 'utf-8'));
      assert.equal(out.version, 3, 'crop_path must be v3');
      assert.ok(out.speaker_timeline, 'speaker_timeline block must exist');
      assert.ok(out.speaker_timeline.windows_split_screen >= 1,
        'expected ≥1 split window; got ' + out.speaker_timeline.windows_split_screen);
      assert.equal(out.speaker_timeline.speakers_detected, 2);
      const ssSamples = out.samples.filter((s) => s.split_screen);
      assert.ok(ssSamples.length >= 1, 'expected ≥1 split_screen sample in output');
      // Speakers in the first split sample MUST be ordered ascending by speaker_id (S3).
      assert.equal(ssSamples[0].split_screen.speakers[0].speaker_id, 0);
      assert.equal(ssSamples[0].split_screen.speakers[1].speaker_id, 1);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('cf-reframe with single-speaker transcript → zero split_screen samples (regression guard)',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src = buildDualPanelMp4(work, 4);
      const outCrop = join(work, 'crop.json');
      const r = spawnSync('node', [
        CF_REFRAME, src,
        '--output', outCrop,
        '--target-aspect', '9:16',
        '--sample-fps', '4',
        '--transcript', SINGLE_TX,
        '--speaker-route', 'auto',
      ], { encoding: 'utf-8' });
      assert.equal(r.status, 0, 'cf-reframe must exit 0; stderr=' + r.stderr);
      const out = JSON.parse(readFileSync(outCrop, 'utf-8'));
      const ssSamples = out.samples.filter((s) => s.split_screen);
      assert.equal(ssSamples.length, 0, 'single-speaker → zero split_screen samples');
      assert.equal(out.speaker_timeline.windows_split_screen, 0);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('--speaker-route=none forces single-face even on multi-speaker transcript',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src = buildDualPanelMp4(work, 4);
      const outCrop = join(work, 'crop.json');
      const r = spawnSync('node', [
        CF_REFRAME, src,
        '--output', outCrop,
        '--target-aspect', '9:16',
        '--sample-fps', '4',
        '--transcript', DUAL_TX,
        '--speaker-route', 'none',
      ], { encoding: 'utf-8' });
      assert.equal(r.status, 0, 'cf-reframe must exit 0; stderr=' + r.stderr);
      const out = JSON.parse(readFileSync(outCrop, 'utf-8'));
      const ssSamples = out.samples.filter((s) => s.split_screen);
      assert.equal(ssSamples.length, 0, '--speaker-route=none → zero split_screen samples');
      assert.equal(out.speaker_timeline.route_mode, 'none');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('cf-ffmpeg render: 9:16 target with split_screen samples → 1080x1920 with distinct TOP vs BOTTOM halves',
  { skip: SKIP || false, timeout: 120_000 }, () => {
    const work = tmp();
    try {
      const src = buildDualPanelMp4(work, 4);
      // Hand-build a v3 crop_path with a single split-screen window
      // covering the whole clip. Speaker 0 maps to LEFT half of source
      // (cx=480), speaker 1 to RIGHT half (cx=1440). Renderer's vstack
      // for 9:16 puts speaker_id 0 on TOP, speaker_id 1 on BOTTOM.
      const cropP = join(work, 'crop.json');
      writeFileSync(cropP, JSON.stringify({
        version: 3, source_w: 1920, source_h: 1080,
        target_w: 1080, target_h: 1920,
        mode: 'face', detector: 'synthetic',
        samples: [{
          t_ms: 0,
          split_screen: {
            speakers: [
              { speaker_id: 0, cx: 480,  cy: 540, scale: 1.0 },
              { speaker_id: 1, cx: 1440, cy: 540, scale: 1.0 },
            ],
          },
        }],
        interp: 'linear',
        fallback_used: false, fallback_reason: null,
        speaker_timeline: {
          windows_split_screen: 1, total_split_duration_ms: 4000,
          speakers_detected: 2, route_mode: 'auto', warnings: [],
        },
      }, null, 2));

      const outMp4 = join(work, 'out.mp4');
      const editP = join(work, 'edit.json');
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'c01',
        source: src, crop_path: cropP,
        start_ms: 0, end_ms: 3500, quality: 'fast',
        output: outMp4,
        target_aspect: '9:16',
      }, null, 2));

      const r = spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editP], {
        cwd: PLUGIN_ROOT, encoding: 'utf-8',
      });
      assert.equal(r.status, 0, 'render must succeed; stderr=' + r.stderr);
      assert.ok(existsSync(outMp4), 'output mp4 must exist');
      const dims = probeDims(outMp4);
      assert.deepEqual(dims, { w: 1080, h: 1920 }, '9:16 canvas must be 1080x1920');

      // Top half should be predominantly BLUE (speaker 0, left source half).
      // Bottom half should be predominantly RED (speaker 1, right source half).
      // We sample mid-clip + use luma proxy: blue and red have similar luma
      // but the conversion to grayscale ranks them differently due to
      // BT.709 weights — luma(blue) ≈ 0.07, luma(red) ≈ 0.21.
      const topLuma = regionLuma(outMp4, 2.0, { x: 0, y: 100, w: 1080, h: 800 });
      const botLuma = regionLuma(outMp4, 2.0, { x: 0, y: 1020, w: 1080, h: 800 });
      assert.ok(topLuma != null && botLuma != null, 'must extract luma for both halves');
      assert.ok(Math.abs(topLuma - botLuma) > 20,
        'top vs bottom luma must differ by > 20; got top=' + topLuma + ', bot=' + botLuma);

      // render_report must carry split_screen block.
      const reportP = join(work, 'render_report.json');
      assert.ok(existsSync(reportP), 'render_report must exist next to output');
      const report = JSON.parse(readFileSync(reportP, 'utf-8'));
      assert.ok(report.split_screen, 'split_screen telemetry block must exist');
      assert.equal(report.split_screen.windows_count, 1);
      assert.equal(report.split_screen.stack_axis, 'vstack');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('cf-ffmpeg render: 16:9 target with split_screen → 1920x1080 with distinct LEFT vs RIGHT halves',
  { skip: SKIP || false, timeout: 120_000 }, () => {
    const work = tmp();
    try {
      const src = buildDualPanelMp4(work, 4);
      const cropP = join(work, 'crop.json');
      writeFileSync(cropP, JSON.stringify({
        version: 3, source_w: 1920, source_h: 1080,
        target_w: 1080, target_h: 1920,
        mode: 'face', detector: 'synthetic',
        samples: [{
          t_ms: 0,
          split_screen: {
            speakers: [
              { speaker_id: 0, cx: 480,  cy: 540, scale: 1.0 },
              { speaker_id: 1, cx: 1440, cy: 540, scale: 1.0 },
            ],
          },
        }],
        interp: 'linear', fallback_used: false, fallback_reason: null,
      }, null, 2));

      const outMp4 = join(work, 'out.mp4');
      const editP = join(work, 'edit.json');
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'c01', source: src, crop_path: cropP,
        start_ms: 0, end_ms: 3500, quality: 'fast',
        output: outMp4, target_aspect: '16:9',
      }, null, 2));

      const r = spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editP], {
        cwd: PLUGIN_ROOT, encoding: 'utf-8',
      });
      assert.equal(r.status, 0, 'render must succeed; stderr=' + r.stderr);
      const dims = probeDims(outMp4);
      assert.deepEqual(dims, { w: 1920, h: 1080 });

      // LEFT half blue (speaker 0), RIGHT half red (speaker 1).
      const leftLuma  = regionLuma(outMp4, 2.0, { x: 100,  y: 100, w: 800, h: 880 });
      const rightLuma = regionLuma(outMp4, 2.0, { x: 1020, y: 100, w: 800, h: 880 });
      assert.ok(Math.abs(leftLuma - rightLuma) > 20,
        'left vs right luma must differ by > 20; got left=' + leftLuma + ', right=' + rightLuma);

      const reportP = join(work, 'render_report.json');
      const report = JSON.parse(readFileSync(reportP, 'utf-8'));
      assert.equal(report.split_screen.stack_axis, 'hstack');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('schema v2 backward compat: hand-written v2 crop_path (no split_screen) renders unchanged',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src = buildDualPanelMp4(work, 3);
      const cropP = join(work, 'crop.json');
      // v2-shaped: no `version` field at all, all samples single-face.
      writeFileSync(cropP, JSON.stringify({
        source_w: 1920, source_h: 1080,
        target_w: 1080, target_h: 1920,
        mode: 'face', detector: 'synthetic',
        samples: [
          { t_ms: 0,    cx: 960, cy: 540, scale: 1.0, letterbox: false },
          { t_ms: 1000, cx: 960, cy: 540, scale: 1.0, letterbox: false },
        ],
        interp: 'linear',
        fallback_used: false, fallback_reason: null,
      }, null, 2));
      const outMp4 = join(work, 'out.mp4');
      const editP = join(work, 'edit.json');
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'c01', source: src, crop_path: cropP,
        start_ms: 0, end_ms: 2500, quality: 'fast',
        output: outMp4, target_aspect: '9:16',
      }, null, 2));
      const r = spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editP], {
        cwd: PLUGIN_ROOT, encoding: 'utf-8',
      });
      assert.equal(r.status, 0, 'v2 crop_path must render cleanly; stderr=' + r.stderr);
      assert.ok(existsSync(outMp4), 'v2 output must exist');
      const dims = probeDims(outMp4);
      assert.deepEqual(dims, { w: 1080, h: 1920 });
      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      // No split_screen telemetry expected on a v2 crop_path render.
      assert.equal(report.split_screen, null, 'v2 crop_path → split_screen telemetry null');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('identity stability: across a split window, top half (speaker 0) stays BLUE — no mid-window flip',
  { skip: SKIP || false, timeout: 120_000 }, () => {
    const work = tmp();
    try {
      const src = buildDualPanelMp4(work, 5);
      const cropP = join(work, 'crop.json');
      writeFileSync(cropP, JSON.stringify({
        version: 3, source_w: 1920, source_h: 1080,
        target_w: 1080, target_h: 1920, mode: 'face', detector: 'synthetic',
        samples: [{
          t_ms: 0,
          split_screen: {
            speakers: [
              { speaker_id: 0, cx: 480,  cy: 540, scale: 1.0 },
              { speaker_id: 1, cx: 1440, cy: 540, scale: 1.0 },
            ],
          },
        }],
        interp: 'linear',
      }, null, 2));
      const outMp4 = join(work, 'out.mp4');
      const editP = join(work, 'edit.json');
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'c01', source: src, crop_path: cropP,
        start_ms: 0, end_ms: 4500, quality: 'fast',
        output: outMp4, target_aspect: '9:16',
      }, null, 2));
      const r = spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editP], {
        cwd: PLUGIN_ROOT, encoding: 'utf-8',
      });
      assert.equal(r.status, 0, 'render must succeed');
      // Sample at 0.5s, 2.0s, 3.5s — speaker_id 0 (blue) MUST stay TOP.
      const samples = [0.5, 2.0, 3.5];
      const region = { x: 100, y: 200, w: 880, h: 500 };
      const lumas = samples.map((t) => regionLuma(outMp4, t, region));
      const maxDelta = Math.max(...lumas) - Math.min(...lumas);
      assert.ok(maxDelta < 30, 'top-half luma must stay stable (no flip); got deltas ' + lumas.join(','));
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });
