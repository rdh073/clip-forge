#!/usr/bin/env node
// translate-mock.mjs — realistic-mock translator for /clip-forge:dub.
//
// Reads { transcript, source_lang, target_lang } JSON on stdin. Emits the
// translated transcript JSON on stdout, preserving every word's start_ms /
// end_ms — that's the realistic-mock contract (PLAN-v0.4.0 §4).
//
// "Translation" is a deterministic per-word prefix swap: "<word>" →
// "<lang>:<word>". This is enough for the dub pipeline to see different
// text per language and for downstream tests to assert "the right thing
// was translated".

import { readFileSync } from 'node:fs';

const stdin = readFileSync(0, 'utf-8');
let brief;
try { brief = JSON.parse(stdin); }
catch (e) {
  process.stderr.write('translate-mock: bad JSON on stdin: ' + e.message + '\n');
  process.exit(1);
}

const tx = brief.transcript || {};
const lang = brief.target_lang || 'xx';

const words = Array.isArray(tx.words) ? tx.words : [];
const translatedWords = words.map((w) => ({
  ...w,
  w: lang + ':' + (w.w || ''),
}));

const out = {
  ...tx,
  language: lang,
  text:     translatedWords.map((w) => w.w).join(' '),
  words:    translatedWords,
};

process.stdout.write(JSON.stringify(out) + '\n');
