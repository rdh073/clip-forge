// srt-vtt.test.mjs — unit tests for the VTT + SRT sidecar builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVtt, buildSrt } from './srt-vtt.mjs';

const SAMPLE = {
  version: 1,
  lines: [
    {
      start_ms: 0, end_ms: 1840,
      words: [
        { w: 'Nobody', start_ms: 0,    end_ms: 320 },
        { w: 'tells',  start_ms: 320,  end_ms: 580 },
        { w: 'you',    start_ms: 580,  end_ms: 760 },
        { w: 'this',   start_ms: 760,  end_ms: 1100, highlight: true },
      ],
      emoji: '🎯',
    },
    {
      start_ms: 1840, end_ms: 3200,
      words: [
        { w: 'Listen', start_ms: 1840, end_ms: 2200 },
        { w: 'up',     start_ms: 2200, end_ms: 2500 },
      ],
    },
  ],
};

// ----- buildVtt -----

test('buildVtt: starts with WEBVTT header', () => {
  const vtt = buildVtt(SAMPLE);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
});

test('buildVtt: contains cue blocks with --> arrows', () => {
  const vtt = buildVtt(SAMPLE);
  const arrows = vtt.match(/-->/g) || [];
  assert.equal(arrows.length, 2, 'two cue blocks → two arrows');
});

test('buildVtt: VTT timestamps use period as decimal separator', () => {
  const vtt = buildVtt(SAMPLE);
  assert.match(vtt, /00:00:00\.000 --> 00:00:01\.840/);
  assert.match(vtt, /00:00:01\.840 --> 00:00:03\.200/);
});

test('buildVtt: cue text is words joined + emoji appended', () => {
  const vtt = buildVtt(SAMPLE);
  assert.match(vtt, /Nobody tells you this 🎯/);
  assert.match(vtt, /Listen up/);
});

test('buildVtt: empty captions → minimal valid WEBVTT', () => {
  assert.equal(buildVtt({ lines: [] }), 'WEBVTT\n\n');
  assert.equal(buildVtt({}), 'WEBVTT\n\n');
  assert.equal(buildVtt(null), 'WEBVTT\n\n');
});

test('buildVtt: idempotent — same input twice → byte-identical output', () => {
  assert.equal(buildVtt(SAMPLE), buildVtt(SAMPLE));
});

test('buildVtt: large timestamp ≥1h formats correctly', () => {
  const vtt = buildVtt({ lines: [{
    start_ms: 3661000, end_ms: 3662500, words: [{ w: 'late' }],
  }]});
  // 3661000 ms = 1:01:01.000
  assert.match(vtt, /01:01:01\.000 --> 01:01:02\.500/);
});

test('buildVtt: sub-millisecond rounding — 1.5 ms → 1 ms', () => {
  const vtt = buildVtt({ lines: [{
    start_ms: 1.5, end_ms: 999.9, words: [{ w: 'x' }],
  }]});
  assert.match(vtt, /00:00:00\.001 --> 00:00:00\.999/);
});

// ----- buildSrt -----

test('buildSrt: numbered blocks 1.., 2.., ...', () => {
  const srt = buildSrt(SAMPLE);
  assert.match(srt, /^1\n/);
  assert.match(srt, /\n2\n/);
});

test('buildSrt: SRT timestamps use comma as decimal separator', () => {
  const srt = buildSrt(SAMPLE);
  assert.match(srt, /00:00:00,000 --> 00:00:01,840/);
  assert.match(srt, /00:00:01,840 --> 00:00:03,200/);
});

test('buildSrt: contains text with emoji', () => {
  const srt = buildSrt(SAMPLE);
  assert.match(srt, /Nobody tells you this 🎯/);
});

test('buildSrt: empty captions → empty string (valid empty SRT)', () => {
  assert.equal(buildSrt({ lines: [] }), '');
  assert.equal(buildSrt({}), '');
  assert.equal(buildSrt(null), '');
});

test('buildSrt: idempotent', () => {
  assert.equal(buildSrt(SAMPLE), buildSrt(SAMPLE));
});

test('buildSrt: large timestamp ≥1h formats correctly with comma separator', () => {
  const srt = buildSrt({ lines: [{
    start_ms: 3661000, end_ms: 3662500, words: [{ w: 'late' }],
  }]});
  assert.match(srt, /01:01:01,000 --> 01:01:02,500/);
});

test('buildSrt + buildVtt agree on cue COUNT', () => {
  const vttArrows = (buildVtt(SAMPLE).match(/-->/g) || []).length;
  const srtArrows = (buildSrt(SAMPLE).match(/-->/g) || []).length;
  assert.equal(vttArrows, srtArrows, 'sidecar formats must agree on cue count');
});
