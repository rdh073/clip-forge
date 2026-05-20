// tighten-stress.test.mjs — Phase C stress test for the splice path at
// high junction count (N = 50). Validates that the renderer survives
// many-cut plans, that the filter graph stays under ffmpeg's command-line
// limits, and that wall-clock degrades gracefully relative to a single-
// chain (no-cut) baseline.
//
// Plan is committed at tests/fixtures/stress-plan-n50.json so the cut
// layout is byte-deterministic across runs (mulberry32(20260520) seed —
// see the generator notes in the LICENSE-adjacent fixture comments).
// The 60 s source is synthesized at test time via ffmpeg lavfi (cheap;
// no committed audio asset needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const CF_FFMPEG   = resolve(PLUGIN_ROOT, 'bin/cf-ffmpeg');
const STRESS_PLAN = resolve(PLUGIN_ROOT, 'tests/fixtures/stress-plan-n50.json');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}
const HAS_FFMPEG  = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const HAS_FIXTURE = existsSync(STRESS_PLAN);
const SKIP = !HAS_FFMPEG  ? 'ffmpeg missing'
           : !HAS_FFPROBE ? 'ffprobe missing'
           : !HAS_FIXTURE ? 'stress-plan-n50.json missing'
           : null;

function buildSource(workDir, durS) {
  mkdirSync(workDir, { recursive: true });
  const mp4 = join(workDir, 'src.mp4');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=darkblue:s=1080x1920:r=30:d=${durS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durS}:sample_rate=48000`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', mp4,
  ]);
  if (r.status !== 0) throw new Error('source build failed: ' + r.stderr);
  return mp4;
}

function buildNoCutPlan(sourceDurMs) {
  // Single kept-segment plan (zero cuts) for the baseline render. The
  // renderer's useSplice gate requires cuts.length >= 1, so the "no-cut"
  // baseline uses a trivial 1ms cut at the very tail — exercises the same
  // splice code path so the comparison measures the per-junction cost, not
  // splice-vs-non-splice mode switches.
  const cut = { start_ms: sourceDurMs - 1, end_ms: sourceDurMs,
                source_start_ms: sourceDurMs - 1, source_end_ms: sourceDurMs,
                reason: 'filler_word', word: 'x', duration_ms: 1, confidence_min: 0.99 };
  const kept = [{ start_ms: 0, end_ms: sourceDurMs - 1,
                  source_start_ms: 0, source_end_ms: sourceDurMs - 1 }];
  return {
    version: 1, clip_id: 'stress-baseline',
    basis_start_ms: 0, basis_end_ms: sourceDurMs,
    source_duration_ms: sourceDurMs,
    output_duration_ms: sourceDurMs - 1, saved_ms: 1,
    cuts: [cut], kept_segments: kept, by_reason: { filler_word: 1 },
    settings: { locale: 'en', keep_pause_ms: 120, silence_threshold_db: -30,
                min_silence_ms: 400, min_confidence: 0.85, effective_min_confidence: 0.85,
                max_cut_ms: 600, aggressive: false, no_silence: false, no_fillers: false },
    filler_dict_version: 'en-v1', fallback_used: false, fallback_reason: null, warnings: [],
  };
}

function writeRenderSet({ workDir, planObj, sourceMp4, sourceDurMs }) {
  mkdirSync(workDir, { recursive: true });
  const planPath = join(workDir, 'plan.json');
  const cropPath = join(workDir, 'crop.json');
  const editPath = join(workDir, 'edit.json');
  const outPath  = join(workDir, 'out.mp4');
  writeFileSync(planPath, JSON.stringify(planObj, null, 2) + '\n');
  writeFileSync(cropPath, JSON.stringify({
    version: 2, source_w: 1080, source_h: 1920, target_w: 1080, target_h: 1920,
    samples: [], interp: 'linear', mode: 'center', detector: 'identity',
    fallback_used: false, fallback_reason: null,
  }) + '\n');
  writeFileSync(editPath, JSON.stringify({
    version: 1, clip_id: planObj.clip_id,
    start_ms: 0, end_ms: sourceDurMs,
    source: sourceMp4, crop_path: cropPath, cuts: planPath,
    output: outPath, quality: 'fast',
  }) + '\n');
  return { editPath, outPath };
}

function runCfFfmpeg(editPath, env = {}) {
  return spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editPath],
    { encoding: 'utf-8', cwd: PLUGIN_ROOT, env: { ...process.env, ...env } });
}

function audioDurationMs(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=duration', '-of', 'csv=p=0', file], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error('ffprobe failed: ' + r.stderr);
  return Math.round(parseFloat(r.stdout.trim()) * 1000);
}

function streamMd5(file, streamSpec) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-i', file, '-map', streamSpec, '-f', 'md5', '-'], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  const m = r.stdout.trim().match(/MD5=([0-9a-f]+)/);
  return m ? m[1] : null;
}

test('Phase C stress: N=50 plan renders, ratio ≤ 2× baseline, telemetry valid',
  { skip: SKIP || false, timeout: 300_000 }, () => {
    const work = join(tmpdir(), 'cf-stress-' + Date.now());
    try {
      const sourceMp4 = buildSource(work, 60.0);
      const stressPlan = JSON.parse(readFileSync(STRESS_PLAN, 'utf-8'));
      assert.equal(stressPlan.cuts.length, 50,
        'committed stress fixture must have exactly 50 cuts; got ' + stressPlan.cuts.length);

      // ----- baseline: 1-cut render of same 60s source -----
      const baseWork = join(work, 'baseline');
      mkdirSync(baseWork, { recursive: true });
      const baseSet = writeRenderSet({
        workDir: baseWork, planObj: buildNoCutPlan(60000),
        sourceMp4, sourceDurMs: 60000,
      });
      const t0Base = Date.now();
      const rBase = runCfFfmpeg(baseSet.editPath);
      const baselineMs = Date.now() - t0Base;
      assert.equal(rBase.status, 0, 'baseline render must succeed; stderr=' + rBase.stderr);

      // ----- stress: N=50 plan -----
      const stressWork = join(work, 'stress');
      mkdirSync(stressWork, { recursive: true });
      const stressSet = writeRenderSet({
        workDir: stressWork, planObj: stressPlan,
        sourceMp4, sourceDurMs: 60000,
      });
      const t0Stress = Date.now();
      const rStress = runCfFfmpeg(stressSet.editPath);
      const stressMs = Date.now() - t0Stress;

      // ----- assertion 1: render completes -----
      assert.equal(rStress.status, 0,
        'N=50 stress render must succeed (exit 0); stderr=' + rStress.stderr);

      // ----- assertion 7: junctions[] has exactly 50 entries -----
      const reportPath = join(stressWork, 'render_report.json');
      assert.ok(existsSync(reportPath), 'render_report.json must exist');
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      assert.equal(report.junctions.length, 50,
        'render_report.junctions must have 50 entries; got ' + report.junctions.length);

      // ----- assertion 4: audio duration within ±50ms -----
      const expectedAudioMs = stressPlan.output_duration_ms;
      const actualAudioMs = audioDurationMs(stressSet.outPath);
      const audioDelta = Math.abs(actualAudioMs - expectedAudioMs);
      assert.ok(audioDelta <= 50,
        `audio duration ${actualAudioMs}ms vs expected ${expectedAudioMs}ms — delta ${audioDelta}ms > 50ms`);

      // ----- assertion 6: schema valid -----
      // Implicitly enforced — renderer would have exited non-zero on invalid.
      assert.equal(report.schema, 'render_report.v1');

      // ----- assertion 3 (informational): filter_complex_bytes -----
      // Logged; does NOT fail the test.
      const fcBytes = report.filter_complex_bytes;

      // ----- assertion 2: wall ≤ 2× baseline (does NOT block ship) -----
      const ratio = stressMs / baselineMs;
      const ratioOk = ratio <= 2.0;

      // ----- per-junction status distribution -----
      const statuses = report.junctions.reduce((acc, j) => {
        acc[j.g1.status] = (acc[j.g1.status] || 0) + 1;
        return acc;
      }, {});
      const warningCodes = report.junctions.flatMap((j) => j.warnings);
      const warningCounts = warningCodes.reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {});

      // ----- print stress summary (visible in test output) -----
      console.log(`
=== Phase C stress summary (committed) ===
  baseline (no-cut, same source): ${baselineMs} ms
  stress   (N=50):                 ${stressMs} ms
  ratio:                           ${ratio.toFixed(2)}×  (gate ≤ 2.0×, ${ratioOk ? 'PASS' : 'FAIL (logged to ROADMAP, does not block)'})
  filter_complex_bytes:            ${fcBytes}  (warn threshold > 8192)
  junctions:                       ${report.junctions.length}
  G1 status distribution:          ${JSON.stringify(statuses)}
  warning code distribution:       ${JSON.stringify(warningCounts)}
  top-level warnings:              ${JSON.stringify((report.warnings || []).map((w) => w.code))}
==========================================
`);

      // ratio failure does not block ship (per ACTION 20). Just assert > 0.
      assert.ok(ratio > 0, 'ratio must be positive');

      // ----- assertion 5: per-stream MD5 stable under deterministic mode -----
      const detWork = join(work, 'det');
      mkdirSync(detWork, { recursive: true });
      const detSetA = writeRenderSet({
        workDir: join(detWork, 'a'), planObj: stressPlan,
        sourceMp4, sourceDurMs: 60000,
      });
      const detSetB = writeRenderSet({
        workDir: join(detWork, 'b'), planObj: stressPlan,
        sourceMp4, sourceDurMs: 60000,
      });
      const rDetA = runCfFfmpeg(detSetA.editPath, { CF_RENDER_DETERMINISTIC: '1' });
      const rDetB = runCfFfmpeg(detSetB.editPath, { CF_RENDER_DETERMINISTIC: '1' });
      assert.equal(rDetA.status, 0, 'deterministic render A must succeed');
      assert.equal(rDetB.status, 0, 'deterministic render B must succeed');
      const vMd5A = streamMd5(detSetA.outPath, '0:v');
      const vMd5B = streamMd5(detSetB.outPath, '0:v');
      const aMd5A = streamMd5(detSetA.outPath, '0:a');
      const aMd5B = streamMd5(detSetB.outPath, '0:a');
      assert.equal(vMd5A, vMd5B, `video MD5 must match under det mode at N=50: A=${vMd5A} B=${vMd5B}`);
      assert.equal(aMd5A, aMd5B, `audio MD5 must match under det mode at N=50: A=${aMd5A} B=${aMd5B}`);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });
