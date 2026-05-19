#!/usr/bin/env node
// Bench: @vladmandic/face-api (TF.js + SSD MobileNet v1).
// Installs @vladmandic/face-api + @tensorflow/tfjs-node + canvas in a temp dir.
//
// Exit code: 0 if a face was detected in Node, 1 otherwise.

import { runBench, printAndExit } from './_bench-lib.mjs';

const runner = `
import * as faceapi from '@vladmandic/face-api';
import { Canvas, Image, ImageData, loadImage } from 'canvas';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Monkey-patch the DOM globals face-api expects.
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// Models live on the upstream repo; download to a local dir for the bench.
const modelDir = './face-api-models';
mkdirSync(modelDir, { recursive: true });
const base = 'https://raw.githubusercontent.com/vladmandic/face-api/master/model/';
const modelFiles = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
];
for (const f of modelFiles) {
  const dest = join(modelDir, f);
  if (existsSync(dest)) continue;
  const r = await fetch(base + f);
  if (!r.ok) throw new Error('model fetch failed: ' + f + ' ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(dest, buf);
}

const t0 = performance.now();
await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir);
await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
const initMs = performance.now() - t0;

const samplePath = process.argv[2];
const img = await loadImage(samplePath);

const t1 = performance.now();
const first = await faceapi.detectAllFaces(img).withFaceLandmarks();
const firstMs = performance.now() - t1;

const times = [];
for (let i = 0; i < 100; i++) {
  const t = performance.now();
  await faceapi.detectAllFaces(img).withFaceLandmarks();
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);

const f0 = first[0];
const landmarks = f0 && f0.landmarks ? f0.landmarks.positions.length : 0;
const out = {
  library: '@vladmandic/face-api',
  version: faceapi.version || 'unknown',
  init_ms: Math.round(initMs),
  first_detect_ms: Math.round(firstMs),
  median_detect_ms: Math.round(times[Math.floor(times.length / 2)]),
  p95_detect_ms: Math.round(times[Math.floor(times.length * 0.95)]),
  face_count: first.length,
  has_478_landmarks: landmarks >= 400,
  has_tracking_id: false,
  works_in_node: first.length > 0,
  landmarks_per_face: landmarks,
};
console.log(JSON.stringify(out));
`;

const result = await runBench({
  label: '@vladmandic/face-api',
  installArgs: ['@vladmandic/face-api', '@tensorflow/tfjs-node', 'canvas'],
  runnerSource: runner,
  installTimeoutMs: 600_000, // canvas + tfjs-node both native
  runTimeoutMs: 240_000,
});
printAndExit(result);
