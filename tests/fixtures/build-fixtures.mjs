#!/usr/bin/env node
// build-fixtures.mjs — generates the RGB fixture files used by
// bin/lib/face-detector.test.mjs. The fixture frames need to be real images
// (MediaPipe can't detect a synthetic gradient as a face), so this script
// expects you to drop a PNG into tests/fixtures/ first.
//
// Workflow:
//   1. Place tests/fixtures/single-face.png (any photo with a clearly visible
//      frontal face, ≥320x240) and tests/fixtures/empty-room.png (any scene
//      without a face).
//   2. Run `npm run build-fixtures`. The script extracts a 320x240 rgb24
//      frame from each PNG and writes the .rgb sibling files + a dims.json
//      that records the canonical width/height.
//
// Why not ship the .rgb files directly? They're large (~230 KB each) and
// the source PNGs are tiny in comparison. Keeping the conversion deterministic
// + scripted means the repo doesn't carry hundreds of KB of derived data.

import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const WIDTH = 320;
const HEIGHT = 240;
const ITEMS = [
  { png: resolve(DIR, 'single-face.png'), rgb: resolve(DIR, 'single-face.rgb') },
  { png: resolve(DIR, 'empty-room.png'), rgb: resolve(DIR, 'empty-room.rgb') },
];

function which(cmd) {
  try { return spawnSync('sh', ['-c', 'command -v ' + cmd]).stdout.toString().trim(); }
  catch { return ''; }
}

if (!which('ffmpeg')) {
  process.stderr.write('build-fixtures: ffmpeg is required.\n');
  process.exit(2);
}

let allOk = true;
for (const { png, rgb } of ITEMS) {
  if (!existsSync(png)) {
    process.stderr.write('  ⚠  ' + png + ' missing — see tests/fixtures/README.md\n');
    allOk = false;
    continue;
  }
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', png,
    '-vf', 'scale=' + WIDTH + ':' + HEIGHT,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    rgb,
  ]);
  if (r.status !== 0) {
    process.stderr.write('  ❌ ' + png + ' → ffmpeg failed: ' + r.stderr.toString().slice(-200) + '\n');
    allOk = false;
    continue;
  }
  process.stdout.write('  ✅ ' + rgb + ' (' + statSync(rgb).size + ' bytes)\n');
}

writeFileSync(resolve(DIR, 'dims.json'),
  JSON.stringify({ width: WIDTH, height: HEIGHT }, null, 2) + '\n');

process.exit(allOk ? 0 : 1);
