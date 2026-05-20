// overlay-builder.test.mjs — unit tests for the pillar (i) pure builders.
// No ffmpeg, no IO. Asserts string shape, geometry math, and idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHookOverlayAss,
  buildProgressBarDrawbox,
  chooseAspectCanvas,
  applyEmojiHighlightToAss,
} from './overlay-builder.mjs';

// ===== chooseAspectCanvas =====

test('chooseAspectCanvas: undefined → 9:16 default, no warning', () => {
  const r = chooseAspectCanvas(undefined);
  assert.equal(r.w, 1080);
  assert.equal(r.h, 1920);
  assert.equal(r.name, '9:16');
  assert.equal(r.warning, null);
});

test('chooseAspectCanvas: null → 9:16 default, no warning', () => {
  const r = chooseAspectCanvas(null);
  assert.equal(r.w, 1080);
  assert.equal(r.h, 1920);
  assert.equal(r.warning, null);
});

test('chooseAspectCanvas: "9:16" → 1080x1920', () => {
  const r = chooseAspectCanvas('9:16');
  assert.deepEqual({ w: r.w, h: r.h, name: r.name, warning: r.warning },
                   { w: 1080, h: 1920, name: '9:16', warning: null });
});

test('chooseAspectCanvas: "1:1" → 1080x1080', () => {
  const r = chooseAspectCanvas('1:1');
  assert.deepEqual({ w: r.w, h: r.h, name: r.name, warning: r.warning },
                   { w: 1080, h: 1080, name: '1:1', warning: null });
});

test('chooseAspectCanvas: "4:5" → 1080x1350', () => {
  const r = chooseAspectCanvas('4:5');
  assert.deepEqual({ w: r.w, h: r.h, name: r.name, warning: r.warning },
                   { w: 1080, h: 1350, name: '4:5', warning: null });
});

test('chooseAspectCanvas: unknown "5:4" → fallback to 9:16 + warning', () => {
  const r = chooseAspectCanvas('5:4');
  assert.equal(r.w, 1080);
  assert.equal(r.h, 1920);
  assert.equal(r.name, '9:16');
  assert.ok(r.warning);
  assert.equal(r.warning.code, 'unknown_aspect');
  assert.match(r.warning.message, /5:4/);
});

// ===== buildHookOverlayAss =====

test('buildHookOverlayAss: short text → ASS with verbatim text', () => {
  const r = buildHookOverlayAss({ text: 'Nobody tells you', end_ms: 1800 });
  assert.match(r.ass, /Nobody tells you/);
  assert.match(r.ass, /^Style: Hook,/m);
  assert.match(r.ass, /^Dialogue: 5,/m);
  assert.equal(r.warnings.length, 0);
});

test('buildHookOverlayAss: end_ms encoded as ASS H:MM:SS.cs', () => {
  const r = buildHookOverlayAss({ text: 'foo', end_ms: 1800 });
  // 1800 ms = 0:00:01.80
  assert.match(r.ass, /0:00:00\.00,0:00:01\.80/);
});

test('buildHookOverlayAss: end_ms 65000 → 0:01:05.00', () => {
  const r = buildHookOverlayAss({ text: 'foo', end_ms: 65000 });
  assert.match(r.ass, /0:00:00\.00,0:01:05\.00/);
});

test('buildHookOverlayAss: long text triggers hook_overlay_wrapped + inserts \\N', () => {
  const long = 'This is a really really really really long hook line that overflows';
  const r = buildHookOverlayAss({ text: long, end_ms: 1800, maxChars: 20 });
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'hook_overlay_wrapped');
  // wrapAtMaxChars uses '\n' which escapeAssText converts to '\N'
  assert.match(r.ass, /\\N/);
});

test('buildHookOverlayAss: empty text → empty ass + no warnings', () => {
  const r = buildHookOverlayAss({ text: '', end_ms: 1800 });
  assert.equal(r.ass, '');
  assert.equal(r.warnings.length, 0);
});

test('buildHookOverlayAss: position upper-third → alignment 8, MarginV near canvasH/3', () => {
  const r = buildHookOverlayAss({
    text: 'foo', end_ms: 1800, position: 'upper-third', canvasH: 1920, safeAreaPx: 80,
  });
  // MarginV = floor(1920/3) - 80 = 640 - 80 = 560
  // Style line is comma-separated; the MarginV is the second-to-last numeric field.
  assert.match(r.ass, /Style: Hook,.*,8,40,40,560,1$/m);
});

test('buildHookOverlayAss: position center → alignment 5, MarginV 0', () => {
  const r = buildHookOverlayAss({
    text: 'foo', end_ms: 1800, position: 'center', canvasH: 1920,
  });
  assert.match(r.ass, /Style: Hook,.*,5,40,40,0,1$/m);
});

test('buildHookOverlayAss: idempotent (same inputs → byte-identical output)', () => {
  const opts = { text: 'Nobody tells you this', end_ms: 1800, position: 'upper-third' };
  const a = buildHookOverlayAss(opts).ass;
  const b = buildHookOverlayAss(opts).ass;
  assert.equal(a, b);
});

test('buildHookOverlayAss: safe-area constraint — MarginV >= safeAreaPx for upper-third on a short canvas', () => {
  // canvasH = 300, safeArea = 80 → floor(300/3) - 80 = 100 - 80 = 20. Clamp to safeArea (80).
  const r = buildHookOverlayAss({
    text: 'foo', end_ms: 1800, position: 'upper-third', canvasH: 300, safeAreaPx: 80,
  });
  assert.match(r.ass, /Style: Hook,.*,8,40,40,80,1$/m);
});

test('buildHookOverlayAss: ASS-special chars { } \\ escaped', () => {
  const r = buildHookOverlayAss({ text: 'foo {bar} \\baz', end_ms: 1800 });
  // escaping: { → \{,  } → \},  \ → \\
  assert.match(r.ass, /foo \\\{bar\\\} \\\\baz/);
});

// ===== buildProgressBarDrawbox =====

test('buildProgressBarDrawbox: enabled false → empty string', () => {
  const r = buildProgressBarDrawbox({
    enabled: false, canvasW: 1080, canvasH: 1920, durationMs: 5000,
  });
  assert.equal(r.filter, '');
  assert.equal(r.warnings.length, 0);
});

test('buildProgressBarDrawbox: enabled true → chain of 20 stepped drawbox calls', () => {
  const r = buildProgressBarDrawbox({
    enabled: true, color: '#ffffff', heightPx: 8, position: 'bottom',
    canvasW: 1080, canvasH: 1920, durationMs: 5000,
  });
  assert.match(r.filter, /^drawbox=/);
  // 20 stepped drawbox calls comma-joined → 20 "drawbox=" tokens.
  const count = (r.filter.match(/drawbox=/g) || []).length;
  assert.equal(count, 20, 'expected 20 steps; got ' + count);
  // bottom → y = canvasH - heightPx = 1912
  assert.match(r.filter, /y=1912/);
  assert.match(r.filter, /h=8/);
  // color contains the literal hex including the @ alpha
  assert.match(r.filter, /#ffffff@1\.0/);
  // enable gates use `between(t, sliceStart, sliceEnd)` per step
  assert.match(r.filter, /enable='between\(t,0\.000,0\.250\)'/);
  // The last segment ends at the full duration (5.000) with the full width.
  assert.match(r.filter, /w=1080:.*enable='between\(t,4\.750,5\.000\)'/);
});

test('buildProgressBarDrawbox: position top → y=0', () => {
  const r = buildProgressBarDrawbox({
    enabled: true, color: '#ffffff', heightPx: 8, position: 'top',
    canvasW: 1080, canvasH: 1920, durationMs: 5000,
  });
  assert.match(r.filter, /y=0:/);
});

test('buildProgressBarDrawbox: color without # → prepended', () => {
  const r = buildProgressBarDrawbox({
    enabled: true, color: 'ff00aa', heightPx: 6,
    canvasW: 1080, canvasH: 1920, durationMs: 3000,
  });
  assert.match(r.filter, /#ff00aa@1\.0/);
});

test('buildProgressBarDrawbox: negative duration → empty + invalid_geometry warning', () => {
  const r = buildProgressBarDrawbox({
    enabled: true, canvasW: 1080, canvasH: 1920, durationMs: -1,
  });
  assert.equal(r.filter, '');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'progress_bar_invalid_geometry');
});

test('buildProgressBarDrawbox: idempotent', () => {
  const opts = { enabled: true, color: '#fff', heightPx: 8, position: 'bottom',
                 canvasW: 1080, canvasH: 1920, durationMs: 5000 };
  assert.equal(buildProgressBarDrawbox(opts).filter, buildProgressBarDrawbox(opts).filter);
});

// ===== applyEmojiHighlightToAss =====

test('applyEmojiHighlightToAss: emoji appended at line end', () => {
  const captions = {
    lines: [{
      start_ms: 0, end_ms: 1000,
      words: [{ w: 'Hello', highlight: false }, { w: 'world', highlight: false }],
      emoji: '🎯',
    }],
  };
  const r = applyEmojiHighlightToAss(captions, { fill: '#ffffff', highlight: '#ffff00' });
  assert.match(r.ass, /Hello world 🎯/);
});

test('applyEmojiHighlightToAss: highlight:true word gets \\c colour override + scale', () => {
  const captions = {
    lines: [{
      start_ms: 0, end_ms: 1000,
      words: [{ w: 'pop', highlight: true }],
    }],
  };
  const r = applyEmojiHighlightToAss(captions, { fill: '#ffffff', highlight: '#ff00ff', highlight_scale: 115 });
  // Highlight colour ff00ff in ASS &HBBGGRR → &H00ff00ff&
  assert.match(r.ass, /\\c&H00ff00ff&\\fscx115\\fscy115\}pop\{\\c&H00ffffff&\\fscx100\\fscy100\}/);
});

test('applyEmojiHighlightToAss: empty lines → empty ass', () => {
  const r = applyEmojiHighlightToAss({ lines: [] }, { fill: '#ffffff', highlight: '#ffff00' });
  assert.equal(r.ass, '');
});

test('applyEmojiHighlightToAss: line without emoji and no highlights → plain Dialogue', () => {
  const captions = {
    lines: [{
      start_ms: 0, end_ms: 500,
      words: [{ w: 'just', highlight: false }, { w: 'text', highlight: false }],
    }],
  };
  const r = applyEmojiHighlightToAss(captions, { fill: '#ffffff', highlight: '#ffff00' });
  assert.match(r.ass, /^Dialogue: 0,0:00:00\.00,0:00:00\.50,Default,,0,0,0,,just text$/m);
});

test('applyEmojiHighlightToAss: missing words array tolerated', () => {
  const captions = { lines: [{ start_ms: 0, end_ms: 500, emoji: '🎯' }] };
  const r = applyEmojiHighlightToAss(captions, { fill: '#ffffff', highlight: '#ffff00' });
  // No words; emoji still appended (with leading space from the join).
  assert.match(r.ass, /Dialogue: 0,.* 🎯/);
});

test('applyEmojiHighlightToAss: idempotent', () => {
  const captions = {
    lines: [{
      start_ms: 0, end_ms: 1000,
      words: [{ w: 'a', highlight: true }, { w: 'b', highlight: false }],
      emoji: '🔥',
    }],
  };
  const tpl = { fill: '#ffffff', highlight: '#ff5cff' };
  assert.equal(applyEmojiHighlightToAss(captions, tpl).ass,
               applyEmojiHighlightToAss(captions, tpl).ass);
});
