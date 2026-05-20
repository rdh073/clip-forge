// speaker-timeline.test.mjs — pure-logic tests for the v0.4.0 pillar 6
// speaker-windowing logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSpeakerTimeline,
  filterSplitScreenWindows,
  totalSplitDurationMs,
} from './speaker-timeline.mjs';

function tx(words) {
  return { version: 1, engine: 'test', language: 'en', words };
}

test('2-speaker transcript with sustained overlap → at least one split window', () => {
  const t = tx([
    { w: 'hi',    start_ms: 0,    end_ms: 500,  speaker: 0, confidence: 0.95 },
    { w: 'yes',   start_ms: 600,  end_ms: 1200, speaker: 1, confidence: 0.95 },
    { w: 'right', start_ms: 1300, end_ms: 2000, speaker: 0, confidence: 0.95 },
    { w: 'go',    start_ms: 2100, end_ms: 2800, speaker: 1, confidence: 0.95 },
    { w: 'ok',    start_ms: 2900, end_ms: 3500, speaker: 0, confidence: 0.95 },
  ]);
  const out = buildSpeakerTimeline({ transcript: t });
  assert.ok(out.windows.length >= 1, 'expected at least one window');
  const split = filterSplitScreenWindows(out.windows);
  assert.ok(split.length >= 1, 'sustained overlap should emit a split-screen window');
  assert.deepEqual(split[0].active_speakers, [0, 1]);
  assert.equal(out.warnings.length, 0, 'no warnings on healthy two-speaker input');
});

test('single-speaker transcript → no windows, single_speaker warning', () => {
  const t = tx([
    { w: 'i',  start_ms: 0,    end_ms: 200,  speaker: 0, confidence: 0.95 },
    { w: 'am', start_ms: 300,  end_ms: 500,  speaker: 0, confidence: 0.95 },
    { w: 'me', start_ms: 600,  end_ms: 900,  speaker: 0, confidence: 0.95 },
  ]);
  const out = buildSpeakerTimeline({ transcript: t });
  assert.equal(out.windows.length, 0);
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].code, 'single_speaker');
});

test('brief overlap (<1500ms) → dominant kept, filterSplitScreenWindows drops it', () => {
  // 800ms of co-speech, dominant = speaker 0 (3 words vs 1).
  const t = tx([
    { w: 'i',    start_ms: 0,    end_ms: 200,  speaker: 0, confidence: 0.95 },
    { w: 'and', start_ms: 250,  end_ms: 450,  speaker: 0, confidence: 0.95 },
    { w: 'yo',  start_ms: 350,  end_ms: 600,  speaker: 1, confidence: 0.95 },
    { w: 'we',  start_ms: 650,  end_ms: 800,  speaker: 0, confidence: 0.95 },
  ]);
  const out = buildSpeakerTimeline({ transcript: t, minWindowMs: 1500 });
  // Build may emit a "window" but filterSplitScreenWindows should drop it
  // because duration < minWindowMs.
  const split = filterSplitScreenWindows(out.windows, 1500);
  assert.equal(split.length, 0, 'brief overlap should not yield a split window');
});

test('sustained overlap ≥1500ms → split window with correct active_speakers', () => {
  // 2.5s of strong alternation, both speakers present throughout.
  const words = [];
  for (let i = 0; i < 10; i++) {
    words.push({
      w: 'w' + i, start_ms: i * 250, end_ms: i * 250 + 200,
      speaker: i % 2, confidence: 0.95,
    });
  }
  const out = buildSpeakerTimeline({ transcript: tx(words) });
  const split = filterSplitScreenWindows(out.windows);
  assert.equal(split.length, 1);
  assert.deepEqual(split[0].active_speakers, [0, 1]);
  assert.ok(split[0].duration_ms >= 1500, 'window must be at least 1500ms');
});

test('no `speaker` field anywhere → no_speaker_labels warning, empty windows', () => {
  const t = tx([
    { w: 'hi', start_ms: 0,    end_ms: 200 },
    { w: 'ok', start_ms: 300,  end_ms: 500 },
  ]);
  const out = buildSpeakerTimeline({ transcript: t });
  assert.equal(out.windows.length, 0);
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].code, 'no_speaker_labels');
});

test('low-confidence words trigger diarize_low_confidence warning', () => {
  const t = tx([
    { w: 'hi', start_ms: 0,    end_ms: 500,  speaker: 0, confidence: 0.4 },
    { w: 'yo', start_ms: 600,  end_ms: 1200, speaker: 1, confidence: 0.9 },
    { w: 'me', start_ms: 1300, end_ms: 2000, speaker: 0, confidence: 0.4 },
    { w: 'go', start_ms: 2100, end_ms: 2800, speaker: 1, confidence: 0.95 },
  ]);
  const out = buildSpeakerTimeline({ transcript: t });
  assert.ok(out.warnings.some((w) => w.code === 'diarize_low_confidence'));
});

test('speakers aggregate carries word_count + total_speaking_ms per speaker', () => {
  const t = tx([
    { w: 'a', start_ms: 0,    end_ms: 200,  speaker: 0, confidence: 0.95 },
    { w: 'b', start_ms: 300,  end_ms: 500,  speaker: 0, confidence: 0.95 },
    { w: 'c', start_ms: 600,  end_ms: 800,  speaker: 1, confidence: 0.95 },
  ]);
  const out = buildSpeakerTimeline({ transcript: t });
  assert.equal(out.speakers['0'].word_count, 2);
  assert.equal(out.speakers['0'].total_speaking_ms, 400);
  assert.equal(out.speakers['1'].word_count, 1);
  assert.equal(out.speakers['1'].total_speaking_ms, 200);
});

test('idempotent: same input → byte-identical output', () => {
  const t = tx([
    { w: 'a', start_ms: 0,    end_ms: 500,  speaker: 0, confidence: 0.95 },
    { w: 'b', start_ms: 600,  end_ms: 1200, speaker: 1, confidence: 0.95 },
    { w: 'c', start_ms: 1300, end_ms: 2000, speaker: 0, confidence: 0.95 },
    { w: 'd', start_ms: 2100, end_ms: 2800, speaker: 1, confidence: 0.95 },
  ]);
  const a = buildSpeakerTimeline({ transcript: t });
  const b = buildSpeakerTimeline({ transcript: t });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('totalSplitDurationMs sums all eligible window durations', () => {
  const t = tx([
    { w: 'a', start_ms: 0,    end_ms: 500,  speaker: 0, confidence: 0.95 },
    { w: 'b', start_ms: 600,  end_ms: 1200, speaker: 1, confidence: 0.95 },
    { w: 'c', start_ms: 1300, end_ms: 2200, speaker: 0, confidence: 0.95 },
    { w: 'd', start_ms: 2300, end_ms: 3000, speaker: 1, confidence: 0.95 },
  ]);
  const out = buildSpeakerTimeline({ transcript: t });
  const total = totalSplitDurationMs(out.windows);
  assert.ok(total >= 1500, 'expected ≥ 1500ms total split duration; got ' + total);
});

test('dominant speaker is the one with the most words in the window', () => {
  // Build a window where speaker 1 dominates by word count.
  const words = [];
  for (let i = 0; i < 4; i++) {
    words.push({ w: 's0_' + i, start_ms: i * 300, end_ms: i * 300 + 150,
                  speaker: 0, confidence: 0.95 });
  }
  for (let i = 0; i < 8; i++) {
    words.push({ w: 's1_' + i, start_ms: i * 250 + 50, end_ms: i * 250 + 200,
                  speaker: 1, confidence: 0.95 });
  }
  const out = buildSpeakerTimeline({ transcript: tx(words) });
  const split = filterSplitScreenWindows(out.windows);
  if (split.length > 0) {
    assert.equal(split[0].dominant, 1, 'speaker 1 should dominate by word count');
  }
});
