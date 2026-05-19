// face-detector.mjs — singleton wrapper around @mediapipe/tasks-vision's
// FaceDetector (BlazeFace short-range). Designed to be init-once, reuse for
// every frame, and degrade gracefully when MediaPipe can't load (missing
// model, WASM runtime issue, etc).
//
// Coordinates returned are in the *source* image frame, not the downsampled
// one — callers pass the downsample factor so we can up-project.
//
// Public API:
//   await initDetector({ modelPath, minConfidence?, runningMode? })
//   detectFaces(rgbBytes, width, height, tMs, sourceScale = 1) → Face[]
//   closeDetector()
//
// where Face = {
//   x, y,            // bbox center in SOURCE coords
//   w, h,            // bbox dims in SOURCE coords
//   confidence,      // 0..1
//   keypoints: { right_eye, left_eye, nose, mouth, right_ear, left_ear } each {x,y} in SOURCE coords
// }

// v0.1.2 STATUS — known broken in Node:
//
// @mediapipe/tasks-vision is a browser-first SDK. It mounts DOM nodes
// (document.createElement('canvas'), document.body.appendChild, ...) during
// FaceDetector.createFromOptions() with no Node-detection branches. Shimming
// is whack-a-mole and was abandoned in favour of a library swap planned for
// v0.2.0 (see docs/ROADMAP.md).
//
// This module is kept so cf-reframe's pipeline shape stays intact, but
// initDetector() ALWAYS marks the detector disabled with reason
// "node_unsupported". Every cf-reframe invocation therefore falls back to
// center-crop with an explicit reason in crop_path.json.fallback_reason.
//
// The pure-JS pieces in this file (rgbToRgba, mapKeypoints, coordinate
// up-projection) will be reused when v0.2.0 swaps in @vladmandic/human or
// similar.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

let _detector = null;
let _initPromise = null;
let _disabled = false;
let _disabledReason = null;

/**
 * Initialize the singleton detector. Safe to call multiple times — only the
 * first call performs work; subsequent calls await the same promise.
 *
 * Never throws — on failure marks the detector "disabled" and `detectFaces`
 * returns []. Callers should check `isDetectorReady()` if they care.
 */
export async function initDetector(opts = {}) {
  if (_detector) return _detector;
  if (_disabled) return null;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // v0.1.2: hard-disable in Node — see file header. We still validate the
    // model file exists so users get a useful warning when they haven't run
    // install-models, but we don't attempt to construct the MediaPipe detector.
    const modelPath = opts.modelPath || resolve(PLUGIN_ROOT, 'bin/models/face_detector.tflite');
    if (!existsSync(modelPath) || statSync(modelPath).size < 100_000) {
      _disabled = true;
      _disabledReason = 'model_missing: ' + modelPath + ' — run `node bin/install-models.mjs`';
      return null;
    }

    _disabled = true;
    _disabledReason = 'mediapipe_not_supported_in_node: @mediapipe/tasks-vision is browser-only and currently does not run in Node. v0.2.0 swaps to a Node-compatible detector — see docs/ROADMAP.md.';
    return null;
  })();

  const r = await _initPromise;
  _initPromise = null;
  return r;
}

export function isDetectorReady() { return !!_detector; }
export function getDisabledReason() { return _disabledReason; }

/**
 * Run the detector on a single frame. Returns an array of Face objects with
 * coordinates already up-projected to the source frame size (caller supplies
 * sourceWidth/sourceHeight).
 *
 * @param {Uint8Array} rgbBytes      Width*Height*3 RGB bytes
 * @param {number}     width         Width of the rgbBytes frame (downsampled)
 * @param {number}     height        Height of the rgbBytes frame (downsampled)
 * @param {number}     tMs           Frame timestamp in ms (must be monotonically increasing for VIDEO mode)
 * @param {number}     sourceWidth   Original source width (for coord up-projection)
 * @param {number}     sourceHeight  Original source height
 */
export function detectFaces(rgbBytes, width, height, tMs, sourceWidth, sourceHeight) {
  if (!_detector) return [];
  const sx = sourceWidth / width;
  const sy = sourceHeight / height;

  // MediaPipe Tasks Vision accepts an ImageData-like bag: { data, width, height }
  // where data is RGBA. So we expand RGB→RGBA on the fly.
  const rgba = rgbToRgba(rgbBytes, width, height);
  const imageData = { data: rgba, width, height };

  let res;
  try {
    res = _detector.detectForVideo(imageData, tMs);
  } catch (e) {
    // Don't poison subsequent frames; just drop this one.
    return [];
  }

  const detections = (res && res.detections) || [];
  return detections.map((d) => {
    const bb = d.boundingBox || {};
    const cx = (bb.originX + bb.width / 2) * sx;
    const cy = (bb.originY + bb.height / 2) * sy;
    const kp = mapKeypoints(d.keypoints || [], width, height, sx, sy);
    const cat = (d.categories || [])[0];
    return {
      x: cx,
      y: cy,
      w: bb.width * sx,
      h: bb.height * sy,
      confidence: cat ? cat.score : 0,
      keypoints: kp,
    };
  });
}

export function closeDetector() {
  try { if (_detector && typeof _detector.close === 'function') _detector.close(); }
  catch {}
  _detector = null;
  _disabled = false;
  _disabledReason = null;
}

// ---- helpers ----

function rgbToRgba(rgb, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j]     = rgb[i];
    out[j + 1] = rgb[i + 1];
    out[j + 2] = rgb[i + 2];
    out[j + 3] = 255;
  }
  return out;
}

// MediaPipe BlazeFace short-range emits six keypoints in this order:
//   0: right_eye, 1: left_eye, 2: nose_tip, 3: mouth_center, 4: right_ear_tragion, 5: left_ear_tragion
// Each keypoint has normalized x/y in [0,1] across the input frame.
const KP_ORDER = ['right_eye', 'left_eye', 'nose', 'mouth', 'right_ear', 'left_ear'];

function mapKeypoints(kps, w, h, sx, sy) {
  const out = {};
  for (let i = 0; i < KP_ORDER.length; i++) {
    const k = kps[i];
    if (!k) continue;
    out[KP_ORDER[i]] = {
      x: k.x * w * sx,
      y: k.y * h * sy,
    };
  }
  return out;
}
