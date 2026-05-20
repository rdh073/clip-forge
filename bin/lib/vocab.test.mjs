// vocab.test.mjs — unit coverage for bin/lib/vocab.mjs.
// Pure-logic tests; no spawn, no disk writes outside tmpdir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadVocabFile,
  buildDeepgramKeywords,
  buildWhisperInitialPrompt,
  applyCaseRestore,
} from './vocab.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'cf-vocab-')); }

test('loadVocabFile: missing file → ok:false + warning vocab_file_missing', () => {
  const d = tmp();
  try {
    const r = loadVocabFile(join(d, 'nope.json'));
    assert.equal(r.ok, false);
    assert.equal(r.data, null);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].code, 'vocab_file_missing');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadVocabFile: malformed JSON → ok:false + warning vocab_unreadable', () => {
  const d = tmp();
  try {
    const p = join(d, 'bad.json');
    writeFileSync(p, '{not json');
    const r = loadVocabFile(p);
    assert.equal(r.ok, false);
    assert.equal(r.data, null);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].code, 'vocab_unreadable');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadVocabFile: valid file → terms normalised with defaults applied', () => {
  const d = tmp();
  try {
    const p = join(d, 'vocab.json');
    writeFileSync(p, JSON.stringify({
      version: 1,
      terms: [
        { term: 'ClipForge' },
        { term: 'Anthropic', weight: 0.8 },
        { term: 'Sumayyah', case: 'preserve', weight: 1.0, lang: 'en' },
      ],
    }));
    const r = loadVocabFile(p);
    assert.equal(r.ok, true);
    assert.equal(r.data.terms.length, 3);
    assert.equal(r.data.terms[0].case, 'preserve');
    assert.equal(r.data.terms[0].weight, 1.0);
    assert.equal(r.data.terms[1].weight, 0.8);
    assert.equal(r.data.terms[2].lang, 'en');
    assert.equal(r.data.deepgram.boost, 8);
    assert.equal(r.data.whisper.initial_prompt_max_tokens, 240);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('buildDeepgramKeywords: empty vocab → empty array, no warning', () => {
  const r = buildDeepgramKeywords({ terms: [] });
  assert.deepEqual(r.keywords, []);
  assert.deepEqual(r.warnings, []);
});

test('buildDeepgramKeywords: weight 1.0 × boost 8 → "Term:8"', () => {
  const r = buildDeepgramKeywords({
    terms: [{ term: 'ClipForge', weight: 1.0 }],
    deepgram: { boost: 8 },
  });
  assert.deepEqual(r.keywords, ['ClipForge:8']);
});

test('buildDeepgramKeywords: weight 1.5 × boost 8 clamps to 10', () => {
  const r = buildDeepgramKeywords({
    terms: [{ term: 'Hi', weight: 1.5 }],
    deepgram: { boost: 8 },
  });
  assert.deepEqual(r.keywords, ['Hi:10']);
});

test('buildDeepgramKeywords: 100-term cap + vocab_terms_truncated warning', () => {
  const terms = [];
  for (let i = 0; i < 150; i++) {
    // Lower-index terms get the highest weight so they win the sort.
    terms.push({ term: 'brand-' + String(i + 1).padStart(3, '0'), weight: 1.0 - (i * 0.001) });
  }
  const r = buildDeepgramKeywords({ terms, deepgram: { boost: 8 } });
  assert.equal(r.keywords.length, 100);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'vocab_terms_truncated');
  // First in sorted order must be brand-001 (highest weight).
  assert.match(r.keywords[0], /^brand-001:/);
});

test('buildWhisperInitialPrompt: empty vocab → "" with no warning', () => {
  const r = buildWhisperInitialPrompt({ terms: [] });
  assert.equal(r.prompt, '');
  assert.deepEqual(r.warnings, []);
});

test('buildWhisperInitialPrompt: short list joins with ", "', () => {
  const r = buildWhisperInitialPrompt({
    terms: [{ term: 'ClipForge', weight: 1.0 }, { term: 'Anthropic', weight: 0.8 }],
    whisper: { initial_prompt_max_tokens: 240 },
  });
  assert.equal(r.prompt, 'ClipForge, Anthropic');
  assert.deepEqual(r.warnings, []);
});

test('buildWhisperInitialPrompt: 240-token cap emits vocab_terms_truncated', () => {
  const terms = [];
  for (let i = 0; i < 400; i++) {
    terms.push({ term: 'brand' + (i + 1), weight: 1.0 - (i * 0.0001) });
  }
  const r = buildWhisperInitialPrompt({ terms, whisper: { initial_prompt_max_tokens: 240 } });
  const tokenCount = r.prompt.split(/\s+/).length;
  assert.ok(tokenCount <= 240, 'prompt must respect token cap; got ' + tokenCount);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'vocab_terms_truncated');
});

test('applyCaseRestore: single-word match in middle of transcript', () => {
  const transcript = {
    words: [
      { w: 'hello', start_ms: 0, end_ms: 200, confidence: 0.9 },
      { w: 'clipforge', start_ms: 200, end_ms: 800, confidence: 0.9 },
      { w: 'world', start_ms: 800, end_ms: 1200, confidence: 0.9 },
    ],
  };
  const vocab = { terms: [{ term: 'ClipForge', weight: 1.0 }] };
  const r = applyCaseRestore(transcript, vocab);
  assert.equal(r.restored_count, 1);
  assert.equal(transcript.words[0].w, 'hello');
  assert.equal(transcript.words[1].w, 'ClipForge');
  assert.equal(transcript.words[2].w, 'world');
  // Timing untouched.
  assert.equal(transcript.words[1].start_ms, 200);
  assert.equal(transcript.words[1].end_ms, 800);
  assert.equal(transcript.words[1].confidence, 0.9);
});

test('applyCaseRestore: multi-word term across word boundaries', () => {
  const transcript = {
    words: [
      { w: 'using', start_ms: 0, end_ms: 200, confidence: 0.9 },
      { w: 'anthropic', start_ms: 200, end_ms: 700, confidence: 0.9 },
      { w: 'cloud', start_ms: 700, end_ms: 1100, confidence: 0.9 },
      { w: 'today', start_ms: 1100, end_ms: 1400, confidence: 0.9 },
    ],
  };
  const vocab = { terms: [{ term: 'Anthropic Cloud', weight: 1.0 }] };
  const r = applyCaseRestore(transcript, vocab);
  assert.equal(r.restored_count, 2);
  assert.equal(transcript.words[1].w, 'Anthropic');
  assert.equal(transcript.words[2].w, 'Cloud');
});

test('applyCaseRestore: punctuation preserved ("Clipforge!" → "ClipForge!")', () => {
  const transcript = {
    words: [
      { w: 'Clipforge!', start_ms: 0, end_ms: 600, confidence: 0.9 },
    ],
  };
  const vocab = { terms: [{ term: 'ClipForge', weight: 1.0 }] };
  const r = applyCaseRestore(transcript, vocab);
  assert.equal(r.restored_count, 1);
  assert.equal(transcript.words[0].w, 'ClipForge!');
});

test('applyCaseRestore: no-match passthrough leaves words verbatim', () => {
  const transcript = {
    words: [
      { w: 'hello,', start_ms: 0, end_ms: 200, confidence: 0.9 },
      { w: 'world.', start_ms: 200, end_ms: 400, confidence: 0.9 },
    ],
  };
  const vocab = { terms: [{ term: 'ClipForge', weight: 1.0 }] };
  const r = applyCaseRestore(transcript, vocab);
  assert.equal(r.restored_count, 0);
  assert.equal(transcript.words[0].w, 'hello,');
  assert.equal(transcript.words[1].w, 'world.');
});

test('applyCaseRestore: silent transcript (words:[]) → no mutation, restored_count=0', () => {
  const transcript = { words: [] };
  const vocab = { terms: [{ term: 'ClipForge', weight: 1.0 }] };
  const r = applyCaseRestore(transcript, vocab);
  assert.equal(r.restored_count, 0);
  assert.equal(transcript.words.length, 0);
});

test('applyCaseRestore: multi-word term wins over a single-word substring on the same window', () => {
  const transcript = {
    words: [
      { w: 'anthropic', start_ms: 0, end_ms: 500, confidence: 0.9 },
      { w: 'cloud', start_ms: 500, end_ms: 900, confidence: 0.9 },
    ],
  };
  const vocab = {
    terms: [
      { term: 'Anthropic', weight: 1.0 },
      { term: 'Anthropic Cloud', weight: 0.8 },
    ],
  };
  const r = applyCaseRestore(transcript, vocab);
  // Multi-word wins regardless of weight order because it matches a longer window.
  assert.equal(transcript.words[0].w, 'Anthropic');
  assert.equal(transcript.words[1].w, 'Cloud');
  assert.equal(r.restored_count, 2);
});

test('applyCaseRestore: idempotent — running twice on byte-identical inputs gives identical outputs', () => {
  const baseWords = () => [
    { w: 'clipforge', start_ms: 0, end_ms: 200, confidence: 0.9 },
    { w: 'rocks', start_ms: 200, end_ms: 400, confidence: 0.9 },
  ];
  const vocab = { terms: [{ term: 'ClipForge', weight: 1.0 }] };
  const a = { words: baseWords() };
  const b = { words: baseWords() };
  applyCaseRestore(a, vocab);
  applyCaseRestore(b, vocab);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
