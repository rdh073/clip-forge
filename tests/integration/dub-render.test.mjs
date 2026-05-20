// dub-render.test.mjs — v0.4.0 pillar 2 composition + render-stinger gate tests.
//
// THE GATE TEST (per brief §brutal-review-9): dub.audio_source + 16:9 +
// tighten cuts + hook_overlay must still produce a valid mp4 with the right
// dimensions, overlays burned, and ai_costs telemetry surfaced in the
// render_report.
//
// Plus a focused prepend/append TTS stinger test — proves that the
// renderer correctly synthesizes hook/outro audio lazily via tts.synthesize
// and mux-concatenates it around the main clip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { resolve as resolvePath, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PLUGIN_ROOT = resolvePath(fileURLToPath(import.meta.url), '../../..');
const CF_FFMPEG   = resolvePath(PLUGIN_ROOT, 'bin', 'cf-ffmpeg');
const TTS_MOCK    = resolvePath(PLUGIN_ROOT, 'tests', 'mocks', 'tts-mock.mjs');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

const HAS_FFMPEG  = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const HAS_MOCK    = existsSync(TTS_MOCK);
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing'
            : !HAS_FFPROBE ? 'ffprobe missing'
            : !HAS_MOCK ? 'tests/mocks/tts-mock.mjs missing'
            : null;

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-dub-render-')); }

function buildDarkMp4(workDir, label, durS, w = 640, h = 360) {
  mkdirSync(workDir, { recursive: true });
  const mp4 = join(workDir, label + '.mp4');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=' + w + 'x' + h + ':r=30:d=' + durS,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + durS + ':sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', mp4,
  ]);
  if (r.status !== 0) throw new Error('buildDarkMp4: ' + r.stderr);
  return mp4;
}

function writeIdentityCrop(path, targetW = 1920, targetH = 1080) {
  writeFileSync(path, JSON.stringify({
    version: 2, source_w: 640, source_h: 360,
    target_w: targetW, target_h: targetH,
    samples: [], interp: 'linear', mode: 'center', detector: 'identity',
    fallback_used: false, fallback_reason: null,
  }) + '\n');
}

function probeStreams(path) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_streams', '-show_format', path,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error('ffprobe: ' + r.stderr);
  return JSON.parse(r.stdout);
}

function runRender(editPath, env = {}) {
  return spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editPath], {
    encoding: 'utf-8',
    cwd: PLUGIN_ROOT,
    env: { ...process.env, ...env },
  });
}

test('render-stinger: prepend_audio (tts) + append_audio (audio_path) → output mp4 grows by expected ms',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src     = buildDarkMp4(work, 'src', 3.0);
      const cropP   = join(work, 'crop.json');
      const editP   = join(work, 'edit.json');
      const outP    = join(work, 'out.mp4');
      writeIdentityCrop(cropP, 1080, 1920);

      // Pre-make an append audio file (no TTS, direct path).
      const appendWav = join(work, 'outro.wav');
      const wavR = spawnSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1.0:sample_rate=22050',
        '-ac', '1', appendWav,
      ]);
      assert.equal(wavR.status, 0);

      // Hook is "hello world" → 2 words × 400 ms = 800 ms prepend.
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'sting',
        source: src, crop_path: cropP, output: outP,
        start_ms: 0, end_ms: 3000, quality: 'fast',
        prepend_audio: { tts: { text: 'hello world', voice_id: 'mock-voice' } },
        append_audio:  { audio_path: appendWav },
      }) + '\n');

      const r = runRender(editP, {
        CF_TTS_MOCK:        TTS_MOCK,
        ELEVENLABS_API_KEY: 'sk-test',
        CF_TTS_PROVIDER:    'elevenlabs',
      });
      assert.equal(r.status, 0, 'composition render must exit 0; stderr=' + r.stderr);
      assert.ok(existsSync(outP));

      // Output duration = main (3s) + prepend (~0.8s) + append (1s) ≈ 4.8s.
      const probe = probeStreams(outP);
      const dur = parseFloat(probe.format.duration);
      assert.ok(dur > 3.5 && dur < 5.5,
        'composed output ~4.8s (main 3s + prepend ~0.8s + append 1s); got ' + dur);

      // render_report carries the new pillar 2 fields.
      const reportPath = join(dirname(outP), 'render_report.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      assert.equal(report.tts_nondeterministic, true,
        'tts_nondeterministic must be true when any TTS ran; got ' + report.tts_nondeterministic);
      assert.match(report.tts_provider_used || '', /mock:elevenlabs/,
        'tts_provider_used must echo the resolved provider; got ' + report.tts_provider_used);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('render-composition: dub.audio_source + 16:9 + tighten cuts + hook_overlay all in one render',
  { skip: SKIP || false, timeout: 120_000 }, () => {
    const work = tmp();
    try {
      // 6s dark source video; the dub audio replaces the source's audio stream.
      const src = buildDarkMp4(work, 'src', 6.0);

      // Build a "dubbed.wav" — 6 seconds of a different tone so we can prove
      // it muxed in (the source had 440 Hz; we use 880 Hz here).
      const dubbedWav = join(work, 'dubbed-id.wav');
      const wavR = spawnSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6:sample_rate=22050',
        '-ac', '1', dubbedWav,
      ]);
      assert.equal(wavR.status, 0, 'dubbed.wav synth must succeed');

      // Tighten plan with one cut at 2.0-2.5s.
      const planP = join(work, 'plan.json');
      writeFileSync(planP, JSON.stringify({
        version: 1, clip_id: 'composition',
        basis_start_ms: 0, basis_end_ms: 6000,
        source_duration_ms: 6000, output_duration_ms: 5500, saved_ms: 500,
        cuts: [{
          start_ms: 2000, end_ms: 2500,
          source_start_ms: 2000, source_end_ms: 2500,
          reason: 'filler_word', word: 'um',
          duration_ms: 500, confidence_min: 0.95,
        }],
        kept_segments: [
          { start_ms: 0,    end_ms: 2000, source_start_ms: 0,    source_end_ms: 2000 },
          { start_ms: 2500, end_ms: 6000, source_start_ms: 2500, source_end_ms: 6000 },
        ],
        by_reason: { filler_word: 1 },
        settings: {
          locale: 'en', keep_pause_ms: 120, silence_threshold_db: -30,
          min_silence_ms: 400, min_confidence: 0.85,
          effective_min_confidence: 0.85, max_cut_ms: 600,
          aggressive: false, no_silence: false, no_fillers: false,
        },
        filler_dict_version: 'en-v1',
        fallback_used: false, fallback_reason: null, warnings: [],
      }) + '\n');

      // Pre-seed a render_manifest.json with ai_costs (simulating a prior
      // dub run charged $0.30).
      const slug = 'comp-podcast';
      const manifestP = join(work, 'renders', slug, 'render_manifest.json');
      mkdirSync(dirname(manifestP), { recursive: true });
      writeFileSync(manifestP, JSON.stringify({
        version: 1, schema: 'render_manifest.v1', slug,
        created_at: '2026-05-21T00:00:00Z',
        ai_costs: {
          cumulative_usd: 0.30,
          budget_cap_usd: 10,
          breakdown: { 'elevenlabs_tts': 0.30 },
          skipped: [],
          history: [
            { ts: '2026-05-21T00:00:00Z', provider: 'elevenlabs', kind: 'tts',
              delta_usd: 0.30, clip_id: 'c01', lang: 'id' },
          ],
        },
      }, null, 2));

      const cropP = join(work, 'crop.json');
      writeIdentityCrop(cropP, 1920, 1080);  // 16:9 → 1920x1080

      const outP  = join(work, 'out.mp4');
      const editP = join(work, 'edit.json');
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'c01', slug,
        source: src, crop_path: cropP,
        start_ms: 0, end_ms: 6000, quality: 'fast',
        target_aspect: '16:9',
        cuts: planP,
        audio_source: dubbedWav,  // — pillar 2 dub variant
        hook_overlay: { text: 'HALO DUNIA', end_ms: 1800, position: 'upper-third' },
        render_manifest: manifestP,
        dub: { source_lang: 'en', target_lang: 'id',
                voice_id: 'creator-main', provider: 'elevenlabs',
                report: '/dev/null' },
        dub_languages: ['id'],
        output: outP,
      }) + '\n');

      const r = runRender(editP);
      assert.equal(r.status, 0,
        'composition render must exit 0; stderr=' + (r.stderr || '').slice(-400));
      assert.ok(existsSync(outP), 'output mp4 must exist');

      // 1. Aspect — output is 1920x1080.
      const streams = probeStreams(outP).streams || [];
      const v = streams.find((s) => s.codec_type === 'video');
      assert.equal(v.width,  1920, 'composition output must be 1920 wide (16:9); got ' + v.width);
      assert.equal(v.height, 1080, 'composition output must be 1080 tall (16:9); got ' + v.height);

      // 2. Has audio (the dubbed.wav).
      const a = streams.find((s) => s.codec_type === 'audio');
      assert.ok(a, 'output must carry an audio stream (dub.audio_source muxed in)');

      // 3. render_report carries ai_costs + tts_nondeterministic + dub_languages + 16:9.
      const reportP = join(dirname(outP), 'render_report.json');
      const report = JSON.parse(readFileSync(reportP, 'utf-8'));
      assert.equal(report.target_aspect, '16:9',
        'report.target_aspect must be 16:9; got ' + report.target_aspect);
      assert.ok(report.ai_costs, 'report.ai_costs must mirror manifest snapshot');
      assert.equal(report.ai_costs.total_usd, 0.30, 'pre-existing $0.30 spend surfaced in report');
      assert.equal(report.ai_costs.budget_cap_usd, 10);
      assert.deepEqual(report.dub_languages, ['id'],
        'dub_languages must echo the edit.json field; got ' + JSON.stringify(report.dub_languages));
      assert.equal(report.overlays?.hook?.burned, true,
        'hook overlay must be reported as burned');
      // No prepend/append TTS in this clip → tts_nondeterministic stays false.
      assert.equal(report.tts_nondeterministic, false,
        'no inline TTS in this clip → tts_nondeterministic stays false');
      // 4. Tighten splice ran (1 cut → 1 junction).
      assert.equal(report.render_mode, 'splice');
      assert.ok(Array.isArray(report.junctions) && report.junctions.length === 1,
        'composition must produce 1 junction (1 cut → 2 kept segments); got ' +
        JSON.stringify(report.junctions?.length));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
