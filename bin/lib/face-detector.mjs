// face-detector.mjs — Ultraface RFB-320 face detector via onnxruntime-node.
//
// v0.2.0 reactivation: replaces the v0.1.x @mediapipe/tasks-vision integration
// (browser-only, didn't run in Node). Now uses a pure-ONNX path with
// onnxruntime-node + sharp — works on every Node ≥ 20, no engine ceiling.
//
// Public API (unchanged shape from v0.1.x):
//   await initDetector({ modelPath?, minConfidence? })
//   isDetectorReady() → boolean
//   getDisabledReason() → string|null
//   await detectFaces(rgbBytes, width, height, tMs, srcWidth, srcHeight) → Face[]
//   closeDetector()
//
// where Face = {
//   x, y, w, h         // bbox center + dims in SOURCE coords
//   confidence         // 0..1
//   keypoints          // {} in Phase 2A (Ultraface = boxes only).
//                      // Phase 2B will populate {right_eye, left_eye, nose, mouth, ...}
//                      // via a PFLD landmark stage.
// }
//
// Note: detectFaces is now `async` (was sync in v0.1.x). All callers in
// cf-reframe were already inside an async loop; the change is transparent
// after adding `await`.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

// Ultraface RFB-320 input dimensions.
const MODEL_W = 320;
const MODEL_H = 240;
const HW = MODEL_H * MODEL_W;

// Detection + NMS thresholds. Match the conservative defaults the bench used.
const DEFAULT_SCORE_THRESHOLD = 0.7;
const NMS_IOU_THRESHOLD = 0.3;

let _session = null;
let _initPromise = null;
let _disabled = false;
let _disabledReason = null;
let _scoreThreshold = DEFAULT_SCORE_THRESHOLD;
let _inputName = 'input';
let _scoresKey = 'scores';
let _boxesKey = 'boxes';

/**
 * Initialize the singleton detector. Safe to call multiple times — only the
 * first call performs work. Never throws — on failure, the detector is
 * marked disabled and detectFaces() returns []. Inspect `getDisabledReason()`
 * to see why.
 */
export async function initDetector(opts = {}) {
  if (_session) return _session;
  if (_disabled) return null;
  if (_initPromise) return _initPromise;

  _scoreThreshold = opts.minConfidence ?? DEFAULT_SCORE_THRESHOLD;

  _initPromise = (async () => {
    const modelPath = opts.modelPath || resolve(PLUGIN_ROOT, 'bin/models/face_detector.onnx');
    if (!existsSync(modelPath) || statSync(modelPath).size < 500_000) {
      _disabled = true;
      _disabledReason = 'model_missing: ' + modelPath + ' — run `node bin/install-models.mjs`';
      return null;
    }

    try {
      _session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
      });
      // Be defensive about the input/output names — Ultraface uses 'input',
      // 'scores', 'boxes' but other ONNX exports may differ.
      if (_session.inputNames && _session.inputNames.length > 0) _inputName = _session.inputNames[0];
      const outNames = _session.outputNames || [];
      const scoresCandidate = outNames.find((n) => /score/i.test(n));
      const boxesCandidate  = outNames.find((n) => /box/i.test(n));
      if (scoresCandidate) _scoresKey = scoresCandidate;
      if (boxesCandidate)  _boxesKey  = boxesCandidate;
      return _session;
    } catch (e) {
      _disabled = true;
      _disabledReason = 'detector_create_failed: ' + e.message;
      return null;
    }
  })();

  const r = await _initPromise;
  _initPromise = null;
  return r;
}

export function isDetectorReady() { return !!_session; }
export function getDisabledReason() { return _disabledReason; }

/**
 * Run the detector on a single frame.
 *
 * @param {Uint8Array|Buffer} rgbBytes  width*height*3 RGB
 * @param {number} width   frame width (downsampled)
 * @param {number} height  frame height (downsampled)
 * @param {number} tMs     frame timestamp (unused by Ultraface but kept for API parity)
 * @param {number} sourceWidth   original source width (for bbox up-projection)
 * @param {number} sourceHeight  original source height
 */
export async function detectFaces(rgbBytes, width, height, tMs, sourceWidth, sourceHeight) {
  if (!_session) return [];

  let resized;
  try {
    resized = await sharp(Buffer.from(rgbBytes.buffer, rgbBytes.byteOffset, rgbBytes.byteLength), {
      raw: { width, height, channels: 3 },
    })
      .resize(MODEL_W, MODEL_H, { fit: 'fill' })
      .raw()
      .toBuffer();
  } catch {
    return [];
  }

  // Normalize HWC RGB → CHW Float32, mean-subtract 127, scale 1/128.
  const chw = new Float32Array(3 * HW);
  for (let y = 0; y < MODEL_H; y++) {
    for (let x = 0; x < MODEL_W; x++) {
      const i = (y * MODEL_W + x) * 3;
      const j = y * MODEL_W + x;
      chw[0 * HW + j] = (resized[i + 0] - 127) / 128;
      chw[1 * HW + j] = (resized[i + 1] - 127) / 128;
      chw[2 * HW + j] = (resized[i + 2] - 127) / 128;
    }
  }
  const tensor = new ort.Tensor('float32', chw, [1, 3, MODEL_H, MODEL_W]);

  let scoresArr, boxesArr;
  try {
    const out = await _session.run({ [_inputName]: tensor });
    scoresArr = out[_scoresKey].data;
    boxesArr  = out[_boxesKey].data;
  } catch {
    return [];
  }

  // Decode scores (N, 2) + boxes (N, 4). Score index 1 = face class.
  const N = scoresArr.length / 2;
  const candidates = [];
  for (let i = 0; i < N; i++) {
    const conf = scoresArr[i * 2 + 1];
    if (conf < _scoreThreshold) continue;
    candidates.push({
      xmin: boxesArr[i * 4 + 0],
      ymin: boxesArr[i * 4 + 1],
      xmax: boxesArr[i * 4 + 2],
      ymax: boxesArr[i * 4 + 3],
      conf,
    });
  }

  // NMS — greedy, IoU > 0.3 suppresses.
  candidates.sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const c of candidates) {
    let suppress = false;
    for (const k of kept) {
      if (iou(c, k) > NMS_IOU_THRESHOLD) { suppress = true; break; }
    }
    if (!suppress) kept.push(c);
  }
  // Cap to top-3 by confidence. Downstream stages (PFLD landmark, active-
  // speaker scorer) only USE the chosen face; running landmarks on every
  // post-NMS candidate burns budget without changing the pick. Three slots
  // is enough headroom for genuine multi-speaker frames.
  if (kept.length > 3) kept.length = 3;

  // Up-project normalized [0,1] boxes to source coordinates.
  return kept.map((b) => {
    const cx = ((b.xmin + b.xmax) / 2) * sourceWidth;
    const cy = ((b.ymin + b.ymax) / 2) * sourceHeight;
    const w  = (b.xmax - b.xmin) * sourceWidth;
    const h  = (b.ymax - b.ymin) * sourceHeight;
    return {
      x: cx,
      y: cy,
      w, h,
      confidence: b.conf,
      keypoints: {}, // Phase 2B: PFLD will populate { right_eye, left_eye, nose, mouth, right_ear, left_ear }
    };
  });
}

export function closeDetector() {
  try { if (_session && typeof _session.release === 'function') _session.release(); }
  catch {}
  _session = null;
  _initPromise = null;
  _disabled = false;
  _disabledReason = null;
}

function iou(a, b) {
  const xL = Math.max(a.xmin, b.xmin);
  const yT = Math.max(a.ymin, b.ymin);
  const xR = Math.min(a.xmax, b.xmax);
  const yB = Math.min(a.ymax, b.ymax);
  if (xR <= xL || yB <= yT) return 0;
  const inter = (xR - xL) * (yB - yT);
  const aArea = (a.xmax - a.xmin) * (a.ymax - a.ymin);
  const bArea = (b.xmax - b.xmin) * (b.ymax - b.ymin);
  return inter / (aArea + bArea - inter);
}
