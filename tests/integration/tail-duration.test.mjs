// tail-duration.test.mjs — regression guard for the AAC tail-truncation bug
// discovered during Phase A R4b. Before the fix, single-pass combined
// video+audio encoding in cf-ffmpeg's planSpliceArgs dropped trailing AAC
// frames when the video stream EOFed slightly before the audio stream,
// truncating output audio by ~150–200 ms. The fix is two-pass: encode the
// audio splice to a temp .m4a first, then encode video + mux with -c:a copy.
//
// This test synthesizes three short fixtures (~1 s, ~5 s, ~30 s) with both
// video + audio streams, builds a 3-cut tighten plan on each, renders via
// cf-ffmpeg, and asserts the output audio duration matches the plan's
// declared output_duration_ms within 30 ms (≈ one AAC frame @ 48 kHz).
//
// Skips cleanly if ffmpeg / ffprobe aren't on PATH (matches repo convention).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}
const HAS_FFMPEG = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing' : !HAS_FFPROBE ? 'ffprobe missing' : null;

function audioDurationMs(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=duration', '-of', 'csv=p=0', file,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error('ffprobe: ' + r.stderr);
  return Math.round(parseFloat(r.stdout.trim()) * 1000);
}

// Synthesize a fixture mp4 of the given source-duration with both video and
// audio. Returns the mp4 path. Caller is responsible for cleanup.
function buildFixture(workDir, label, sourceDurS) {
  mkdirSync(workDir, { recursive: true });
  const mp4 = join(workDir, label + '.mp4');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=size=320x240:rate=30:color=darkgreen:duration=${sourceDurS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sourceDurS}:sample_rate=48000`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', mp4,
  ]);
  if (r.status !== 0) throw new Error('fixture build failed: ' + r.stderr);
  return mp4;
}

// Build a 3-cut plan over [0, sourceDurMs] that cuts 3 short slices.
// Returns { plan: object, expectedOutputMs: number }.
function buildPlan(sourceDurMs) {
  // Cut three 60ms slices spaced evenly.
  const cuts = [
    { start_ms: Math.floor(sourceDurMs * 0.20), end_ms: Math.floor(sourceDurMs * 0.20) + 60 },
    { start_ms: Math.floor(sourceDurMs * 0.50), end_ms: Math.floor(sourceDurMs * 0.50) + 60 },
    { start_ms: Math.floor(sourceDurMs * 0.80), end_ms: Math.floor(sourceDurMs * 0.80) + 60 },
  ].map((c) => ({
    ...c, source_start_ms: c.start_ms, source_end_ms: c.end_ms,
    reason: 'filler_word', word: 'x', duration_ms: c.end_ms - c.start_ms, confidence_min: 0.99,
  }));
  const kept = [];
  let cur = 0;
  for (const c of cuts) {
    kept.push({ start_ms: cur, end_ms: c.start_ms, source_start_ms: cur, source_end_ms: c.start_ms });
    cur = c.end_ms;
  }
  kept.push({ start_ms: cur, end_ms: sourceDurMs, source_start_ms: cur, source_end_ms: sourceDurMs });
  const savedMs = cuts.reduce((a, c) => a + c.duration_ms, 0);
  const outputMs = sourceDurMs - savedMs;
  return {
    expectedOutputMs: outputMs,
    plan: {
      version: 1, clip_id: 'tail-' + sourceDurMs,
      basis_start_ms: 0, basis_end_ms: sourceDurMs,
      source_duration_ms: sourceDurMs, output_duration_ms: outputMs, saved_ms: savedMs,
      cuts, kept_segments: kept,
      by_reason: { filler_word: 3 },
      settings: { locale: 'en', keep_pause_ms: 120, silence_threshold_db: -30,
                  min_silence_ms: 400, min_confidence: 0.85, effective_min_confidence: 0.85,
                  max_cut_ms: 600, aggressive: false, no_silence: false, no_fillers: false },
      filler_dict_version: 'en-v1', fallback_used: false, fallback_reason: null, warnings: [],
    },
  };
}

const TOLERANCE_MS = 30; // ≈ one AAC frame @ 48 kHz

for (const sourceDurS of [1.0, 5.0, 30.0]) {
  test(`tail-duration: source=${sourceDurS}s rendered audio matches expected ±${TOLERANCE_MS}ms`,
    { skip: SKIP || false, timeout: 120_000 }, () => {
      const work = join(tmpdir(), `cf-tail-${Date.now()}-${Math.round(sourceDurS * 1000)}`);
      try {
        const sourceMp4 = buildFixture(work, `src-${sourceDurS}`, sourceDurS);
        const sourceDurMs = Math.round(sourceDurS * 1000);
        const { plan, expectedOutputMs } = buildPlan(sourceDurMs);
        const planPath = join(work, 'plan.json');
        const cropPath = join(work, 'crop.json');
        const editPath = join(work, 'edit.json');
        const outPath  = join(work, 'out.mp4');
        writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
        writeFileSync(cropPath, JSON.stringify({
          version: 2, source_w: 320, source_h: 240, target_w: 320, target_h: 240,
          samples: [], interp: 'linear', mode: 'center', detector: 'identity',
          fallback_used: false, fallback_reason: null,
        }) + '\n');
        writeFileSync(editPath, JSON.stringify({
          version: 1, clip_id: plan.clip_id,
          start_ms: 0, end_ms: sourceDurMs,
          source: sourceMp4, crop_path: cropPath, cuts: planPath,
          output: outPath, quality: 'fast',
        }) + '\n');

        const r = spawnSync('node', [
          resolve(PLUGIN_ROOT, 'bin/cf-ffmpeg'), 'render', '--manifest', editPath,
        ], { encoding: 'utf-8', cwd: PLUGIN_ROOT });
        assert.equal(r.status, 0, 'render exit code 0 expected; got ' + r.status + '\n' + r.stderr);
        assert.ok(existsSync(outPath), 'output mp4 must exist');

        const actualMs = audioDurationMs(outPath);
        const delta = Math.abs(actualMs - expectedOutputMs);
        assert.ok(delta <= TOLERANCE_MS,
          `tail-duration regression: source=${sourceDurS}s expected=${expectedOutputMs}ms ` +
          `actual=${actualMs}ms delta=${delta}ms (tolerance=${TOLERANCE_MS}ms) — ` +
          `the AAC tail-truncation bug may have returned. Two-pass encode in ` +
          `planSpliceArgs is the fix; check that audioTmpPath is being written and ` +
          `that pass 2 uses -c:a copy on input #1.`);
      } finally {
        try { rmSync(work, { recursive: true, force: true }); } catch {}
      }
    });
}
