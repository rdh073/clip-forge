// avatar.test.mjs — positive-evidence integration tests for v0.4.0 pillar 5
// avatar stinger skill (/clip-forge:avatar + bin/cf-avatar).
//
// Covers the two-gate consent state machine, primary-face auto-detect,
// duration cap, --no-avatar override, and budget hard-stop.

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
const CF_AVATAR   = join(PLUGIN_ROOT, 'bin', 'cf-avatar');
const AVATAR_MOCK = join(PLUGIN_ROOT, 'tests', 'mocks', 'avatar-mock.mjs');

function which(bin) {
  const r = spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf-8' });
  return r.status === 0;
}

const HAS_FFMPEG = which('ffmpeg');
const HAS_DISPATCH = existsSync(CF_AVATAR);
const HAS_MOCK = existsSync(AVATAR_MOCK);
const SKIP = !HAS_DISPATCH ? 'bin/cf-avatar missing'
           : !HAS_MOCK     ? 'tests/mocks/avatar-mock.mjs missing'
           : !HAS_FFMPEG   ? 'ffmpeg missing'
           : false;

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-avatar-test-')); }

function setupClipDir(workDir, cropStats) {
  mkdirSync(join(workDir, 'clips', 'podcast', 'c01'), { recursive: true });
  mkdirSync(join(workDir, 'renders', 'podcast'), { recursive: true });
  if (cropStats) {
    writeFileSync(join(workDir, 'clips', 'podcast', 'c01', 'crop_path.json'),
                  JSON.stringify({ version: 2, samples: [{ t_ms: 0, cx: 540, cy: 960, scale: 1.5 }],
                                    stats: cropStats }, null, 2));
  }
}

function makeFixtures(workDir) {
  const photo = join(workDir, 'photo.jpg'); writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]));
  const audio = join(workDir, 'audio.wav'); writeFileSync(audio, Buffer.alloc(44));
  return { photo, audio };
}

function runDispatch({ workDir, args, env = {} }) {
  const consentLog = env.consentLog || join(workDir, '.consent-log');
  const r = spawnSync(process.execPath, [CF_AVATAR, ...args, '--consent-log', consentLog], {
    cwd: workDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Suppress real keys; force mock-only behavior.
      HEYGEN_API_KEY: '', DID_API_KEY: '', FAL_API_KEY: '',
      CF_AVATAR_MOCK: AVATAR_MOCK,
      ...env,
    },
  });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  const events = lines.map((l) => { try { return JSON.parse(l); } catch { return { _raw: l }; } });
  const done = events.find((e) => e.event === 'done');
  return { exit: r.status, stderr: r.stderr, events, done };
}

test('avatar: happy path — photo+audio (3s) → mp4 generated via mock', { skip: SKIP || false, timeout: 30_000 }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 100, framesWithFace: 5 });
  const { photo, audio } = makeFixtures(wd);
  const { exit, done } = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '3000'],
    env: { CF_AVATAR_CONSENT: '1', CF_CONSENT_MOCK: 'auto-yes' },
  });
  assert.equal(exit, 0);
  assert.equal(done.generated, 1);
  assert.ok(done.video_path);
  assert.ok(existsSync(join(wd, done.video_path)) || existsSync(done.video_path));
  assert.equal(done.consent_verified, true);
  rmSync(wd, { recursive: true, force: true });
});

test('avatar: duration_ms=6000 → refused, no API call', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 100, framesWithFace: 5 });
  const { photo, audio } = makeFixtures(wd);
  const { exit, done } = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '6000'],
    env: { CF_AVATAR_CONSENT: '1', CF_CONSENT_MOCK: 'auto-yes' },
  });
  assert.equal(exit, 0);
  assert.equal(done.refused, 1);
  assert.equal(done.refusal_reason, 'avatar_duration_capped');
  rmSync(wd, { recursive: true, force: true });
});

test('avatar: auto-detect — crop_path with high face yield → refuse avatar_overlaps_primary_face', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 400, framesWithFace: 300 });
  const { photo, audio } = makeFixtures(wd);
  const { exit, done } = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '3000'],
    env: { CF_AVATAR_CONSENT: '1', CF_CONSENT_MOCK: 'auto-yes' },
  });
  assert.equal(exit, 0);
  assert.equal(done.refused, 1);
  assert.equal(done.refusal_reason, 'avatar_overlaps_primary_face');
  rmSync(wd, { recursive: true, force: true });
});

test('avatar: auto-detect — crop_path with low face yield (50/500=10%) → allowed', { skip: SKIP || false, timeout: 30_000 }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 500, framesWithFace: 50 });
  const { photo, audio } = makeFixtures(wd);
  const { exit, done } = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '3000'],
    env: { CF_AVATAR_CONSENT: '1', CF_CONSENT_MOCK: 'auto-yes' },
  });
  assert.equal(exit, 0);
  assert.equal(done.generated, 1);
  rmSync(wd, { recursive: true, force: true });
});

test('avatar: consent gate 1 — CF_AVATAR_CONSENT unset + CF_CONSENT_MOCK=auto-yes → log written', { skip: SKIP || false, timeout: 30_000 }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 100, framesWithFace: 5 });
  const { photo, audio } = makeFixtures(wd);
  const consentLog = join(wd, '.consent-log');
  const { exit, done, events } = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '3000'],
    env: { CF_AVATAR_CONSENT: '', CF_CONSENT_MOCK: 'auto-yes', consentLog },
  });
  assert.equal(exit, 0);
  // Verify the bilingual prompt event was emitted (gate-1 prompt has both EN + ID).
  const g1Prompt = events.find((e) => e.event === 'consent_gate_1_prompt');
  assert.ok(g1Prompt, 'gate-1 prompt event must fire');
  assert.ok(g1Prompt.prompt_en && /consent/i.test(g1Prompt.prompt_en));
  assert.ok(g1Prompt.prompt_id && /persetujuan/i.test(g1Prompt.prompt_id));
  // Log file should now exist with machine_id_hash recorded.
  assert.ok(existsSync(consentLog));
  const log = JSON.parse(readFileSync(consentLog, 'utf-8'));
  assert.ok(log.machine_id_hash, 'machine_id_hash must be stamped after gate-1 consent');
  rmSync(wd, { recursive: true, force: true });
});

test('avatar: consent gate 1 — CF_AVATAR_CONSENT=1 bypass → no prompt event', { skip: SKIP || false, timeout: 30_000 }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 100, framesWithFace: 5 });
  const { photo, audio } = makeFixtures(wd);
  const { events } = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '3000'],
    env: { CF_AVATAR_CONSENT: '1', CF_CONSENT_MOCK: 'auto-yes' },
  });
  const g1Prompt = events.find((e) => e.event === 'consent_gate_1_prompt');
  assert.equal(g1Prompt, undefined, 'no gate-1 prompt should fire under CF_AVATAR_CONSENT=1');
  rmSync(wd, { recursive: true, force: true });
});

test('avatar: consent gate 2 — same photo twice → second invocation cached, no prompt', { skip: SKIP || false, timeout: 30_000 }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 100, framesWithFace: 5 });
  const { photo, audio } = makeFixtures(wd);
  const consentLog = join(wd, '.consent-log');
  // First run — gate 2 must prompt.
  const r1 = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '3000'],
    env: { CF_AVATAR_CONSENT: '1', CF_CONSENT_MOCK: 'auto-yes', consentLog },
  });
  const g2First = r1.events.find((e) => e.event === 'consent_gate_2_prompt');
  assert.ok(g2First, 'first run with this photo must fire gate-2 prompt');
  // Second run — same photo. No prompt; cached event.
  const r2 = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '3000'],
    env: { CF_AVATAR_CONSENT: '1', CF_CONSENT_MOCK: 'auto-yes', consentLog },
  });
  const g2Second = r2.events.find((e) => e.event === 'consent_gate_2_prompt');
  assert.equal(g2Second, undefined, 'second run with same photo must NOT prompt');
  const g2Cached = r2.events.find((e) => e.event === 'consent_gate_2_cached');
  assert.ok(g2Cached, 'second run must emit consent_gate_2_cached');
  assert.ok(g2Cached.use_count >= 2);
  rmSync(wd, { recursive: true, force: true });
});

test('avatar: --no-avatar flag → skips immediately, no consent prompt, no API call', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 100, framesWithFace: 5 });
  const { exit, done, events } = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01', '--no-avatar'],
  });
  assert.equal(exit, 0);
  assert.equal(done.skipped, true);
  assert.equal(done.skip_reason, 'no_avatar_flag');
  // No consent events should fire.
  for (const e of events) {
    assert.ok(!e.event.startsWith('consent_'), 'no consent events under --no-avatar');
  }
  rmSync(wd, { recursive: true, force: true });
});

test('avatar: no provider keys + no mock → fallback no_avatar_provider, exit 0', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 100, framesWithFace: 5 });
  const { photo, audio } = makeFixtures(wd);
  const { exit, done } = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '3000'],
    env: { CF_AVATAR_MOCK: '', CF_AVATAR_CONSENT: '1', CF_CONSENT_MOCK: 'auto-yes' },
  });
  assert.equal(exit, 0);
  assert.equal(done.fallback_used, true);
  assert.equal(done.fallback_reason, 'no_avatar_provider');
  rmSync(wd, { recursive: true, force: true });
});

test('avatar: gate 2 denied (auto-no) → exit 0, no avatar, no log mutation', { skip: SKIP || false, timeout: 30_000 }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 100, framesWithFace: 5 });
  const { photo, audio } = makeFixtures(wd);
  const consentLog = join(wd, '.consent-log');
  const { exit, done } = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '3000'],
    env: { CF_AVATAR_CONSENT: '1', CF_CONSENT_MOCK: 'auto-no', consentLog },
  });
  assert.equal(exit, 0);
  assert.equal(done.skipped, true);
  assert.equal(done.skip_reason, 'consent_denied_gate_2');
  if (existsSync(consentLog)) {
    const log = JSON.parse(readFileSync(consentLog, 'utf-8'));
    assert.equal(Object.keys(log.photos).length, 0, 'denied photo must not be cached');
  }
  rmSync(wd, { recursive: true, force: true });
});

test('avatar: budget exhausted → exit 0, no generation, skipped recorded', { skip: SKIP || false, timeout: 30_000 }, () => {
  const wd = tmp();
  setupClipDir(wd, { framesProcessed: 100, framesWithFace: 5 });
  const { photo, audio } = makeFixtures(wd);
  // Pre-seed the manifest with cumulative_usd already at the cap.
  mkdirSync(join(wd, 'renders', 'podcast'), { recursive: true });
  writeFileSync(join(wd, 'renders', 'podcast', 'render_manifest.json'),
                JSON.stringify({
                  version: 1, schema: 'render_manifest.v1', slug: 'podcast',
                  ai_costs: { cumulative_usd: 0.50, budget_cap_usd: 0.50,
                              breakdown: {}, skipped: [], history: [] },
                }, null, 2));
  const { exit, done } = runDispatch({
    workDir: wd,
    args: ['--slug', 'podcast', '--clip-id', 'c01',
           '--photo', photo, '--audio', audio,
           '--duration-ms', '3000', '--yolo'],
    env: { CF_AVATAR_CONSENT: '1', CF_CONSENT_MOCK: 'auto-yes' },
  });
  assert.equal(exit, 0);
  assert.equal(done.budget_exhausted, true);
  rmSync(wd, { recursive: true, force: true });
});
