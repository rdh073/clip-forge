// render-manifest.test.mjs — unit tests for the cf-edit render manifest
// I/O + diff (v0.4.0 pillar 4).
//
// Coverage:
//   - hashFileSha256: deterministic + null on missing
//   - computeInputHashes: all six input slots present
//   - diffClips: cold-start, no-change, mid-change
//   - saveManifestAtomic: writes + survives crash semantics
//   - loadManifestFile preserves pillar-2 ai_costs (composition guarantee)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hashFileSha256, hashStringSha256, computeInputHashes, diffClips,
  loadManifestFile, saveManifestAtomic, recordClipRender, manifestPathForSlug,
} from './render-manifest.mjs';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'cf-rm-')); }

test('hashFileSha256: deterministic for same content', () => {
  const dir = tmpDir();
  try {
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'hello world');
    const h1 = hashFileSha256(p);
    const h2 = hashFileSha256(p);
    assert.equal(h1, h2);
    assert.ok(h1.startsWith('sha256:'));
    assert.equal(h1.length, 'sha256:'.length + 64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hashFileSha256: null on missing file', () => {
  assert.equal(hashFileSha256('/nonexistent/path.json'), null);
  assert.equal(hashFileSha256(null), null);
  assert.equal(hashFileSha256(''), null);
});

test('hashFileSha256: different content → different hash', () => {
  const dir = tmpDir();
  try {
    const a = join(dir, 'a.txt'); const b = join(dir, 'b.txt');
    writeFileSync(a, 'hello'); writeFileSync(b, 'world');
    assert.notEqual(hashFileSha256(a), hashFileSha256(b));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('computeInputHashes: all six slots populated for a complete edit.json', () => {
  const dir = tmpDir();
  try {
    const crop = join(dir, 'crop.json'); writeFileSync(crop, '{"v":2}');
    const ass = join(dir, 'cap.ass');    writeFileSync(ass, '[Script Info]');
    const cuts = join(dir, 'cuts.json'); writeFileSync(cuts, '{"cuts":[]}');
    const audio = join(dir, 'a.wav');    writeFileSync(audio, Buffer.alloc(16));
    const wm = join(dir, 'wm.png');      writeFileSync(wm, Buffer.alloc(32));
    const edit = join(dir, 'edit.json');
    writeFileSync(edit, JSON.stringify({
      clip_id: 'c01',
      crop_path: crop, captions: ass, cuts: cuts,
      audio_source: audio, watermark: wm,
    }));
    const h = computeInputHashes(edit);
    assert.ok(h.edit_json.startsWith('sha256:'));
    assert.ok(h.crop_path.startsWith('sha256:'));
    assert.ok(h.captions_ass.startsWith('sha256:'));
    assert.ok(h.cuts_plan.startsWith('sha256:'));
    assert.ok(h.audio_source.startsWith('sha256:'));
    assert.ok(h.brand_kit.startsWith('sha256:'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('computeInputHashes: inline brand_kit object → hashed canonically', () => {
  const dir = tmpDir();
  try {
    const edit = join(dir, 'edit.json');
    writeFileSync(edit, JSON.stringify({
      brand_kit: { version: 1, assets: { logo: { path: '/x.png' } } },
    }));
    const h = computeInputHashes(edit);
    assert.ok(h.brand_kit.startsWith('sha256:'));
    // Reordering keys must not change the brand_kit hash.
    writeFileSync(edit, JSON.stringify({
      brand_kit: { assets: { logo: { path: '/x.png' } }, version: 1 },
    }));
    const h2 = computeInputHashes(edit);
    assert.equal(h.brand_kit, h2.brand_kit);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('computeInputHashes: missing edit.json → all nulls', () => {
  const h = computeInputHashes('/nonexistent/edit.json');
  for (const k of Object.keys(h)) assert.equal(h[k], null);
});

test('diffClips: cold-start → all clips stale with reason cold_start', () => {
  const dir = tmpDir();
  try {
    const edit = join(dir, 'edit.json');
    writeFileSync(edit, JSON.stringify({ clip_id: 'c01' }));
    const manifest = loadManifestFile(null);
    const r = diffClips([{ clip_id: 'c01', edit_json_path: edit }], manifest);
    assert.deepEqual(r.stale, ['c01']);
    assert.equal(r.reasons.c01.reason, 'cold_start');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('diffClips: identical inputs → no stale clips (idempotent)', () => {
  const dir = tmpDir();
  try {
    const edit = join(dir, 'edit.json');
    writeFileSync(edit, JSON.stringify({ clip_id: 'c01' }));
    const manifest = loadManifestFile(null);
    recordClipRender(manifest, {
      clip_id:      'c01',
      output:       '/dev/null',
      input_hashes: computeInputHashes(edit),
    });
    const r = diffClips([{ clip_id: 'c01', edit_json_path: edit }], manifest);
    assert.deepEqual(r.stale, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('diffClips: mutating edit.json → that clip becomes stale', () => {
  const dir = tmpDir();
  try {
    const edit = join(dir, 'edit.json');
    writeFileSync(edit, JSON.stringify({ clip_id: 'c01', hook: 'A' }));
    const manifest = loadManifestFile(null);
    recordClipRender(manifest, {
      clip_id:      'c01',
      output:       '/dev/null',
      input_hashes: computeInputHashes(edit),
    });
    // Mutate.
    writeFileSync(edit, JSON.stringify({ clip_id: 'c01', hook: 'B' }));
    const r = diffClips([{ clip_id: 'c01', edit_json_path: edit }], manifest);
    assert.deepEqual(r.stale, ['c01']);
    assert.ok(r.reasons.c01.reason.startsWith('input_changed:'));
    assert.ok(r.reasons.c01.stale_keys.includes('edit_json'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saveManifestAtomic: writes manifest + survives byte-for-byte rewrite', () => {
  const dir = tmpDir();
  try {
    const p = join(dir, 'manifest.json');
    const m = { version: 1, slug: 's', clips: { c01: { input_hashes: {} } } };
    saveManifestAtomic(p, m);
    assert.ok(existsSync(p));
    const reloaded = JSON.parse(readFileSync(p, 'utf-8'));
    assert.equal(reloaded.slug, 's');
    assert.ok(reloaded.clips.c01);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saveManifestAtomic: tmp file does not linger after rename', () => {
  const dir = tmpDir();
  try {
    const p = join(dir, 'manifest.json');
    saveManifestAtomic(p, { version: 1, slug: 's', clips: {} });
    const entries = readFileSync(p).length > 0;
    assert.ok(entries);
    // No <path>.tmp.* should remain.
    const list = readdirSync(dir);
    const stragglers = list.filter((f) => f.startsWith('manifest.json.tmp'));
    assert.equal(stragglers.length, 0,
      'no .tmp.* siblings should remain after atomic write; got ' + JSON.stringify(stragglers));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadManifestFile: missing path → empty shell with slug', () => {
  const m = loadManifestFile('/nonexistent/manifest.json', { slug: 'demo' });
  assert.equal(m.slug, 'demo');
  assert.deepEqual(m.clips, {});
});

test('loadManifestFile: preserves pillar-2 ai_costs block byte-for-byte', () => {
  const dir = tmpDir();
  try {
    const p = join(dir, 'manifest.json');
    const pillar2 = {
      version: 1, slug: 'demo',
      ai_costs: {
        cumulative_usd: 0.42,
        budget_cap_usd: 10,
        breakdown: { elevenlabs_tts: 0.30, groq_translate: 0.12 },
        skipped: [],
        history: [{ ts: '2026-05-21T00:00:00Z', provider: 'elevenlabs', kind: 'tts',
                    delta_usd: 0.30, clip_id: 'c01', lang: 'id' }],
      },
    };
    saveManifestAtomic(p, pillar2);
    const m = loadManifestFile(p, { slug: 'demo' });
    assert.equal(m.ai_costs.cumulative_usd, 0.42);
    assert.equal(m.ai_costs.breakdown.elevenlabs_tts, 0.30);
    assert.equal(m.ai_costs.history.length, 1);
    // Add pillar-4 clips block; save; ai_costs must stay intact.
    recordClipRender(m, {
      clip_id: 'c01', output: '/dev/null',
      input_hashes: { edit_json: 'sha256:abc' },
    });
    saveManifestAtomic(p, m);
    const reloaded = JSON.parse(readFileSync(p, 'utf-8'));
    assert.equal(reloaded.ai_costs.cumulative_usd, 0.42,
      'pillar-2 cumulative_usd must survive pillar-4 rewrite');
    assert.equal(reloaded.ai_costs.breakdown.elevenlabs_tts, 0.30,
      'pillar-2 breakdown must survive pillar-4 rewrite');
    assert.equal(reloaded.ai_costs.history[0].provider, 'elevenlabs',
      'pillar-2 history entries must survive pillar-4 rewrite');
    assert.ok(reloaded.clips.c01.input_hashes,
      'pillar-4 clips block must be present alongside ai_costs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hashStringSha256: matches openssl reference', () => {
  // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  assert.equal(hashStringSha256('hello'),
    'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('manifestPathForSlug: builds ./renders/<slug>/render_manifest.json', () => {
  assert.equal(manifestPathForSlug('demo'),
    join('./renders', 'demo', 'render_manifest.json'));
  assert.equal(manifestPathForSlug('demo', { rendersRoot: '/tmp/r' }),
    join('/tmp/r', 'demo', 'render_manifest.json'));
});
