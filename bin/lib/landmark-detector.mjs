// landmark-detector.mjs — PFLD 68-point face-landmark detector.
//
// Pipeline placement: Ultraface gives us face bounding boxes; this module
// crops each face (with a small margin), runs PFLD against the crop, and
// returns the bbox augmented with a structured 68-point keypoint object.
//
// Coordinate convention: keypoints are returned in **source-frame
// coordinates** (same convention as face-detector.mjs), so downstream code
// (active-speaker.mjs, the renderer) doesn't need to know which crop the
// landmark came from.
//
// Graceful degradation: if the PFLD model is missing or initialization
// fails, detectLandmarks() returns the input faces UNCHANGED (empty
// keypoints). active-speaker.mjs auto-renormalizes to no-mouth weights in
// that case — proven path from Phase 2A.
//
// Public API:
//   await initLandmarker({ modelPath? })       — idempotent
//   isLandmarkerReady() → boolean
//   getLandmarkerReason() → string|null
//   await detectLandmarks(face, frameRgb, frameW, frameH, srcW, srcH) → augmented Face
//   closeLandmarker()

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

// PFLD canonical input
const MODEL_W = 112;
const MODEL_H = 112;
const HW = MODEL_H * MODEL_W;

// 10 % padding on each side of the bbox before cropping — gives PFLD some
// context around the face so the cnn isn't fed a half-jaw.
const CROP_PAD_FRAC = 0.10;

let _session = null;
let _initPromise = null;
let _disabled = false;
let _disabledReason = null;
let _inputName = 'input';
let _outputName = 'output';

export async function initLandmarker(opts = {}) {
  if (_session) return _session;
  if (_disabled) return null;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const modelPath = opts.modelPath || resolve(PLUGIN_ROOT, 'bin/models/face_landmark.onnx');
    if (!existsSync(modelPath) || statSync(modelPath).size < 1_000_000) {
      _disabled = true;
      _disabledReason = 'landmark_model_missing: ' + modelPath + ' — run `node bin/install-models.mjs`';
      return null;
    }
    try {
      _session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
      if (_session.inputNames && _session.inputNames.length > 0) _inputName = _session.inputNames[0];
      if (_session.outputNames && _session.outputNames.length > 0) _outputName = _session.outputNames[0];
      return _session;
    } catch (e) {
      _disabled = true;
      _disabledReason = 'landmark_create_failed: ' + e.message;
      return null;
    }
  })();

  const r = await _initPromise;
  _initPromise = null;
  return r;
}

export function isLandmarkerReady() { return !!_session; }
export function getLandmarkerReason() { return _disabledReason; }

/**
 * Augment a Face object with 68-point landmarks. Returns the face unchanged
 * (with `keypoints: {}` plus diagnostic fields) when the landmarker isn't
 * ready or per-face inference fails.
 *
 * @param {Face} face         — Output of face-detector (in source coords)
 * @param {Uint8Array} rgb    — full-frame RGB at frame_w × frame_h (downsampled)
 * @param {number} frameW
 * @param {number} frameH
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 */
export async function detectLandmarks(face, rgb, frameW, frameH, sourceWidth, sourceHeight) {
  if (!_session) return face;

  // Compute padded crop region in SOURCE coords from the face bbox.
  const halfW = face.w / 2;
  const halfH = face.h / 2;
  const padW = face.w * CROP_PAD_FRAC;
  const padH = face.h * CROP_PAD_FRAC;
  const cropL = Math.max(0, Math.floor(face.x - halfW - padW));
  const cropT = Math.max(0, Math.floor(face.y - halfH - padH));
  const cropR = Math.min(sourceWidth,  Math.ceil(face.x + halfW + padW));
  const cropB = Math.min(sourceHeight, Math.ceil(face.y + halfH + padH));
  const cropW = cropR - cropL;
  const cropH = cropB - cropT;
  if (cropW < 8 || cropH < 8) return face;

  // The RGB buffer we have is downsampled (frameW × frameH). Map crop coords
  // from source-space to frame-space for sharp's extract().
  const fsx = frameW / sourceWidth;
  const fsy = frameH / sourceHeight;
  const fL = Math.max(0, Math.floor(cropL * fsx));
  const fT = Math.max(0, Math.floor(cropT * fsy));
  const fW = Math.min(frameW - fL, Math.max(1, Math.floor(cropW * fsx)));
  const fH = Math.min(frameH - fT, Math.max(1, Math.floor(cropH * fsy)));

  let cropped;
  try {
    cropped = await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength),
                         { raw: { width: frameW, height: frameH, channels: 3 } })
      .extract({ left: fL, top: fT, width: fW, height: fH })
      .resize(MODEL_W, MODEL_H, { fit: 'fill' })
      .raw()
      .toBuffer();
  } catch {
    return face;
  }

  // PFLD normalization: uint8 [0,255] → [0,1], CHW Float32.
  const chw = new Float32Array(3 * HW);
  for (let y = 0; y < MODEL_H; y++) {
    for (let x = 0; x < MODEL_W; x++) {
      const i = (y * MODEL_W + x) * 3;
      const j = y * MODEL_W + x;
      chw[0 * HW + j] = cropped[i + 0] / 255;
      chw[1 * HW + j] = cropped[i + 1] / 255;
      chw[2 * HW + j] = cropped[i + 2] / 255;
    }
  }
  const tensor = new ort.Tensor('float32', chw, [1, 3, MODEL_H, MODEL_W]);

  let coords;
  try {
    const out = await _session.run({ [_inputName]: tensor });
    coords = out[_outputName].data; // length 136 (68 × 2)
    if (!coords || coords.length !== 136) return face;
  } catch {
    return face;
  }

  // Map 68 normalized [0,1] coords → source-frame pixels. The crop occupies
  // (cropL..cropR, cropT..cropB) in source coords, so the un-projection is
  // straightforward.
  const pts = new Array(68);
  for (let i = 0; i < 68; i++) {
    const nx = coords[i * 2];
    const ny = coords[i * 2 + 1];
    pts[i] = {
      x: cropL + nx * cropW,
      y: cropT + ny * cropH,
    };
  }

  // dlib / Multi-PIE 68-point indexing
  const keypoints = {
    jaw:        pts.slice(0, 17),
    eyebrowL:   pts.slice(17, 22),
    eyebrowR:   pts.slice(22, 27),
    nose:       pts.slice(27, 36),
    eyeL:       pts.slice(36, 42),
    eyeR:       pts.slice(42, 48),
    mouthOuter: pts.slice(48, 60),
    mouthInner: pts.slice(60, 68),
    // Backward-compat aliases consumed by active-speaker.mjs's mouth cue.
    mouth: centroid(pts.slice(48, 60)),
    eyeL_center: centroid(pts.slice(36, 42)),
    eyeR_center: centroid(pts.slice(42, 48)),
    // Raw flat list — handy for callers that want a dense landmark dump.
    all: pts,
  };

  return { ...face, keypoints };
}

export function closeLandmarker() {
  try { if (_session && typeof _session.release === 'function') _session.release(); }
  catch {}
  _session = null;
  _initPromise = null;
  _disabled = false;
  _disabledReason = null;
}

function centroid(points) {
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  return { x: sx / points.length, y: sy / points.length };
}
