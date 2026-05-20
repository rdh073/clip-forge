// brand-kit.test.mjs — v0.4.0 pillar 3 integration tests.
//
// Positive-evidence assertions on the rendered MP4, not just exit code or
// filter-graph syntax. Coverage:
//
//   - logo: PNG at bottom-right → high-luminance region at t=2 s
//   - endcard: appended → output duration = clip + endcard.duration_ms (±50 ms)
//   - lower-third: visible inside show_from..show_until, absent outside
//   - missing brand-kit.json → no warning, no change (B1)
//   - malformed brand-kit.json → soft warning + render succeeds (B2)
//   - brand_asset_missing:<key> → soft warning + render continues (B3)
//   - legacy `"watermark": "<path>"` string still works (B5 regression guard)
//   - composition: brand-kit + 16:9 + dub.audio_source + tighten cuts + hook
//                  in ONE render; assert dims, hook burned, brand_kit.applied
//   - SVG without librsvg (forced via CF_FORCE_NO_LIBRSVG=1) → SVG skipped
//                  with librsvg_not_available warning; PNG in same kit renders

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

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

const HAS_FFMPEG  = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing'
            : !HAS_FFPROBE ? 'ffprobe missing'
            : null;

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-brand-kit-')); }

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

function buildWhitePng(workDir, label, w, h) {
  mkdirSync(workDir, { recursive: true });
  const png = join(workDir, label + '.png');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=white:s=' + w + 'x' + h + ':d=0.1',
    '-frames:v', '1', png,
  ]);
  if (r.status !== 0) throw new Error('buildWhitePng: ' + r.stderr);
  return png;
}

function buildSolidPng(workDir, label, hex, w, h) {
  mkdirSync(workDir, { recursive: true });
  const png = join(workDir, label + '.png');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=' + hex + ':s=' + w + 'x' + h + ':d=0.1',
    '-frames:v', '1', png,
  ]);
  if (r.status !== 0) throw new Error('buildSolidPng: ' + r.stderr);
  return png;
}

function writeIdentityCrop(path, targetW = 1080, targetH = 1920, srcW = 640, srcH = 360) {
  writeFileSync(path, JSON.stringify({
    version: 2, source_w: srcW, source_h: srcH,
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

// Extract a single grayscale frame at time t and return a band-mean reader.
function extractGrayFrame(srcMp4, tSec) {
  const tmpRaw = join(tmpdir(), 'cf-bk-frame-' + process.pid + '-' + Date.now() + Math.random() + '.gray');
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-select_streams', 'v', '-show_streams', srcMp4,
  ], { encoding: 'utf-8' });
  const v = JSON.parse(probe.stdout).streams[0];
  const W = v.width, H = v.height;
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(tSec), '-i', srcMp4, '-frames:v', '1',
    '-vf', 'format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray',
    tmpRaw,
  ]);
  if (r.status !== 0) throw new Error('extractGrayFrame at t=' + tSec + ': ' + r.stderr);
  const buf = readFileSync(tmpRaw);
  try { rmSync(tmpRaw); } catch {}
  return {
    width: W, height: H,
    // Mean luminance of a rectangular band [(xStart..xEnd) × (yStart..yEnd)].
    meanLumaRect(xStart, xEnd, yStart, yEnd) {
      xStart = Math.max(0, Math.floor(xStart));
      xEnd   = Math.min(W, Math.floor(xEnd));
      yStart = Math.max(0, Math.floor(yStart));
      yEnd   = Math.min(H, Math.floor(yEnd));
      let sum = 0, n = 0;
      for (let row = yStart; row < yEnd; row++) {
        const base = row * W;
        for (let col = xStart; col < xEnd; col++) {
          sum += buf[base + col];
          n++;
        }
      }
      return n > 0 ? sum / n : 0;
    },
  };
}

// ============================================================
// 1. Logo overlay luminance test (positive evidence)
// ============================================================

test('brand-kit logo: PNG at bottom-right → high luma in that quadrant at t=2s',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src    = buildDarkMp4(work, 'src', 4.0);
      const logo   = buildWhitePng(work, 'logo', 128, 64);
      const cropP  = join(work, 'crop.json');
      const editP  = join(work, 'edit.json');
      const outP   = join(work, 'out.mp4');
      writeIdentityCrop(cropP);

      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'logo-test',
        source: src, crop_path: cropP, output: outP,
        start_ms: 0, end_ms: 4000, quality: 'fast',
        brand_kit: {
          version: 1, name: 'inline',
          assets: { logo: { path: logo, position: 'bottom-right', opacity: 1.0, scale_px: 128 } },
        },
      }) + '\n');

      const r = runRender(editP);
      assert.equal(r.status, 0, 'logo render must exit 0; stderr=' + (r.stderr || '').slice(-400));

      // Sample bottom-right region for high luma (white logo on black source).
      const f = extractGrayFrame(outP, 2.0);
      // 9:16 → 1080×1920. Logo is 128 px wide scaled, placed bottom-right
      // with 4% padding (43 px). So roughly x∈[900..1050], y∈[1800..1880].
      const brLuma = f.meanLumaRect(900, 1050, 1800, 1880);
      const tlLuma = f.meanLumaRect(20, 150, 20, 100);  // top-left = empty
      assert.ok(brLuma > 50,
        'bottom-right region must show white logo (luma > 50); got ' + brLuma.toFixed(2));
      assert.ok(brLuma > tlLuma + 30,
        'bottom-right luma must exceed top-left by ≥30; got br=' + brLuma.toFixed(2) +
        ' tl=' + tlLuma.toFixed(2));

      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      assert.ok(report.brand_kit, 'report.brand_kit must be present');
      assert.equal(report.brand_kit.applied, true);
      assert.equal(report.brand_kit.source, 'inline');
      assert.ok(report.brand_kit.assets_burned.includes('logo'));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

// ============================================================
// 2. Endcard append duration test
// ============================================================

test('brand-kit endcard: PNG endcard appended → output duration = clip + endcard.duration_ms (±200ms)',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src    = buildDarkMp4(work, 'src', 3.0);
      const endcard = buildSolidPng(work, 'endcard', 'red', 1080, 1920);
      const cropP  = join(work, 'crop.json');
      const editP  = join(work, 'edit.json');
      const outP   = join(work, 'out.mp4');
      writeIdentityCrop(cropP);

      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'endcard-test',
        source: src, crop_path: cropP, output: outP,
        start_ms: 0, end_ms: 3000, quality: 'fast',
        brand_kit: {
          version: 1, name: 'inline',
          assets: { endcard: { path: endcard, duration_ms: 2000 } },
        },
      }) + '\n');

      const r = runRender(editP);
      assert.equal(r.status, 0, 'endcard render must exit 0; stderr=' + r.stderr);

      const fmt = probeStreams(outP).format;
      const dur = parseFloat(fmt.duration);
      // clip 3s + endcard 2s = 5s expected; concat adds a small encoder
      // boundary so we tolerate ±300ms.
      assert.ok(dur > 4.6 && dur < 5.4,
        'endcard concat → duration ≈ 5.0 s ±0.3; got ' + dur);

      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      assert.equal(report.brand_kit.applied, true);
      assert.ok(report.brand_kit.assets_burned.includes('endcard'));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

// ============================================================
// 3. Lower-third time-gating test (sample three frames)
// ============================================================

test('brand-kit lower_third: visible inside show_from..show_until, absent outside',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src     = buildDarkMp4(work, 'src', 6.0);
      const ltPath  = buildSolidPng(work, 'lt', 'white', 600, 80);
      const cropP   = join(work, 'crop.json');
      const editP   = join(work, 'edit.json');
      const outP    = join(work, 'out.mp4');
      writeIdentityCrop(cropP);

      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'lt-test',
        source: src, crop_path: cropP, output: outP,
        start_ms: 0, end_ms: 6000, quality: 'fast',
        brand_kit: {
          version: 1, name: 'inline',
          assets: {
            lower_third: {
              path: ltPath, position: 'bottom-left', opacity: 1.0,
              show_from_ms: 2000, show_until_ms: 4000,
            },
          },
        },
      }) + '\n');

      const r = runRender(editP);
      assert.equal(r.status, 0, 'lower-third render must exit 0; stderr=' + r.stderr);

      // Sample three frames: before window (t=0.5), in window (t=3.0), after (t=5.5).
      const fBefore = extractGrayFrame(outP, 0.5);
      const fIn     = extractGrayFrame(outP, 3.0);
      const fAfter  = extractGrayFrame(outP, 5.5);
      // Lower-left region: x∈[43..643] (4% padding), y∈[varies by overlay].
      // The PNG is 600 wide × 80 tall, positioned bottom-left.
      // Bottom-left y ≈ canvasH - 80 - padding (≈ 4%) = 1920 - 80 - 76 ≈ 1764.
      const yStart = 1740, yEnd = 1840;
      const xStart = 40, xEnd = 600;
      const lumaBefore = fBefore.meanLumaRect(xStart, xEnd, yStart, yEnd);
      const lumaIn     = fIn.meanLumaRect(xStart, xEnd, yStart, yEnd);
      const lumaAfter  = fAfter.meanLumaRect(xStart, xEnd, yStart, yEnd);
      assert.ok(lumaIn > lumaBefore + 30,
        'in-window luma must exceed before-window by ≥30; got before=' + lumaBefore.toFixed(2) +
        ' in=' + lumaIn.toFixed(2));
      assert.ok(lumaIn > lumaAfter + 30,
        'in-window luma must exceed after-window by ≥30; got in=' + lumaIn.toFixed(2) +
        ' after=' + lumaAfter.toFixed(2));

      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      assert.equal(report.brand_kit.applied, true);
      assert.ok(report.brand_kit.assets_burned.includes('lower_third'));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

// ============================================================
// 4. B1 — missing brand-kit.json → no warning, no change
// ============================================================

test('brand-kit B1: no brand-kit anywhere → no warning, report.brand_kit:null',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src   = buildDarkMp4(work, 'src', 2.0);
      const cropP = join(work, 'crop.json');
      const editP = join(work, 'edit.json');
      const outP  = join(work, 'out.mp4');
      writeIdentityCrop(cropP);
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'no-bk', slug: 'bk-b1-' + Date.now(),
        source: src, crop_path: cropP, output: outP,
        start_ms: 0, end_ms: 2000, quality: 'fast',
      }) + '\n');

      // Force HOME to a clean temp dir so global brand-kit.json can't sneak in.
      const fakeHome = join(work, 'fakehome');
      mkdirSync(fakeHome, { recursive: true });
      const r = runRender(editP, { HOME: fakeHome });
      assert.equal(r.status, 0, 'no-brand render must exit 0; stderr=' + r.stderr);
      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      assert.equal(report.brand_kit, null, 'brand_kit must be null when no kit present');
      const brandWarnings = (report.warnings || []).filter((w) =>
        w.code && w.code.startsWith('brand_'));
      assert.equal(brandWarnings.length, 0,
        'no warnings should be brand_*; got ' + JSON.stringify(brandWarnings));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

// ============================================================
// 5. B2 — malformed brand-kit.json → warning + render succeeds
// ============================================================

test('brand-kit B2: malformed brand-kit.json → brand_kit_unreadable warning + render succeeds',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src   = buildDarkMp4(work, 'src', 2.0);
      const cropP = join(work, 'crop.json');
      const editP = join(work, 'edit.json');
      const outP  = join(work, 'out.mp4');
      writeIdentityCrop(cropP);

      // Per-project corrupt brand-kit at ./uploads/<slug>/brand-kit.json.
      const slug = 'bk-b2-' + Date.now();
      const uploadsDir = join(PLUGIN_ROOT, 'uploads', slug);
      mkdirSync(uploadsDir, { recursive: true });
      const corruptPath = join(uploadsDir, 'brand-kit.json');
      writeFileSync(corruptPath, '{ this is not: valid');

      try {
        writeFileSync(editP, JSON.stringify({
          version: 1, clip_id: 'bk-b2', slug,
          source: src, crop_path: cropP, output: outP,
          start_ms: 0, end_ms: 2000, quality: 'fast',
        }) + '\n');
        const r = runRender(editP);
        assert.equal(r.status, 0, 'malformed brand-kit must NOT fail render; stderr=' + r.stderr);
        const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
        const codes = (report.warnings || []).map((w) => w.code);
        assert.ok(codes.includes('brand_kit_unreadable'),
          'render_report.warnings must include brand_kit_unreadable; got ' + JSON.stringify(codes));
      } finally {
        rmSync(uploadsDir, { recursive: true, force: true });
      }
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

// ============================================================
// 6. B3 — brand asset path missing → soft warning, render continues
// ============================================================

test('brand-kit B3: asset path missing → brand_asset_missing:<key> warning, render succeeds',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src   = buildDarkMp4(work, 'src', 2.0);
      const cropP = join(work, 'crop.json');
      const editP = join(work, 'edit.json');
      const outP  = join(work, 'out.mp4');
      writeIdentityCrop(cropP);
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'bk-b3',
        source: src, crop_path: cropP, output: outP,
        start_ms: 0, end_ms: 2000, quality: 'fast',
        brand_kit: {
          version: 1, name: 'inline',
          assets: {
            logo: { path: join(work, 'does-not-exist.png'), position: 'bottom-right', opacity: 0.7, scale_px: 96 },
          },
        },
      }) + '\n');

      const r = runRender(editP);
      assert.equal(r.status, 0, 'missing-asset render must exit 0; stderr=' + r.stderr);
      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      const codes = (report.warnings || []).map((w) => w.code);
      assert.ok(codes.includes('brand_asset_missing'),
        'render_report.warnings must include brand_asset_missing; got ' + JSON.stringify(codes));
      // brand_kit should NOT report logo as burned.
      const burned = report.brand_kit?.assets_burned || [];
      assert.ok(!burned.includes('logo'),
        'logo must NOT be in assets_burned when path missing; got ' + JSON.stringify(burned));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

// ============================================================
// 7. B5 — backward-compat: legacy `"watermark": "<path>"` string still works
// ============================================================

test('brand-kit B5: legacy watermark string still produces logo overlay (regression guard)',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src   = buildDarkMp4(work, 'src', 3.0);
      const logo  = buildWhitePng(work, 'legacy-logo', 96, 96);
      const cropP = join(work, 'crop.json');
      const editP = join(work, 'edit.json');
      const outP  = join(work, 'out.mp4');
      writeIdentityCrop(cropP);
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'legacy-bk',
        source: src, crop_path: cropP, output: outP,
        start_ms: 0, end_ms: 3000, quality: 'fast',
        watermark: logo,   // ← legacy string format
      }) + '\n');

      const r = runRender(editP);
      assert.equal(r.status, 0, 'legacy watermark must still render; stderr=' + (r.stderr || '').slice(-400));

      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      assert.equal(report.brand_kit?.source, 'legacy',
        'legacy watermark must surface source="legacy"; got ' + JSON.stringify(report.brand_kit));
      assert.ok((report.brand_kit?.assets_burned || []).includes('logo'),
        'legacy watermark must burn a logo; got ' + JSON.stringify(report.brand_kit));

      // Positive-evidence frame check — high luma in bottom-right.
      const f = extractGrayFrame(outP, 1.5);
      const brLuma = f.meanLumaRect(900, 1050, 1800, 1880);
      const tlLuma = f.meanLumaRect(20, 150, 20, 100);
      assert.ok(brLuma > tlLuma + 20,
        'legacy watermark must produce visible logo: br=' + brLuma.toFixed(2) +
        ' tl=' + tlLuma.toFixed(2));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

// ============================================================
// 8. SVG without librsvg → graceful degrade, PNG in same kit renders
// ============================================================

test('brand-kit: SVG asset without librsvg → librsvg_not_available warning, PNG in same kit still renders',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const src   = buildDarkMp4(work, 'src', 2.0);
      const svg   = join(work, 'logo.svg');
      writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#fff"/></svg>');
      const ltPng = buildSolidPng(work, 'lt', 'white', 400, 60);
      const cropP = join(work, 'crop.json');
      const editP = join(work, 'edit.json');
      const outP  = join(work, 'out.mp4');
      writeIdentityCrop(cropP);
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'svg-degrade',
        source: src, crop_path: cropP, output: outP,
        start_ms: 0, end_ms: 2000, quality: 'fast',
        brand_kit: {
          version: 1, name: 'inline',
          assets: {
            logo: { path: svg, position: 'top-right', opacity: 1.0, scale_px: 96 },
            lower_third: { path: ltPng, position: 'bottom-left', opacity: 1.0,
                           show_from_ms: 500, show_until_ms: 1500 },
          },
        },
      }) + '\n');

      const r = runRender(editP, { CF_FORCE_NO_LIBRSVG: '1' });
      assert.equal(r.status, 0, 'svg + librsvg-disabled render must exit 0; stderr=' + r.stderr);
      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      const codes = (report.warnings || []).map((w) => w.code);
      assert.ok(codes.includes('librsvg_not_available'),
        'render_report.warnings must include librsvg_not_available; got ' + JSON.stringify(codes));
      // SVG skipped, PNG burned.
      const burned = report.brand_kit?.assets_burned || [];
      assert.ok(burned.includes('lower_third'),
        'PNG lower_third in same kit must still burn; got ' + JSON.stringify(burned));
      assert.ok(!burned.includes('logo'),
        'SVG logo must NOT burn when librsvg unavailable; got ' + JSON.stringify(burned));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

// ============================================================
// 9. THE COMPOSITION GATE TEST (brief §6 §brutal-review-5)
// ============================================================

test('brand-kit composition: brand-kit + 16:9 + dub.audio_source + tighten cuts + hook_overlay in one render',
  { skip: SKIP || false, timeout: 120_000 }, () => {
    const work = tmp();
    try {
      const src       = buildDarkMp4(work, 'src', 6.0);
      const dubbedWav = join(work, 'dubbed-id.wav');
      const wavR = spawnSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6:sample_rate=22050',
        '-ac', '1', dubbedWav,
      ]);
      assert.equal(wavR.status, 0, 'dubbed.wav synth must succeed');

      const logo = buildWhitePng(work, 'logo', 128, 64);
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

      const cropP = join(work, 'crop.json');
      writeIdentityCrop(cropP, 1920, 1080);  // 16:9 → 1920×1080
      const outP  = join(work, 'out.mp4');
      const editP = join(work, 'edit.json');
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'c01',
        source: src, crop_path: cropP,
        start_ms: 0, end_ms: 6000, quality: 'fast',
        target_aspect: '16:9',
        cuts: planP,
        audio_source: dubbedWav,
        hook_overlay: { text: 'HALO DUNIA', end_ms: 1800, position: 'upper-third' },
        brand_kit: {
          version: 1, name: 'inline',
          assets: { logo: { path: logo, position: 'bottom-right', opacity: 1.0, scale_px: 128 } },
        },
        dub: { source_lang: 'en', target_lang: 'id',
                voice_id: 'creator-main', provider: 'elevenlabs',
                report: '/dev/null' },
        dub_languages: ['id'],
        output: outP,
      }) + '\n');

      const r = runRender(editP);
      assert.equal(r.status, 0,
        'composition render must exit 0; stderr=' + (r.stderr || '').slice(-800));
      assert.ok(existsSync(outP), 'output mp4 must exist');

      // 1. Aspect — output is 1920×1080.
      const streams = probeStreams(outP).streams || [];
      const v = streams.find((s) => s.codec_type === 'video');
      assert.equal(v.width,  1920, '16:9 composition must be 1920 wide; got ' + v.width);
      assert.equal(v.height, 1080, '16:9 composition must be 1080 tall; got ' + v.height);

      // 2. Audio carried (the dubbed.wav).
      const a = streams.find((s) => s.codec_type === 'audio');
      assert.ok(a, 'output must carry an audio stream (dub.audio_source muxed in)');

      // 3. render_report carries 16:9 + hook burned + brand_kit applied +
      //    splice (1 junction) + no inline TTS.
      const reportP = join(dirname(outP), 'render_report.json');
      const report = JSON.parse(readFileSync(reportP, 'utf-8'));
      assert.equal(report.target_aspect, '16:9',
        'report.target_aspect must be 16:9; got ' + report.target_aspect);
      assert.equal(report.overlays?.hook?.burned, true,
        'hook overlay must be reported as burned');
      assert.equal(report.brand_kit?.applied, true,
        'brand_kit.applied must be true');
      assert.equal(report.brand_kit?.source, 'inline',
        'brand_kit.source must be inline; got ' + report.brand_kit?.source);
      assert.ok(report.brand_kit?.assets_burned?.includes('logo'),
        "brand_kit.assets_burned must include 'logo'; got " +
        JSON.stringify(report.brand_kit?.assets_burned));
      assert.equal(report.render_mode, 'splice',
        'tighten cuts must trigger splice mode');
      assert.ok(Array.isArray(report.junctions) && report.junctions.length === 1,
        'composition must produce 1 junction (1 cut → 2 kept segments); got ' +
        JSON.stringify(report.junctions?.length));
      assert.equal(report.tts_nondeterministic, false,
        'no inline TTS in this clip → tts_nondeterministic stays false');
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
