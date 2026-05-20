// visual.test.mjs — unit tests for the visual.mjs dispatcher (v0.4.0 pillar 5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

import { resolveProvider, generate, PRECEDENCE } from './visual.mjs';

const PLUGIN_ROOT = resolvePath(fileURLToPath(import.meta.url), '../../..');
const VISUAL_MOCK = join(PLUGIN_ROOT, 'tests', 'mocks', 'visual-mock.mjs');

function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('visual: precedence — fal preferred over nanobanana when both set', () => {
  withEnv({
    FAL_API_KEY: 'fal-test', GEMINI_API_KEY: 'gem-test',
    REPLICATE_API_TOKEN: undefined, CF_VISUAL_PROVIDER: undefined,
  }, () => {
    const p = resolveProvider();
    assert.equal(p.name, 'fal');
  });
});

test('visual: precedence — nanobanana picked when only GEMINI_API_KEY set', () => {
  withEnv({
    FAL_API_KEY: undefined, GEMINI_API_KEY: 'gem-test',
    REPLICATE_API_TOKEN: undefined, CF_VISUAL_PROVIDER: undefined,
  }, () => {
    const p = resolveProvider();
    assert.equal(p.name, 'nanobanana');
  });
});

test('visual: precedence — replicate picked when only REPLICATE_API_TOKEN set', () => {
  withEnv({
    FAL_API_KEY: undefined, GEMINI_API_KEY: undefined,
    REPLICATE_API_TOKEN: 'rep-test', CF_VISUAL_PROVIDER: undefined,
  }, () => {
    const p = resolveProvider();
    assert.equal(p.name, 'replicate');
  });
});

test('visual: no keys → resolveProvider returns null', () => {
  withEnv({
    FAL_API_KEY: undefined, GEMINI_API_KEY: undefined,
    REPLICATE_API_TOKEN: undefined, CF_VISUAL_PROVIDER: undefined,
  }, () => {
    assert.equal(resolveProvider(), null);
  });
});

test('visual: CF_VISUAL_PROVIDER=nanobanana overrides FAL_API_KEY', () => {
  withEnv({
    FAL_API_KEY: 'fal-test', CF_VISUAL_PROVIDER: 'nanobanana',
  }, () => {
    const p = resolveProvider();
    assert.equal(p.name, 'nanobanana');
  });
});

test('visual: CF_VISUAL_PROVIDER=unknown throws', () => {
  withEnv({ CF_VISUAL_PROVIDER: 'bogus' }, () => {
    assert.throws(() => resolveProvider(), /unknown provider/);
  });
});

test('visual.generate: no provider + no mock → fallback_used=no_visual_provider', async () => {
  await withEnv({
    FAL_API_KEY: undefined, GEMINI_API_KEY: undefined,
    REPLICATE_API_TOKEN: undefined, CF_VISUAL_PROVIDER: undefined,
    CF_VISUAL_MOCK: undefined,
  }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cf-visual-test-'));
    const out = join(tmp, 'img.png');
    const r = await generate({ prompt: 'test', paths: [out], aspect: '9:16' });
    assert.equal(r.fallback_used, true);
    assert.equal(r.fallback_reason, 'no_visual_provider');
    rmSync(tmp, { recursive: true, force: true });
  });
});

test('visual.generate: CF_VISUAL_MOCK writes a real PNG + returns cost_usd', async () => {
  await withEnv({ CF_VISUAL_MOCK: VISUAL_MOCK }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cf-visual-test-'));
    const out = join(tmp, 'img.png');
    const r = await generate({ prompt: 'a cat', paths: [out], aspect: '9:16', count: 1 });
    assert.equal(r.fallback_used, undefined);
    assert.equal(r.provider_used, 'mock');
    assert.ok(r.cost_usd > 0, 'mock must return non-zero cost_usd');
    rmSync(tmp, { recursive: true, force: true });
  });
});

test('visual.generate: paths arg is required', async () => {
  await assert.rejects(generate({ prompt: 'x' }), /paths/);
});

test('visual: PRECEDENCE order is [fal, nanobanana, replicate]', () => {
  assert.deepEqual(PRECEDENCE, ['fal', 'nanobanana', 'replicate']);
});
