// vocab.test.mjs — positive-evidence integration tests for pillar (e)
// "brand vocabulary" of docs/PLAN-v0.3.0.md §4.1.
//
// All four scenarios route through bin/cf-whisper with
// CF_WHISPER_TRANSCRIPT_MOCK pointed at a static fixture transcript. The
// mock path is deterministic (no whisper.cpp invoked), so re-runs produce
// byte-identical transcript.json and these assertions stay stable.
//
// Skip-on-missing: fixtures are produced by tests/fixtures/build-fixtures.mjs.
// On a fresh checkout the suite reports SKIP rather than failing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  loadVocabFile,
  buildDeepgramKeywords,
} from '../../bin/lib/vocab.mjs';

const PLUGIN_ROOT       = resolve(fileURLToPath(import.meta.url), '../../..');
const CF_WHISPER        = resolve(PLUGIN_ROOT, 'bin/cf-whisper');
const MOCK_CLIPFORGE    = resolve(PLUGIN_ROOT, 'tests/fixtures/mock-transcript-clipforge-3s.json');
const MOCK_SILENT       = resolve(PLUGIN_ROOT, 'tests/fixtures/mock-transcript-silent-3s.json');
const SAMPLE_VOCAB      = resolve(PLUGIN_ROOT, 'tests/fixtures/sample-vocab.json');
const LARGE_VOCAB       = resolve(PLUGIN_ROOT, 'tests/fixtures/large-vocab.json');

function skipReason() {
  if (!existsSync(CF_WHISPER))     return 'bin/cf-whisper missing';
  if (!existsSync(MOCK_CLIPFORGE)) return 'mock-transcript-clipforge-3s.json missing — run `npm run build-fixtures`';
  if (!existsSync(MOCK_SILENT))    return 'mock-transcript-silent-3s.json missing — run `npm run build-fixtures`';
  if (!existsSync(SAMPLE_VOCAB))   return 'sample-vocab.json missing — run `npm run build-fixtures`';
  if (!existsSync(LARGE_VOCAB))    return 'large-vocab.json missing — run `npm run build-fixtures`';
  return null;
}
const SKIP = skipReason();

function runWhisperMock({ mock, vocab, workDir }) {
  mkdirSync(workDir, { recursive: true });
  // The --in path is unused when CF_WHISPER_TRANSCRIPT_MOCK is set, but the
  // arg parser requires it — point at the mock file itself so existsSync
  // (if ever consulted) is happy.
  const args = [
    CF_WHISPER,
    '--in', mock,
    '--out', join(workDir, 'transcript.json'),
  ];
  if (vocab) args.push('--vocab', vocab);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    env: { ...process.env, CF_WHISPER_TRANSCRIPT_MOCK: mock },
  });
  assert.equal(r.status, 0,
    'cf-whisper must exit 0 on every documented path; stderr=' + (r.stderr || ''));
  const outPath = join(workDir, 'transcript.json');
  assert.ok(existsSync(outPath), 'transcript.json must exist after cf-whisper run');
  return { data: JSON.parse(readFileSync(outPath, 'utf-8')), outPath };
}

test('vocab applied: lowercase "clipforge" restored to canonical "ClipForge"',
  { skip: SKIP || false, timeout: 15_000 }, () => {
    const work = join(tmpdir(), 'cf-vocab-applied-' + Date.now());
    try {
      const { data } = runWhisperMock({
        mock: MOCK_CLIPFORGE,
        vocab: SAMPLE_VOCAB,
        workDir: work,
      });
      const forms = data.words.map((w) => w.w);
      assert.ok(forms.includes('ClipForge'),
        'transcript words must include canonical "ClipForge"; got ' + JSON.stringify(forms));
      assert.ok(!forms.includes('clipforge'),
        'transcript words must NOT include lowercase "clipforge" after vocab; got ' + JSON.stringify(forms));
      assert.ok(data.vocab && data.vocab.applied === true,
        'transcript.vocab.applied must be true; got ' + JSON.stringify(data.vocab));
      assert.ok(data.vocab.restored_count >= 1,
        'transcript.vocab.restored_count must be >=1; got ' + data.vocab.restored_count);
      // Timing must be untouched by the post-pass.
      const cf = data.words.find((w) => w.w === 'ClipForge');
      assert.equal(cf.start_ms, 1000, 'start_ms preserved');
      assert.equal(cf.end_ms, 1800, 'end_ms preserved');
      assert.equal(cf.confidence, 0.93, 'confidence preserved');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('no vocab: lowercase "clipforge" stays as-is + transcript.vocab is undefined',
  { skip: SKIP || false, timeout: 15_000 }, () => {
    const work = join(tmpdir(), 'cf-vocab-none-' + Date.now());
    try {
      const { data } = runWhisperMock({
        mock: MOCK_CLIPFORGE,
        vocab: null,
        workDir: work,
      });
      const forms = data.words.map((w) => w.w);
      assert.ok(forms.includes('clipforge'),
        'without vocab the lowercase form must survive; got ' + JSON.stringify(forms));
      assert.ok(!forms.includes('ClipForge'),
        'without vocab no case-restore happens; got ' + JSON.stringify(forms));
      assert.equal(data.vocab, undefined,
        'transcript.vocab must be absent when --vocab not passed; got ' + JSON.stringify(data.vocab));
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('hallucination guard: silent transcript + vocab → no spurious word insertions',
  { skip: SKIP || false, timeout: 15_000 }, () => {
    const work = join(tmpdir(), 'cf-vocab-silent-' + Date.now());
    try {
      const { data } = runWhisperMock({
        mock: MOCK_SILENT,
        vocab: SAMPLE_VOCAB,
        workDir: work,
      });
      assert.equal(data.words.length, 0,
        'silent transcript + vocab must NOT inject brand terms into empty words[]; got ' +
        JSON.stringify(data.words));
      assert.ok(data.vocab && data.vocab.applied === true,
        'vocab block must record applied:true even on empty input; got ' + JSON.stringify(data.vocab));
      assert.equal(data.vocab.restored_count, 0,
        'restored_count on silent transcript must be 0; got ' + data.vocab.restored_count);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('vocab truncation: 200-term vocab → vocab_terms_truncated warning + Deepgram cap honored',
  { skip: SKIP || false, timeout: 15_000 }, () => {
    const work = join(tmpdir(), 'cf-vocab-large-' + Date.now());
    try {
      const { data } = runWhisperMock({
        mock: MOCK_CLIPFORGE,
        vocab: LARGE_VOCAB,
        workDir: work,
      });
      assert.ok(data.vocab && data.vocab.applied === true,
        'large-vocab must still apply; got ' + JSON.stringify(data.vocab));
      assert.ok(Array.isArray(data.vocab.warnings),
        'transcript.vocab.warnings must be an array; got ' + JSON.stringify(data.vocab.warnings));
      // The Whisper initial-prompt builder will have emitted vocab_terms_truncated
      // — but the post-pass case-restore does NOT carry that warning. The lib's
      // build helper covers the prompt cap; we exercise the deepgram cap
      // directly below to assert the honest 100-term boundary.

      const load = loadVocabFile(LARGE_VOCAB);
      assert.ok(load.ok, 'loadVocabFile must succeed on the large fixture');
      const { keywords, warnings } = buildDeepgramKeywords(load.data);
      assert.equal(keywords.length, 100,
        'buildDeepgramKeywords must cap at exactly 100 terms; got ' + keywords.length);
      assert.equal(warnings.length, 1, 'truncation must emit exactly one warning');
      assert.equal(warnings[0].code, 'vocab_terms_truncated',
        'warning code must be vocab_terms_truncated; got ' + warnings[0].code);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  });

test('idempotent: two cf-whisper runs with the same inputs produce byte-identical output',
  { skip: SKIP || false, timeout: 15_000 }, () => {
    const workA = join(tmpdir(), 'cf-vocab-idem-a-' + Date.now());
    const workB = join(tmpdir(), 'cf-vocab-idem-b-' + Date.now());
    try {
      const a = runWhisperMock({ mock: MOCK_CLIPFORGE, vocab: SAMPLE_VOCAB, workDir: workA });
      const b = runWhisperMock({ mock: MOCK_CLIPFORGE, vocab: SAMPLE_VOCAB, workDir: workB });
      const bytesA = readFileSync(a.outPath);
      const bytesB = readFileSync(b.outPath);
      assert.equal(bytesA.equals(bytesB), true,
        'two cf-whisper runs on identical inputs must produce byte-identical transcript.json');
    } finally {
      try { rmSync(workA, { recursive: true, force: true }); } catch {}
      try { rmSync(workB, { recursive: true, force: true }); } catch {}
    }
  });
