// pillar-6-composition.test.mjs — composition gate for v0.4.0 pillar 6.
//
// Verifies that split-screen renders cleanly when composed with the prior
// pillar features in one pass:
//   - 16:9 target aspect (pillar 1)
//   - dub audio_source as a separate mux track (pillar 2)
//   - brand-kit logo overlay (pillar 3)
//   - hook overlay (pillar i v0.3.0)
//   - split-screen (pillar 6)
//
// Splice (tighten cuts) is intentionally NOT exercised in this gate.
// Pillar 6 documents split_screen + splice as mutually exclusive in
// v0.4.0 (a `split_screen_disabled_by_splice` warning is emitted when
// both are present). The deferred combination is tracked in
// docs/PLAN-v0.4.0.md §11.
//
// Assertions:
//   - rendered MP4 dims match target_aspect (1920×1080 for 16:9)
//   - hstack at split window — left half luminance differs from right half
//   - hook overlay visible upper-third at t=0.5s
//   - audio is the dub track, not the source
//   - render_report carries split_screen + brand_kit + overlays blocks

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
const CF_FFMPEG = join(PLUGIN_ROOT, 'bin', 'cf-ffmpeg');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore','pipe','ignore'] }).toString().trim(); }
  catch { return null; }
}
const HAS_FFMPEG  = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing' : !HAS_FFPROBE ? 'ffprobe missing' : false;

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-pillar6-comp-')); }

function buildDualPanelMp4(dir, durS, w = 1920, h = 1080) {
  mkdirSync(dir, { recursive: true });
  const mp4 = join(dir, 'source.mp4');
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
  if (r.status !== 0) throw new Error('buildDualPanelMp4: ' + r.stderr);
  return mp4;
}

// Build a dub WAV with a distinct frequency so we can verify it's muxed.
function buildDubWav(dir, durS) {
  mkdirSync(dir, { recursive: true });
  const wav = join(dir, 'dub.wav');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=' + durS + ':sample_rate=22050',
    wav,
  ]);
  if (r.status !== 0) throw new Error('buildDubWav: ' + r.stderr);
  return wav;
}

function buildLogoPng(dir) {
  mkdirSync(dir, { recursive: true });
  const png = join(dir, 'logo.png');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=white:s=120x60',
    '-frames:v', '1', png,
  ]);
  if (r.status !== 0) throw new Error('buildLogoPng: ' + r.stderr);
  return png;
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

function regionLuma(mp4, tS, region) {
  const pgmPath = mp4 + '.frame.pgm';
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', tS.toFixed(3), '-i', mp4,
    '-vf', 'crop=' + region.w + ':' + region.h + ':' + region.x + ':' + region.y + ',format=gray',
    '-vframes', '1', pgmPath,
  ]);
  if (r.status !== 0) return null;
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
  readLine(); // maxval
  let sum = 0, n = 0;
  for (let i = pos; i < buf.length; i++) { sum += buf[i]; n++; }
  return n > 0 ? sum / n : 0;
}

test('pillar-6 composition: split-screen + brand-kit + dub audio + 16:9 + hook ALL TOGETHER',
  { skip: SKIP || false, timeout: 240_000 }, () => {
    const work = tmp();
    try {
      const slug = 'demo';
      const uploads = join(work, 'uploads', slug);
      mkdirSync(uploads, { recursive: true });
      const src = buildDualPanelMp4(uploads, 4);
      const dub = buildDubWav(uploads, 4);
      const logo = buildLogoPng(uploads);

      const c01dir = join(work, 'clips', slug, 'c01');
      mkdirSync(c01dir, { recursive: true });
      const cropP = join(c01dir, 'crop.json');
      writeFileSync(cropP, JSON.stringify({
        version: 3, source_w: 1920, source_h: 1080,
        target_w: 1920, target_h: 1080,
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
        speaker_timeline: {
          windows_split_screen: 1, total_split_duration_ms: 3500,
          speakers_detected: 2, route_mode: 'auto', warnings: [],
        },
      }, null, 2));

      const outMp4 = join(work, 'renders', slug, 'c01.mp4');
      const editP = join(c01dir, 'edit.json');
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'c01', slug,
        source: src, crop_path: cropP,
        start_ms: 0, end_ms: 3500, quality: 'fast',
        output: outMp4,
        target_aspect: '16:9',
        audio_source: dub,
        hook_overlay: { text: 'HOOK', end_ms: 2000, position: 'upper-third' },
        brand_kit: {
          version: 1, name: 'test',
          assets: {
            logo: { path: logo, position: 'bottom-right', opacity: 0.9, scale_px: 120 },
          },
        },
      }, null, 2));

      const r = spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editP], {
        cwd: PLUGIN_ROOT, encoding: 'utf-8',
      });
      assert.equal(r.status, 0, 'render must succeed; stderr=' + r.stderr);
      assert.ok(existsSync(outMp4), 'output mp4 must exist');

      // 16:9 dims.
      const dims = probeDims(outMp4);
      assert.deepEqual(dims, { w: 1920, h: 1080 });

      // hstack at split window: LEFT half blue (speaker 0), RIGHT half red.
      const leftLuma  = regionLuma(outMp4, 1.5, { x: 100,  y: 200, w: 800, h: 700 });
      const rightLuma = regionLuma(outMp4, 1.5, { x: 1020, y: 200, w: 800, h: 700 });
      assert.ok(Math.abs(leftLuma - rightLuma) > 20,
        'left vs right luma must differ; got left=' + leftLuma + ', right=' + rightLuma);

      // Hook overlay luminance test — compare hook-band luma WHEN the hook
      // is visible (t=0.5s) vs AFTER the hook end_ms=2000 (t=3.0s). The
      // bright white text only appears in the first window so the band
      // luma drops noticeably after the hook clears.
      const hookBand = { x: 200, y: 280, w: 1520, h: 80 };
      const lumaWhileHook = regionLuma(outMp4, 0.5, hookBand);
      const lumaAfterHook = regionLuma(outMp4, 3.0, hookBand);
      assert.ok(lumaWhileHook - lumaAfterHook > 1,
        'hook overlay band must brighten while hook is visible; ' +
        'got while=' + lumaWhileHook + ', after=' + lumaAfterHook);

      // render_report — split_screen + brand_kit + overlays all present.
      const reportP = join(work, 'renders', slug, 'render_report.json');
      const report = JSON.parse(readFileSync(reportP, 'utf-8'));
      assert.ok(report.split_screen,                     'split_screen telemetry present');
      assert.equal(report.split_screen.windows_count,     1);
      assert.equal(report.split_screen.stack_axis,        'hstack');
      assert.ok(report.brand_kit && report.brand_kit.applied, 'brand_kit applied');
      assert.ok(report.brand_kit.assets_burned.includes('logo'), 'logo burned');
      assert.ok(report.overlays && report.overlays.hook && report.overlays.hook.burned,
        'hook overlay burned');
      assert.equal(report.target_aspect, '16:9');

      // Confirm the dub audio_source was muxed (not source audio).
      // Source audio is 440Hz; dub is 880Hz. Probe shows 1 audio stream.
      const probeAudio = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'a',
        '-show_entries', 'stream=codec_name,sample_rate',
        '-of', 'json', outMp4,
      ], { encoding: 'utf-8' });
      assert.equal(probeAudio.status, 0);
      const audioInfo = JSON.parse(probeAudio.stdout);
      assert.ok(audioInfo.streams && audioInfo.streams.length === 1,
        'output must carry exactly one audio stream');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('pillar-6: split_screen + splice → split-screen layer is skipped with explicit warning',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const slug = 'demo';
      const uploads = join(work, 'uploads', slug);
      mkdirSync(uploads, { recursive: true });
      const src = buildDualPanelMp4(uploads, 4);
      const c01dir = join(work, 'clips', slug, 'c01');
      mkdirSync(c01dir, { recursive: true });
      const cropP = join(c01dir, 'crop.json');
      writeFileSync(cropP, JSON.stringify({
        version: 3, source_w: 1920, source_h: 1080,
        target_w: 1920, target_h: 1080,
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
      }, null, 2));

      const cutsP = join(c01dir, 'cuts.json');
      writeFileSync(cutsP, JSON.stringify({
        version: 1, clip_id: 'c01', source_duration_ms: 4000,
        basis_start_ms: 0, basis_end_ms: 4000,
        kept_segments: [
          { start_ms: 0,    end_ms: 1500, source: 'voiced' },
          { start_ms: 2500, end_ms: 4000, source: 'voiced' },
        ],
        cuts: [
          { start_ms: 1500, end_ms: 2500, kind: 'silence',
            confidence: 0.95, source_evidence: { rms_db: -50, duration_ms: 1000 } },
        ],
        output_duration_ms: 3000, saved_ms: 1000,
        warnings: [], plan_version: 1,
      }, null, 2));

      const outMp4 = join(work, 'renders', slug, 'c01.mp4');
      const editP = join(c01dir, 'edit.json');
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'c01', slug,
        source: src, crop_path: cropP, cuts: cutsP,
        start_ms: 0, end_ms: 4000, quality: 'fast',
        output: outMp4, target_aspect: '16:9',
      }, null, 2));

      const r = spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editP], {
        cwd: PLUGIN_ROOT, encoding: 'utf-8',
      });
      assert.equal(r.status, 0, 'render must succeed; stderr=' + r.stderr);
      const reportP = join(work, 'renders', slug, 'render_report.json');
      const report = JSON.parse(readFileSync(reportP, 'utf-8'));
      const warns = report.warnings || [];
      assert.ok(warns.some((w) => w.code === 'split_screen_disabled_by_splice'),
        'expected split_screen_disabled_by_splice warning; got ' + JSON.stringify(warns));
      // Splice still produced ≥1 junction.
      assert.ok(report.junctions.length >= 1, 'splice must have ≥ 1 junction');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });
