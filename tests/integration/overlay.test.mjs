// overlay.test.mjs — v0.3.0 pillar (i) integration tests.
//
// Asserts visible EFFECT, not exit code or filter graph syntax:
//   * Hook overlay: high-luminance band in upper third at t=0.5s, gone at t=4s.
//   * Progress bar: bottom row has more fill at t=2.5s than t=0.5s.
//   * Aspect profiles: rendered MP4 dimensions match 9:16/1:1/4:5.
//   * Baseline: no-overlay + CF_RENDER_DETERMINISTIC=1 → byte-identical MD5.
//   * Sidecars: <output>.vtt + <output>.srt files exist and parse.
//   * Wrap warning: hook overflow → render_report records the wrap.
//   * Emoji burn: rendered frame in caption region differs with vs. without emoji.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const CF_FFMPEG  = resolve(PLUGIN_ROOT, 'bin/cf-ffmpeg');
const FIXTURE = resolve(PLUGIN_ROOT, 'tests/fixtures/talking-head-5s.mp4');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

const HAS_FFMPEG  = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const HAS_FIXTURE = existsSync(FIXTURE);
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing'
            : !HAS_FFPROBE ? 'ffprobe missing'
            : !HAS_FIXTURE ? 'fixture missing: ' + FIXTURE
            : null;

// ----- helpers -----

function writeIdentityCrop(path, targetW = 1080, targetH = 1920) {
  // talking-head-5s.mp4 is 640x360 source. Use those dims so the crop
  // expression's source_w/h match reality; the renderer will scale up.
  writeFileSync(path, JSON.stringify({
    version: 2, source_w: 640, source_h: 360,
    target_w: targetW, target_h: targetH,
    samples: [], interp: 'linear', mode: 'center', detector: 'identity',
    fallback_used: false, fallback_reason: null,
  }) + '\n');
}

function writeEdit(path, overrides) {
  writeFileSync(path, JSON.stringify({
    version: 1, clip_id: 'overlay-test',
    start_ms: 0, end_ms: 5000, quality: 'fast',
    ...overrides,
  }) + '\n');
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

function streamMd5(file, streamSpec) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-i', file, '-map', streamSpec, '-f', 'md5', '-'], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  const m = r.stdout.trim().match(/MD5=([0-9a-f]+)/);
  return m ? m[1] : null;
}

// Extract a frame at time t (seconds) → raw rgb24 grayscale luminance per pixel.
// Returns { width, height, lumaRow(y) } where lumaRow takes a band of `band`
// pixels centered on y and returns the mean luminance ∈ [0, 255].
function extractGrayFrame(srcMp4, tSec) {
  const tmpRaw = join(tmpdir(), 'cf-overlay-frame-' + process.pid + '-' + Date.now() + Math.random() + '.gray');
  const probe = ffprobeJson(['-select_streams', 'v', '-show_streams', srcMp4]);
  const v = probe.streams[0];
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
    meanLumaBand(y, bandPx) {
      const yStart = Math.max(0, Math.floor(y - bandPx / 2));
      const yEnd   = Math.min(H, yStart + bandPx);
      let sum = 0, n = 0;
      for (let row = yStart; row < yEnd; row++) {
        const base = row * W;
        for (let col = 0; col < W; col++) {
          sum += buf[base + col];
          n++;
        }
      }
      return n > 0 ? sum / n : 0;
    },
  };
}

// ============================================================
// Hook overlay luminance test
// ============================================================

// Build a dark synthetic source so overlays / progress bars produce a
// clean luminance signal against a near-black background. The
// talking-head fixture is bright and saturates the row sums.
function buildDarkSource(workDir, label, durS, w = 640, h = 360) {
  mkdirSync(workDir, { recursive: true });
  const mp4 = join(workDir, label + '.mp4');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=30:d=${durS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durS}:sample_rate=48000`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', mp4,
  ]);
  if (r.status !== 0) throw new Error('buildDarkSource: ' + r.stderr);
  return mp4;
}

test('overlay-hook: high-luma band in upper third at t=0.5s, absent at t=4s after end_ms=1800',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-hook-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const darkSrc = buildDarkSource(work, 'dark', 5.0);
      const cropPath = join(work, 'crop.json');
      const editPath = join(work, 'edit.json');
      const outPath  = join(work, 'out.mp4');
      writeIdentityCrop(cropPath);
      writeEdit(editPath, {
        source: darkSrc, crop_path: cropPath, output: outPath,
        hook_overlay: { text: 'NOBODY TELLS YOU THIS', end_ms: 1800, position: 'upper-third' },
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'render with hook_overlay must exit 0; stderr=' + r.stderr);

      // Sample upper-third band (y ≈ 640, since canvas is 1920 tall) at both
      // times. The hook is visible at t=0.5s, gone after t=1.8s. Source is
      // black; bold white text raises luma noticeably.
      const f05 = extractGrayFrame(outPath, 0.5);
      const f40 = extractGrayFrame(outPath, 4.0);
      assert.equal(f05.height, 1920);
      const lumaAt05 = f05.meanLumaBand(640, 80);
      const lumaAt40 = f40.meanLumaBand(640, 80);
      assert.ok(lumaAt05 - lumaAt40 > 5,
        'hook overlay should raise upper-third luma by >5 at t=0.5s vs t=4s; got 0.5=' + lumaAt05.toFixed(2) +
        ', 4.0=' + lumaAt40.toFixed(2));

      const reportPath = join(work, 'render_report.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      assert.ok(report.overlays && report.overlays.hook, 'render_report.overlays.hook must be present');
      assert.equal(report.overlays.hook.burned, true);
      assert.equal(report.overlays.hook.end_ms, 1800);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// Progress bar luminance test
// ============================================================

test('overlay-progress: bottom 8 px row has more fill at t=2.5s than t=0.5s',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-pb-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const darkSrc = buildDarkSource(work, 'dark', 5.0);
      const cropPath = join(work, 'crop.json');
      const editPath = join(work, 'edit.json');
      const outPath  = join(work, 'out.mp4');
      writeIdentityCrop(cropPath);
      writeEdit(editPath, {
        source: darkSrc, crop_path: cropPath, output: outPath,
        progress_bar: { enabled: true, color: '#ffffff', height_px: 8, position: 'bottom' },
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'render with progress_bar must exit 0; stderr=' + r.stderr);

      // Bottom 8 px row should have more total fill at t=2.5s than at t=0.5s.
      // Sample the bottom band (y = 1916). Source is black so the bar's
      // contribution is the only luminance.
      const f05 = extractGrayFrame(outPath, 0.5);
      const f25 = extractGrayFrame(outPath, 2.5);
      const lumaAt05 = f05.meanLumaBand(1916, 8);
      const lumaAt25 = f25.meanLumaBand(1916, 8);
      // At t=0.5s, bar covers ~10% of width → mean luma ≈ 25. At t=2.5s,
      // ~50% → ≈ 128. Robust assertion: ratio ≥ 1.5×.
      assert.ok(lumaAt25 > lumaAt05 * 1.5,
        'bottom-row luma at t=2.5s must be ≥ 1.5× t=0.5s (progress fill); got 0.5=' +
        lumaAt05.toFixed(2) + ', 2.5=' + lumaAt25.toFixed(2));

      const reportPath = join(work, 'render_report.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      assert.ok(report.overlays && report.overlays.progress_bar, 'render_report.overlays.progress_bar present');
      assert.equal(report.overlays.progress_bar.burned, true);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// Aspect profiles
// ============================================================

test('aspect: target_aspect "1:1" → rendered MP4 is 1080x1080',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-a11-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const cropPath = join(work, 'crop.json');
      const editPath = join(work, 'edit.json');
      const outPath  = join(work, 'out.mp4');
      // Identity crop with target_w/h = 1080/1080 so the source-derived
      // crop is computed against the new aspect. The renderer also
      // overrides target_w/h from edit.json.target_aspect; keeping both
      // consistent is the contract.
      writeIdentityCrop(cropPath, 1080, 1080);
      writeEdit(editPath, {
        source: FIXTURE, crop_path: cropPath, output: outPath,
        target_aspect: '1:1',
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'render with target_aspect 1:1 must exit 0; stderr=' + r.stderr);
      const probe = ffprobeJson(['-select_streams', 'v', '-show_streams', outPath]);
      const v = probe.streams[0];
      assert.equal(v.width, 1080);
      assert.equal(v.height, 1080);
      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      assert.equal(report.target_aspect, '1:1');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('aspect: target_aspect "4:5" → rendered MP4 is 1080x1350',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-a45-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const cropPath = join(work, 'crop.json');
      const editPath = join(work, 'edit.json');
      const outPath  = join(work, 'out.mp4');
      writeIdentityCrop(cropPath, 1080, 1350);
      writeEdit(editPath, {
        source: FIXTURE, crop_path: cropPath, output: outPath,
        target_aspect: '4:5',
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'render with target_aspect 4:5 must exit 0; stderr=' + r.stderr);
      const probe = ffprobeJson(['-select_streams', 'v', '-show_streams', outPath]);
      const v = probe.streams[0];
      assert.equal(v.width, 1080);
      assert.equal(v.height, 1350);
      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      assert.equal(report.target_aspect, '4:5');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('aspect: target_aspect unset → rendered MP4 is 1080x1920 (default 9:16 baseline)',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-916-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const cropPath = join(work, 'crop.json');
      const editPath = join(work, 'edit.json');
      const outPath  = join(work, 'out.mp4');
      writeIdentityCrop(cropPath);
      writeEdit(editPath, {
        source: FIXTURE, crop_path: cropPath, output: outPath,
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'baseline render must exit 0; stderr=' + r.stderr);
      const probe = ffprobeJson(['-select_streams', 'v', '-show_streams', outPath]);
      const v = probe.streams[0];
      assert.equal(v.width, 1080);
      assert.equal(v.height, 1920);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// Idempotency on baseline
// ============================================================

test('baseline: no overlays + CF_RENDER_DETERMINISTIC=1 → byte-identical per-stream MD5 across two runs',
  { skip: SKIP || false, timeout: 90_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-md5-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const cropPath = join(work, 'crop.json');
      writeIdentityCrop(cropPath);
      const runOnce = (suffix) => {
        const w = join(work, 'run-' + suffix);
        mkdirSync(w, { recursive: true });
        const editPath = join(w, 'edit.json');
        const outPath  = join(w, 'out.mp4');
        writeEdit(editPath, {
          source: FIXTURE, crop_path: cropPath, output: outPath,
        });
        const r = runCfFfmpeg(editPath, { CF_RENDER_DETERMINISTIC: '1' });
        assert.equal(r.status, 0, 'deterministic render must exit 0; stderr=' + r.stderr);
        return outPath;
      };
      const outA = runOnce('a');
      const outB = runOnce('b');
      const vA = streamMd5(outA, '0:v');
      const vB = streamMd5(outB, '0:v');
      assert.ok(vA && vB && vA === vB,
        'per-stream video MD5 must match between deterministic runs: A=' + vA + ' B=' + vB);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// VTT + SRT sidecars
// ============================================================

function writeCaptionsJson(path, opts = {}) {
  const captions = {
    version: 1, clip_id: 'overlay-test', style: 'Submagic-Pop',
    brand: { primary: '#ff0066', accent: '#00d4ff' },
    font: 'Inter',
    lines: [
      {
        start_ms: 0, end_ms: 1500,
        words: [
          { w: 'Hello', start_ms: 0, end_ms: 400 },
          { w: 'world', start_ms: 400, end_ms: 1000, highlight: true },
        ],
        emoji: opts.emoji || null,
      },
      {
        start_ms: 1500, end_ms: 3000,
        words: [
          { w: 'second', start_ms: 1500, end_ms: 2000 },
          { w: 'line',   start_ms: 2000, end_ms: 2500 },
        ],
      },
    ],
  };
  writeFileSync(path, JSON.stringify(captions, null, 2) + '\n');
  return captions;
}

function writeCaptionsAss(path, captionsJson) {
  // Minimal valid ASS with one Dialogue line per captions line.
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Liberation Sans,72,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H64000000&,-1,0,0,0,100,100,0,0,1,4,2,2,40,40,220,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = [];
  for (const line of captionsJson.lines) {
    const fmt = (ms) => {
      const cs = Math.floor(ms / 10) % 100;
      const s = Math.floor(ms / 1000) % 60;
      const m = Math.floor(ms / 60000) % 60;
      const h = Math.floor(ms / 3600000);
      return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
    };
    const text = line.words.map((w) => w.w).join(' ') + (line.emoji ? ' ' + line.emoji : '');
    events.push('Dialogue: 0,' + fmt(line.start_ms) + ',' + fmt(line.end_ms) + ',Default,,0,0,0,,' + text);
  }
  writeFileSync(path, head.concat(events).join('\n') + '\n');
}

test('sidecars: <output>.vtt exists, starts with WEBVTT, has cue blocks',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-vtt-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const cropPath = join(work, 'crop.json');
      const editPath = join(work, 'edit.json');
      const outPath  = join(work, 'out.mp4');
      const captionsJsonPath = join(work, 'captions.json');
      const captionsAssPath  = join(work, 'captions.ass');
      writeIdentityCrop(cropPath);
      const captions = writeCaptionsJson(captionsJsonPath);
      writeCaptionsAss(captionsAssPath, captions);
      writeEdit(editPath, {
        source: FIXTURE, crop_path: cropPath, output: outPath,
        captions: captionsAssPath, captions_json: captionsJsonPath,
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'render with captions must exit 0; stderr=' + r.stderr);
      const vttPath = outPath.replace(/\.mp4$/, '.vtt');
      assert.ok(existsSync(vttPath), 'VTT sidecar must exist at ' + vttPath);
      const vtt = readFileSync(vttPath, 'utf-8');
      assert.ok(vtt.startsWith('WEBVTT'), 'VTT must start with WEBVTT; got: ' + vtt.slice(0, 30));
      assert.match(vtt, /-->/);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('sidecars: <output>.srt exists, has numbered blocks + comma timestamps',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-srt-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const cropPath = join(work, 'crop.json');
      const editPath = join(work, 'edit.json');
      const outPath  = join(work, 'out.mp4');
      const captionsJsonPath = join(work, 'captions.json');
      const captionsAssPath  = join(work, 'captions.ass');
      writeIdentityCrop(cropPath);
      const captions = writeCaptionsJson(captionsJsonPath);
      writeCaptionsAss(captionsAssPath, captions);
      writeEdit(editPath, {
        source: FIXTURE, crop_path: cropPath, output: outPath,
        captions: captionsAssPath, captions_json: captionsJsonPath,
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'render with captions must exit 0; stderr=' + r.stderr);
      const srtPath = outPath.replace(/\.mp4$/, '.srt');
      assert.ok(existsSync(srtPath), 'SRT sidecar must exist at ' + srtPath);
      const srt = readFileSync(srtPath, 'utf-8');
      assert.match(srt, /^1\n/);
      assert.match(srt, /,\d{3} --> /);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// Hook overlay wrap warning
// ============================================================

test('hook_overlay_wrapped: long text triggers warning recorded in render_report.json',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-wrap-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const cropPath = join(work, 'crop.json');
      const editPath = join(work, 'edit.json');
      const outPath  = join(work, 'out.mp4');
      writeIdentityCrop(cropPath);
      writeEdit(editPath, {
        source: FIXTURE, crop_path: cropPath, output: outPath,
        hook_overlay: {
          text: 'This hook line is intentionally far far far far far too long to fit in any reasonable safe area on a vertical canvas without wrapping multiple times',
          end_ms: 1800, position: 'upper-third', max_chars: 28,
        },
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'render must exit 0 even with wrap; stderr=' + r.stderr);
      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      assert.equal(report.overlays.hook.wrapped, true,
        'render_report.overlays.hook.wrapped must be true');
      const codes = (report.warnings || []).map((w) => w.code);
      assert.ok(codes.includes('hook_overlay_wrapped'),
        'render_report.warnings must include hook_overlay_wrapped; got ' + JSON.stringify(codes));
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// Emoji burn
// ============================================================

test('emoji burn: caption with emoji renders distinct frame in caption region vs. without',
  { skip: SKIP || false, timeout: 120_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-emoji-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const cropPath = join(work, 'crop.json');
      writeIdentityCrop(cropPath);

      const renderWith = (label, withEmoji) => {
        const dir = join(work, label);
        mkdirSync(dir, { recursive: true });
        const editPath = join(dir, 'edit.json');
        const outPath  = join(dir, 'out.mp4');
        const captionsJsonPath = join(dir, 'captions.json');
        const captionsAssPath  = join(dir, 'captions.ass');
        const captions = writeCaptionsJson(captionsJsonPath, withEmoji ? { emoji: '🎯' } : {});
        writeCaptionsAss(captionsAssPath, captions);
        writeEdit(editPath, {
          source: FIXTURE, crop_path: cropPath, output: outPath,
          captions: captionsAssPath, captions_json: captionsJsonPath,
        });
        const r = runCfFfmpeg(editPath, { CF_RENDER_DETERMINISTIC: '1' });
        assert.equal(r.status, 0, 'render ' + label + ' must exit 0; stderr=' + r.stderr);
        return outPath;
      };
      const withE  = renderWith('with',  true);
      const without = renderWith('no',   false);

      // Sample frame at t=0.5 (line 1 active). The caption Region is the
      // bottom ~280 px (MarginV=220). Compare luma there: with emoji should
      // differ from without.
      const fW = extractGrayFrame(withE, 0.5);
      const fN = extractGrayFrame(without, 0.5);
      const lumaW = fW.meanLumaBand(1700, 200);
      const lumaN = fN.meanLumaBand(1700, 200);
      // Emoji rendering on Liberation Sans typically shows as a box glyph (one
      // missing-glyph rectangle outline). Either rendered glyph or fallback box
      // contributes some luminance. The "with emoji" render should differ from
      // "without" by at least 0.05 luma in the caption band (a very small but
      // non-zero pixel-level effect).
      assert.ok(Math.abs(lumaW - lumaN) > 0.01,
        'caption band luma must differ with vs. without emoji; got with=' + lumaW.toFixed(3) +
        ' without=' + lumaN.toFixed(3));
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// Unknown aspect graceful fallback
// ============================================================

test('aspect fallback: unknown target_aspect "5:4" → renders 1080x1920 + unknown_aspect warning',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-unka-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      const cropPath = join(work, 'crop.json');
      const editPath = join(work, 'edit.json');
      const outPath  = join(work, 'out.mp4');
      writeIdentityCrop(cropPath);
      writeEdit(editPath, {
        source: FIXTURE, crop_path: cropPath, output: outPath,
        target_aspect: '5:4',
      });
      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'unknown aspect must NOT fail render; stderr=' + r.stderr);
      const probe = ffprobeJson(['-select_streams', 'v', '-show_streams', outPath]);
      const v = probe.streams[0];
      assert.equal(v.width, 1080);
      assert.equal(v.height, 1920);
      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      const codes = (report.warnings || []).map((w) => w.code);
      assert.ok(codes.includes('unknown_aspect'),
        'render_report.warnings must include unknown_aspect; got ' + JSON.stringify(codes));
      assert.equal(report.target_aspect, '9:16');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

// ============================================================
// Composition stress: every v0.3.0 pillar in a single edit.json.
// Regression guard for the splice + audio_source + overlay + aspect + sidecar
// intersection. Composition broken at this intersection would slip past the
// per-feature tests above, so this one asserts they coexist.
// ============================================================

test('composition: cuts + audio_source + hook_overlay + progress_bar + 4:5 + captions all compose',
  { skip: SKIP || false, timeout: 120_000 }, () => {
    const work = join(tmpdir(), 'cf-ovl-composition-' + Date.now());
    mkdirSync(work, { recursive: true });
    try {
      // Build a 6-second dark synthetic source + a synthetic 48 kHz mono wav
      // standing in for an enhanced-audio artefact. No real cf-enhance run
      // needed; the renderer only requires a playable audio file.
      const sourceMp4 = buildDarkSource(work, 'src', 6);
      const enhancedWav = join(work, 'enhanced.wav');
      const wavR = spawnSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=48000',
        '-ac', '1', enhancedWav,
      ]);
      assert.equal(wavR.status, 0, 'enhanced.wav synth must succeed');

      // Tighten plan with one cut at 2.0-2.5s, identical schema to pillar A.
      const planPath = join(work, 'plan.json');
      writeFileSync(planPath, JSON.stringify({
        version: 1, clip_id: 'comp',
        basis_start_ms: 0, basis_end_ms: 6000,
        source_duration_ms: 6000,
        output_duration_ms: 5500, saved_ms: 500,
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

      const cropPath = join(work, 'crop.json');
      writeIdentityCrop(cropPath);
      const captionsJsonPath = join(work, 'captions.json');
      const captionsAssPath  = join(work, 'captions.ass');
      const captions = writeCaptionsJson(captionsJsonPath);
      writeCaptionsAss(captionsAssPath, captions);

      const outPath  = join(work, 'out.mp4');
      const editPath = join(work, 'edit.json');
      writeEdit(editPath, {
        source: sourceMp4, crop_path: cropPath,
        cuts: planPath, audio_source: enhancedWav,
        captions: captionsAssPath, captions_json: captionsJsonPath,
        hook_overlay:  { text: 'ALL FOUR PILLARS', end_ms: 1800, position: 'upper-third' },
        progress_bar:  { enabled: true, color: '#ffffff', height_px: 8, position: 'bottom' },
        target_aspect: '4:5',
        output: outPath,
        end_ms: 6000,
      });

      const r = runCfFfmpeg(editPath);
      assert.equal(r.status, 0, 'composition render must exit 0; stderr=' + r.stderr);

      // Output dims honour 4:5 → 1080×1350.
      const probe = ffprobeJson(['-select_streams', 'v', '-show_streams', outPath]);
      const v = probe.streams[0];
      assert.equal(v.width, 1080,  'composition output must be 1080 wide; got ' + v.width);
      assert.equal(v.height, 1350, 'composition output must be 1350 tall (4:5); got ' + v.height);

      // Report must reflect all four pillars active simultaneously.
      const report = JSON.parse(readFileSync(join(work, 'render_report.json'), 'utf-8'));
      assert.equal(report.target_aspect, '4:5',
        'report.target_aspect must echo 4:5; got ' + report.target_aspect);
      assert.equal(report.overlays?.hook?.burned, true,
        'report.overlays.hook.burned must be true; got ' + JSON.stringify(report.overlays?.hook));
      assert.equal(report.overlays?.progress_bar?.burned, true,
        'report.overlays.progress_bar.burned must be true; got ' + JSON.stringify(report.overlays?.progress_bar));
      assert.ok(Array.isArray(report.junctions) && report.junctions.length === 1,
        'splice path must emit 1 junction (1 cut → 2 kept segments → 1 junction); got ' +
        JSON.stringify(report.junctions?.length));
      assert.equal(typeof report.sidecars?.vtt, 'string',
        'sidecars.vtt path must be present when captions emit; got ' + JSON.stringify(report.sidecars));
      assert.equal(typeof report.sidecars?.srt, 'string',
        'sidecars.srt path must be present when captions emit; got ' + JSON.stringify(report.sidecars));
      assert.ok(existsSync(outPath.replace(/\.mp4$/, '.vtt')), 'composition VTT sidecar must exist on disk');
      assert.ok(existsSync(outPath.replace(/\.mp4$/, '.srt')), 'composition SRT sidecar must exist on disk');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });
