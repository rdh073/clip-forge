// budget.test.mjs — unit tests for the cumulative-spend tracker.
//
// Coverage:
//   - default cap (CF_AI_BUDGET_USD unset → $10)
//   - projectCharge 80% checkpoint detection
//   - projectCharge 100% would_exceed
//   - recordCharge updates cumulative + breakdown
//   - recordSkip appends to skipped[]
//   - raiseCap honors monotonic-up only
//   - snapshotForReport shape matches schema

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadManifest, saveManifest, projectCharge, recordCharge, recordSkip,
  raiseCap, snapshotForReport, DEFAULT_BUDGET_USD,
} from './budget.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-budget-test-')); }

function freshManifest(cap = DEFAULT_BUDGET_USD) {
  return loadManifest(null, { slug: 't', cap });
}

test('default cap is $10', () => {
  const m = freshManifest();
  assert.equal(m.ai_costs.budget_cap_usd, 10);
});

test('projectCharge: below threshold → allowed, no checkpoint', () => {
  const m = freshManifest(10);
  const r = projectCharge(m, 1.00);
  assert.equal(r.allowed, true);
  assert.equal(r.checkpoint_hit, false);
});

test('projectCharge: crossing 80% triggers checkpoint_hit', () => {
  const m = freshManifest(10);
  m.ai_costs.cumulative_usd = 7.50;  // 75%
  const r = projectCharge(m, 1.00);   // pushes to 85% — crosses 80
  assert.equal(r.checkpoint_hit, true);
  assert.equal(r.allowed, true);
});

test('projectCharge: would_exceed = true at 100% boundary', () => {
  const m = freshManifest(10);
  m.ai_costs.cumulative_usd = 9.50;
  const r = projectCharge(m, 0.60);
  assert.equal(r.allowed, false);
  assert.equal(r.would_exceed, true);
});

test('projectCharge: at exactly cap → allowed (boundary inclusive)', () => {
  const m = freshManifest(10);
  m.ai_costs.cumulative_usd = 9.00;
  const r = projectCharge(m, 1.00);
  assert.equal(r.allowed, true);
});

test('recordCharge: updates cumulative + breakdown + history', () => {
  const m = freshManifest(10);
  recordCharge(m, { provider: 'elevenlabs', kind: 'tts', delta_usd: 0.30, clip_id: 'c01', lang: 'id' });
  recordCharge(m, { provider: 'elevenlabs', kind: 'tts', delta_usd: 0.20, clip_id: 'c01', lang: 'en' });
  recordCharge(m, { provider: 'groq',       kind: 'translate', delta_usd: 0.01, clip_id: 'c01', lang: 'id' });
  assert.equal(+m.ai_costs.cumulative_usd.toFixed(4), 0.51);
  assert.equal(m.ai_costs.breakdown.elevenlabs_tts, 0.5);
  assert.equal(m.ai_costs.breakdown.groq_translate, 0.01);
  assert.equal(m.ai_costs.history.length, 3);
});

test('recordSkip: appends to skipped[]', () => {
  const m = freshManifest(10);
  recordSkip(m, { clip_id: 'c01', lang: 'es', reason: 'budget_exhausted' });
  assert.equal(m.ai_costs.skipped.length, 1);
  assert.equal(m.ai_costs.skipped[0].clip_id, 'c01');
});

test('raiseCap: monotonic up only', () => {
  const m = freshManifest(10);
  raiseCap(m, 20);
  assert.equal(m.ai_costs.budget_cap_usd, 20);
  raiseCap(m, 5);  // ignored — would lower
  assert.equal(m.ai_costs.budget_cap_usd, 20);
});

test('snapshotForReport: shape matches v0.4.0 §8 cross-cutting schema', () => {
  const m = freshManifest(10);
  recordCharge(m, { provider: 'cartesia', kind: 'tts', delta_usd: 0.05, clip_id: 'c01' });
  recordSkip(m, { clip_id: 'c02', lang: 'fr', reason: 'budget_exhausted' });
  const snap = snapshotForReport(m);
  assert.equal(typeof snap.total_usd, 'number');
  assert.equal(snap.breakdown.cartesia_tts, 0.05);
  assert.equal(snap.budget_cap_usd, 10);
  assert.equal(typeof snap.budget_used_pct, 'number');
  assert.equal(snap.budget_exhausted, false);
  assert.equal(snap.skipped_clips.length, 1);
});

test('saveManifest + loadManifest: round-trip preserves ai_costs', () => {
  const d = tmp();
  try {
    const p = join(d, 'render_manifest.json');
    const m = freshManifest(15);
    recordCharge(m, { provider: 'elevenlabs', kind: 'tts', delta_usd: 0.42, clip_id: 'c01' });
    saveManifest(p, m);
    const round = loadManifest(p, { slug: 't' });
    // budget_cap_usd persists from the saved manifest — env default doesn't override.
    assert.equal(round.ai_costs.budget_cap_usd, 15);
    assert.equal(round.ai_costs.cumulative_usd, 0.42);
    assert.equal(round.ai_costs.history.length, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadManifest: missing file → fresh manifest with env-derived cap', () => {
  const d = tmp();
  try {
    // No CF_AI_BUDGET_USD override → DEFAULT_BUDGET_USD.
    const m = loadManifest(join(d, 'nope.json'), { slug: 't' });
    assert.equal(m.ai_costs.budget_cap_usd, DEFAULT_BUDGET_USD);
    assert.equal(m.ai_costs.cumulative_usd, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadManifest: older manifest without ai_costs → migrated additively', () => {
  const d = tmp();
  try {
    const p = join(d, 'render_manifest.json');
    // Simulate a pillar-1-era manifest that pre-dates v0.4.0.
    saveManifest(p, { version: 1, schema: 'render_manifest.v1', slug: 't' });
    const m = loadManifest(p, { slug: 't' });
    assert.ok(m.ai_costs, 'ai_costs block synthesized on load');
    assert.equal(m.ai_costs.cumulative_usd, 0);
    assert.deepEqual(m.ai_costs.skipped, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
