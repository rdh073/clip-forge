// cf-edit.test.mjs — integration tests for /clip-forge:edit diff mode
// (v0.4.0 pillar 4, deliverable A).
//
// Coverage (PLAN-v0.4.0 §3.4 + brief tests required):
//   - cold start: empty renders/ → all clips render, manifest written
//   - no-op: twice with no changes → zero re-renders (E4 idempotency)
//   - partial: change captions.ass for c03 → only c03 re-renders
//   - --force: re-renders all regardless of hashes (E3)
//   - --dry-run: shows diff, no manifest mutation (E1)
//   - --only c02: restricts to subset
//   - ai_costs preservation: pillar-2 block survives cf-edit rewrites (E7)

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
const CF_EDIT     = resolvePath(PLUGIN_ROOT, 'bin', 'cf-edit');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

const HAS_FFMPEG  = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing'
            : !HAS_FFPROBE ? 'ffprobe missing'
            : null;

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-edit-itest-')); }

function buildDarkMp4(workDir, label, durS, w = 320, h = 180) {
  mkdirSync(workDir, { recursive: true });
  const mp4 = join(workDir, label + '.mp4');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=' + w + 'x' + h + ':r=30:d=' + durS,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + durS + ':sample_rate=22050',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', mp4,
  ]);
  if (r.status !== 0) throw new Error('buildDarkMp4: ' + r.stderr);
  return mp4;
}

function writeIdentityCrop(path, targetW = 1080, targetH = 1920, srcW = 320, srcH = 180) {
  writeFileSync(path, JSON.stringify({
    version: 2, source_w: srcW, source_h: srcH,
    target_w: targetW, target_h: targetH,
    samples: [], interp: 'linear', mode: 'center', detector: 'identity',
    fallback_used: false, fallback_reason: null,
  }) + '\n');
}

function setupProject(work, { numClips = 2 } = {}) {
  // Layout:
  //   <work>/clips/demo/c01/edit.json (+ c02, ...)
  //   <work>/uploads/demo/source.mp4
  //   <work>/renders/demo/ (created on first run)
  const slug = 'demo';
  const uploadsDir = join(work, 'uploads', slug);
  mkdirSync(uploadsDir, { recursive: true });
  const src = buildDarkMp4(uploadsDir, 'source', 3.0);
  const clipsDir = join(work, 'clips', slug);
  const editPaths = [];
  for (let i = 0; i < numClips; i++) {
    const id = 'c' + String(i + 1).padStart(2, '0');
    const dir = join(clipsDir, id);
    mkdirSync(dir, { recursive: true });
    const cropP = join(dir, 'crop.json');
    writeIdentityCrop(cropP);
    const outP = join(work, 'renders', slug, id + '.mp4');
    const editP = join(dir, 'edit.json');
    writeFileSync(editP, JSON.stringify({
      version: 1, clip_id: id,
      source: src, crop_path: cropP,
      start_ms: 0, end_ms: 2500, quality: 'fast',
      output: outP,
    }, null, 2) + '\n');
    editPaths.push({ id, editP, cropP, outP });
  }
  return { slug, src, editPaths, work };
}

function runEdit(work, slug, args = [], env = {}) {
  return spawnSync('node', [CF_EDIT,
    '--slug', slug,
    '--clips-root',   join(work, 'clips'),
    '--renders-root', join(work, 'renders'),
    ...args,
  ], { encoding: 'utf-8', cwd: PLUGIN_ROOT, env: { ...process.env, ...env } });
}

function parseEvents(stdout) {
  return String(stdout || '').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

test('cf-edit: cold start renders all clips, writes manifest',
  { skip: SKIP || false, timeout: 180_000 }, () => {
    const work = tmp();
    try {
      const { slug, editPaths } = setupProject(work, { numClips: 2 });
      const r = runEdit(work, slug);
      assert.equal(r.status, 0, 'cold-start must exit 0; stderr=' + (r.stderr || '').slice(-400));
      const events = parseEvents(r.stdout);
      const done = events.find((e) => e.event === 'done');
      assert.ok(done, 'must emit event: "done"');
      assert.deepEqual(done.stale.sort(), ['c01', 'c02']);
      // Manifest exists.
      const mfPath = join(work, 'renders', slug, 'render_manifest.json');
      assert.ok(existsSync(mfPath), 'manifest must be written on cold-start');
      const mf = JSON.parse(readFileSync(mfPath, 'utf-8'));
      assert.equal(mf.slug, slug);
      assert.ok(mf.clips.c01 && mf.clips.c01.input_hashes,
        'c01 must have input_hashes recorded');
      assert.ok(mf.clips.c01.input_hashes.edit_json.startsWith('sha256:'));
      // Output files exist.
      for (const e of editPaths) {
        assert.ok(existsSync(e.outP), 'output must exist for ' + e.id);
      }
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('cf-edit: idempotent — second run with no changes re-renders zero clips (E4)',
  { skip: SKIP || false, timeout: 180_000 }, () => {
    const work = tmp();
    try {
      const { slug } = setupProject(work, { numClips: 2 });
      const r1 = runEdit(work, slug);
      assert.equal(r1.status, 0, 'cold-start must succeed');
      const r2 = runEdit(work, slug);
      assert.equal(r2.status, 0, 'second run must exit 0');
      const events = parseEvents(r2.stdout);
      const done = events.find((e) => e.event === 'done');
      assert.ok(done, 'must emit event: "done"');
      assert.deepEqual(done.stale, [], 'second run must report zero stale clips; got ' +
        JSON.stringify(done.stale));
      // No render_start events on second run.
      const renderStarts = events.filter((e) => e.event === 'render_start');
      assert.equal(renderStarts.length, 0, 'no clips should re-render; got ' + renderStarts.length);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('cf-edit: partial — touching c02 edit.json → only c02 re-renders',
  { skip: SKIP || false, timeout: 180_000 }, () => {
    const work = tmp();
    try {
      const { slug, editPaths } = setupProject(work, { numClips: 2 });
      const r1 = runEdit(work, slug);
      assert.equal(r1.status, 0);
      // Mutate c02's edit.json (change start_ms).
      const c02 = editPaths[1];
      const edit = JSON.parse(readFileSync(c02.editP, 'utf-8'));
      edit.start_ms = 100;
      writeFileSync(c02.editP, JSON.stringify(edit, null, 2) + '\n');
      const r2 = runEdit(work, slug);
      assert.equal(r2.status, 0, 'partial re-render must succeed');
      const events = parseEvents(r2.stdout);
      const done = events.find((e) => e.event === 'done');
      assert.deepEqual(done.stale, ['c02'],
        'only c02 must be stale; got ' + JSON.stringify(done.stale));
      const renderStarts = events.filter((e) => e.event === 'render_start');
      assert.equal(renderStarts.length, 1);
      assert.equal(renderStarts[0].clip_id, 'c02');
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('cf-edit --force: re-renders all clips regardless of hashes (E3)',
  { skip: SKIP || false, timeout: 180_000 }, () => {
    const work = tmp();
    try {
      const { slug } = setupProject(work, { numClips: 2 });
      const r1 = runEdit(work, slug);
      assert.equal(r1.status, 0);
      const r2 = runEdit(work, slug, ['--force']);
      assert.equal(r2.status, 0);
      const events = parseEvents(r2.stdout);
      const done = events.find((e) => e.event === 'done');
      assert.deepEqual(done.stale.sort(), ['c01', 'c02']);
      const reasons = events.filter((e) => e.event === 'render_start').map((e) => e.reason);
      assert.ok(reasons.every((r) => r === 'force'),
        'all render_start events must report reason=force; got ' + JSON.stringify(reasons));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('cf-edit --dry-run: prints stale set, performs no work (E1)',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const { slug } = setupProject(work, { numClips: 2 });
      const r = runEdit(work, slug, ['--dry-run']);
      assert.equal(r.status, 0);
      const events = parseEvents(r.stdout);
      const diff = events.find((e) => e.event === 'diff');
      assert.ok(diff, 'dry-run must emit a diff event');
      assert.equal(diff.dry_run, true);
      assert.deepEqual(diff.stale.sort(), ['c01', 'c02']);
      // No manifest written on dry-run.
      const mfPath = join(work, 'renders', slug, 'render_manifest.json');
      assert.equal(existsSync(mfPath), false,
        'dry-run must NOT write a manifest; found ' + mfPath);
      // No render_start events.
      const renderStarts = events.filter((e) => e.event === 'render_start');
      assert.equal(renderStarts.length, 0);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('cf-edit --only c02: restricts to subset',
  { skip: SKIP || false, timeout: 180_000 }, () => {
    const work = tmp();
    try {
      const { slug } = setupProject(work, { numClips: 2 });
      const r = runEdit(work, slug, ['--only', 'c02']);
      assert.equal(r.status, 0);
      const events = parseEvents(r.stdout);
      const done = events.find((e) => e.event === 'done');
      assert.deepEqual(done.stale, ['c02']);
      // Manifest must NOT carry c01 (not in the --only scope).
      const mfPath = join(work, 'renders', slug, 'render_manifest.json');
      const mf = JSON.parse(readFileSync(mfPath, 'utf-8'));
      assert.ok(mf.clips.c02, 'c02 must be in manifest');
      assert.equal(!!mf.clips.c01, false, 'c01 must not be in manifest (not in --only)');
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('cf-edit: pillar-2 ai_costs block preserved across rewrites (E7)',
  { skip: SKIP || false, timeout: 180_000 }, () => {
    const work = tmp();
    try {
      const { slug } = setupProject(work, { numClips: 1 });
      // Seed render_manifest with a pillar-2 ai_costs block before cf-edit runs.
      const mfPath = join(work, 'renders', slug, 'render_manifest.json');
      mkdirSync(dirname(mfPath), { recursive: true });
      const seed = {
        version: 1, slug,
        ai_costs: {
          cumulative_usd: 0.42,
          budget_cap_usd: 10,
          breakdown: { elevenlabs_tts: 0.30, groq_translate: 0.12 },
          skipped: [],
          history: [{ ts: '2026-05-21T00:00:00Z', provider: 'elevenlabs', kind: 'tts',
                      delta_usd: 0.30, clip_id: 'c01', lang: 'id' }],
        },
      };
      writeFileSync(mfPath, JSON.stringify(seed, null, 2) + '\n');
      const r = runEdit(work, slug);
      assert.equal(r.status, 0);
      const mf = JSON.parse(readFileSync(mfPath, 'utf-8'));
      assert.equal(mf.ai_costs.cumulative_usd, 0.42,
        'pillar-2 cumulative_usd must survive cf-edit rewrite');
      assert.equal(mf.ai_costs.breakdown.elevenlabs_tts, 0.30,
        'pillar-2 breakdown must survive cf-edit rewrite');
      assert.equal(mf.ai_costs.history[0].provider, 'elevenlabs',
        'pillar-2 history must survive cf-edit rewrite');
      assert.ok(mf.clips.c01, 'pillar-4 clips block must be added alongside ai_costs');
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
