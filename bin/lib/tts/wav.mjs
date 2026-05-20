// wav.mjs — minimal WAV PCM s16le writer used by the Piper adapter and the
// CF_TTS_MOCK helper. No external deps. Pure-logic at import time (no IO).
//
// PCM s16le mono 22050 Hz matches Piper's default output. The dub pipeline
// re-encodes everything to the renderer's 48 kHz stereo target downstream
// via ffmpeg, so this writer only needs to produce a valid WAV header that
// ffprobe can read.

import { writeFileSync } from 'node:fs';

const PCM_SAMPLE_RATE = 22050;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_CHANNELS = 1;

function writeUInt32LE(buf, off, val) {
  buf[off]     = val & 0xff;
  buf[off + 1] = (val >>> 8)  & 0xff;
  buf[off + 2] = (val >>> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}

function writeUInt16LE(buf, off, val) {
  buf[off]     = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
}

function writeInt16LE(buf, off, val) {
  let v = val | 0;
  if (v < -32768) v = -32768;
  if (v >  32767) v =  32767;
  buf[off]     = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
}

/**
 * Build a PCM s16le mono WAV buffer.
 *
 * @param {Int16Array|number[]} samples
 * @param {{sampleRate?: number, channels?: number}} [opts]
 * @returns {Buffer}
 */
export function buildWav(samples, opts = {}) {
  const sampleRate = opts.sampleRate || PCM_SAMPLE_RATE;
  const channels   = opts.channels   || PCM_CHANNELS;
  const bps        = PCM_BITS_PER_SAMPLE;
  const dataBytes  = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  writeUInt32LE(buf, 4, 36 + dataBytes);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  writeUInt32LE(buf, 16, 16);                   // fmt chunk size
  writeUInt16LE(buf, 20, 1);                    // PCM format code
  writeUInt16LE(buf, 22, channels);
  writeUInt32LE(buf, 24, sampleRate);
  writeUInt32LE(buf, 28, sampleRate * channels * bps / 8); // byte rate
  writeUInt16LE(buf, 32, channels * bps / 8);   // block align
  writeUInt16LE(buf, 34, bps);
  buf.write('data', 36, 'ascii');
  writeUInt32LE(buf, 40, dataBytes);
  for (let i = 0; i < samples.length; i++) {
    writeInt16LE(buf, 44 + i * 2, samples[i]);
  }
  return buf;
}

/**
 * Build a deterministic placeholder WAV whose duration matches the text length
 * using the "1 word ≈ 400 ms" heuristic (matches the realistic-mock contract
 * from docs/PLAN-v0.4.0.md §4). The audio is a low-amplitude sine envelope
 * (440 Hz, gain 0.06) so it is recognisable as "speech-shaped placeholder"
 * rather than perfect silence — useful for downstream timing sanity checks.
 *
 * @param {string} text
 * @param {{ms_per_word?: number, sampleRate?: number}} [opts]
 * @returns {{ buf: Buffer, duration_ms: number }}
 */
export function buildPlaceholderWav(text, opts = {}) {
  const msPerWord = opts.ms_per_word || 400;
  const sr = opts.sampleRate || PCM_SAMPLE_RATE;
  const wordCount = String(text || '').trim().length === 0
    ? 0
    : String(text).trim().split(/\s+/).length;
  const durationMs = wordCount * msPerWord;
  const sampleCount = Math.round(sr * durationMs / 1000);
  const samples = new Int16Array(sampleCount);
  // 440 Hz sine modulated by a slow 4 Hz envelope to mimic syllable rhythm.
  const f = 440;
  const env = 4;
  const gain = 0.06 * 32767;
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sr;
    const amp = 0.5 * (1 + Math.sin(2 * Math.PI * env * t));
    samples[i] = Math.round(gain * amp * Math.sin(2 * Math.PI * f * t));
  }
  return { buf: buildWav(samples, { sampleRate: sr, channels: 1 }), duration_ms: durationMs };
}

/**
 * Build a silent WAV of the given duration. Used for hallucination-guarded
 * empty-text paths and for source-longer-than-dub silence padding.
 *
 * @param {number} durationMs
 * @param {{sampleRate?: number}} [opts]
 * @returns {Buffer}
 */
export function buildSilentWav(durationMs, opts = {}) {
  const sr = opts.sampleRate || PCM_SAMPLE_RATE;
  const sampleCount = Math.max(0, Math.round(sr * (durationMs || 0) / 1000));
  const samples = new Int16Array(sampleCount);
  return buildWav(samples, { sampleRate: sr, channels: 1 });
}

export function writeWavFile(path, buf) {
  writeFileSync(path, buf);
}
