// brand-overlay-builder.test.mjs — unit tests for the pure-logic ffmpeg
// filter expression builders. No ffmpeg invocation; pure string assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  positionExpr, buildLogoOverlay, buildLowerThirdOverlay,
  composeBrandKitFilter, resolveBrandToken,
} from './brand-overlay-builder.mjs';

test('positionExpr: five named positions map to ffmpeg overlay expressions', () => {
  const W = 1920, H = 1080;
  assert.match(positionExpr('bottom-right', W, H).x, /^W-w-\d+$/);
  assert.match(positionExpr('bottom-right', W, H).y, /^H-h-\d+$/);
  assert.equal(positionExpr('center', W, H).x, '(W-w)/2');
  assert.equal(positionExpr('center', W, H).y, '(H-h)/2');
  assert.match(positionExpr('top-left', W, H).x, /^\d+$/);
  assert.match(positionExpr('top-left', W, H).y, /^\d+$/);
});

test('positionExpr: 16:9 padding scales with canvas width', () => {
  const narrow = positionExpr('bottom-right', 1080, 1920);
  const wide   = positionExpr('bottom-right', 1920, 1080);
  // Padding is 4% of W/H. 1080×0.04 = 43; 1920×0.04 = 76.
  assert.match(narrow.x, /W-w-43/);
  assert.match(wide.x,   /W-w-76/);
});

test('buildLogoOverlay: PNG logo emits format=rgba, scale, colorchannelmixer, overlay', () => {
  const r = buildLogoOverlay({
    asset: { path: '/abs/logo.png', position: 'bottom-right', opacity: 0.7, scale_px: 96 },
    canvasW: 1080, canvasH: 1920,
    inputIndex: 2, inLabel: '0:v', outLabel: 'vlogo',
  });
  assert.equal(r.skipped, false);
  assert.match(r.filter, /\[2:v\]format=rgba/);
  assert.match(r.filter, /scale=96:-1/);
  assert.match(r.filter, /colorchannelmixer=aa=0\.700/);
  assert.match(r.filter, /\[0:v\]\[logo_wm_2\]overlay=/);
  assert.match(r.filter, /\[vlogo\]$/);
});

test('buildLogoOverlay: SVG path without librsvg → skipped + librsvg_not_available warning', () => {
  const r = buildLogoOverlay({
    asset: { path: '/abs/logo.svg', position: 'bottom-right', opacity: 0.7, scale_px: 96 },
    canvasW: 1080, canvasH: 1920,
    inputIndex: 2,
    librsvgAvailable: false,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.svg, true);
  const codes = r.warnings.map((w) => w.code);
  assert.ok(codes.includes('librsvg_not_available'));
});

test('buildLogoOverlay: SVG path WITH librsvg → not skipped, filter emitted', () => {
  const r = buildLogoOverlay({
    asset: { path: '/abs/logo.svg', position: 'bottom-right', opacity: 0.7, scale_px: 96 },
    canvasW: 1080, canvasH: 1920,
    inputIndex: 2,
    librsvgAvailable: true,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.svg, true);
  assert.equal(r.warnings.length, 0);
});

test('buildLogoOverlay: missing asset → skipped, no warning', () => {
  const r = buildLogoOverlay({ asset: null, inputIndex: 2 });
  assert.equal(r.skipped, true);
  assert.equal(r.filter, '');
  assert.equal(r.warnings.length, 0);
});

test('buildLowerThirdOverlay: emits time-gated enable=between(t,…) expression', () => {
  const r = buildLowerThirdOverlay({
    asset: {
      path: '/abs/lt.png', position: 'bottom-left', opacity: 0.9,
      show_from_ms: 1500, show_until_ms: 4000,
    },
    canvasW: 1080, canvasH: 1920,
    inputIndex: 3, inLabel: '0:v', outLabel: 'vlt',
  });
  assert.equal(r.skipped, false);
  assert.match(r.filter, /enable='between\(t,1\.500,4\.000\)'/);
  assert.match(r.filter, /\[vlt\]$/);
});

test('buildLowerThirdOverlay: show_until_ms ≤ show_from_ms → clamped to from + 50ms', () => {
  const r = buildLowerThirdOverlay({
    asset: { path: '/abs/lt.png', show_from_ms: 1000, show_until_ms: 500 },
    canvasW: 1080, canvasH: 1920,
    inputIndex: 3,
  });
  assert.match(r.filter, /enable='between\(t,1\.000,1\.050\)'/);
});

test('composeBrandKitFilter: empty kit → empty chain, no extraInputs', () => {
  const r = composeBrandKitFilter({ brand: { assets: {} } });
  assert.equal(r.chain, '');
  assert.deepEqual(r.extraInputs, []);
  assert.deepEqual(r.assetsBurned, []);
});

test('composeBrandKitFilter: logo only → 1 extraInput, finalLabel=vlogo, assetsBurned=["logo"]', () => {
  const r = composeBrandKitFilter({
    brand: {
      assets: { logo: { path: '/abs/l.png', position: 'bottom-right', opacity: 0.7, scale_px: 96 } },
    },
    canvasW: 1080, canvasH: 1920, inputIndexOffset: 1,
  });
  assert.equal(r.extraInputs.length, 1);
  assert.equal(r.extraInputs[0], '/abs/l.png');
  assert.deepEqual(r.assetsBurned, ['logo']);
  assert.equal(r.finalLabel, 'vlogo');
});

test('composeBrandKitFilter: logo + lower_third → 2 inputs, chained, finalLabel=vlt', () => {
  const r = composeBrandKitFilter({
    brand: {
      assets: {
        logo:        { path: '/abs/l.png',  position: 'bottom-right', opacity: 0.7, scale_px: 96 },
        lower_third: { path: '/abs/lt.png', position: 'bottom-left',  opacity: 0.9, show_from_ms: 1000, show_until_ms: 3000 },
      },
    },
    canvasW: 1080, canvasH: 1920, inputIndexOffset: 1,
  });
  assert.equal(r.extraInputs.length, 2);
  assert.deepEqual(r.assetsBurned, ['logo', 'lower_third']);
  assert.equal(r.finalLabel, 'vlt');
  // The first overlay reads [0:v]; the second reads [vlogo] from the first.
  assert.match(r.chain, /\[0:v\]\[logo_wm_1\]overlay=[^;]+\[vlogo\]/);
  assert.match(r.chain, /\[vlogo\]\[lt_wm_2\]overlay=/);
});

test('composeBrandKitFilter: lower_third only (no logo) → finalLabel=vlt, 1 input at offset', () => {
  const r = composeBrandKitFilter({
    brand: {
      assets: { lower_third: { path: '/abs/lt.png', show_from_ms: 1000, show_until_ms: 3000 } },
    },
    canvasW: 1080, canvasH: 1920, inputIndexOffset: 1,
  });
  assert.equal(r.extraInputs.length, 1);
  assert.deepEqual(r.assetsBurned, ['lower_third']);
  assert.equal(r.finalLabel, 'vlt');
  assert.match(r.chain, /\[0:v\]\[lt_wm_1\]overlay=/);
});

test('composeBrandKitFilter: SVG without librsvg in same kit as PNG → PNG renders, SVG skipped', () => {
  const r = composeBrandKitFilter({
    brand: {
      assets: {
        logo:        { path: '/abs/l.svg', position: 'bottom-right', opacity: 0.7, scale_px: 96 },
        lower_third: { path: '/abs/lt.png', show_from_ms: 1000, show_until_ms: 3000 },
      },
    },
    canvasW: 1080, canvasH: 1920, inputIndexOffset: 1,
    librsvgAvailable: false,
  });
  assert.deepEqual(r.assetsBurned, ['lower_third']);
  const codes = r.warnings.map((w) => w.code);
  assert.ok(codes.includes('librsvg_not_available'));
  // Only one extra input (the lower_third PNG); SVG was skipped.
  assert.equal(r.extraInputs.length, 1);
});

test('resolveBrandToken: $brand.logo → resolves to kit.assets.logo.path', () => {
  const kit = { assets: { logo: { path: '/abs/l.png' } } };
  assert.equal(resolveBrandToken('$brand.logo', kit), '/abs/l.png');
  assert.equal(resolveBrandToken('$brand.colors.primary', kit), null,
    'colour tokens are documented hooks — not yet resolved this round');
  assert.equal(resolveBrandToken('not-a-token', kit), null);
});
