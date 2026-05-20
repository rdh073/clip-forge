// consent-log.test.mjs — unit tests for v0.4.0 pillar 5 avatar consent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadLog, saveLogAtomic, checkGate1, recordGate1,
  checkGate2, recordGate2, bumpUseCount, photoHash, machineIdHash,
  GATE1_PROMPT_EN, GATE1_PROMPT_ID, GATE2_PROMPT_EN, GATE2_PROMPT_ID,
} from './consent-log.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-consent-test-')); }

test('consent: empty log → checkGate1 returns needs_prompt', () => {
  const t = tmp();
  const log = loadLog(join(t, 'log'));
  // Clear env defensively
  delete process.env.CF_AVATAR_CONSENT;
  assert.equal(checkGate1(log).state, 'needs_prompt');
  rmSync(t, { recursive: true, force: true });
});

test('consent: CF_AVATAR_CONSENT=1 → env_bypass', () => {
  const log = loadLog();
  const prev = process.env.CF_AVATAR_CONSENT;
  process.env.CF_AVATAR_CONSENT = '1';
  try {
    assert.equal(checkGate1({}).state, 'env_bypass');
  } finally {
    if (prev === undefined) delete process.env.CF_AVATAR_CONSENT;
    else process.env.CF_AVATAR_CONSENT = prev;
  }
});

test('consent: recordGate1 stamps consented_at + machine_id_hash', () => {
  const log = loadLog();
  delete process.env.CF_AVATAR_CONSENT;
  const updated = recordGate1(log);
  assert.ok(updated.consented_at);
  assert.ok(updated.machine_id_hash && updated.machine_id_hash.startsWith('sha256:'));
  assert.equal(checkGate1(updated).state, 'consented');
});

test('consent: saveLogAtomic + loadLog round-trip preserves photos', () => {
  const t = tmp();
  const p = join(t, 'log.json');
  const log = recordGate1(loadLog(p));
  log.photos['sha256:deadbeef'] = { consented_at: 'X', last_used_at: 'Y', use_count: 1 };
  saveLogAtomic(log, p);
  const loaded = loadLog(p);
  assert.equal(loaded.photos['sha256:deadbeef'].use_count, 1);
  rmSync(t, { recursive: true, force: true });
});

test('consent: photoHash returns sha256:<hex> for an existing file, null for missing', () => {
  const t = tmp();
  const p = join(t, 'photo.bin');
  writeFileSync(p, Buffer.from([1, 2, 3, 4]));
  const h = photoHash(p);
  assert.ok(h && h.startsWith('sha256:'));
  assert.equal(photoHash(join(t, 'nope.bin')), null);
  rmSync(t, { recursive: true, force: true });
});

test('consent: photoHash deterministic — same bytes → same hash', () => {
  const t = tmp();
  const p1 = join(t, 'a.bin'); const p2 = join(t, 'b.bin');
  const bytes = Buffer.from('clipforge avatar test');
  writeFileSync(p1, bytes); writeFileSync(p2, bytes);
  assert.equal(photoHash(p1), photoHash(p2));
  rmSync(t, { recursive: true, force: true });
});

test('consent: gate 2 — new photo → needs_prompt; recordGate2 → consented on next check', () => {
  const t = tmp();
  const p = join(t, 'photo.bin');
  writeFileSync(p, Buffer.from('test-photo'));
  let log = loadLog();
  const probe1 = checkGate2(log, p);
  assert.equal(probe1.state, 'needs_prompt');
  log = recordGate2(log, probe1.hash);
  assert.equal(log.photos[probe1.hash].use_count, 1);
  const probe2 = checkGate2(log, p);
  assert.equal(probe2.state, 'consented');
  rmSync(t, { recursive: true, force: true });
});

test('consent: bumpUseCount increments existing entry', () => {
  let log = loadLog();
  log = recordGate2(log, 'sha256:test');
  assert.equal(log.photos['sha256:test'].use_count, 1);
  log = bumpUseCount(log, 'sha256:test');
  assert.equal(log.photos['sha256:test'].use_count, 2);
});

test('consent: gate-2 photo_missing when file absent', () => {
  const t = tmp();
  const log = loadLog();
  const probe = checkGate2(log, join(t, 'nope.bin'));
  assert.equal(probe.state, 'photo_missing');
  rmSync(t, { recursive: true, force: true });
});

test('consent: atomic save — log file exists after rename, no .tmp survivors', async () => {
  const t = tmp();
  const p = join(t, 'log');
  saveLogAtomic({ version: 1, photos: {} }, p);
  const { readdirSync } = await import('node:fs');
  const tmpFiles = readdirSync(t).filter((f) => f.includes('.tmp.'));
  assert.equal(tmpFiles.length, 0, 'no .tmp.<pid>.<ts> survivors after atomic save');
  const loaded = loadLog(p);
  assert.deepEqual(loaded.photos, {});
  rmSync(t, { recursive: true, force: true });
});

test('consent: bilingual prompt strings include EN + ID', () => {
  assert.ok(GATE1_PROMPT_EN.toLowerCase().includes('consent'));
  assert.ok(GATE1_PROMPT_ID.toLowerCase().includes('persetujuan'));
  assert.ok(GATE2_PROMPT_EN.toLowerCase().includes('permission'));
  assert.ok(GATE2_PROMPT_ID.toLowerCase().includes('izin'));
});

test('consent: machineIdHash returns sha256:<hex>', () => {
  const h = machineIdHash();
  assert.ok(h.startsWith('sha256:'));
  assert.equal(h.length, 7 + 64);
});
