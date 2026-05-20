// primary-detect.test.mjs — unit tests for v0.4.0 pillar 5 face-yield gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadCropStats, detectsPrimaryFace, gateAiOnSegment, FACE_YIELD_THRESHOLD,
} from './primary-detect.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-primary-test-')); }

function writeCropPath(path, stats) {
  writeFileSync(path, JSON.stringify({
    version: 2, source_w: 1920, source_h: 1080, target_w: 1080, target_h: 1920,
    samples: [{ t_ms: 0, cx: 960, cy: 540, scale: 1.5 }],
    stats,
  }));
}

test('loadCropStats: missing file → null', () => {
  assert.equal(loadCropStats('/nope.json'), null);
});

test('loadCropStats: valid file → {framesProcessed, framesWithFace, yield_ratio}', () => {
  const t = tmp();
  const p = join(t, 'crop.json');
  writeCropPath(p, { framesProcessed: 100, framesWithFace: 60 });
  const s = loadCropStats(p);
  assert.equal(s.framesProcessed, 100);
  assert.equal(s.framesWithFace, 60);
  assert.equal(s.yield_ratio, 0.6);
  rmSync(t, { recursive: true, force: true });
});

test('loadCropStats: no stats block → null', () => {
  const t = tmp();
  const p = join(t, 'crop.json');
  writeFileSync(p, JSON.stringify({ version: 2, samples: [] }));
  assert.equal(loadCropStats(p), null);
  rmSync(t, { recursive: true, force: true });
});

test('detectsPrimaryFace: yield > 0.5 → overlaps_primary=true', () => {
  const stats = { framesProcessed: 400, framesWithFace: 300, yield_ratio: 0.75 };
  const r = detectsPrimaryFace(stats, { start_ms: 0, end_ms: 3000 });
  assert.equal(r.overlaps_primary, true);
  assert.equal(r.reason, 'avatar_overlaps_primary_face');
});

test('detectsPrimaryFace: yield = 0.1 → overlaps_primary=false', () => {
  const stats = { framesProcessed: 500, framesWithFace: 50, yield_ratio: 0.10 };
  const r = detectsPrimaryFace(stats, { start_ms: 0, end_ms: 3000 });
  assert.equal(r.overlaps_primary, false);
});

test('detectsPrimaryFace: null stats → false (no_crop_stats)', () => {
  assert.deepEqual(detectsPrimaryFace(null).overlaps_primary, false);
  assert.equal(detectsPrimaryFace(null).reason, 'no_crop_stats');
});

test('detectsPrimaryFace: framesProcessed=0 → false (no_frames_processed)', () => {
  const r = detectsPrimaryFace({ framesProcessed: 0, framesWithFace: 0, yield_ratio: 0 });
  assert.equal(r.overlaps_primary, false);
  assert.equal(r.reason, 'no_frames_processed');
});

test('gateAiOnSegment: segment.is_primary:true → refused with is_primary_segment', () => {
  const seg = { id: 's1', is_primary: true, start_ms: 0, end_ms: 3000 };
  const r = gateAiOnSegment({ segment: seg, cropStats: null });
  assert.equal(r.allowed, false);
  assert.equal(r.refusal_reason, 'is_primary_segment');
});

test('gateAiOnSegment: clean segment + low face yield → allowed', () => {
  const seg = { id: 's1', is_primary: false, start_ms: 0, end_ms: 3000 };
  const stats = { framesProcessed: 100, framesWithFace: 10, yield_ratio: 0.10 };
  const r = gateAiOnSegment({ segment: seg, cropStats: stats });
  assert.equal(r.allowed, true);
});

test('gateAiOnSegment: clean segment + high face yield → refused', () => {
  const seg = { id: 's1', is_primary: false, start_ms: 0, end_ms: 3000 };
  const stats = { framesProcessed: 100, framesWithFace: 75, yield_ratio: 0.75 };
  const r = gateAiOnSegment({ segment: seg, cropStats: stats });
  assert.equal(r.allowed, false);
  assert.equal(r.refusal_reason, 'avatar_overlaps_primary_face');
});

test('FACE_YIELD_THRESHOLD is 0.5', () => {
  assert.equal(FACE_YIELD_THRESHOLD, 0.5);
});
