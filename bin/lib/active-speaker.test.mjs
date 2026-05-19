// active-speaker.test.mjs — pure unit tests, no MediaPipe required.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActiveSpeakerTracker, parseSpeakerMap, autoCalibrateSpeakerMap,
} from './active-speaker.mjs';

function fakeFace({ x, y, w = 200, h = 200, confidence = 0.9, mouthX, mouthY }) {
  return {
    x, y, w, h, confidence,
    keypoints: { mouth: { x: mouthX ?? x, y: mouthY ?? (y + 30) } },
  };
}

const FRAME_W = 1920, FRAME_H = 1080;

test('parseSpeakerMap: named slots', () => {
  const m = parseSpeakerMap('0:left,1:right');
  assert.deepEqual(m, { 0: { x: 0.25, y: 0.5 }, 1: { x: 0.75, y: 0.5 } });
});

test('parseSpeakerMap: explicit numeric pairs', () => {
  const m = parseSpeakerMap('0:0.25,0.5,1:0.75,0.5');
  assert.deepEqual(m, { 0: { x: 0.25, y: 0.5 }, 1: { x: 0.75, y: 0.5 } });
});

test('parseSpeakerMap: auto', () => {
  assert.equal(parseSpeakerMap('auto'), 'auto');
});

test('parseSpeakerMap: none/off/empty → null', () => {
  assert.equal(parseSpeakerMap('none'), null);
  assert.equal(parseSpeakerMap('off'), null);
  assert.equal(parseSpeakerMap(''), null);
  assert.equal(parseSpeakerMap(null), null);
});

test('parseSpeakerMap: mixed named + numeric not supported, returns null gracefully', () => {
  const m = parseSpeakerMap('garbage');
  assert.equal(m, null);
});

test('autoCalibrateSpeakerMap picks median position per speaker', () => {
  // Speaker 0 talks at t=0..1000ms; faces at (480,540) consistently
  // Speaker 1 talks at t=1500..2500ms; faces at (1440,540) consistently
  const transcript = {
    words: [
      { w: 'one',   start_ms: 0,    end_ms: 1000, speaker: 0 },
      { w: 'two',   start_ms: 1500, end_ms: 2500, speaker: 1 },
    ],
  };
  const samples = [
    { tMs: 100,  faces: [fakeFace({ x: 480,  y: 540, w: 300, h: 300, confidence: 0.9 })] },
    { tMs: 500,  faces: [fakeFace({ x: 482,  y: 542, w: 300, h: 300, confidence: 0.9 })] },
    { tMs: 800,  faces: [fakeFace({ x: 478,  y: 540, w: 300, h: 300, confidence: 0.9 })] },
    { tMs: 1700, faces: [fakeFace({ x: 1440, y: 540, w: 300, h: 300, confidence: 0.9 })] },
    { tMs: 2100, faces: [fakeFace({ x: 1438, y: 542, w: 300, h: 300, confidence: 0.9 })] },
    { tMs: 2400, faces: [fakeFace({ x: 1442, y: 540, w: 300, h: 300, confidence: 0.9 })] },
  ];
  const m = autoCalibrateSpeakerMap(samples, transcript, FRAME_W, FRAME_H);
  assert.ok(m['0'], 'speaker 0 should be mapped');
  assert.ok(m['1'], 'speaker 1 should be mapped');
  assert.ok(Math.abs(m['0'].x - 0.25) < 0.02, 'speaker 0 x should be ~0.25');
  assert.ok(Math.abs(m['1'].x - 0.75) < 0.02, 'speaker 1 x should be ~0.75');
});

test('tracker: highest-confidence face wins when active-speaker disabled', () => {
  const tracker = new ActiveSpeakerTracker({ disableActiveSpeaker: true });
  const faces = [
    fakeFace({ x: 480,  y: 540, confidence: 0.6 }),
    fakeFace({ x: 1440, y: 540, confidence: 0.95 }),
  ];
  const r = tracker.pickActiveFace(faces, { tMs: 0, frameWidth: FRAME_W, frameHeight: FRAME_H });
  assert.equal(r.face.x, 1440);
});

test('tracker: switching damper holds chosen target for ≥0.8s', () => {
  // Two faces with mouth-movement priority. Initially face A moves a lot;
  // then face A goes silent and face B starts moving. The tracker should
  // NOT switch until 800ms have passed.
  const tracker = new ActiveSpeakerTracker({});
  const A = (mx) => fakeFace({ x: 480,  y: 540, mouthX: mx, mouthY: 540 });
  const B = (mx) => fakeFace({ x: 1440, y: 540, mouthX: mx, mouthY: 540 });

  // Phase 1 (0..500ms): A is moving, B is still. A should be chosen.
  for (let t = 0; t < 500; t += 100) {
    // Move A's mouth each frame; B's mouth steady.
    const r = tracker.pickActiveFace([A(480 + (t % 50)), B(1440)],
                                      { tMs: t, frameWidth: FRAME_W, frameHeight: FRAME_H });
    assert.ok(r.face);
  }
  const stateBefore = tracker._currentId;
  assert.ok(stateBefore != null);

  // Phase 2 (500..1100ms): A goes still; B starts moving. Within 800ms of
  // first lock, the tracker should hold on A (the original).
  for (let t = 500; t < 1100; t += 100) {
    tracker.pickActiveFace([A(480), B(1440 + ((t - 500) % 50))],
                           { tMs: t, frameWidth: FRAME_W, frameHeight: FRAME_H });
    assert.equal(tracker._currentId, stateBefore, 'must hold within 0.8s + 24 frames');
  }
});

test('tracker: switching allowed after cooldown', () => {
  const tracker = new ActiveSpeakerTracker({ switchCooldownMs: 200, frameLockN: 3 });
  const A = fakeFace({ x: 480,  y: 540, mouthX: 480, mouthY: 540 });
  const B = fakeFace({ x: 1440, y: 540, mouthX: 1440, mouthY: 540 });

  // Lock onto A first
  for (let t = 0; t < 200; t += 50) {
    tracker.pickActiveFace([{ ...A, keypoints: { mouth: { x: 480 + (t % 30), y: 540 } } }, B],
                           { tMs: t, frameWidth: FRAME_W, frameHeight: FRAME_H });
  }
  const aId = tracker._currentId;

  // After 500ms with B clearly winning, we should switch.
  for (let t = 300; t < 800; t += 50) {
    tracker.pickActiveFace([A, { ...B, keypoints: { mouth: { x: 1440 + (t % 30), y: 540 } } }],
                           { tMs: t, frameWidth: FRAME_W, frameHeight: FRAME_H });
  }
  assert.notEqual(tracker._currentId, aId, 'tracker should switch after cooldown');
});

test('tracker: empty faces → no chosen face, currentId preserved', () => {
  const tracker = new ActiveSpeakerTracker({});
  const A = fakeFace({ x: 480, y: 540 });
  tracker.pickActiveFace([A], { tMs: 0, frameWidth: FRAME_W, frameHeight: FRAME_H });
  const before = tracker._currentId;
  const r = tracker.pickActiveFace([], { tMs: 100, frameWidth: FRAME_W, frameHeight: FRAME_H });
  assert.equal(r.face, null);
  assert.equal(tracker._currentId, before);
});

test('tracker: deterministic with fixed inputs + weights', () => {
  // Same inputs, fresh tracker → same outputs every time.
  const make = () => new ActiveSpeakerTracker({
    weights: { audio: 0, mouth: 0.5, central: 0.5, confidence: 0 },
  });
  const A = fakeFace({ x: 480, y: 540, confidence: 0.6, mouthX: 480, mouthY: 540 });
  const B = fakeFace({ x: 1500, y: 540, confidence: 0.9, mouthX: 1500, mouthY: 540 });
  const run = () => {
    const t = make();
    return t.pickActiveFace([A, B], { tMs: 0, frameWidth: FRAME_W, frameHeight: FRAME_H }).face.x;
  };
  const a = run();
  const b = run();
  assert.equal(a, b);
});
