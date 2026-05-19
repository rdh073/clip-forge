// face-detector.test.mjs — exercises the singleton detector wrapper without
// requiring the MediaPipe model to be present. Tests that touch real
// detection are skipped (not failed) when the fixture/model is absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initDetector, detectFaces, closeDetector, isDetectorReady, getDisabledReason,
} from './face-detector.mjs';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const MODEL_PATH = resolve(PLUGIN_ROOT, 'bin/models/face_detector.tflite');
const FIXTURE_SINGLE_FACE = resolve(PLUGIN_ROOT, 'tests/fixtures/single-face.rgb');
const FIXTURE_EMPTY = resolve(PLUGIN_ROOT, 'tests/fixtures/empty-room.rgb');
const FIXTURE_DIM_PATH = resolve(PLUGIN_ROOT, 'tests/fixtures/dims.json');

function hasModel() {
  return existsSync(MODEL_PATH) && statSync(MODEL_PATH).size > 100_000;
}
function hasFixture(p) { return existsSync(p); }

function loadDims() {
  try {
    const { readFileSync } = require('node:fs');
    return JSON.parse(readFileSync(FIXTURE_DIM_PATH, 'utf-8'));
  } catch { return null; }
}

test('initDetector is idempotent (returns same instance on second call)', async () => {
  // We don't need the real model for this test — the wrapper either returns
  // the same disabled state twice OR the same detector instance twice.
  closeDetector();
  const a = await initDetector({ modelPath: '/nonexistent/path.tflite' });
  const b = await initDetector({ modelPath: '/nonexistent/path.tflite' });
  assert.equal(a, b, 'second init should return the same value as the first');
  assert.equal(isDetectorReady(), false, 'detector should be disabled when model path is bogus');
  assert.match(getDisabledReason() || '', /model_missing/,
    'reason should mention model_missing for a bogus modelPath');
  closeDetector();
});

test('closeDetector resets state so initDetector can run again', async () => {
  await initDetector({ modelPath: '/nonexistent/path.tflite' });
  closeDetector();
  // After close, the disabled flag should be cleared so a fresh init can succeed.
  assert.equal(getDisabledReason(), null);
});

test('detectFaces returns [] when detector is not ready', async () => {
  closeDetector();
  const fakeRgb = new Uint8Array(64 * 48 * 3);
  const out = await detectFaces(fakeRgb, 64, 48, 0, 1920, 1080);
  assert.deepEqual(out, []);
});

test('single-face fixture (skipped when fixture or model missing)', { skip: !(hasModel() && hasFixture(FIXTURE_SINGLE_FACE)) }, async () => {
  const { readFileSync } = await import('node:fs');
  const rgb = new Uint8Array(readFileSync(FIXTURE_SINGLE_FACE));
  const dims = loadDims();
  if (!dims) { assert.fail('tests/fixtures/dims.json missing — run `npm run build-fixtures`'); }

  await initDetector({});
  assert.equal(isDetectorReady(), true, 'detector should init when model is present');
  const out = detectFaces(rgb, dims.width, dims.height, 0, dims.width, dims.height);
  closeDetector();

  assert.ok(out.length >= 1, 'expected ≥1 face detection in single-face fixture');
  const top = out.slice().sort((a, b) => b.confidence - a.confidence)[0];
  assert.ok(top.confidence > 0.5, 'top detection confidence should exceed 0.5');
  // Spatial sanity: the face center should be inside the frame.
  assert.ok(top.x >= 0 && top.x <= dims.width);
  assert.ok(top.y >= 0 && top.y <= dims.height);
});

test('empty-room fixture (skipped when fixture or model missing)', { skip: !(hasModel() && hasFixture(FIXTURE_EMPTY)) }, async () => {
  const { readFileSync } = await import('node:fs');
  const rgb = new Uint8Array(readFileSync(FIXTURE_EMPTY));
  const dims = loadDims();
  if (!dims) return; // already covered by previous test

  await initDetector({});
  const out = detectFaces(rgb, dims.width, dims.height, 0, dims.width, dims.height);
  closeDetector();
  assert.deepEqual(out, [], 'expected zero detections in empty-room fixture');
});
