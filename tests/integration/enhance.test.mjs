// enhance.test.mjs — positive-evidence coverage for /clip-forge:enhance.
//
// The denoise assertion checks the rendered WAV itself, not only the report:
// the final loudness-normalized output must have a noise-floor RMS at least
// 12 dB lower than the noisy fixture's tail window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const CF_ENHANCE = resolve(PLUGIN_ROOT, 'bin/cf-enhance');
const CF_FFMPEG = resolve(PLUGIN_ROOT, 'bin/cf-ffmpeg');
const FIXTURE = resolve(PLUGIN_ROOT, 'tests/fixtures/noisy-speech-5s.mp4');
const RNNOISE_MODEL = resolve(PLUGIN_ROOT, 'bin/models/cb.rnnn');

function which(cmd) {
  try { return execSync('command -v ' + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

const HAS_FFMPEG = !!which('ffmpeg');
const HAS_FFPROBE = !!which('ffprobe');
const HAS_FIXTURE = existsSync(FIXTURE);
const SKIP = !HAS_FFMPEG ? 'ffmpeg missing'
  : !HAS_FFPROBE ? 'ffprobe missing'
  : !HAS_FIXTURE ? 'fixture missing: ' + FIXTURE
  : null;

function rmsDb(file, startS, endS) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(startS), '-to', String(endS),
    '-i', file,
    '-vn', '-map', '0:a:0',
    '-ac', '1', '-ar', '48000',
    '-f', 's16le', '-c:a', 'pcm_s16le',
    'pipe:1',
  ], { maxBuffer: 12 * 1024 * 1024 });
  assert.equal(r.status, 0, 'ffmpeg PCM extraction failed: ' + r.stderr.toString());
  assert.ok(r.stdout.length > 0, 'PCM extraction should return samples');

  let sum = 0;
  const samples = Math.floor(r.stdout.length / 2);
  for (let i = 0; i < samples; i++) {
    const x = r.stdout.readInt16LE(i * 2) / 32768;
    sum += x * x;
  }
  return 20 * Math.log10(Math.sqrt(sum / samples) + 1e-12);
}

function ffprobeJson(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', file,
  ], { encoding: 'utf-8' });
  assert.equal(r.status, 0, 'ffprobe failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

function audioStreamInfo(file) {
  const data = ffprobeJson(file);
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  assert.ok(audio, 'file must contain an audio stream: ' + file);
  return audio;
}

function integratedLoudness(file) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', file,
    '-af', 'ebur128',
    '-f', 'null', '-',
  ], { encoding: 'utf-8', maxBuffer: 12 * 1024 * 1024 });
  assert.equal(r.status, 0, 'ffmpeg ebur128 failed: ' + r.stderr);
  const m = r.stderr.match(/Integrated loudness:\s*[\s\S]*?\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  assert.ok(m, 'could not parse integrated loudness from ebur128 stderr:\n' + r.stderr);
  return parseFloat(m[1]);
}

function writeMinimalCrop(path) {
  writeFileSync(path, JSON.stringify({
    version: 2,
    source_w: 320,
    source_h: 240,
    target_w: 1080,
    target_h: 1920,
    samples: [],
    interp: 'linear',
    mode: 'center',
    detector: 'identity',
    fallback_used: false,
    fallback_reason: null,
  }, null, 2) + '\n');
}

function zeroCrossingFrequency(file) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-ss', '1.0', '-to', '4.0',
    '-i', file,
    '-vn', '-map', '0:a:0',
    '-ac', '1', '-ar', '48000',
    '-f', 's16le', '-c:a', 'pcm_s16le',
    'pipe:1',
  ], { maxBuffer: 20 * 1024 * 1024 });
  assert.equal(r.status, 0, 'ffmpeg PCM extraction failed: ' + r.stderr.toString());
  let crossings = 0;
  let prev = 0;
  for (let i = 0; i < r.stdout.length; i += 2) {
    const sample = r.stdout.readInt16LE(i);
    if ((prev < 0 && sample >= 0) || (prev >= 0 && sample < 0)) crossings++;
    prev = sample;
  }
  return crossings / (2 * 3);
}

test('enhance: audio.norm.wav is 48k/16-bit, -14 LUFS, true-peak safe, and denoised',
  { skip: SKIP || false, timeout: 45_000 }, () => {
    const work = join(tmpdir(), 'cf-enhance-' + Date.now());
    try {
      mkdirSync(work, { recursive: true });
      const outWav = join(work, 'audio.norm.wav');
      const reportPath = join(work, 'enhance.json');
      const editPath = join(work, 'edit.json');
      writeFileSync(editPath, JSON.stringify({ version: 1, source: FIXTURE }, null, 2) + '\n');

      const r = spawnSync('node', [
        CF_ENHANCE,
        '--in', FIXTURE,
        '--out', outWav,
        '--report', reportPath,
        '--edit-json', editPath,
      ], { encoding: 'utf-8', cwd: PLUGIN_ROOT });

      assert.equal(r.status, 0, 'cf-enhance exits 0; stderr=' + r.stderr);
      assert.ok(existsSync(outWav), 'enhanced.wav should be written');
      assert.ok(statSync(outWav).size > 0, 'enhanced.wav should be non-empty');
      assert.ok(existsSync(reportPath), 'enhance_report.json should be written');

      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      assert.equal(report.output, outWav, 'enhance report should point at audio.norm.wav');
      const audio = audioStreamInfo(outWav);
      assert.equal(audio.sample_rate, '48000', 'audio.norm.wav sample-rate must be 48000');
      assert.equal(audio.codec_name, 'pcm_s16le', 'audio.norm.wav must be signed 16-bit PCM');
      assert.equal(audio.bits_per_sample, 16, 'audio.norm.wav bit-depth must be 16');

      const measuredLufs = integratedLoudness(outWav);
      assert.ok(Math.abs(measuredLufs - (-14)) <= 1.0,
        'ebur128 integrated loudness must be -14 ± 1.0 LUFS; got ' + measuredLufs);
      assert.ok(report.integrated_loudness <= -12.5 && report.integrated_loudness >= -15.5,
        'integrated loudness should land near -14 LUFS; got ' + report.integrated_loudness);
      assert.ok(report.true_peak <= -1.0,
        'true peak must never exceed -1.0 dBTP; got ' + report.true_peak);
      assert.ok(parseFloat(report.filters.loudnorm.pass2.output_tp) <= -1.0,
        'loudnorm pass2 output_tp must be <= -1.0 dBTP; got ' + report.filters.loudnorm.pass2.output_tp);
      assert.ok(report.noise_reduction_db >= 25,
        'report noise_reduction_db must be >= 25; got ' + report.noise_reduction_db);

      const inputNoise = rmsDb(FIXTURE, 4, 5);
      const outputNoise = rmsDb(outWav, 4, 5);
      const reduction = inputNoise - outputNoise;
      assert.ok(outputNoise < -50,
        'silent-tail output noise floor must be < -50 dBFS; got ' + outputNoise.toFixed(3));
      assert.ok(reduction >= 25,
        `output noise floor must be >= 25 dB lower; input=${inputNoise.toFixed(3)} output=${outputNoise.toFixed(3)} reduction=${reduction.toFixed(3)}`);

      const edit = JSON.parse(readFileSync(editPath, 'utf-8'));
      assert.equal(edit.audio_source, outWav,
        'cf-enhance should patch edit.json with the enhanced WAV path');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('enhance: RNNoise-missing branch falls back to afftdn and still writes valid audio',
  { skip: SKIP || false, timeout: 45_000 }, () => {
    const work = join(tmpdir(), 'cf-enhance-no-rnnoise-' + Date.now());
    const backup = RNNOISE_MODEL + '.bak-test-' + process.pid + '-' + Date.now();
    let moved = false;
    try {
      mkdirSync(work, { recursive: true });
      if (existsSync(RNNOISE_MODEL)) {
        renameSync(RNNOISE_MODEL, backup);
        moved = true;
      }

      const outWav = join(work, 'audio.norm.wav');
      const reportPath = join(work, 'enhance.json');
      const r = spawnSync('node', [
        CF_ENHANCE,
        '--in', FIXTURE,
        '--out', outWav,
        '--report', reportPath,
      ], { encoding: 'utf-8', cwd: PLUGIN_ROOT });

      assert.equal(r.status, 0, 'cf-enhance exits 0 without RNNoise model; stderr=' + r.stderr);
      assert.ok(existsSync(outWav), 'audio.norm.wav should still be written without RNNoise');
      assert.ok(statSync(outWav).size > 0, 'audio.norm.wav should be non-empty without RNNoise');
      const audio = audioStreamInfo(outWav);
      assert.equal(audio.sample_rate, '48000');
      assert.equal(audio.codec_name, 'pcm_s16le');
      assert.equal(audio.bits_per_sample, 16);

      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      assert.equal(report.denoiser, 'afftdn',
        'missing RNNoise model must use afftdn as observable denoiser');
      assert.equal(report.filters.rnnoise.enabled, false);
      assert.equal(report.filters.rnnoise.fallback_reason, 'model_missing');
      assert.match(report.fallback_reason, /rnnoise_model_missing/,
        'enhance.json fallback_reason must record RNNoise degradation');
      assert.ok(report.true_peak <= -1.0,
        'true peak must still be <= -1.0 dBTP without RNNoise; got ' + report.true_peak);
    } finally {
      if (moved && existsSync(backup)) {
        renameSync(backup, RNNOISE_MODEL);
      }
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('enhance: missing input exits 0 and writes a valid fallback report',
  { timeout: 10_000 }, () => {
    const work = join(tmpdir(), 'cf-enhance-missing-' + Date.now());
    try {
      mkdirSync(work, { recursive: true });
      const reportPath = join(work, 'enhance_report.json');
      const r = spawnSync('node', [
        CF_ENHANCE,
        '--in', join(work, 'missing.mp4'),
        '--out', join(work, 'enhanced.wav'),
        '--report', reportPath,
      ], { encoding: 'utf-8', cwd: PLUGIN_ROOT });
      assert.equal(r.status, 0, 'documented failure paths must exit 0');
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      assert.equal(report.fallback_used, true);
      assert.match(report.fallback_reason, /input_not_found/);
      assert.equal(report.output, null);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('render: edit.json audio_source replaces source audio during render',
  { skip: SKIP || false, timeout: 60_000 }, () => {
    const work = join(tmpdir(), 'cf-enhance-render-' + Date.now());
    try {
      mkdirSync(work, { recursive: true });
      const source = join(work, 'source.mp4');
      const altAudio = join(work, 'audio-source.wav');
      const cropPath = join(work, 'crop.json');
      const editPath = join(work, 'edit.json');
      const outMp4 = join(work, 'out.mp4');

      let r = spawnSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=5',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5:sample_rate=48000',
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-shortest', source,
      ], { encoding: 'utf-8' });
      assert.equal(r.status, 0, 'source fixture build failed: ' + r.stderr);

      r = spawnSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=5:sample_rate=48000',
        '-ar', '48000', '-c:a', 'pcm_s16le', altAudio,
      ], { encoding: 'utf-8' });
      assert.equal(r.status, 0, 'audio_source fixture build failed: ' + r.stderr);

      writeMinimalCrop(cropPath);
      writeFileSync(editPath, JSON.stringify({
        version: 1,
        clip_id: 'audio-source',
        start_ms: 0,
        end_ms: 5000,
        source,
        crop_path: cropPath,
        audio_source: altAudio,
        output: outMp4,
        quality: 'fast',
      }, null, 2) + '\n');

      r = spawnSync('node', [CF_FFMPEG, 'render', '--manifest', editPath],
        { encoding: 'utf-8', cwd: PLUGIN_ROOT });
      assert.equal(r.status, 0, 'cf-ffmpeg render should succeed: ' + r.stderr);

      const probe = ffprobeJson(outMp4);
      assert.ok(probe.streams.find((s) => s.codec_type === 'audio'),
        'rendered MP4 must contain an audio stream from audio_source');
      const freq = zeroCrossingFrequency(outMp4);
      assert.ok(freq > 820 && freq < 940,
        'rendered audio should come from the 880 Hz audio_source, not the 440 Hz source; got ' + freq.toFixed(1));
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });
