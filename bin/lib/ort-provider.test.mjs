import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOrtProviderAttempts,
  createOrtSessionWithFallback,
  normalizeOrtProvider,
} from './ort-provider.mjs';

test('normalizeOrtProvider maps GPU aliases to CUDA', () => {
  assert.equal(normalizeOrtProvider('gpu'), 'cuda');
  assert.equal(normalizeOrtProvider('nvidia'), 'cuda');
  assert.equal(normalizeOrtProvider('directml'), 'dml');
  assert.equal(normalizeOrtProvider(''), 'cpu');
});

test('buildOrtProviderAttempts tries requested GPU before CPU fallback', () => {
  assert.deepEqual(buildOrtProviderAttempts('gpu'), ['cuda', 'cpu']);
  assert.deepEqual(buildOrtProviderAttempts('cpu'), ['cpu']);
});

test('createOrtSessionWithFallback falls back to CPU when GPU session creation fails', async () => {
  const calls = [];
  const fakeOrt = {
    InferenceSession: {
      async create(_modelPath, opts) {
        const provider = opts.executionProviders[0];
        calls.push(provider);
        if (provider === 'cuda') throw new Error('cuda unavailable');
        return { provider };
      },
    },
  };

  const created = await createOrtSessionWithFallback(fakeOrt, 'model.onnx', { provider: 'gpu' });

  assert.deepEqual(calls, ['cuda', 'cpu']);
  assert.equal(created.session.provider, 'cpu');
  assert.equal(created.provider, 'cpu');
  assert.equal(created.fallbackUsed, true);
  assert.match(created.fallbackReason, /cuda unavailable/);
});

test('createOrtSessionWithFallback keeps CPU-only requests on CPU', async () => {
  const calls = [];
  const fakeOrt = {
    InferenceSession: {
      async create(_modelPath, opts) {
        calls.push(opts.executionProviders[0]);
        return { ok: true };
      },
    },
  };

  const created = await createOrtSessionWithFallback(fakeOrt, 'model.onnx', { provider: 'cpu' });

  assert.deepEqual(calls, ['cpu']);
  assert.equal(created.provider, 'cpu');
  assert.equal(created.fallbackUsed, false);
  assert.equal(created.fallbackReason, null);
});
