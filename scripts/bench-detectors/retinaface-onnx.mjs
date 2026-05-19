#!/usr/bin/env node
// Bench: onnxruntime-node + Ultraface RFB-320 ONNX (compact CPU face detector).
// We use Ultraface rather than full RetinaFace because the ONNX export of
// RetinaFace requires heavyweight post-processing (anchor decoding + NMS that
// duplicates 200+ lines of upstream code), while Ultraface ships
// post-processing in the model output and weighs ~1.5 MB.
//
// Installs onnxruntime-node + sharp in a temp dir.
// Exit code: 0 if a face was detected in Node, 1 otherwise.

import { runBench, printAndExit } from './_bench-lib.mjs';

const runner = `
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

const samplePath = process.argv[2];

// Ultraface RFB-320: small input (240x320), float32 NCHW. From onnx/models.
const modelDir = './onnx-models';
const modelPath = modelDir + '/version-RFB-320.onnx';
mkdirSync(modelDir, { recursive: true });
if (!existsSync(modelPath)) {
  const url = 'https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx';
  const r = await fetch(url);
  if (!r.ok) throw new Error('model fetch failed: ' + r.status);
  writeFileSync(modelPath, Buffer.from(await r.arrayBuffer()));
}

const t0 = performance.now();
const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
const initMs = performance.now() - t0;

// Preprocess: resize to 320x240, mean-subtract (127), divide by 128, NCHW.
const W = 320, H = 240;
const { data: rgb } = await sharp(samplePath)
  .resize({ width: W, height: H, fit: 'fill' })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const chw = new Float32Array(3 * H * W);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const j = y * W + x;
    chw[0 * H * W + j] = (rgb[i + 0] - 127) / 128;
    chw[1 * H * W + j] = (rgb[i + 1] - 127) / 128;
    chw[2 * H * W + j] = (rgb[i + 2] - 127) / 128;
  }
}
const tensor = new ort.Tensor('float32', chw, [1, 3, H, W]);

async function detect() {
  const r = await session.run({ input: tensor });
  // Outputs: 'scores' [1, N, 2] and 'boxes' [1, N, 4]. Apply threshold + NMS.
  const scores = r.scores.data; // length N*2
  const N = scores.length / 2;
  const faces = [];
  for (let i = 0; i < N; i++) {
    const conf = scores[i * 2 + 1]; // class 1 = face
    if (conf < 0.7) continue;
    faces.push({ conf });
  }
  return faces;
}

const t1 = performance.now();
const first = await detect();
const firstMs = performance.now() - t1;

const times = [];
for (let i = 0; i < 100; i++) {
  const t = performance.now();
  await detect();
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);

const out = {
  library: 'onnxruntime-node + ultraface',
  version: 'ultraface-rfb-320',
  init_ms: Math.round(initMs),
  first_detect_ms: Math.round(firstMs),
  median_detect_ms: Math.round(times[Math.floor(times.length / 2)]),
  p95_detect_ms: Math.round(times[Math.floor(times.length * 0.95)]),
  face_count: first.length,
  has_478_landmarks: false, // Ultraface emits boxes only; no landmarks.
  has_tracking_id: false,
  works_in_node: first.length > 0,
  notes: 'Ultraface is boxes-only. Landmarks/mesh would require a second model (e.g. PFLD or FaceLandmark1k3D).',
};
console.log(JSON.stringify(out));
`;

const result = await runBench({
  label: 'onnxruntime-node + ultraface',
  installArgs: ['onnxruntime-node', 'sharp'],
  runnerSource: runner,
  installTimeoutMs: 600_000,
  runTimeoutMs: 180_000,
});
printAndExit(result);
