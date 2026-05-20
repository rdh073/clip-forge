// crop-expression-builder.test.mjs — pure-logic tests, no ffmpeg required.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCropExpression, buildFilterArg, buildFilterScript,
  escapeFilterArg, chooseRenderMode, computeCropDims,
  chooseSplitAxis, buildSplitScreenFilter, summarizeSplitScreenSamples,
} from './crop-expression-builder.mjs';

const baseCropPath = (samples = []) => ({
  version: 2,
  source_w: 1920,
  source_h: 1080,
  target_w: 1080,
  target_h: 1920,
  mode: 'face',
  samples,
});

test('computeCropDims: landscape source → portrait target uses full source height', () => {
  // 1920×1080 source, 1080×1920 (9:16) target → crop is 9:16 aspect at source-h
  // cropH = 1080, cropW = round(1080 * 9/16) = 608
  const { cropW, cropH } = computeCropDims(1920, 1080, 1080, 1920);
  assert.equal(cropH, 1080);
  assert.equal(cropW, 608);
});

test('computeCropDims: portrait source → landscape target uses full source width', () => {
  // 720×1280 source → 1920×1080 target (16:9)
  // cropW = 720, cropH = round(720 / (16/9)) = 405
  const { cropW, cropH } = computeCropDims(720, 1280, 1920, 1080);
  assert.equal(cropW, 720);
  assert.equal(cropH, 405);
});

test('computeCropDims: small downsampled source still computes valid crop dims', () => {
  // 640×360 downsampled source → 1080×1920 target — the actual smoke-test case.
  const { cropW, cropH } = computeCropDims(640, 360, 1080, 1920);
  // 9:16 of 360-tall source: cropH=360, cropW=round(360*9/16)=203 (Math.round 202.5 → 203)
  assert.equal(cropH, 360);
  assert.equal(cropW, 203);
});

test('empty samples → centered static crop with correct crop dims', () => {
  const cp = { source_w: 1920, source_h: 1080, target_w: 1080, target_h: 1920, samples: [] };
  const { exprX, exprY, cropW, cropH, keyframeCount } = buildCropExpression(cp);
  // cropW=608, cropH=1080; centered x = (1920-608)/2 = 656; y = (1080-1080)/2 = 0
  assert.equal(cropW, 608);
  assert.equal(cropH, 1080);
  assert.equal(exprX, '656');
  assert.equal(exprY, '0');
  assert.equal(keyframeCount, 0);
});

test('single sample → constant expression (no if-ladder)', () => {
  const cp = { source_w: 1920, source_h: 1080, target_w: 1080, target_h: 1920,
               samples: [{ t_ms: 0, cx: 960, cy: 540 }] };
  const { exprX, exprY, keyframeCount } = buildCropExpression(cp);
  // crop=608x1080. center 960 → x = 960 - 304 = 656; cy=540 → y = 540 - 540 = 0
  assert.equal(exprX, '656');
  assert.equal(exprY, '0');
  assert.equal(keyframeCount, 1);
});

test('multi-sample → if-ladder, count matches input length', () => {
  const cp = baseCropPath([
    { t_ms: 0,    cx: 800,  cy: 540 },
    { t_ms: 200,  cx: 900,  cy: 540 },
    { t_ms: 400,  cx: 1000, cy: 540 },
    { t_ms: 600,  cx: 1100, cy: 540 },
  ]);
  // 1920×1080 source, 1080×1920 target → crop 608×1080
  // x = cx - 304: 496, 596, 696, 796
  const { exprX, keyframeCount } = buildCropExpression(cp);
  assert.equal(keyframeCount, 4);
  assert.equal((exprX.match(/if\(/g) || []).length, 3);
  assert.ok(exprX.startsWith('if(lt(t,0.200),496,'), 'expr should start with first point: ' + exprX.slice(0, 40));
});

test('out-of-bounds samples are clamped to source extents', () => {
  const cp = baseCropPath([
    { t_ms: 0,   cx: -500,    cy: -100 },
    { t_ms: 100, cx: 99999,   cy: 99999 },
  ]);
  // 1920×1080 → 1080×1920 target → crop 608×1080
  // maxX = 1920 - 608 = 1312; maxY = 1080 - 1080 = 0
  const { exprX, exprY } = buildCropExpression(cp);
  assert.ok(exprX.includes('0,'), 'low x clamped to 0: ' + exprX);
  assert.ok(exprX.includes('1312'), 'high x clamped to 1312: ' + exprX);
  // y always 0 since crop fills full height
  assert.ok(/(^|\D)0($|\D)/.test(exprY), 'y should be 0 (full-height crop): ' + exprY);
});

test('center → top-left with downsampled source (acid test for smoke regression)', () => {
  // The actual case the smoke test hit: 640×360 source, 1080×1920 target.
  const cp = { source_w: 640, source_h: 360, target_w: 1080, target_h: 1920,
               samples: [{ t_ms: 0, cx: 506, cy: 64 }] };
  const { exprX, exprY, cropW, cropH } = buildCropExpression(cp);
  // crop 203×360. x = round(506 - 101.5) = round(404.5) = 405 (Math.round half-up).
  // maxX = 640 - 203 = 437. y = 64 - 180 = -116 → clamp 0.
  assert.equal(cropW, 203);
  assert.equal(cropH, 360);
  assert.equal(exprX, '405');
  assert.equal(exprY, '0');
});

test('consecutive duplicates collapse to a single keyframe', () => {
  const cp = baseCropPath([
    { t_ms: 0,   cx: 500, cy: 500 },
    { t_ms: 100, cx: 500, cy: 500 }, // dup → collapsed
    { t_ms: 200, cx: 500, cy: 500 }, // dup → collapsed
    { t_ms: 300, cx: 600, cy: 500 }, // different → keep
  ]);
  cp.target_w = 200; cp.target_h = 200;
  const { keyframeCount } = buildCropExpression(cp);
  assert.equal(keyframeCount, 2, 'duplicates should collapse, leaving 2 unique points');
});

test('expression length stays bounded after stride-downsample to 99 keyframes', () => {
  // Synthesize 360 samples (≈60 s at 6 fps), each shifting by 1 px so dedupe
  // doesn't collapse them. With the 99-keyframe cap, the resulting expression
  // is ~1.5-2.5 KB regardless of input timeline length.
  const samples = Array.from({ length: 360 }, (_, i) => ({
    t_ms: i * 166,
    cx: 500 + i,
    cy: 300,
  }));
  const cp = baseCropPath(samples);
  cp.target_w = 200; cp.target_h = 200;
  const { exprX, keyframeCount } = buildCropExpression(cp);
  assert.equal(keyframeCount, 99, 'expression must be capped to 99 keyframes');
  assert.ok(exprX.length > 1_000 && exprX.length < 4_000,
    'expected 1-4 KB for 99-keyframe expression; got ' + exprX.length);
});

test('escapeFilterArg escapes commas for inline -vf use', () => {
  assert.equal(escapeFilterArg('if(lt(t,1),100,200)'), 'if(lt(t\\,1)\\,100\\,200)');
  // No commas → unchanged
  assert.equal(escapeFilterArg('420'), '420');
});

test('buildFilterArg uses crop dims (not target dims) before scale', () => {
  const cp = baseCropPath([{ t_ms: 0, cx: 960, cy: 540 }]);
  // 1920×1080 → 1080×1920 → crop 608×1080
  const arg = buildFilterArg(cp);
  assert.equal(arg, 'crop=608:1080:656:0,scale=1080:1920');
});

test('buildFilterScript wraps in [0:v]…[v] for -filter_complex_script', () => {
  const cp = baseCropPath([{ t_ms: 0, cx: 960, cy: 540 }]);
  const script = buildFilterScript(cp);
  assert.match(script, /^\[0:v\]crop=608:1080:656:0,scale=1080:1920\[v\]\n$/);
});

test('chooseRenderMode: 0 samples → static', () => {
  const cp = baseCropPath([]);
  cp.target_w = 200; cp.target_h = 200;
  const { mode, keyframeCount } = chooseRenderMode(cp);
  assert.equal(mode, 'static');
  assert.equal(keyframeCount, 0);
});

test('chooseRenderMode: small timeline → inline', () => {
  const samples = Array.from({ length: 50 }, (_, i) => ({ t_ms: i * 200, cx: 500 + i * 5, cy: 300 }));
  const cp = baseCropPath(samples);
  cp.target_w = 200; cp.target_h = 200;
  const { mode, byteSize } = chooseRenderMode(cp);
  assert.equal(mode, 'inline');
  assert.ok(byteSize < 100_000);
});

test('chooseRenderMode: long input is downsampled to fit ffmpeg cap, stays inline', () => {
  // 7000 samples — downsampled to 99 (ffmpeg's nested-if ceiling), expression
  // shrinks to ~7-9 KB, well under 100 KB threshold → mode is 'inline'.
  const samples = Array.from({ length: 7000 }, (_, i) => ({ t_ms: i * 166, cx: 500 + (i % 1000), cy: 300 }));
  const cp = baseCropPath(samples);
  cp.target_w = 200; cp.target_h = 200;
  const { mode, byteSize, keyframeCount, downsampled, originalKeyframeCount } = chooseRenderMode(cp, 100_000);
  assert.equal(mode, 'inline', 'downsample brings byteSize well under 100 KB');
  assert.equal(keyframeCount, 99, 'post-downsample keyframe count must equal ffmpeg cap');
  assert.equal(downsampled, true);
  assert.ok(originalKeyframeCount > 99, 'originalKeyframeCount records pre-downsample size');
  assert.ok(byteSize < 100_000, 'downsampled expression should be < 100 KB; got ' + byteSize);
});

test('chooseRenderMode: filter-script triggers when threshold is below tiny expression size', () => {
  // Force the filter-script path by using a much smaller threshold than even
  // a small expression. Confirms the routing logic, not the realistic case.
  const samples = Array.from({ length: 50 }, (_, i) => ({ t_ms: i * 200, cx: 500 + i * 5, cy: 300 }));
  const cp = baseCropPath(samples);
  cp.target_w = 200; cp.target_h = 200;
  const { mode } = chooseRenderMode(cp, 100); // 100-byte threshold → script mode
  assert.equal(mode, 'filter-script');
});

test('chooseRenderMode: threshold is overridable (large threshold keeps inline)', () => {
  const samples = Array.from({ length: 50 }, (_, i) => ({ t_ms: i * 200, cx: 500 + i * 5, cy: 300 }));
  const cp = baseCropPath(samples);
  cp.target_w = 200; cp.target_h = 200;
  const { mode } = chooseRenderMode(cp, 1_000_000);
  assert.equal(mode, 'inline');
});

test('downsampled flag fires only when post-dedupe count exceeds maxKeyframes', () => {
  // Use cx values that survive clamping so dedupe doesn't collapse them.
  // Source 1920×1080, target 9:16 → crop 608×1080, maxX = 1312.
  // cx = 800 + i*2 (i=0..199) → x = round(cx - 304) ∈ [496..894], all in-range, all unique.
  const samples = Array.from({ length: 200 }, (_, i) => ({ t_ms: i * 100, cx: 800 + i * 2, cy: 540 }));
  const cp = baseCropPath(samples);
  // Use default baseCropPath target (1080×1920) so crop dims are 608×1080.
  const { keyframeCount, downsampled, originalKeyframeCount } = buildCropExpression(cp);
  assert.equal(downsampled, true);
  assert.equal(keyframeCount, 99);
  assert.equal(originalKeyframeCount, 200, 'all 200 inputs should pass dedupe');
});

test('downsample preserves the first and last keyframes', () => {
  const samples = Array.from({ length: 200 }, (_, i) => ({ t_ms: i * 100, cx: 800 + i * 2, cy: 540 }));
  const cp = baseCropPath(samples);
  const { exprX } = buildCropExpression(cp);
  // First keyframe x = round(800 - 304) = 496; last = round(800 + 199*2 - 304) = 894
  assert.ok(exprX.includes('496'), 'first keyframe x=496 should be in expression: ' + exprX.slice(0, 60));
  assert.ok(exprX.includes('894'), 'last keyframe x=894 should be in expression');
});

// ----- v0.4.0 pillar 6: split-screen tests -----

test('chooseSplitAxis: 9:16 → vstack', () => {
  assert.equal(chooseSplitAxis('9:16'), 'vstack');
});
test('chooseSplitAxis: 4:5 → vstack', () => {
  assert.equal(chooseSplitAxis('4:5'), 'vstack');
});
test('chooseSplitAxis: 1:1 → hstack', () => {
  assert.equal(chooseSplitAxis('1:1'), 'hstack');
});
test('chooseSplitAxis: 16:9 → hstack', () => {
  assert.equal(chooseSplitAxis('16:9'), 'hstack');
});

test('buildSplitScreenFilter: 9:16 emits vstack chain with two crop+scale panels', () => {
  const sample = {
    t_ms: 0,
    split_screen: {
      speakers: [
        { speaker_id: 0, cx: 480,  cy: 540, scale: 1.4 },
        { speaker_id: 1, cx: 1440, cy: 540, scale: 1.4 },
      ],
    },
  };
  const r = buildSplitScreenFilter({
    sample, sourceW: 1920, sourceH: 1080,
    targetW: 1080, targetH: 1920, targetAspect: '9:16',
  });
  assert.equal(r.axis, 'vstack');
  assert.equal(r.panelW, 1080);
  assert.equal(r.panelH, 960);
  assert.match(r.filter, /vstack/);
  assert.match(r.filter, /\[0:v\]crop=/);
  // Two panel sub-chains.
  assert.equal((r.filter.match(/crop=/g) || []).length, 2);
});

test('buildSplitScreenFilter: 16:9 emits hstack chain with two side-by-side panels', () => {
  const sample = {
    t_ms: 0,
    split_screen: {
      speakers: [
        { speaker_id: 0, cx: 480,  cy: 540, scale: 1.4 },
        { speaker_id: 1, cx: 1440, cy: 540, scale: 1.4 },
      ],
    },
  };
  const r = buildSplitScreenFilter({
    sample, sourceW: 1920, sourceH: 1080,
    targetW: 1920, targetH: 1080, targetAspect: '16:9',
  });
  assert.equal(r.axis, 'hstack');
  assert.equal(r.panelW, 960);
  assert.equal(r.panelH, 1080);
  assert.match(r.filter, /hstack/);
});

test('buildSplitScreenFilter: speaker_id 0 is always FIRST in the stack (identity stability S3)', () => {
  // Pass speakers in reversed order — builder MUST resort so speaker_id 0 is first.
  const sample = {
    t_ms: 0,
    split_screen: {
      speakers: [
        { speaker_id: 1, cx: 1440, cy: 540, scale: 1.4 },
        { speaker_id: 0, cx: 480,  cy: 540, scale: 1.4 },
      ],
    },
  };
  const r = buildSplitScreenFilter({
    sample, sourceW: 1920, sourceH: 1080,
    targetW: 1080, targetH: 1920, targetAspect: '9:16',
  });
  assert.deepEqual(r.speakerOrder, [0, 1], 'speaker_id 0 must precede 1 in the stack');
  // The vstack line consumes [outLabel_p0][outLabel_p1] → speaker 0 on top.
  assert.match(r.filter, /\[vss_p0\]\[vss_p1\]vstack/);
});

test('buildSplitScreenFilter: hstack axis with two speakers — speaker 0 on LEFT', () => {
  const sample = {
    t_ms: 0,
    split_screen: {
      speakers: [
        { speaker_id: 0, cx: 480,  cy: 540, scale: 1.4 },
        { speaker_id: 1, cx: 1440, cy: 540, scale: 1.4 },
      ],
    },
  };
  const r = buildSplitScreenFilter({
    sample, sourceW: 1920, sourceH: 1080,
    targetW: 1920, targetH: 1080, targetAspect: '16:9',
  });
  // hstack consumes left-then-right: speaker 0 is left because it's p0.
  assert.match(r.filter, /\[vss_p0\]\[vss_p1\]hstack/);
});

test('buildSplitScreenFilter: missing speakers (<2) returns empty filter', () => {
  const sample = { t_ms: 0, split_screen: { speakers: [{ speaker_id: 0, cx: 100, cy: 100, scale: 1.0 }] } };
  const r = buildSplitScreenFilter({
    sample, sourceW: 1920, sourceH: 1080,
    targetW: 1080, targetH: 1920, targetAspect: '9:16',
  });
  assert.equal(r.filter, '');
});

test('summarizeSplitScreenSamples counts split samples and detected speakers', () => {
  const cropPath = {
    version: 3,
    source_w: 1920, source_h: 1080,
    target_w: 1080, target_h: 1920,
    samples: [
      { t_ms: 0, cx: 960, cy: 540, scale: 1.0 },
      { t_ms: 1500, split_screen: { speakers: [
        { speaker_id: 0, cx: 480,  cy: 540, scale: 1.4 },
        { speaker_id: 1, cx: 1440, cy: 540, scale: 1.4 },
      ] } },
      { t_ms: 3000, split_screen: { speakers: [
        { speaker_id: 0, cx: 480,  cy: 540, scale: 1.4 },
        { speaker_id: 1, cx: 1440, cy: 540, scale: 1.4 },
      ] } },
      { t_ms: 4500, cx: 960, cy: 540, scale: 1.0 },
    ],
  };
  const s = summarizeSplitScreenSamples(cropPath);
  assert.equal(s.count, 2);
  assert.deepEqual(s.speakers, [0, 1]);
  assert.equal(s.total_duration_ms, 1500);
});
