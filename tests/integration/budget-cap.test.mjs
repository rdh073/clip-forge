// budget-cap.test.mjs — v0.4.0 pillar 5 cumulative budget cap integration.
//
// Verifies the 80%/100% checkpoint contract across the new paid skills
// (broll-ai, avatar) AND that pillar-2/pillar-4 ai_costs fields survive
// byte-for-byte (modulo additive breakdown keys).

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
const CF_AVATAR   = join(PLUGIN_ROOT, 'bin', 'cf-avatar');
const VISUAL_MOCK = join(PLUGIN_ROOT, 'tests', 'mocks', 'visual-mock.mjs');
const AVATAR_MOCK = join(PLUGIN_ROOT, 'tests', 'mocks', 'avatar-mock.mjs');

function which(bin) {
  const r = spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf-8' });
  return r.status === 0;
}

const SKIP = !(existsSync(CF_BROLL_AI) && existsSync(CF_AVATAR) &&
               existsSync(VISUAL_MOCK) && existsSync(AVATAR_MOCK) && which('ffmpeg'))
             ? 'pillar 5 dispatchers / mocks / ffmpeg missing' : false;

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-budget-test-')); }

function setupAvatar(wd) {
  mkdirSync(join(wd, 'clips', 'podcast', 'c01'), { recursive: true });
  mkdirSync(join(wd, 'renders', 'podcast'), { recursive: true });
  writeFileSync(join(wd, 'clips', 'podcast', 'c01', 'crop_path.json'),
                JSON.stringify({ version: 2, samples: [], stats: { framesProcessed: 100, framesWithFace: 5 } }));
  const photo = join(wd, 'p.jpg'); writeFileSync(photo, Buffer.from([0xff, 0xd8]));
  const audio = join(wd, 'a.wav'); writeFileSync(audio, Buffer.alloc(44));
  return { photo, audio };
}

function setupBroll(wd, segCount = 5) {
  mkdirSync(join(wd, 'clips', 'podcast', 'c01'), { recursive: true });
  mkdirSync(join(wd, 'renders', 'podcast'), { recursive: true });
  const segments = [];
  for (let i = 0; i < segCount; i++) {
    segments.push({
      id: 's' + i, sentence: 'item ' + i,
      start_ms: i * 3000, end_ms: (i + 1) * 3000,
      source: 'pexels', score: 0.3, is_primary: false,
    });
  }
  writeFileSync(join(wd, 'clips', 'podcast', 'c01', 'broll.json'),
                JSON.stringify({ version: 1, clip_id: 'c01', segments }, null, 2));
  writeFileSync(join(wd, 'clips', 'podcast', 'c01', 'crop_path.json'),
                JSON.stringify({ version: 2, samples: [], stats: { framesProcessed: 100, framesWithFace: 5 } }));
}

function runBrollAi({ wd, env = {} }) {
  const r = spawnSync(process.execPath, [CF_BROLL_AI, '--slug', 'podcast', '--clip-id', 'c01', '--max-cutaways', '10'], {
    cwd: wd, encoding: 'utf-8',
    env: {
      ...process.env,
      FAL_API_KEY: '', GEMINI_API_KEY: '', REPLICATE_API_TOKEN: '',
      CF_VISUAL_MOCK: VISUAL_MOCK,
      ...env,
    },
  });
  const events = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return { exit: r.status, events, done: events.find((e) => e.event === 'done') };
}

function runAvatar({ wd, photo, audio, env = {} }) {
  const consentLog = join(wd, '.consent-log');
  const r = spawnSync(process.execPath, [
    CF_AVATAR, '--slug', 'podcast', '--clip-id', 'c01',
    '--photo', photo, '--audio', audio, '--duration-ms', '3000',
    '--consent-log', consentLog,
  ], {
    cwd: wd, encoding: 'utf-8',
    env: {
      ...process.env,
      HEYGEN_API_KEY: '', DID_API_KEY: '', FAL_API_KEY: '',
      CF_AVATAR_MOCK: AVATAR_MOCK,
      CF_AVATAR_CONSENT: '1',
      CF_CONSENT_MOCK: 'auto-yes',
      ...env,
    },
  });
  const events = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return { exit: r.status, events, done: events.find((e) => e.event === 'done') };
}

test('budget: 100% hard-stop — pre-seeded manifest at cap → broll-ai exits with budget_exhausted', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupBroll(wd, 3);
  // Pre-seed cumulative_usd at exactly the cap.
  writeFileSync(join(wd, 'renders', 'podcast', 'render_manifest.json'),
                JSON.stringify({
                  version: 1, schema: 'render_manifest.v1', slug: 'podcast',
                  ai_costs: { cumulative_usd: 0.10, budget_cap_usd: 0.10,
                              breakdown: {}, skipped: [], history: [] },
                }, null, 2));
  const { exit, done } = runBrollAi({ wd, env: { CF_AI_BUDGET_USD: '0.10' } });
  assert.equal(exit, 0);
  assert.ok(done.budget_exhausted, 'budget_exhausted must be true at 100% cap');
  assert.equal(done.generated, 0);
  rmSync(wd, { recursive: true, force: true });
});

test('budget: 80% checkpoint fires AskUserQuestion event mid-chain', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupBroll(wd, 5);
  // estCost when no real provider + mock active is 0.04. Pre-seed at 50%
  // ($0.05/$0.10). Next $0.04 charge → 90% (allowed=true, checkpoint_hit=true).
  writeFileSync(join(wd, 'renders', 'podcast', 'render_manifest.json'),
                JSON.stringify({
                  version: 1, schema: 'render_manifest.v1', slug: 'podcast',
                  ai_costs: { cumulative_usd: 0.05, budget_cap_usd: 0.10,
                              breakdown: {}, skipped: [], history: [] },
                }, null, 2));
  const { events } = runBrollAi({ wd, env: { CF_AI_BUDGET_USD: '0.10' } });
  const checkpoint = events.find((e) => e.event === 'budget_checkpoint');
  assert.ok(checkpoint, 'expected budget_checkpoint event to fire crossing 80% line');
  assert.ok(checkpoint.used_pct >= 80, 'checkpoint used_pct should be >= 80');
  rmSync(wd, { recursive: true, force: true });
});

test('budget: --yolo silent skip at 100% — no checkpoint prompts even crossing 80%', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupBroll(wd, 5);
  writeFileSync(join(wd, 'renders', 'podcast', 'render_manifest.json'),
                JSON.stringify({
                  version: 1, schema: 'render_manifest.v1', slug: 'podcast',
                  ai_costs: { cumulative_usd: 0.05, budget_cap_usd: 0.10,
                              breakdown: {}, skipped: [], history: [] },
                }, null, 2));
  // The dispatcher should not emit a budget_checkpoint under --yolo.
  const r = spawnSync(process.execPath, [
    CF_BROLL_AI, '--slug', 'podcast', '--clip-id', 'c01', '--max-cutaways', '10', '--yolo',
  ], {
    cwd: wd, encoding: 'utf-8',
    env: { ...process.env, FAL_API_KEY: '', GEMINI_API_KEY: '', REPLICATE_API_TOKEN: '',
           CF_VISUAL_MOCK: VISUAL_MOCK, CF_AI_BUDGET_USD: '0.10' },
  });
  const events = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  const checkpoint = events.find((e) => e.event === 'budget_checkpoint');
  assert.equal(checkpoint, undefined, 'no checkpoint event should fire under --yolo');
  rmSync(wd, { recursive: true, force: true });
});

test('budget: pillar-2 + pillar-4 fields preserved when broll-ai writes manifest', { skip: SKIP || false }, () => {
  const wd = tmp();
  setupBroll(wd, 2);
  // Pre-seed manifest with pillar-2 dub spend + pillar-4 LLM spend + extra
  // top-level "clips" block (pillar 4 contract).
  const before = {
    version: 1, schema: 'render_manifest.v1', slug: 'podcast',
    created_at: '2026-05-20T00:00:00Z',
    clips: {
      c01: {
        output: './renders/podcast/c01.mp4',
        rendered_at: '2026-05-20T00:00:01Z',
        rendered_sha256: 'sha256:deadbeef',
        rerender_reason: 'manual',
        input_hashes: { edit_json: 'sha256:abc', crop_path: null, captions_ass: null,
                         cuts_plan: null, audio_source: null, brand_kit: null },
      },
    },
    ai_costs: {
      cumulative_usd: 0.34,
      budget_cap_usd: 10.00,
      breakdown: { elevenlabs_tts: 0.30, groq_llm: 0.04 },
      skipped: [],
      history: [
        { ts: '2026-05-20T00:00:00Z', provider: 'elevenlabs', kind: 'tts',
          delta_usd: 0.30, clip_id: 'c01', lang: 'id' },
        { ts: '2026-05-20T00:00:00Z', provider: 'groq', kind: 'llm',
          delta_usd: 0.04, clip_id: 'c01', lang: null },
      ],
    },
  };
  writeFileSync(join(wd, 'renders', 'podcast', 'render_manifest.json'),
                JSON.stringify(before, null, 2));
  const { exit } = runBrollAi({ wd });
  assert.equal(exit, 0);
  const after = JSON.parse(readFileSync(join(wd, 'renders', 'podcast', 'render_manifest.json'), 'utf-8'));
  // Pillar-4 clips block byte-survives.
  assert.deepEqual(after.clips, before.clips);
  // Pillar-2 history entries survive.
  assert.equal(after.ai_costs.history.length >= 2, true);
  assert.equal(after.ai_costs.history[0].provider, 'elevenlabs');
  assert.equal(after.ai_costs.history[1].provider, 'groq');
  // Pillar-2 breakdown keys survive.
  assert.equal(after.ai_costs.breakdown.elevenlabs_tts, 0.30);
  assert.equal(after.ai_costs.breakdown.groq_llm, 0.04);
  // New pillar-5 breakdown key was appended additively.
  assert.ok(after.ai_costs.breakdown.mock_visual !== undefined ||
            after.ai_costs.breakdown.fal_visual !== undefined ||
            after.ai_costs.breakdown.nanobanana_visual !== undefined ||
            after.ai_costs.breakdown.replicate_visual !== undefined,
            'visual breakdown key must be added');
  rmSync(wd, { recursive: true, force: true });
});

test('budget: avatar charge stacks on top of dub charges in same manifest', { skip: SKIP || false, timeout: 30_000 }, () => {
  const wd = tmp();
  const { photo, audio } = setupAvatar(wd);
  // Pre-seed with a dub charge from pillar 2.
  writeFileSync(join(wd, 'renders', 'podcast', 'render_manifest.json'),
                JSON.stringify({
                  version: 1, schema: 'render_manifest.v1', slug: 'podcast',
                  ai_costs: { cumulative_usd: 0.50, budget_cap_usd: 10.00,
                              breakdown: { elevenlabs_tts: 0.50 },
                              skipped: [], history: [
                                { ts: 'X', provider: 'elevenlabs', kind: 'tts',
                                  delta_usd: 0.50, clip_id: 'c01', lang: 'id' },
                              ] },
                }, null, 2));
  const { exit, done } = runAvatar({ wd, photo, audio });
  assert.equal(exit, 0);
  assert.equal(done.generated, 1);
  const after = JSON.parse(readFileSync(join(wd, 'renders', 'podcast', 'render_manifest.json'), 'utf-8'));
  // Stack — cumulative must be >= 0.50 + mock avatar cost.
  assert.ok(after.ai_costs.cumulative_usd > 0.50);
  assert.equal(after.ai_costs.breakdown.elevenlabs_tts, 0.50);
  rmSync(wd, { recursive: true, force: true });
});
