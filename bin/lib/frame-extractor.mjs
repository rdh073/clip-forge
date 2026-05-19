// frame-extractor.mjs — async iterator that yields downsampled RGB frames
// from an ffmpeg pipe. Frames come out in `pix_fmt=rgb24` so we can pass them
// straight to MediaPipe's `detectForVideo`.
//
// Usage:
//   for await (const frame of extractFrames({ input, sampleFps, width, height, startMs, endMs })) {
//     // frame = { rgb: Uint8Array, width, height, tMs, frameIdx }
//   }
//
// The extractor honors `AbortSignal` so callers can stop early without
// leaving a zombie ffmpeg process.

import { spawn } from 'node:child_process';

export const DEFAULT_DOWNSCALE_HEIGHT = 360; // ~640x360 for 16:9 sources

/**
 * Extract downsampled RGB frames from a video at a target sample fps.
 *
 * @param {object} opts
 * @param {string} opts.input               Path to source video
 * @param {number} [opts.sampleFps=6]       Frames to sample per second
 * @param {number} [opts.startMs=0]
 * @param {number} [opts.endMs]             Required (end of source if unset by caller)
 * @param {number} [opts.downscaleHeight=360]
 * @param {AbortSignal} [opts.signal]
 * @returns {AsyncGenerator<{rgb: Uint8Array, width: number, height: number, tMs: number, frameIdx: number}>}
 */
export async function* extractFrames(opts) {
  const sampleFps = opts.sampleFps ?? 6;
  const startMs   = opts.startMs ?? 0;
  const endMs     = opts.endMs;
  const downH     = opts.downscaleHeight ?? DEFAULT_DOWNSCALE_HEIGHT;
  if (!opts.input) throw new Error('frame-extractor: input required');
  if (endMs == null) throw new Error('frame-extractor: endMs required');

  // Probe source dims so we can compute the downscaled frame size.
  const { width: srcW, height: srcH } = probe(opts.input);
  if (!srcW || !srcH) throw new Error('frame-extractor: could not probe ' + opts.input);
  const downW = Math.round((downH * srcW) / srcH / 2) * 2; // even
  const bytesPerFrame = downW * downH * 3;

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', (startMs / 1000).toFixed(3),
    '-to', (endMs / 1000).toFixed(3),
    '-i', opts.input,
    '-vf', 'fps=' + sampleFps + ',scale=' + downW + ':' + downH,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderrTail = [];
  proc.stderr.on('data', (c) => {
    stderrTail.push(c.toString());
    if (stderrTail.length > 20) stderrTail.shift();
  });

  if (opts.signal) {
    opts.signal.addEventListener('abort', () => { try { proc.kill('SIGTERM'); } catch {} }, { once: true });
  }

  // Buffer assembly: ffmpeg emits arbitrary-size chunks; we slice into frames.
  let leftover = Buffer.alloc(0);
  let frameIdx = 0;
  let resolved = false;

  // We need to interleave reading stdout with the generator's pull. The
  // cleanest path is to push chunks into a queue and yield from it.
  const queue = [];
  const waiters = [];
  let done = false;
  let err = null;

  proc.stdout.on('data', (chunk) => {
    leftover = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    while (leftover.length >= bytesPerFrame) {
      const frameBuf = leftover.subarray(0, bytesPerFrame);
      leftover = leftover.subarray(bytesPerFrame);
      const tMs = Math.round((frameIdx / sampleFps) * 1000);
      const frame = {
        rgb: new Uint8Array(frameBuf.buffer, frameBuf.byteOffset, frameBuf.byteLength),
        width: downW,
        height: downH,
        sourceWidth: srcW,
        sourceHeight: srcH,
        tMs,
        frameIdx,
      };
      frameIdx++;
      const w = waiters.shift();
      if (w) w(frame); else queue.push(frame);
    }
  });

  proc.on('error', (e) => {
    err = e;
    done = true;
    const w = waiters.shift();
    if (w) w(null);
  });

  proc.on('close', (code) => {
    done = true;
    if (code !== 0 && code !== null) {
      err = new Error('ffmpeg exit ' + code + ': ' + stderrTail.slice(-3).join('').slice(-400));
    }
    while (waiters.length) waiters.shift()(null);
  });

  try {
    while (true) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      if (done) {
        if (err) throw err;
        return;
      }
      const frame = await new Promise((res) => waiters.push(res));
      if (!frame) {
        if (err) throw err;
        return;
      }
      yield frame;
    }
  } finally {
    if (!proc.killed) {
      try { proc.kill('SIGTERM'); } catch {}
    }
  }
}

function probe(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams', '-show_format',
    file,
  ]);
  if (r.status !== 0) return { width: 0, height: 0 };
  try {
    const data = JSON.parse(r.stdout.toString());
    const v = (data.streams || []).find((s) => s.codec_type === 'video') || {};
    return { width: v.width || 0, height: v.height || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

// Local import to avoid a top-level child_process duplicate.
import { spawnSync } from 'node:child_process';
