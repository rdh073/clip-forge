// face-tracker.test.mjs — pure-logic tests, no model required.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FaceTracker, iou } from './face-tracker.mjs';

function face(x, y, w = 200, h = 200, extra = {}) {
  return { x, y, w, h, ...extra };
}

test('iou: identical boxes → 1.0', () => {
  const a = face(500, 500);
  assert.equal(iou(a, a), 1);
});

test('iou: non-overlapping boxes → 0', () => {
  assert.equal(iou(face(0, 0), face(1000, 1000)), 0);
});

test('iou: half-overlapping in x → 1/3', () => {
  // a=[400..600] b=[500..700], intersection=[500..600] width=100, height=200
  // intersection area = 100*200 = 20000
  // union = 2*40000 - 20000 = 60000
  // iou = 20000/60000 = 1/3
  const a = face(500, 500);
  const b = face(600, 500);
  assert.ok(Math.abs(iou(a, b) - 1/3) < 1e-6, 'expected ~0.333, got ' + iou(a, b));
});

test('tracker: sticky ID across overlapping frames', () => {
  const t = new FaceTracker({});
  const r1 = t.assignIds([face(500, 500)], 0);
  const r2 = t.assignIds([face(510, 505)], 100);     // tiny drift → same ID
  const r3 = t.assignIds([face(520, 510)], 200);     // more drift, still overlapping
  assert.equal(r1[0].id, r2[0].id);
  assert.equal(r2[0].id, r3[0].id);
});

test('tracker: new ID when IoU drops below threshold', () => {
  const t = new FaceTracker({ iouThreshold: 0.3 });
  const r1 = t.assignIds([face(500, 500)], 0);
  // jump well beyond bbox extent → IoU 0
  const r2 = t.assignIds([face(1500, 500)], 100);
  assert.notEqual(r1[0].id, r2[0].id);
});

test('tracker: distinct simultaneous faces get distinct IDs', () => {
  const t = new FaceTracker({});
  const r = t.assignIds([face(300, 300), face(1500, 300)], 0);
  assert.equal(r.length, 2);
  assert.notEqual(r[0].id, r[1].id);
});

test('tracker: stale tracks are reaped', () => {
  const t = new FaceTracker({ staleAfterMs: 1000 });
  t.assignIds([face(500, 500)], 0);
  assert.equal(t._internalTrackCount, 1);
  // 1500 ms later, no face in frame
  t.assignIds([], 1500);
  assert.equal(t._internalTrackCount, 0);
});

test('tracker: greedy matching is deterministic per input order', () => {
  // When two candidate tracks could each match an incoming face, the first
  // incoming face claims the best match; the second one falls through to
  // either a worse match or a new ID.
  const t = new FaceTracker({ iouThreshold: 0.3 });
  t.assignIds([face(500, 500), face(700, 500)], 0);
  // Both incoming faces sit between the two prior tracks; whoever comes
  // first gets the best-overlap ID; the second face also gets reassigned
  // (since its IoU with the remaining track may still be high).
  const r = t.assignIds([face(550, 500), face(650, 500)], 100);
  assert.equal(r.length, 2);
  assert.notEqual(r[0].id, r[1].id);
});

test('tracker: reset clears state', () => {
  const t = new FaceTracker({});
  t.assignIds([face(500, 500)], 0);
  assert.equal(t._internalTrackCount, 1);
  t.reset();
  assert.equal(t._internalTrackCount, 0);
  // Next assignment should re-issue id 1.
  const r = t.assignIds([face(500, 500)], 100);
  assert.equal(r[0].id, 1);
});
