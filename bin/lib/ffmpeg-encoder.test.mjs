import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFfmpegPlan,
  buildVideoEncoderPlan,
  normalizeFfmpegEncoder,
} from './ffmpeg-encoder.mjs';

test('normalizeFfmpegEncoder defaults to CPU and maps GPU aliases to NVENC', () => {
  assert.equal(normalizeFfmpegEncoder(''), 'libx264');
  assert.equal(normalizeFfmpegEncoder('cpu'), 'libx264');
  assert.equal(normalizeFfmpegEncoder('x264'), 'libx264');
  assert.equal(normalizeFfmpegEncoder('gpu'), 'h264_nvenc');
  assert.equal(normalizeFfmpegEncoder('nvenc'), 'h264_nvenc');
});

test('buildVideoEncoderPlan preserves the existing CPU preset shape', () => {
  const plan = buildVideoEncoderPlan({ encoder: 'cpu', cpuPreset: 'slow', cpuCrf: 18 });

  assert.deepEqual(plan.args, ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18']);
  assert.equal(plan.fallbackArgs, null);
});

test('buildVideoEncoderPlan creates NVENC args with CPU fallback args', () => {
  const plan = buildVideoEncoderPlan({ encoder: 'gpu', cpuPreset: 'fast', cpuCrf: 22 });

  assert.deepEqual(plan.args, ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-b:v', '0']);
  assert.deepEqual(plan.fallbackArgs, ['-c:v', 'libx264', '-preset', 'fast', '-crf', '22']);
  assert.equal(plan.fallbackEncoder, 'libx264');
});

test('buildFfmpegPlan applies GPU and fallback encoders without changing surrounding args', () => {
  const plan = buildFfmpegPlan(['-i', 'in.mp4', '-vf', 'scale=1080:1920'], ['-c:a', 'aac', 'out.mp4'], {
    encoder: 'gpu',
    cpuPreset: 'slow',
    cpuCrf: 18,
  });

  assert.deepEqual(plan.args, [
    '-i', 'in.mp4', '-vf', 'scale=1080:1920',
    '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '19', '-b:v', '0',
    '-c:a', 'aac', 'out.mp4',
  ]);
  assert.deepEqual(plan.fallbackArgs, [
    '-i', 'in.mp4', '-vf', 'scale=1080:1920',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-c:a', 'aac', 'out.mp4',
  ]);
});
