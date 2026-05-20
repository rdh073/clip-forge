// brand-kit.test.mjs — unit tests for the brand-kit loader/saver.
//
// Coverage:
//   - missing file → empty kit
//   - malformed JSON → empty kit + brand_kit_unreadable warning
//   - normalisation drops bogus fields, clamps opacity/scale_px
//   - per-project wins over global (no merge)
//   - per-project unreadable → fallback to global with brand_kit_unreadable warning
//   - file-size enforcement: oversized logo (≥ 2 MB) → skipped + brand_kit_asset_oversize warning
//   - missing-path enforcement: brand_asset_missing:<key> warning + asset skipped
//   - resolveKitForEdit precedence: inline > brand_kit_ref > legacy string > project > global
//   - legacy watermark string maps to {assets.logo} with default position
//   - upsertAsset + removeAsset + saveKitFile + round-trip

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadKitFile, loadKit, resolveKitForEdit, enforceAssetLimits,
  upsertAsset, removeAsset, saveKitFile, SCHEMA_VERSION, LIMITS,
} from './brand-kit.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-brand-kit-test-')); }

function makeFile(path, bytes) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 0));
}

test('loadKitFile: missing file → empty kit + brand_kit_file_missing warning', () => {
  const d = tmp();
  try {
    const r = loadKitFile(join(d, 'nope.json'));
    assert.equal(r.ok, false);
    assert.equal(r.warning, 'brand_kit_file_missing');
    assert.deepEqual(r.kit.assets, {});
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadKitFile: malformed JSON → empty kit + brand_kit_unreadable warning', () => {
  const d = tmp();
  try {
    const p = join(d, 'bad.json');
    writeFileSync(p, '{ not: valid');
    const r = loadKitFile(p);
    assert.equal(r.ok, false);
    const codes = r.warnings.map((w) => w.code);
    assert.ok(codes.includes('brand_kit_unreadable'),
      'malformed JSON must emit brand_kit_unreadable; got ' + JSON.stringify(codes));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadKitFile: normalisation clamps opacity to [0,1] + defaults position', () => {
  const d = tmp();
  try {
    const logoPath = join(d, 'logo.png');
    makeFile(logoPath, 1024);
    const p = join(d, 'kit.json');
    writeFileSync(p, JSON.stringify({
      version: 1, name: 'x',
      assets: {
        logo: { path: logoPath, opacity: 999, scale_px: 'nope', position: 'bogus' },
      },
    }));
    const r = loadKitFile(p);
    assert.equal(r.ok, true);
    assert.equal(r.kit.assets.logo.opacity, 1);
    assert.equal(r.kit.assets.logo.scale_px, 96, 'invalid scale_px → default 96');
    assert.equal(r.kit.assets.logo.position, 'bottom-right', 'invalid position → default bottom-right');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadKit: per-project wins entirely over global (no merge)', () => {
  const d = tmp();
  try {
    const globalLogo  = join(d, 'global-logo.png');
    const projectLogo = join(d, 'project-logo.png');
    makeFile(globalLogo, 1024);
    makeFile(projectLogo, 2048);
    const globalP  = join(d, 'global', 'brand-kit.json');
    const projectP = join(d, 'project', 'brand-kit.json');
    saveKitFile(globalP, {
      version: 1, name: 'default',
      assets: { logo: { path: globalLogo, position: 'bottom-right', opacity: 0.5, scale_px: 64 } },
    });
    saveKitFile(projectP, {
      version: 1, name: 'project',
      assets: { logo: { path: projectLogo, position: 'top-left', opacity: 0.9, scale_px: 128 } },
    });
    const r = loadKit({ globalPath: globalP, projectPath: projectP });
    assert.equal(r.source, 'project');
    assert.equal(r.kit.assets.logo.path, projectLogo);
    assert.equal(r.kit.assets.logo.scale_px, 128);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadKit: project file unreadable → falls back to global with brand_kit_unreadable warning', () => {
  const d = tmp();
  try {
    const globalLogo = join(d, 'global-logo.png');
    makeFile(globalLogo, 1024);
    const globalP  = join(d, 'global', 'brand-kit.json');
    const projectP = join(d, 'project', 'brand-kit.json');
    saveKitFile(globalP, {
      version: 1, name: 'default',
      assets: { logo: { path: globalLogo, position: 'bottom-right', opacity: 0.5, scale_px: 64 } },
    });
    mkdirSync(join(d, 'project'), { recursive: true });
    writeFileSync(projectP, '{ corrupt');
    const r = loadKit({ globalPath: globalP, projectPath: projectP });
    assert.equal(r.source, 'global');
    const codes = r.warnings.map((w) => w.code);
    assert.ok(codes.includes('brand_kit_unreadable'));
    assert.equal(r.kit.assets.logo.path, globalLogo);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('enforceAssetLimits: oversized logo (≥ 2 MB) skipped with brand_kit_asset_oversize', () => {
  const d = tmp();
  try {
    const big = join(d, 'big.png');
    makeFile(big, LIMITS.logo_bytes + 1);  // 1 byte over 2 MB
    const kit = {
      version: 1, name: 'x',
      assets: { logo: { path: big, position: 'bottom-right', opacity: 0.7, scale_px: 96 } },
    };
    const warnings = [];
    enforceAssetLimits(kit, warnings);
    assert.equal(kit.assets.logo, undefined, 'oversized logo must be removed');
    const codes = warnings.map((w) => w.code);
    assert.ok(codes.includes('brand_kit_asset_oversize'),
      'oversize must emit brand_kit_asset_oversize; got ' + JSON.stringify(codes));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('enforceAssetLimits: missing path → brand_asset_missing:<key>, asset skipped', () => {
  const d = tmp();
  try {
    const kit = {
      version: 1, name: 'x',
      assets: {
        logo:        { path: join(d, 'gone.png'), position: 'bottom-right', opacity: 0.7, scale_px: 96 },
        endcard:     { path: join(d, 'gone.png'), duration_ms: 3000 },
        lower_third: { path: join(d, 'gone.png'), position: 'bottom-left', opacity: 0.9, show_from_ms: 0, show_until_ms: 1000 },
      },
    };
    const warnings = [];
    enforceAssetLimits(kit, warnings);
    const codes = warnings.filter((w) => w.code === 'brand_asset_missing').map((w) => w.asset);
    assert.deepEqual(codes.sort(), ['endcard', 'logo', 'lower_third'].sort(),
      'all three missing assets must emit brand_asset_missing with their key');
    assert.equal(kit.assets.logo, undefined);
    assert.equal(kit.assets.endcard, undefined);
    assert.equal(kit.assets.lower_third, undefined);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolveKitForEdit: inline brand_kit wins over watermark string', () => {
  const d = tmp();
  try {
    const inlineLogo = join(d, 'inline-logo.png');
    const legacyLogo = join(d, 'legacy-logo.png');
    makeFile(inlineLogo, 1024);
    makeFile(legacyLogo, 1024);
    const r = resolveKitForEdit({
      brand_kit: {
        version: 1, name: 'inline',
        assets: { logo: { path: inlineLogo, position: 'center', opacity: 0.6, scale_px: 120 } },
      },
      watermark: legacyLogo,
    });
    assert.equal(r.source, 'inline');
    assert.equal(r.kit.assets.logo.path, inlineLogo);
    assert.equal(r.applied, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolveKitForEdit: legacy watermark string maps to logo-only kit (B5 backward-compat)', () => {
  const d = tmp();
  try {
    const legacy = join(d, 'legacy-logo.png');
    makeFile(legacy, 4096);
    const r = resolveKitForEdit({ watermark: legacy });
    assert.equal(r.source, 'legacy', 'legacy string watermark must resolve as legacy source');
    assert.equal(r.kit.assets.logo.path, legacy);
    assert.equal(r.kit.assets.logo.position, 'bottom-right',
      'legacy default position must be bottom-right (matches existing cf-ffmpeg watermark)');
    assert.ok(Math.abs(r.kit.assets.logo.opacity - 0.7) < 1e-6,
      'legacy default opacity must be 0.7');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolveKitForEdit: brand_kit_ref → loads referenced file, source="ref"', () => {
  const d = tmp();
  try {
    const logo = join(d, 'ref-logo.png');
    makeFile(logo, 1024);
    const refPath = join(d, 'ref.json');
    saveKitFile(refPath, {
      version: 1, name: 'ref',
      assets: { logo: { path: logo, position: 'bottom-left', opacity: 0.5, scale_px: 64 } },
    });
    const r = resolveKitForEdit({ watermark: { brand_kit_ref: refPath } });
    assert.equal(r.source, 'ref');
    assert.equal(r.kit.assets.logo.path, logo);
    assert.equal(r.kit.assets.logo.position, 'bottom-left');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolveKitForEdit: no brand info at all → empty kit + applied:false (B1)', () => {
  const r = resolveKitForEdit({});
  assert.equal(r.applied, false);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.kit.assets.logo, undefined);
});

test('upsertAsset + removeAsset + saveKitFile round-trip', () => {
  const d = tmp();
  try {
    const logo = join(d, 'logo.png');
    makeFile(logo, 1024);
    let kit = { version: 1, name: 'x', assets: {} };
    kit = upsertAsset(kit, 'logo', { path: logo, position: 'bottom-right', opacity: 0.7, scale_px: 96 });
    const p = join(d, 'kit.json');
    saveKitFile(p, kit);
    const r = loadKitFile(p);
    assert.equal(r.ok, true);
    assert.equal(r.kit.assets.logo.path, logo);

    const removed = removeAsset(r.kit, 'logo');
    assert.equal(removed.assets.logo, undefined, 'removeAsset clears the key');
    saveKitFile(p, removed);
    const r2 = loadKitFile(p);
    assert.equal(r2.kit.assets.logo, undefined);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
