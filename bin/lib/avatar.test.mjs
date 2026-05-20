// avatar.test.mjs — unit tests for the avatar.mjs dispatcher (v0.4.0 pillar 5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { resolveProvider, generate, PRECEDENCE, DURATION_HARD_CAP_MS } from './avatar.mjs';

const PLUGIN_ROOT = resolvePath(fileURLToPath(import.meta.url), '../../..');
const AVATAR_MOCK = join(PLUGIN_ROOT, 'tests', 'mocks', 'avatar-mock.mjs');

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

test('avatar: precedence — heygen preferred over did + fal_lip', () => {
  withEnv({
    HEYGEN_API_KEY: 'h-test', DID_API_KEY: 'd-test', FAL_API_KEY: 'f-test',
    CF_AVATAR_PROVIDER: undefined,
  }, () => {
    const p = resolveProvider();
    assert.equal(p.name, 'heygen');
  });
});

test('avatar: precedence — did picked when only DID_API_KEY set', () => {
  withEnv({
    HEYGEN_API_KEY: undefined, DID_API_KEY: 'd-test', FAL_API_KEY: undefined,
    CF_AVATAR_PROVIDER: undefined,
  }, () => {
    assert.equal(resolveProvider().name, 'did');
  });
});

test('avatar: precedence — fal_lip picked when only FAL_API_KEY set', () => {
  withEnv({
    HEYGEN_API_KEY: undefined, DID_API_KEY: undefined, FAL_API_KEY: 'f-test',
    CF_AVATAR_PROVIDER: undefined,
  }, () => {
    assert.equal(resolveProvider().name, 'fal_lip');
  });
});

test('avatar: no keys → null provider', () => {
  withEnv({
    HEYGEN_API_KEY: undefined, DID_API_KEY: undefined, FAL_API_KEY: undefined,
    CF_AVATAR_PROVIDER: undefined,
  }, () => {
    assert.equal(resolveProvider(), null);
  });
});

test('avatar: CF_AVATAR_PROVIDER=did overrides heygen presence', () => {
  withEnv({ HEYGEN_API_KEY: 'h-test', DID_API_KEY: 'd-test',
            CF_AVATAR_PROVIDER: 'did' }, () => {
    assert.equal(resolveProvider().name, 'did');
  });
});

test('avatar: CF_AVATAR_PROVIDER=unknown throws', () => {
  withEnv({ CF_AVATAR_PROVIDER: 'bogus' }, () => {
    assert.throws(() => resolveProvider(), /unknown provider/);
  });
});

test('avatar.generate: duration_ms > 5000 → refused, no API call', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cf-avatar-test-'));
  const out = join(tmp, 'avatar.mp4');
  const r = await generate({
    photo_path: '/nope', audio_path: '/nope',
    duration_ms: 6000, aspect: '9:16', video_path: out,
  });
  assert.equal(r.fallback_used, true);
  assert.equal(r.fallback_reason, 'avatar_duration_capped');
  rmSync(tmp, { recursive: true, force: true });
});

test('avatar.generate: no provider + no mock → fallback_used=no_avatar_provider', async () => {
  await withEnv({
    HEYGEN_API_KEY: undefined, DID_API_KEY: undefined, FAL_API_KEY: undefined,
    CF_AVATAR_PROVIDER: undefined, CF_AVATAR_MOCK: undefined,
  }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cf-avatar-test-'));
    const out = join(tmp, 'avatar.mp4');
    const r = await generate({
      photo_path: '/nope', audio_path: '/nope', duration_ms: 3000,
      aspect: '9:16', video_path: out,
    });
    assert.equal(r.fallback_used, true);
    assert.equal(r.fallback_reason, 'no_avatar_provider');
    rmSync(tmp, { recursive: true, force: true });
  });
});

test('avatar.generate: CF_AVATAR_MOCK writes a real MP4 + returns cost_usd', async () => {
  await withEnv({ CF_AVATAR_MOCK: AVATAR_MOCK }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cf-avatar-test-'));
    const photo = join(tmp, 'p.jpg'); writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const audio = join(tmp, 'a.wav'); writeFileSync(audio, Buffer.alloc(44));
    const out = join(tmp, 'avatar.mp4');
    const r = await generate({
      photo_path: photo, audio_path: audio, duration_ms: 3000,
      aspect: '9:16', video_path: out,
    });
    assert.equal(r.fallback_used, undefined);
    assert.equal(r.provider_used, 'mock');
    assert.ok(r.cost_usd > 0);
    rmSync(tmp, { recursive: true, force: true });
  });
});

test('avatar: PRECEDENCE order is [heygen, did, fal_lip]', () => {
  assert.deepEqual(PRECEDENCE, ['heygen', 'did', 'fal_lip']);
});

test('avatar: DURATION_HARD_CAP_MS is 5000', () => {
  assert.equal(DURATION_HARD_CAP_MS, 5000);
});

test('avatar.generate: video_path required', async () => {
  await assert.rejects(generate({ photo_path: 'p', audio_path: 'a', duration_ms: 1000 }),
                       /video_path/);
});
