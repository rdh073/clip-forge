// tighten-render.test.mjs — Phase B integration tests for the tighten
// splice path through cf-ffmpeg render. Covers (per docs/PLAN-v0.3.0.md):
//
//   R4a — output duration tolerance (± 50 ms)
//   R4d — codec / dims / audio-stream / 3-frame sha256 distinctness
//   R4e — invariant-violation contract (exit non-zero, exact message format)
//   R4f — frame-MD5 idempotency under CF_RENDER_DETERMINISTIC=1
//   R5  — NDJSON progress emits more than one event per pass
//   R6  — graceful degradation (zero-byte output guard)
//   ADD-1 — skill ordering validator (cuts + broll/transitions/music)
//   ADD-3 — filter graph length warning on > 8192-byte graphs
//   ADD-4 — CF_RENDER_DETERMINISTIC env var honored (cpu encoder + bitexact)
//
// R4c (Whisper re-ASR) lives in tighten-reasr.test.mjs because it gates on
// network access to $CF_WHISPER_URL and is skipped on default checkouts.
//
// All tests synthesize their fixture audio/video via ffmpeg lavfi to keep
// the suite self-contained and runnable on a fresh checkout (no committed
// audio assets needed except for R4c's jfk-speech-10s.mp4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const CF_FFMPEG = resolve(PLUGIN_ROOT, 'bin/cf-ffmpeg');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}
const HAS_FFMPEG  = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing' : !HAS_FFPROBE ? 'ffprobe missing' : null;

// ----- shared fixture builder -----

function buildSineFixture(workDir, label, durS) {
  mkdirSync(workDir, { recursive: true });
  const mp4 = join(workDir, label + '.mp4');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=darkblue:s=1080x1920:r=30:d=${durS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durS}:sample_rate=48000`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', mp4,
  ]);
  if (r.status !== 0) throw new Error('fixture build failed: ' + r.stderr);
  return mp4;
}

// Build a fixture whose video changes color over time so 3-frame sha256
// distinctness assertion has a real signal to check.
function buildAnimatedFixture(workDir, label, durS) {
  mkdirSync(workDir, { recursive: true });
  const mp4 = join(workDir, label + '.mp4');
  // Build segments of distinct colors back-to-back so any frame sample in a
  // different second yields a different hash.
  const segS = durS / 3;
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=red:s=1080x1920:r=30:d=${segS}`,
    '-f', 'lavfi', '-i', `color=c=green:s=1080x1920:r=30:d=${segS}`,
    '-f', 'lavfi', '-i', `color=c=blue:s=1080x1920:r=30:d=${segS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durS}:sample_rate=48000`,
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', mp4,
  ]);
  if (r.status !== 0) throw new Error('animated fixture build failed: ' + r.stderr);
  return mp4;
}

function buildPlan({ sourceDurMs, cuts, basisStartMs = 0 }) {
  // Normalize cuts to canonical shape + compute kept_segments + saved_ms.
  const sortedCuts = [...cuts].sort((a, b) => a.start_ms - b.start_ms);
  const annotated = sortedCuts.map((c) => ({
    start_ms: c.start_ms, end_ms: c.end_ms,
    source_start_ms: basisStartMs + c.start_ms,
    source_end_ms:   basisStartMs + c.end_ms,
    reason: c.reason ?? 'filler_word', word: c.word ?? 'x',
    duration_ms: c.end_ms - c.start_ms, confidence_min: c.confidence_min ?? 0.99,
  }));
  const kept = [];
  let cur = 0;
  for (const c of annotated) {
    if (c.start_ms > cur) {
      kept.push({ start_ms: cur, end_ms: c.start_ms,
                  source_start_ms: basisStartMs + cur,
                  source_end_ms:   basisStartMs + c.start_ms });
    }
    cur = c.end_ms;
  }
  if (cur < sourceDurMs) {
    kept.push({ start_ms: cur, end_ms: sourceDurMs,
                source_start_ms: basisStartMs + cur,
                source_end_ms:   basisStartMs + sourceDurMs });
  }
  const savedMs = annotated.reduce((a, c) => a + c.duration_ms, 0);
  return {
    version: 1, clip_id: 'phB',
    basis_start_ms: basisStartMs, basis_end_ms: basisStartMs + sourceDurMs,
    source_duration_ms: sourceDurMs,
    output_duration_ms: sourceDurMs - savedMs, saved_ms: savedMs,
    cuts: annotated, kept_segments: kept, by_reason: { filler_word: annotated.length },
    settings: { locale: 'en', keep_pause_ms: 120, silence_threshold_db: -30,
                min_silence_ms: 400, min_confidence: 0.85, effective_min_confidence: 0.85,
                max_cut_ms: 600, aggressive: false, no_silence: false, no_fillers: false },
    filler_dict_version: 'en-v1', fallback_used: false, fallback_reason: null, warnings: [],
  };
}

function writeRenderSet({ workDir, planObj, sourceMp4, sourceDurMs, identityCrop = true, overrides = {} }) {
  const planPath = join(workDir, 'plan.json');
  const cropPath = join(workDir, 'crop.json');
  const editPath = join(workDir, 'edit.json');
  const outPath  = join(workDir, 'out.mp4');
  writeFileSync(planPath, JSON.stringify(planObj, null, 2) + '\n');
  writeFileSync(cropPath, JSON.stringify({
    version: 2, source_w: 1080, source_h: 1920,
    target_w: identityCrop ? 1080 : 1080, target_h: identityCrop ? 1920 : 1920,
    samples: [], interp: 'linear', mode: 'center', detector: 'identity',
    fallback_used: false, fallback_reason: null,
  }) + '\n');
  writeFileSync(editPath, JSON.stringify({
    version: 1, clip_id: planObj.clip_id,
    start_ms: 0, end_ms: sourceDurMs,
    source: sourceMp4, crop_path: cropPath, cuts: planPath,
    output: outPath, quality: 'fast',
    ...overrides,
  }) + '\n');
  return { planPath, cropPath, editPath, outPath };
}

function runCfFfmpeg(editPath, env = {}) {
  return spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editPath],
    { encoding: 'utf-8', cwd: PLUGIN_ROOT, env: { ...process.env, ...env } });
}

function ffprobeJson(args) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', ...args], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error('ffprobe: ' + r.stderr);
  return JSON.parse(r.stdout);
}

function audioDurationMs(file) {
  const data = ffprobeJson(['-select_streams', 'a', '-show_entries', 'stream=duration', file]);
  const d = data.streams?.[0]?.duration;
  return d ? Math.round(parseFloat(d) * 1000) : 0;
}

function streamMd5(file, streamSpec) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-i', file, '-map', streamSpec, '-f', 'md5', '-'], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  const m = r.stdout.trim().match(/MD5=([0-9a-f]+)/);
  return m ? m[1] : null;
}

// ============================================================
// R4e — invariant violation contract
// ============================================================

test('R4e: I3 violation → renderer exits non-zero with exact message format',
  { skip: SKIP || false, timeout: 30_000 }, () => {
    const work = join(tmpdir(), 'cf-r4e-' + Date.now());
    try {
      const sourceMp4 = buildSineFixture(work, 'src', 2.0);
      // Hand-craft a plan with I3 violation: kept_segments[] doesn't complement cuts[].
      const bad = {
        version: 1, clip_id: 'r4e',
        basis_start_ms: 0, basis_end_ms: 2000,
        source_duration_ms: 2000,
        output_duration_ms: 1730, saved_ms: 270,
        cuts: [{ start_ms: 500, end_ms: 770, source_start_ms: 500, source_end_ms: 770,
                 reason: 'filler_word', word: 'um', duration_ms: 270, confidence_min: 0.99 }],
        kept_segments: [
          // intentionally wrong: missing the (770, 2000) tail
          { start_ms: 0, end_ms: 500, source_start_ms: 0, source_end_ms: 500 },
        ],
        by_reason: { filler_word: 1 },
        settings: { locale: 'en', keep_pause_ms: 120, silence_threshold_db: -30,
                    min_silence_ms: 400, min_confidence: 0.85, effective_min_confidence: 0.85,
                    max_cut_ms: 600, aggressive: false, no_silence: false, no_fillers: false },
        filler_dict_version: 'en-v1', fallback_used: false, fallback_reason: null, warnings: [],
      };
      const { editPath } = writeRenderSet({
        workDir: work, planObj: bad, sourceMp4, sourceDurMs: 2000,
      });
      const r = runCfFfmpeg(editPath);
      assert.notEqual(r.status, 0, 'renderer must exit non-zero on invariant violation; stdout=' + r.stdout);
      assert.match(r.stderr, /render: invariant violation I3 —/,
        'stderr must contain exact "render: invariant violation I<n> — " message; got: ' + r.stderr);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// R4a — output duration tolerance (formalized; tail-duration.test.mjs
//       covers the same shape at 1s/5s/30s).
// ============================================================

test('R4a: splice output audio duration within ±50ms of (source − saved_ms)',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-r4a-' + Date.now());
    try {
      const sourceMp4 = buildSineFixture(work, 'src', 6.0);
      const planObj = buildPlan({ sourceDurMs: 6000, cuts: [
        { start_ms: 1000, end_ms: 1200, word: 'um' },
        { start_ms: 3000, end_ms: 3300, word: 'you know' },
        { start_ms: 4500, end_ms: 4700, word: 'like' },
      ]});
      const { editPath, outPath } = writeRenderSet({
        workDir: work, planObj, sourceMp4, sourceDurMs: 6000,
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'render must succeed; stderr=' + r.stderr);
      const expected = 6000 - planObj.saved_ms;
      const actual = audioDurationMs(outPath);
      const delta = Math.abs(actual - expected);
      assert.ok(delta <= 50, `audio duration ${actual}ms vs expected ${expected}ms — delta ${delta}ms > 50ms`);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// R4d — codec / dims / audio stream / 3 distinct frame sha256
// ============================================================

test('R4d: splice output is 1080x1920 h264, has audio stream, 3 frames have distinct sha256',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-r4d-' + Date.now());
    try {
      const sourceMp4 = buildAnimatedFixture(work, 'src', 6.0);
      const planObj = buildPlan({ sourceDurMs: 6000, cuts: [
        { start_ms: 1900, end_ms: 2100, word: 'um' }, // straddles red→green boundary
      ]});
      const { editPath, outPath } = writeRenderSet({
        workDir: work, planObj, sourceMp4, sourceDurMs: 6000,
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'render must succeed; stderr=' + r.stderr);

      const probe = ffprobeJson(['-show_streams', outPath]);
      const v = probe.streams.find((s) => s.codec_type === 'video');
      const a = probe.streams.find((s) => s.codec_type === 'audio');
      assert.equal(v?.codec_name, 'h264',  'video codec must be h264');
      assert.equal(v?.width,  1080, 'width must be 1080');
      assert.equal(v?.height, 1920, 'height must be 1920');
      assert.ok(a, 'output must have an audio stream');

      // Sample 3 frames at distinct times in the output (after the splice).
      // Output duration ≈ 5.8s; pick t=0.5s (red), 2.5s (green-ish), 5.0s (blue).
      const hashes = [];
      for (const t of [0.5, 2.5, 5.0]) {
        const png = join(work, 'f-' + t + '.png');
        const fr = spawnSync('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-ss', String(t), '-i', outPath, '-frames:v', '1', png,
        ]);
        assert.equal(fr.status, 0, 'frame extract at t=' + t + ' failed');
        const h = spawnSync('sha256sum', [png], { encoding: 'utf-8' });
        hashes.push(h.stdout.split(/\s+/)[0]);
      }
      assert.equal(new Set(hashes).size, 3, 'all 3 frame hashes must differ; got ' + JSON.stringify(hashes));
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// R4f — frame-MD5 idempotency with CF_RENDER_DETERMINISTIC=1
// ============================================================

test('R4f: same plan + CF_RENDER_DETERMINISTIC=1 → per-stream MD5 matches across two renders',
  { skip: SKIP || false, timeout: 90_000 }, () => {
    const work = join(tmpdir(), 'cf-r4f-' + Date.now());
    try {
      const sourceMp4 = buildSineFixture(work, 'src', 4.0);
      const planObj = buildPlan({ sourceDurMs: 4000, cuts: [
        { start_ms: 1000, end_ms: 1200, word: 'um' },
        { start_ms: 2500, end_ms: 2700, word: 'like' },
      ]});

      const runOnce = (suffix) => {
        const w = join(work, 'run-' + suffix);
        mkdirSync(w, { recursive: true });
        const { editPath, outPath } = writeRenderSet({
          workDir: w, planObj, sourceMp4, sourceDurMs: 4000,
        });
        const r = runCfFfmpeg(editPath, { CF_RENDER_DETERMINISTIC: '1' });
        assert.equal(r.status, 0, 'deterministic render must succeed; stderr=' + r.stderr);
        return outPath;
      };

      const outA = runOnce('a');
      const outB = runOnce('b');
      const vA = streamMd5(outA, '0:v');
      const vB = streamMd5(outB, '0:v');
      const aA = streamMd5(outA, '0:a');
      const aB = streamMd5(outB, '0:a');
      assert.ok(vA && vB && vA === vB, `video stream MD5 must match: A=${vA} B=${vB}`);
      assert.ok(aA && aB && aA === aB, `audio stream MD5 must match: A=${aA} B=${aB}`);

      // Sanity: report should record deterministic=true.
      const reportPath = join(work, 'run-a', 'render_report.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      assert.equal(report.deterministic, true, 'report.deterministic must be true under CF_RENDER_DETERMINISTIC=1');
      assert.equal(report.encoder, 'libx264', 'deterministic mode must force CPU encoder');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// R5 — NDJSON progress emits ≥ 2 events per pass
// ============================================================

test('R5: NDJSON progress emits more than one event per pass on a non-trivial render',
  { skip: SKIP || false, timeout: 90_000 }, () => {
    const work = join(tmpdir(), 'cf-r5-' + Date.now());
    try {
      // Use a longer fixture so ffmpeg has time to emit multiple progress lines.
      const sourceMp4 = buildSineFixture(work, 'src', 30.0);
      const planObj = buildPlan({ sourceDurMs: 30000, cuts: [
        { start_ms: 5000, end_ms: 5200 },
        { start_ms: 15000, end_ms: 15400 },
        { start_ms: 25000, end_ms: 25300 },
      ]});
      const { editPath } = writeRenderSet({
        workDir: work, planObj, sourceMp4, sourceDurMs: 30000,
      });
      // Slow the encoder by setting medium preset for the test (via deterministic mode).
      const r = runCfFfmpeg(editPath, { CF_RENDER_DETERMINISTIC: '1' });
      assert.equal(r.status, 0, 'render must succeed; stderr=' + r.stderr);

      const events = r.stdout.split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      const progressByPass = {};
      for (const e of events) {
        if (e.event === 'progress') {
          progressByPass[e.pass] = (progressByPass[e.pass] || 0) + 1;
        }
      }
      assert.ok(progressByPass.audio >= 2,
        `audio pass must emit ≥ 2 progress events; got ${progressByPass.audio} (events: ` + JSON.stringify(progressByPass) + ')');
      assert.ok(progressByPass['video+mux'] >= 2,
        `video+mux pass must emit ≥ 2 progress events; got ${progressByPass['video+mux']}`);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// ADD-1 — skill ordering validator: cuts + (broll|transitions|music)
// ============================================================

test('ADD-1: edit.json with cuts + broll → renderer exits with exact skill-ordering message',
  { skip: SKIP || false, timeout: 15_000 }, () => {
    const work = join(tmpdir(), 'cf-add1-' + Date.now());
    try {
      const sourceMp4 = buildSineFixture(work, 'src', 2.0);
      const planObj = buildPlan({ sourceDurMs: 2000, cuts: [{ start_ms: 500, end_ms: 700 }] });
      const { editPath } = writeRenderSet({
        workDir: work, planObj, sourceMp4, sourceDurMs: 2000,
        overrides: { broll: './fake/broll.json' },
      });
      const r = runCfFfmpeg(editPath);
      assert.notEqual(r.status, 0, 'renderer must exit non-zero on skill-ordering violation');
      assert.match(r.stderr, /render: skill ordering violation — tighten plan present after broll\/transitions bake/,
        'stderr must match the exact ordering-violation message; got: ' + r.stderr);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// ADD-3 — filter graph length warning at > 8192 bytes
// ============================================================

test('ADD-3: filter graph > 8192 bytes emits filter_graph_length_near_limit warning',
  { skip: SKIP || false, timeout: 90_000 }, () => {
    const work = join(tmpdir(), 'cf-add3-' + Date.now());
    try {
      const sourceMp4 = buildSineFixture(work, 'src', 30.0);
      // Build many tiny cuts to inflate the filter graph length. Each kept segment
      // contributes ~75 bytes to the graph (split + trim + setpts + concat label).
      // ~110 segments yields > 8192 bytes.
      const cuts = [];
      for (let i = 0; i < 110; i++) {
        // 200ms kept + 50ms cut, leaves room within 30000ms.
        const start = 200 + i * 250;
        cuts.push({ start_ms: start, end_ms: start + 50 });
      }
      const planObj = buildPlan({ sourceDurMs: 30000, cuts });
      const { editPath } = writeRenderSet({
        workDir: work, planObj, sourceMp4, sourceDurMs: 30000,
      });
      const r = runCfFfmpeg(editPath);
      // The render may still succeed (graph is over the warn threshold but under
      // ffmpeg's hard limit). The test asserts the WARNING was emitted to stderr.
      assert.match(r.stderr, /filter graph .* bytes, approaching ffmpeg/,
        'stderr must contain filter_graph_length_near_limit warning; got: ' + r.stderr);
      // Also verify the render_report.json contains the warning code, IF the
      // render reached the report-emission stage (it may exit early on huge graph).
      if (r.status === 0) {
        const reportPath = join(work, 'render_report.json');
        if (existsSync(reportPath)) {
          const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
          const codes = (report.warnings || []).map((w) => w.code);
          assert.ok(codes.includes('filter_graph_length_near_limit'),
            'render_report.json warnings must include filter_graph_length_near_limit; got ' + JSON.stringify(codes));
        }
      }
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// ADD-4 — CF_RENDER_DETERMINISTIC env var honored
// ============================================================

test('ADD-4: CF_RENDER_DETERMINISTIC=1 forces CPU encoder + bitexact in argv',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-add4-' + Date.now());
    try {
      const sourceMp4 = buildSineFixture(work, 'src', 3.0);
      const planObj = buildPlan({ sourceDurMs: 3000, cuts: [{ start_ms: 1000, end_ms: 1200 }] });
      const { editPath } = writeRenderSet({
        workDir: work, planObj, sourceMp4, sourceDurMs: 3000,
      });
      // With env set
      const r1 = runCfFfmpeg(editPath, { CF_RENDER_DETERMINISTIC: '1' });
      assert.equal(r1.status, 0, 'deterministic render exit 0');
      const events1 = r1.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; }}).filter(Boolean);
      const plan1 = events1.find((e) => e.event === 'plan');
      assert.equal(plan1?.deterministic, true, 'plan event must record deterministic=true');
      assert.equal(plan1?.encoder, 'libx264', 'plan event must record cpu encoder under deterministic');

      // Without env set
      const r2 = runCfFfmpeg(editPath, { CF_RENDER_DETERMINISTIC: '' });
      assert.equal(r2.status, 0, 'non-deterministic render exit 0');
      const events2 = r2.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; }}).filter(Boolean);
      const plan2 = events2.find((e) => e.event === 'plan');
      assert.equal(plan2?.deterministic, false, 'plan event must record deterministic=false');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// R6 — zero-byte output guard (renders that produce 0 bytes exit 1)
// ============================================================
// Pure zero-byte tests are hard to engineer reliably (ffmpeg almost always
// writes SOMETHING). The negative-path test below uses an unreadable output
// directory; the renderer should die before producing a zero-byte file.

test('R6: render to unwritable output path → renderer exits non-zero, leaves no stub file',
  { skip: SKIP || false, timeout: 30_000 }, () => {
    const work = join(tmpdir(), 'cf-r6-' + Date.now());
    try {
      const sourceMp4 = buildSineFixture(work, 'src', 2.0);
      const planObj = buildPlan({ sourceDurMs: 2000, cuts: [{ start_ms: 500, end_ms: 700 }] });
      // Output path under a non-existent parent that's also unwritable (root-owned).
      const badOut = '/proc/self/cannot-write-here.mp4';
      const { editPath } = writeRenderSet({
        workDir: work, planObj, sourceMp4, sourceDurMs: 2000,
        overrides: { output: badOut },
      });
      const r = runCfFfmpeg(editPath);
      assert.notEqual(r.status, 0, 'render must exit non-zero on unwritable output');
      assert.ok(!existsSync(badOut), 'must not leave a zero-byte stub file at output path');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });
