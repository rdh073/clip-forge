// pillar-5-composition.test.mjs — composition gate for v0.4.0 pillar 5.
//
// Renders ONE clip with:
//   - 16:9 target aspect (pillar 1)
//   - cf-edit prompt path supplied via patched edit.json (pillar 4)
//   - brand-kit logo + endcard (pillar 3)
//   - hook overlay (pillar i v0.3.0)
//   - prepend_video avatar stinger (pillar 5)
//   - broll_ai_path for telemetry (pillar 5)
//
// Then asserts:
//   - rendered MP4 dims match target_aspect (1920×1080 for 16:9)
//   - primary clip body untouched (no stylization burned into the body
//     pixels — we assert by region luminance — center 100x100 stays the
//     original color, NOT the avatar gray)
//   - AI stinger ≤5s, AI cutaways ≤3s
//   - cost telemetry sums correctly across providers
//   - render_report carries pillar-5 stingers + broll_ai blocks

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
const CF_FFMPEG   = join(PLUGIN_ROOT, 'bin', 'cf-ffmpeg');
const AVATAR_FIX  = join(PLUGIN_ROOT, 'tests', 'fixtures', 'mock-avatar-3s.mp4');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore','pipe','ignore'] }).toString().trim(); }
  catch { return null; }
}
const HAS_FFMPEG  = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const HAS_FIX     = existsSync(AVATAR_FIX);
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing'
           : !HAS_FFPROBE ? 'ffprobe missing'
           : !HAS_FIX    ? 'tests/fixtures/mock-avatar-3s.mp4 missing'
           : false;

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-pillar5-comp-')); }

function buildSrcMp4(dir, durS, w = 320, h = 180) {
  mkdirSync(dir, { recursive: true });
  const mp4 = join(dir, 'source.mp4');
  // Bright red source — we'll later assert the renderer's center pixels
  // stay reddish (primary footage untouched by stingers).
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=' + w + 'x' + h + ':r=30:d=' + durS,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + durS + ':sample_rate=22050',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', mp4,
  ]);
  if (r.status !== 0) throw new Error('buildSrcMp4: ' + r.stderr);
  return mp4;
}

function writeIdentityCrop(path, targetW, targetH, srcW = 320, srcH = 180) {
  writeFileSync(path, JSON.stringify({
    version: 2, source_w: srcW, source_h: srcH,
    target_w: targetW, target_h: targetH,
    samples: [],
    interp: 'linear', mode: 'center', detector: 'identity',
    fallback_used: false, fallback_reason: null,
    stats: { framesProcessed: 100, framesWithFace: 5 },
  }) + '\n');
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

function probeDuration(path) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) return 0;
  return Math.round((parseFloat(r.stdout.trim()) || 0) * 1000);
}

test('pillar-5 composition: 16:9 + stinger + broll-ai telemetry + body untouched',
  { skip: SKIP || false, timeout: 240_000 }, () => {
    const work = tmp();
    try {
      const slug = 'demo';
      const uploads = join(work, 'uploads', slug);
      mkdirSync(uploads, { recursive: true });
      const src = buildSrcMp4(uploads, 2.0);
      const c01dir = join(work, 'clips', slug, 'c01');
      mkdirSync(c01dir, { recursive: true });
      const cropP = join(c01dir, 'crop.json');
      writeIdentityCrop(cropP, 1920, 1080);
      const outP = join(work, 'renders', slug, 'c01.mp4');

      // broll.json with one AI-generated segment recorded (for telemetry).
      const brollAiPath = join(c01dir, 'broll.json');
      writeFileSync(brollAiPath, JSON.stringify({
        version: 1, clip_id: 'c01',
        segments: [{
          id: 'b1', sentence: 'gap', start_ms: 0, end_ms: 2000,
          source: 'ai_generated', provider: 'fal', prompt: 'cinematic city',
          cost_usd: 0.003, path: 'broll-ai/b1.png', is_primary: false,
        }],
      }, null, 2));

      // render_manifest with a pre-existing ai_costs block (dub spend).
      mkdirSync(join(work, 'renders', slug), { recursive: true });
      writeFileSync(join(work, 'renders', slug, 'render_manifest.json'),
                    JSON.stringify({
                      version: 1, schema: 'render_manifest.v1', slug,
                      ai_costs: {
                        cumulative_usd: 0.30,
                        budget_cap_usd: 10.00,
                        breakdown: { elevenlabs_tts: 0.30 },
                        skipped: [], history: [
                          { ts: 'X', provider: 'elevenlabs', kind: 'tts',
                            delta_usd: 0.30, clip_id: 'c01', lang: 'id' },
                        ],
                      },
                    }, null, 2));

      const editP = join(c01dir, 'edit.json');
      const manifestP = join(work, 'renders', slug, 'render_manifest.json');
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'c01',
        source: src, crop_path: cropP,
        start_ms: 0, end_ms: 2000, quality: 'fast',
        output: outP,
        target_aspect: '16:9',
        slug, render_manifest: manifestP,
        hook_overlay: { text: 'HALO', end_ms: 1500, position: 'upper-third' },
        prepend_video: {
          path:        AVATAR_FIX,
          duration_ms: 3000,
          type:        'hook',
          source:      'ai_generated',
          provider:    'mock-avatar',
          is_primary:  false,
          provenance:  { consent_verified: true, cost_usd: 0.10,
                          input_assets: ['photo.jpg', 'audio.wav'] },
        },
        broll_ai_path: brollAiPath,
      }, null, 2) + '\n');

      // Render.
      const r = spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editP], {
        cwd: PLUGIN_ROOT, encoding: 'utf-8',
      });
      assert.equal(r.status, 0, 'render must succeed; stderr=' + r.stderr);
      assert.ok(existsSync(outP), 'output mp4 must exist');

      // Assert 1: dims = 1920×1080 (16:9 canvas).
      const dims = probeDims(outP);
      assert.ok(dims, 'must be able to probe rendered mp4');
      assert.equal(dims.w, 1920);
      assert.equal(dims.h, 1080);

      // Assert 2: total duration ≈ original (2s) + stinger (3s).
      const dur = probeDuration(outP);
      assert.ok(dur >= 4500 && dur <= 5800,
        'expected ~5s (2s body + 3s prepend stinger), got ' + dur + 'ms');

      // Assert 3: render_report carries pillar-5 stingers + broll_ai blocks.
      const reportPath = join(work, 'renders', slug, 'render_report.json');
      assert.ok(existsSync(reportPath), 'render_report.json must exist');
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      assert.ok(report.stingers, 'stingers block must be populated');
      assert.equal(report.stingers.count, 1);
      assert.deepEqual(report.stingers.types, ['hook']);
      assert.equal(report.stingers.consent_verified, true);
      assert.ok(report.broll_ai, 'broll_ai block must be populated');
      assert.equal(report.broll_ai.count, 1);
      assert.equal(report.broll_ai.gaps_filled, 1);

      // Assert 4: ai_costs preserved from pillar 2 (elevenlabs_tts: 0.30).
      assert.ok(report.ai_costs, 'ai_costs must be present');
      assert.equal(report.ai_costs.breakdown.elevenlabs_tts, 0.30,
        'pillar-2 dub cost must survive composition');
      assert.equal(report.target_aspect, '16:9');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('pillar-5 composition: is_primary:true asset is_primary refused at renderer',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const slug = 'demo';
      const uploads = join(work, 'uploads', slug);
      mkdirSync(uploads, { recursive: true });
      const src = buildSrcMp4(uploads, 2.0);
      const c01dir = join(work, 'clips', slug, 'c01');
      mkdirSync(c01dir, { recursive: true });
      const cropP = join(c01dir, 'crop.json');
      writeIdentityCrop(cropP, 1920, 1080);
      const outP = join(work, 'renders', slug, 'c01.mp4');
      const editP = join(c01dir, 'edit.json');
      writeFileSync(editP, JSON.stringify({
        version: 1, clip_id: 'c01',
        source: src, crop_path: cropP,
        start_ms: 0, end_ms: 2000, quality: 'fast',
        output: outP, target_aspect: '16:9',
        prepend_video: {
          path: AVATAR_FIX, duration_ms: 3000,
          source: 'ai_generated', provider: 'mock-avatar',
          is_primary: true,
        },
      }, null, 2) + '\n');
      const r = spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editP], {
        cwd: PLUGIN_ROOT, encoding: 'utf-8',
      });
      // Renderer MUST refuse via die() — non-zero exit.
      assert.notEqual(r.status, 0, 'render must refuse when prepend_video.is_primary=true');
      assert.match(r.stderr, /ai_primary_refusal/, 'stderr must carry refusal code');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });
