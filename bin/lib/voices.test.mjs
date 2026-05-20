// voices.test.mjs — unit tests for the voice library loader/saver.
//
// Coverage:
//   - missing file → empty library
//   - malformed file → empty library + warning
//   - normalisation drops malformed entries, keeps valid ones
//   - per-project wins over global (no merge)
//   - per-project unreadable → graceful fallback to global
//   - resolveVoiceForUse honours uses[] tag, then default, then alphabetical
//   - upsertVoice → new library object (does not mutate input)
//   - saveLibraryFile + loadLibraryFile round-trip

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadLibraryFile, loadLibrary, resolveVoiceForUse, upsertVoice,
  saveLibraryFile, SCHEMA_VERSION,
} from './voices.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-voices-test-')); }

test('loadLibraryFile: missing → empty library + warning', () => {
  const d = tmp();
  try {
    const r = loadLibraryFile(join(d, 'nope.json'));
    assert.equal(r.ok, false);
    assert.equal(r.warning, 'voices_file_missing');
    assert.deepEqual(r.library.voices, {});
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadLibraryFile: malformed JSON → empty library + voices_unreadable', () => {
  const d = tmp();
  try {
    const p = join(d, 'bad.json');
    writeFileSync(p, '{ not: valid');
    const r = loadLibraryFile(p);
    assert.equal(r.ok, false);
    assert.match(r.warning, /voices_unreadable/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadLibraryFile: drops entries missing provider+voice_id, keeps valid', () => {
  const d = tmp();
  try {
    const p = join(d, 'mixed.json');
    writeFileSync(p, JSON.stringify({
      version: 1, default: 'good',
      voices: {
        good: { provider: 'elevenlabs', voice_id: 'abc' },
        nope: { provider: 'elevenlabs' /* no voice_id */ },
        also_nope: { voice_id: 'x' /* no provider */ },
      },
    }));
    const r = loadLibraryFile(p);
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.library.voices), ['good']);
    assert.equal(r.library.default, 'good');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadLibrary: per-project wins over global (no merge)', () => {
  const d = tmp();
  try {
    const globalP  = join(d, 'global', 'voices.json');
    const projectP = join(d, 'project', 'voices.json');
    saveLibraryFile(globalP, {
      version: 1, default: 'global-default',
      voices: { 'global-default': { provider: 'elevenlabs', voice_id: 'G' } },
    });
    saveLibraryFile(projectP, {
      version: 1, default: 'project-default',
      voices: { 'project-default': { provider: 'cartesia', voice_id: 'P' } },
    });
    const r = loadLibrary({ globalPath: globalP, projectPath: projectP });
    assert.equal(r.source, 'project');
    assert.deepEqual(Object.keys(r.library.voices), ['project-default']);
    assert.equal(r.library.default, 'project-default');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadLibrary: project file unreadable → falls back to global with warning', () => {
  const d = tmp();
  try {
    const globalP  = join(d, 'global', 'voices.json');
    const projectP = join(d, 'project', 'voices.json');
    saveLibraryFile(globalP, {
      version: 1, default: 'g',
      voices: { g: { provider: 'elevenlabs', voice_id: 'gid' } },
    });
    mkdirSync(join(d, 'project'), { recursive: true });
    writeFileSync(projectP, '{ corrupt');
    const r = loadLibrary({ globalPath: globalP, projectPath: projectP });
    assert.equal(r.source, 'global');
    assert.match(r.warning || '', /project_voices_unreadable/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolveVoiceForUse: matching uses[] tag wins', () => {
  const lib = {
    version: 1, default: 'A',
    voices: {
      A: { provider: 'elevenlabs', voice_id: 'a', uses: ['hook'] },
      B: { provider: 'cartesia',   voice_id: 'b', uses: ['dub-id'] },
    },
  };
  const r = resolveVoiceForUse(lib, 'dub-id');
  assert.equal(r.key, 'B');
  assert.equal(r.voice_id, 'b');
});

test('resolveVoiceForUse: no use match → falls back to library.default', () => {
  const lib = {
    version: 1, default: 'A',
    voices: {
      A: { provider: 'elevenlabs', voice_id: 'a', uses: [] },
      B: { provider: 'cartesia',   voice_id: 'b', uses: [] },
    },
  };
  const r = resolveVoiceForUse(lib, 'dub-fr');
  assert.equal(r.key, 'A');
});

test('upsertVoice: returns new library, does not mutate input', () => {
  const orig = { version: 1, default: null, voices: {} };
  const next = upsertVoice(orig, 'main', {
    provider: 'elevenlabs', voice_id: 'X', uses: ['hook'],
  });
  assert.equal(orig.voices.main, undefined, 'input library untouched');
  assert.equal(next.voices.main.provider, 'elevenlabs');
  assert.equal(next.default, 'main', 'first voice becomes default');
});

test('saveLibraryFile + loadLibraryFile: round-trip preserves schema', () => {
  const d = tmp();
  try {
    const p = join(d, 'voices.json');
    const lib = upsertVoice({ version: 1, default: null, voices: {} }, 'main', {
      provider: 'elevenlabs', voice_id: 'abc', sample_path: '/abs/sample.wav',
      created_at: '2026-05-21T00:00:00Z', uses: ['hook', 'outro'],
    });
    saveLibraryFile(p, lib);
    const r = loadLibraryFile(p);
    assert.equal(r.ok, true);
    assert.equal(r.library.version, SCHEMA_VERSION);
    assert.equal(r.library.voices.main.voice_id, 'abc');
    assert.deepEqual(r.library.voices.main.uses, ['hook', 'outro']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
