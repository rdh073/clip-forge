// llm.test.mjs — unit tests for the LLM dispatcher (v0.4.0 pillar 4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { complete, resolveProvider, PRECEDENCE, PROVIDERS } from './llm.mjs';

function withClearedEnv(fn) {
  const saved = {
    GROQ_API_KEY:      process.env.GROQ_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CF_LLM_PROVIDER:   process.env.CF_LLM_PROVIDER,
    CF_LLM_MOCK:       process.env.CF_LLM_MOCK,
  };
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CF_LLM_PROVIDER;
  delete process.env.CF_LLM_MOCK;
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('llm.resolveProvider: GROQ_API_KEY set → groq (default precedence)', () => {
  withClearedEnv(() => {
    process.env.GROQ_API_KEY = 'gsk_test';
    const r = resolveProvider();
    assert.equal(r.name, 'groq');
  });
});

test('llm.resolveProvider: ANTHROPIC_API_KEY set, no GROQ → anthropic', () => {
  withClearedEnv(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const r = resolveProvider();
    assert.equal(r.name, 'anthropic');
  });
});

test('llm.resolveProvider: both keys set → groq wins (precedence ordering)', () => {
  withClearedEnv(() => {
    process.env.GROQ_API_KEY      = 'gsk_test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const r = resolveProvider();
    assert.equal(r.name, 'groq');
  });
});

test('llm.resolveProvider: CF_LLM_PROVIDER=anthropic forces anthropic even with GROQ set', () => {
  withClearedEnv(() => {
    process.env.GROQ_API_KEY     = 'gsk_test';
    process.env.CF_LLM_PROVIDER = 'anthropic';
    const r = resolveProvider();
    assert.equal(r.name, 'anthropic');
  });
});

test('llm.resolveProvider: no keys → null (caller emits no_llm_provider)', () => {
  withClearedEnv(() => {
    assert.equal(resolveProvider(), null);
  });
});

test('llm.resolveProvider: unknown explicit provider throws', () => {
  withClearedEnv(() => {
    assert.throws(() => resolveProvider('cohere'), /unknown provider/);
  });
});

test('llm.complete: no keys + no mock → fallback no_llm_provider', async () => {
  await withClearedEnv(async () => {
    const r = await complete({ system: 's', user: 'u' });
    assert.equal(r.fallback_used, true);
    assert.equal(r.fallback_reason, 'no_llm_provider');
    assert.equal(r.cost_usd, 0);
  });
});

test('llm.complete: CF_LLM_MOCK injection bypasses real providers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-llm-mock-'));
  const mock = join(dir, 'mock.mjs');
  writeFileSync(mock, `
    let data = '';
    process.stdin.on('data', (b) => { data += b; });
    process.stdin.on('end', () => {
      const req = JSON.parse(data);
      process.stdout.write(JSON.stringify({
        text: JSON.stringify({ patch: [], warning: null }),
        cost_usd: 0,
        echo: req.user,
      }));
    });
  `);
  chmodSync(mock, 0o755);
  try {
    await withClearedEnv(async () => {
      process.env.CF_LLM_MOCK = mock;
      const r = await complete({ system: 's', user: 'change hook' });
      assert.equal(r.provider_used, 'mock');
      assert.ok(r.text.includes('"patch"'));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('llm.complete: CF_LLM_MOCK missing file → fallback llm_mock_missing', async () => {
  await withClearedEnv(async () => {
    process.env.CF_LLM_MOCK = '/nonexistent/mock.mjs';
    const r = await complete({ system: 's', user: 'u' });
    assert.equal(r.fallback_used, true);
    assert.equal(r.fallback_reason, 'llm_mock_missing');
  });
});

test('llm.PRECEDENCE: groq comes before anthropic', () => {
  assert.deepEqual(PRECEDENCE, ['groq', 'anthropic']);
});

test('llm.PROVIDERS: groq + anthropic adapters registered, available() callable', () => {
  withClearedEnv(() => {
    assert.equal(typeof PROVIDERS.groq.available, 'function');
    assert.equal(typeof PROVIDERS.anthropic.available, 'function');
    assert.equal(PROVIDERS.groq.available(), false);
    assert.equal(PROVIDERS.anthropic.available(), false);
    process.env.GROQ_API_KEY = 'x';
    assert.equal(PROVIDERS.groq.available(), true);
  });
});

test('llm.complete: throws on non-object req', async () => {
  await assert.rejects(() => complete(null), /req must be an object/);
});

test('llm.complete: mock that returns invalid JSON → llm_mock_invalid_json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-llm-mock-'));
  const mock = join(dir, 'mock.mjs');
  writeFileSync(mock, `process.stdout.write("not json");`);
  try {
    await withClearedEnv(async () => {
      process.env.CF_LLM_MOCK = mock;
      const r = await complete({ system: 's', user: 'u' });
      assert.equal(r.fallback_used, true);
      assert.equal(r.fallback_reason, 'llm_mock_invalid_json');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
