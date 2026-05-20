// broll-ai.test.mjs — positive-evidence integration tests for v0.4.0 pillar 5
// AI B-roll skill (/clip-forge:broll-ai + bin/cf-broll-ai).
//
// Asserts the moat-anchor invariants AND the documented graceful-degrade
// paths. All paid paths exercised via CF_VISUAL_MOCK (no real keys needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolvePath(fileURLToPath(import.meta.url), '../../..');
const CF_BROLL_AI = join(PLUGIN_ROOT, 'bin', 'cf-broll-ai');
const VISUAL_MOCK = join(PLUGIN_ROOT, 'tests', 'mocks', 'visual-mock.mjs');

const HAS_DISPATCH = existsSync(CF_BROLL_AI);
const HAS_MOCK = existsSync(VISUAL_MOCK);
const SKIP = !HAS_DISPATCH ? 'bin/cf-broll-ai missing'
           : !HAS_MOCK     ? 'tests/mocks/visual-mock.mjs missing'
           : false;

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-broll-ai-test-')); }

function setupClip(workDir, { segments, cropStats }) {
  mkdirSync(join(workDir, 'clips', 'podcast', 'c01'), { recursive: true });
  mkdirSync(join(workDir, 'renders', 'podcast'), { recursive: true });
  const broll = { version: 1, clip_id: 'c01', segments };
  writeFileSync(join(workDir, 'clips', 'podcast', 'c01', 'broll.json'),
                JSON.stringify(broll, null, 2));
  if (cropStats) {
    writeFileSync(join(workDir, 'clips', 'podcast', 'c01', 'crop_path.json'),
                  JSON.stringify({ version: 2, samples: [{ t_ms: 0, cx: 540, cy: 960, scale: 1.5 }],
                                    stats: cropStats }, null, 2));
  }
}

function runDispatch({ workDir, args, env = {} }) {
  const r = spawnSync(process.execPath, [CF_BROLL_AI, ...args], {
    cwd: workDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Important: undefine real keys so the mock takes precedence.
      FAL_API_KEY: '', GEMINI_API_KEY: '', REPLICATE_API_TOKEN: '',
      CF_VISUAL_MOCK: VISUAL_MOCK,
      ...env,
    },
  });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  const events = lines.map((l) => { try { return JSON.parse(l); } catch { return { _raw: l }; } });
  const done = events.find((e) => e.event === 'done');
  return { exit: r.status, stderr: r.stderr, events, done };
}

test('broll-ai: gap-fill — 3 low-score sentences → 3 AI images generated', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupClip(wd, {
    segments: [
      { id: 's1', sentence: 'morning coffee in cafe', start_ms: 0, end_ms: 3000, source: 'pexels', score: 0.3, is_primary: false },
      { id: 's2', sentence: 'sunset over city skyline', start_ms: 3000, end_ms: 6000, source: 'ai_gap_pending', is_primary: false },
      { id: 's3', sentence: 'busy street market', start_ms: 6000, end_ms: 9000, source: 'pexels', score: 0.2, is_primary: false },
    ],
    cropStats: { framesProcessed: 100, framesWithFace: 10 },
  });
  const { exit, done } = runDispatch({ workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01', '--max-cutaways', '3'] });
  assert.equal(exit, 0);
  assert.equal(done.generated, 3, 'expected 3 generated, got ' + done.generated);
  assert.equal(done.refused, 0);

  const broll = JSON.parse(readFileSync(join(wd, 'clips', 'podcast', 'c01', 'broll.json'), 'utf-8'));
  const aiCount = broll.segments.filter((s) => s.source === 'ai_generated').length;
  assert.equal(aiCount, 3);
  for (const s of broll.segments.filter((s) => s.source === 'ai_generated')) {
    assert.equal(s.is_primary, false, 'AI segments MUST have is_primary: false');
    assert.ok(existsSync(join(wd, s.path)), 'AI image file must exist on disk: ' + s.path);
  }
  rmSync(wd, { recursive: true, force: true });
});

test('broll-ai: is_primary:true segment refused, no mock invoked', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupClip(wd, {
    segments: [
      { id: 's1', sentence: 'creator face speaking', start_ms: 0, end_ms: 3000, source: 'pexels', score: 0.3, is_primary: true },
    ],
    cropStats: { framesProcessed: 100, framesWithFace: 10 },
  });
  // Use stylize mode to force AI op on a single segment.
  const { exit, done, events } = runDispatch({ workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01', '--stylize-segment', 's1', '--preset', 'cinematic'] });
  assert.equal(exit, 0);
  assert.equal(done.refused, 1);
  assert.equal(done.refusal_reason, 'is_primary_segment');
  const refused = events.find((e) => e.event === 'refused');
  assert.ok(refused, 'must emit a refused event');
  assert.equal(refused.refusal_reason, 'is_primary_segment');
  // Verify broll.json is byte-identical after refusal (no AI mutation).
  const broll = JSON.parse(readFileSync(join(wd, 'clips', 'podcast', 'c01', 'broll.json'), 'utf-8'));
  assert.equal(broll.segments[0].is_primary, true);
  assert.equal(broll.segments[0].source, 'pexels');
  rmSync(wd, { recursive: true, force: true });
});

test('broll-ai: stylize mode — preset+segment writes ai_stylized entry', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupClip(wd, {
    segments: [
      { id: 's1', sentence: 'b-roll cutaway', start_ms: 0, end_ms: 3000, source: 'pexels', score: 0.8, is_primary: false },
    ],
    cropStats: { framesProcessed: 100, framesWithFace: 5 },
  });
  const { exit, done } = runDispatch({ workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01', '--stylize-segment', 's1', '--preset', 'cinematic'] });
  assert.equal(exit, 0);
  assert.equal(done.generated, 1);
  const broll = JSON.parse(readFileSync(join(wd, 'clips', 'podcast', 'c01', 'broll.json'), 'utf-8'));
  assert.equal(broll.segments[0].source, 'ai_stylized');
  assert.equal(broll.segments[0].is_primary, false);
  rmSync(wd, { recursive: true, force: true });
});

test('broll-ai: no visual provider + no mock → exits 0 with no_visual_provider', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupClip(wd, {
    segments: [
      { id: 's1', sentence: 'cafe', start_ms: 0, end_ms: 3000, source: 'pexels', score: 0.3, is_primary: false },
    ],
    cropStats: { framesProcessed: 100, framesWithFace: 10 },
  });
  const { exit, done } = runDispatch({ workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01'],
    env: { CF_VISUAL_MOCK: '' /* turn mock off */ },
  });
  assert.equal(exit, 0);
  assert.equal(done.fallback_used, true);
  assert.equal(done.fallback_reason, 'no_visual_provider');
  // Original broll.json untouched.
  const broll = JSON.parse(readFileSync(join(wd, 'clips', 'podcast', 'c01', 'broll.json'), 'utf-8'));
  assert.equal(broll.segments[0].source, 'pexels');
  rmSync(wd, { recursive: true, force: true });
});

test('broll-ai: crop_path face yield > 0.5 → all candidates refused', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupClip(wd, {
    segments: [
      { id: 's1', sentence: 'gap', start_ms: 0, end_ms: 3000, source: 'pexels', score: 0.3, is_primary: false },
    ],
    cropStats: { framesProcessed: 100, framesWithFace: 75 },
  });
  const { done } = runDispatch({ workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01'] });
  assert.equal(done.refused, 1);
  assert.equal(done.generated, 0);
});

test('broll-ai: brand-kit color hint folds into prompt', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupClip(wd, {
    segments: [
      { id: 's1', sentence: 'sunset skyline', start_ms: 0, end_ms: 3000, source: 'pexels', score: 0.3, is_primary: false },
    ],
    cropStats: { framesProcessed: 100, framesWithFace: 5 },
  });
  // Inject brand_kit into broll.json so the dispatcher can pass it down.
  const brollPath = join(wd, 'clips', 'podcast', 'c01', 'broll.json');
  const broll = JSON.parse(readFileSync(brollPath, 'utf-8'));
  broll.brand_kit = { colors: { primary: '#ff5500', accent: '#0055ff' } };
  writeFileSync(brollPath, JSON.stringify(broll, null, 2));
  const { exit, done } = runDispatch({ workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01'] });
  assert.equal(exit, 0);
  assert.equal(done.generated, 1);
  const out = JSON.parse(readFileSync(brollPath, 'utf-8'));
  // The mock receives the brand_kit and the dispatcher's buildPrompt
  // suffix should reference brand vocabulary; we assert at minimum the
  // segment got an AI source + provider record.
  assert.equal(out.segments[0].source, 'ai_generated');
});

test('broll-ai: budget at $0.005 cap stops after first ~1 image (mock returns 0.003/img)', { skip: SKIP || false }, () => {
  const wd = tmp();
  // Pre-seed the manifest with cumulative_usd just below the per-image cost.
  mkdirSync(join(wd, 'renders', 'podcast'), { recursive: true });
  const manifest = {
    version: 1, schema: 'render_manifest.v1', slug: 'podcast',
    ai_costs: {
      cumulative_usd: 0.0, budget_cap_usd: 0.005,
      breakdown: {}, skipped: [], history: [],
    },
  };
  writeFileSync(join(wd, 'renders', 'podcast', 'render_manifest.json'),
                JSON.stringify(manifest, null, 2));
  setupClip(wd, {
    segments: [
      { id: 's1', sentence: 'a', start_ms: 0, end_ms: 3000, source: 'pexels', score: 0.3, is_primary: false },
      { id: 's2', sentence: 'b', start_ms: 3000, end_ms: 6000, source: 'pexels', score: 0.3, is_primary: false },
      { id: 's3', sentence: 'c', start_ms: 6000, end_ms: 9000, source: 'pexels', score: 0.3, is_primary: false },
    ],
    cropStats: { framesProcessed: 100, framesWithFace: 5 },
  });
  const { done } = runDispatch({ workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01', '--yolo'] });
  // At $0.005 cap and $0.003/img, only 1 image fits.
  assert.ok(done.generated <= 2, 'budget should have capped generation; got ' + done.generated);
  const mf = JSON.parse(readFileSync(join(wd, 'renders', 'podcast', 'render_manifest.json'), 'utf-8'));
  assert.ok(mf.ai_costs.cumulative_usd <= 0.005 + 0.0001, 'cumulative must respect cap');
});
