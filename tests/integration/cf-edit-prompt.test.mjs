// cf-edit-prompt.test.mjs — integration tests for /clip-forge:edit
// prompt mode (v0.4.0 pillar 4, deliverable B).
//
// Coverage:
//   - --prompt with CF_LLM_MOCK → patch applied, clip re-rendered
//   - --dry-run --prompt? we don't bundle that combo; --prompt always applies
//     so the equivalent test is verifying patch_applied + only one render
//   - LLM retry: first response malformed → second succeeds (1 retry max)
//   - LLM patch off-whitelist (mock tries to edit /audio_source) → rejected
//     with off_whitelist
//   - No-LLM degrade: --prompt + no keys → exit 0 with fallback no_llm_provider
//   - Composition gate (CRITICAL §6 brutal-review): initial render +
//     cf-edit --prompt to change hook+aspect → only changed clip re-renders +
//     final MP4 reflects the patch (hook='BARU', dims 1080×1350)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync,
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

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-edit-prompt-')); }

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

function setupSingleClip(work, editExtras = {}) {
  const slug = 'demo';
  const uploads = join(work, 'uploads', slug);
  mkdirSync(uploads, { recursive: true });
  const src = buildDarkMp4(uploads, 'source', 3.0);
  const dir = join(work, 'clips', slug, 'c01');
  mkdirSync(dir, { recursive: true });
  const cropP = join(dir, 'crop.json');
  writeIdentityCrop(cropP);
  const outP = join(work, 'renders', slug, 'c01.mp4');
  const editP = join(dir, 'edit.json');
  writeFileSync(editP, JSON.stringify({
    version: 1, clip_id: 'c01',
    source: src, crop_path: cropP,
    start_ms: 0, end_ms: 2500, quality: 'fast',
    output: outP,
    hook_overlay: { text: 'HALO', end_ms: 1500, position: 'upper-third' },
    target_aspect: '9:16',
    ...editExtras,
  }, null, 2) + '\n');
  return { slug, editP, outP, cropP, src };
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

function writeMockScript(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function withClearedLlmEnv(env) {
  // Test runs CF_EDIT in a child process; we clear all LLM provider keys so
  // the dispatcher MUST use the mock path.
  return {
    ...env,
    GROQ_API_KEY:      undefined,
    ANTHROPIC_API_KEY: undefined,
    CF_LLM_PROVIDER:   undefined,
  };
}

test('cf-edit --prompt with CF_LLM_MOCK: patch applied + clip re-rendered',
  { skip: SKIP || false, timeout: 180_000 }, () => {
    const work = tmp();
    try {
      const { slug, editP, outP } = setupSingleClip(work);
      // Cold-start render once.
      assert.equal(runEdit(work, slug).status, 0, 'cold-start must succeed');
      // Mock LLM returns a valid patch changing hook text + aspect.
      const mockPath = join(work, 'mock-llm.mjs');
      writeMockScript(mockPath, `
        let data = '';
        process.stdin.on('data', (b) => { data += b; });
        process.stdin.on('end', () => {
          process.stdout.write(JSON.stringify({
            text: JSON.stringify({
              patch: [
                { op: 'replace', path: '/hook_overlay/text', value: 'BARU' },
                { op: 'replace', path: '/target_aspect', value: '4:5' },
              ],
              warning: null,
            }),
            cost_usd: 0.0008,
          }));
        });
      `);
      const r = runEdit(work, slug,
        ['--prompt', 'change hook to BARU and aspect to 4:5', '--auto-apply'],
        withClearedLlmEnv({ CF_LLM_MOCK: mockPath }));
      assert.equal(r.status, 0, 'prompt-mode must exit 0; stderr=' + (r.stderr || '').slice(-400));
      const events = parseEvents(r.stdout);
      const applied = events.find((e) => e.event === 'patch_applied');
      assert.ok(applied, 'must emit patch_applied event');
      assert.equal(applied.clip_id, 'c01');
      // Verify edit.json on disk reflects the patch.
      const edit = JSON.parse(readFileSync(editP, 'utf-8'));
      assert.equal(edit.hook_overlay.text, 'BARU');
      assert.equal(edit.target_aspect, '4:5');
      // Output MP4 was re-rendered.
      const renderDone = events.find((e) => e.event === 'render_done' && e.clip_id === 'c01');
      assert.ok(renderDone, 'must emit render_done for c01');
      // Final dims must be 1080×1350 (4:5).
      const probe = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height',
        '-of', 'json', outP,
      ], { encoding: 'utf-8' });
      const v = JSON.parse(probe.stdout).streams[0];
      assert.equal(v.width,  1080, 'patched MP4 must be 1080 wide; got ' + v.width);
      assert.equal(v.height, 1350, 'patched MP4 must be 1350 tall (4:5); got ' + v.height);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('cf-edit --prompt off-whitelist: mock tries to edit /audio_source → rejected',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const { slug, editP } = setupSingleClip(work);
      const mockPath = join(work, 'mock-llm.mjs');
      // Mock always returns an off-whitelist patch (twice — once per retry).
      writeMockScript(mockPath, `
        process.stdout.write(JSON.stringify({
          text: JSON.stringify({
            patch: [{ op: 'replace', path: '/audio_source', value: '/tmp/x.wav' }],
            warning: null,
          }),
          cost_usd: 0.0005,
        }));
      `);
      const editBefore = readFileSync(editP, 'utf-8');
      const r = runEdit(work, slug,
        ['--prompt', 'swap the audio file', '--auto-apply'],
        withClearedLlmEnv({ CF_LLM_MOCK: mockPath }));
      assert.notEqual(r.status, 0, 'off-whitelist patch must reject the run');
      const events = parseEvents(r.stdout);
      const rejected = events.find((e) => e.event === 'llm_patch_rejected');
      assert.ok(rejected, 'must emit llm_patch_rejected event');
      assert.equal(rejected.rejected_reason, 'off_whitelist',
        'rejected_reason must be off_whitelist; got ' + rejected.rejected_reason);
      assert.equal(rejected.retry_count, 2,
        'must retry once before final reject; got retry_count=' + rejected.retry_count);
      // edit.json untouched.
      assert.equal(readFileSync(editP, 'utf-8'), editBefore,
        'edit.json must be byte-identical after rejected patch');
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('cf-edit --prompt retry: first response malformed → retried successfully',
  { skip: SKIP || false, timeout: 180_000 }, () => {
    const work = tmp();
    try {
      const { slug, editP } = setupSingleClip(work);
      assert.equal(runEdit(work, slug).status, 0, 'cold-start must succeed');
      const mockPath = join(work, 'mock-llm.mjs');
      const counterFile = join(work, 'mock-counter');
      writeFileSync(counterFile, '0');
      // First call returns malformed JSON, second call returns a valid patch.
      writeMockScript(mockPath, `
        import { readFileSync, writeFileSync } from 'node:fs';
        const counterFile = ${JSON.stringify(counterFile)};
        const n = parseInt(readFileSync(counterFile, 'utf-8'), 10) || 0;
        writeFileSync(counterFile, String(n + 1));
        if (n === 0) {
          process.stdout.write(JSON.stringify({ text: 'NOT JSON AT ALL', cost_usd: 0.0001 }));
        } else {
          process.stdout.write(JSON.stringify({
            text: JSON.stringify({
              patch: [{ op: 'replace', path: '/hook_overlay/text', value: 'RETRY OK' }],
              warning: null,
            }),
            cost_usd: 0.0004,
          }));
        }
      `);
      const r = runEdit(work, slug,
        ['--prompt', 'change hook to RETRY OK', '--auto-apply'],
        withClearedLlmEnv({ CF_LLM_MOCK: mockPath }));
      assert.equal(r.status, 0, 'retry must succeed; stderr=' + (r.stderr || '').slice(-300));
      const events = parseEvents(r.stdout);
      const applied = events.find((e) => e.event === 'patch_applied');
      assert.ok(applied, 'must emit patch_applied event after retry');
      assert.equal(applied.retry_count, 1, 'retry_count must be 1; got ' + applied.retry_count);
      const edit = JSON.parse(readFileSync(editP, 'utf-8'));
      assert.equal(edit.hook_overlay.text, 'RETRY OK');
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('cf-edit --prompt: no LLM keys → exit 0 with fallback no_llm_provider, diff mode still works',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = tmp();
    try {
      const { slug, editP } = setupSingleClip(work);
      const editBefore = readFileSync(editP, 'utf-8');
      const r = runEdit(work, slug,
        ['--prompt', 'change hook'],
        withClearedLlmEnv({ CF_LLM_MOCK: undefined }));
      assert.equal(r.status, 0, '--prompt with no keys must exit 0 gracefully');
      const events = parseEvents(r.stdout);
      const done = events.find((e) => e.event === 'done' && e.fallback_used === true);
      assert.ok(done, 'must emit done with fallback_used=true');
      assert.equal(done.fallback_reason, 'no_llm_provider');
      // edit.json untouched.
      assert.equal(readFileSync(editP, 'utf-8'), editBefore,
        'edit.json must be untouched when LLM degrades');
      // Diff mode still works on the same slug.
      const r2 = runEdit(work, slug);
      assert.equal(r2.status, 0, 'diff mode must succeed even after --prompt degrade');
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

test('cf-edit composition gate: full pipeline — initial render + prompt-patch + only changed clip re-renders',
  { skip: SKIP || false, timeout: 240_000 }, () => {
    const work = tmp();
    try {
      // 2-clip project; we'll patch only c01, c02 stays untouched.
      const slug = 'demo';
      const uploads = join(work, 'uploads', slug);
      mkdirSync(uploads, { recursive: true });
      const src = buildDarkMp4(uploads, 'source', 3.0);
      const c01dir = join(work, 'clips', slug, 'c01');
      const c02dir = join(work, 'clips', slug, 'c02');
      mkdirSync(c01dir, { recursive: true }); mkdirSync(c02dir, { recursive: true });
      const cropP01 = join(c01dir, 'crop.json'); writeIdentityCrop(cropP01);
      const cropP02 = join(c02dir, 'crop.json'); writeIdentityCrop(cropP02);
      const outP01 = join(work, 'renders', slug, 'c01.mp4');
      const outP02 = join(work, 'renders', slug, 'c02.mp4');
      const editP01 = join(c01dir, 'edit.json');
      const editP02 = join(c02dir, 'edit.json');
      const base = {
        version: 1,
        source: src,
        start_ms: 0, end_ms: 2500, quality: 'fast',
        target_aspect: '9:16',
        hook_overlay: { text: 'HALO', end_ms: 1500, position: 'upper-third' },
      };
      writeFileSync(editP01, JSON.stringify({ ...base, clip_id: 'c01', crop_path: cropP01, output: outP01 }, null, 2) + '\n');
      writeFileSync(editP02, JSON.stringify({ ...base, clip_id: 'c02', crop_path: cropP02, output: outP02 }, null, 2) + '\n');
      // Cold-start renders both.
      assert.equal(runEdit(work, slug).status, 0, 'cold-start must succeed');
      assert.ok(existsSync(outP01) && existsSync(outP02), 'both outputs must exist after cold-start');
      // Patch c01 with an LLM mock that flips hook text + aspect to 4:5.
      const mockPath = join(work, 'mock-llm.mjs');
      writeMockScript(mockPath, `
        process.stdout.write(JSON.stringify({
          text: JSON.stringify({
            patch: [
              { op: 'replace', path: '/hook_overlay/text', value: 'BARU' },
              { op: 'replace', path: '/target_aspect', value: '4:5' },
            ],
            warning: null,
          }),
          cost_usd: 0.0008,
        }));
      `);
      const r = runEdit(work, slug,
        ['--prompt', 'change hook to BARU and aspect to 4:5', '--only', 'c01', '--auto-apply'],
        withClearedLlmEnv({ CF_LLM_MOCK: mockPath }));
      assert.equal(r.status, 0, 'composition prompt must succeed');
      const events = parseEvents(r.stdout);
      // Only c01 re-rendered.
      const renderStarts = events.filter((e) => e.event === 'render_start');
      assert.equal(renderStarts.length, 1);
      assert.equal(renderStarts[0].clip_id, 'c01');
      const c01edit = JSON.parse(readFileSync(editP01, 'utf-8'));
      assert.equal(c01edit.hook_overlay.text, 'BARU');
      assert.equal(c01edit.target_aspect, '4:5');
      // c02 untouched.
      const c02edit = JSON.parse(readFileSync(editP02, 'utf-8'));
      assert.equal(c02edit.hook_overlay.text, 'HALO');
      assert.equal(c02edit.target_aspect, '9:16');
      // Final c01 MP4 dims = 1080×1350.
      const probe = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height',
        '-of', 'json', outP01,
      ], { encoding: 'utf-8' });
      const v = JSON.parse(probe.stdout).streams[0];
      assert.equal(v.width,  1080, 'patched c01 must be 1080 wide; got ' + v.width);
      assert.equal(v.height, 1350, 'patched c01 must be 1350 tall (4:5); got ' + v.height);
      // Manifest reflects c01 re-rendered with rerender_reason input_changed; c02 NOT re-rendered.
      const mfPath = join(work, 'renders', slug, 'render_manifest.json');
      const mf = JSON.parse(readFileSync(mfPath, 'utf-8'));
      assert.ok(mf.clips.c01.rerender_reason &&
        mf.clips.c01.rerender_reason.startsWith('input_changed:'),
        'c01.rerender_reason must include input_changed:; got ' +
        mf.clips.c01.rerender_reason);
      assert.ok(mf.clips.c02, 'c02 must still be in manifest from cold-start');
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
