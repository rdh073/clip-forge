#!/usr/bin/env node
// Bench: @vladmandic/human (TF.js backend, 478-point mesh).
// Installs @vladmandic/human + @tensorflow/tfjs-node in a temp dir.
//
// Exit code: 0 if a face was detected in Node, 1 otherwise.

import { runBench, printAndExit } from './_bench-lib.mjs';

const runner = `
import Human from '@vladmandic/human';
import { readFileSync } from 'node:fs';

const samplePath = process.argv[2];
const buf = readFileSync(samplePath);

// Construct Human. modelBasePath supports a local "file://" prefix or remote
// URL. We use the public CDN; downloads happen on first call to load().
const HumanCtor = Human.Human || Human.default || Human;
const human = new HumanCtor({
  modelBasePath: 'https://vladmandic.github.io/human-models/models/',
  cacheSensitivity: 0,
  debug: false,
  face: { enabled: true, detector: { rotation: false }, mesh: { enabled: true }, iris: { enabled: false }, description: { enabled: false } },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
});

const t0 = performance.now();
await human.load();
const initMs = performance.now() - t0;

// Decode the JPEG to a tensor. human.tf exposes the TFJS instance.
const tf = human.tf;
let tensor;
if (tf && tf.node && tf.node.decodeImage) {
  tensor = tf.node.decodeImage(buf, 3);
} else if (tf && tf.tidy && tf.tensor3d) {
  // Fallback: pure-JS JPEG decode would be needed. Mark works_in_node = false.
  throw new Error('tfjs-node decodeImage unavailable; install @tensorflow/tfjs-node');
}

const t1 = performance.now();
const first = await human.detect(tensor);
const firstMs = performance.now() - t1;

const times = [];
for (let i = 0; i < 100; i++) {
  const t = performance.now();
  await human.detect(tensor);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const med = times[Math.floor(times.length / 2)];
const p95 = times[Math.floor(times.length * 0.95)];

const f0 = first.face[0];
const out = {
  library: '@vladmandic/human',
  version: HumanCtor.version || Human.version || 'unknown',
  init_ms: Math.round(initMs),
  first_detect_ms: Math.round(firstMs),
  median_detect_ms: Math.round(med),
  p95_detect_ms: Math.round(p95),
  face_count: first.face.length,
  has_478_landmarks: !!(f0 && f0.mesh && f0.mesh.length >= 400),
  has_tracking_id: !!(f0 && (f0.id !== undefined)),
  works_in_node: first.face.length > 0,
};
console.log(JSON.stringify(out));
`;

const result = await runBench({
  label: '@vladmandic/human',
  installArgs: ['@vladmandic/human', '@tensorflow/tfjs-node'],
  runnerSource: runner,
  installTimeoutMs: 600_000, // tfjs-node native binary download is slow
  runTimeoutMs: 240_000,     // first run downloads models
});
printAndExit(result);
