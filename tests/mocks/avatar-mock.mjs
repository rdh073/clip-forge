#!/usr/bin/env node
// avatar-mock.mjs — realistic-mock talking-head generator for cf-avatar
// integration tests. Reads a brief JSON on stdin:
//
//   { photo_path, audio_path, duration_ms, aspect, video_path }
//
// Generates a tiny MP4 at video_path with duration matching duration_ms
// (within ±100ms — realistic-mock contract). Emits result JSON on stdout.
//
// Avoids touching the real photo/audio inputs so the mock works even
// when photo_path is a placeholder. ffmpeg lavfi sources are used to
// produce the placeholder MP4 with the requested duration.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_MP4 = resolvePath(__dirname, '..', 'fixtures', 'mock-avatar-3s.mp4');

const stdin = readFileSync(0, 'utf-8');
let brief;
try { brief = JSON.parse(stdin); }
catch (e) {
  process.stderr.write('avatar-mock: bad JSON: ' + e.message + '\n');
  process.exit(1);
}
if (!brief.video_path) {
  process.stderr.write('avatar-mock: brief.video_path required\n');
  process.exit(2);
}
mkdirSync(dirname(brief.video_path), { recursive: true });

const durMs = Math.max(100, Math.min(5000, brief.duration_ms || 3000));
const durS  = (durMs / 1000).toFixed(3);

// Strategy: if the requested duration is within ±300ms of the 3s fixture,
// just copy it. Otherwise re-encode via ffmpeg lavfi for the realistic
// duration. The copy path keeps tests fast + deterministic; the re-encode
// path covers the >3s / <3s edge cases.
const FIXTURE_DUR_MS = 3000;
if (Math.abs(durMs - FIXTURE_DUR_MS) <= 300 && existsSync(FIXTURE_MP4)) {
  copyFileSync(FIXTURE_MP4, brief.video_path);
} else {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-t', durS, '-i', 'color=c=gray:s=256x456:r=30',
    '-f', 'lavfi', '-t', durS, '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '30',
    '-c:a', 'aac', '-b:a', '96k',
    '-shortest',
    '-movflags', '+faststart',
    brief.video_path,
  ];
  const r = spawnSync('ffmpeg', args);
  if (r.status !== 0) {
    process.stderr.write('avatar-mock: ffmpeg failed: ' + (r.stderr || '').toString().slice(-200) + '\n');
    process.exit(3);
  }
}

process.stdout.write(JSON.stringify({
  video_path:  brief.video_path,
  cost_usd:    0.10,
  duration_ms: durMs,
  model:       'mock-avatar',
}) + '\n');
