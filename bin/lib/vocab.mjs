// vocab.mjs — pure-logic helpers for the brand-vocabulary feature
// (docs/PLAN-v0.3.0.md §3.2, pillar e).
//
// Four responsibilities, all pure and side-effect-free at import time:
//
//   1. loadVocabFile(path)
//      Reads vocab.json, validates shape, normalises term entries
//      (defaults: case='preserve', weight=1.0). Soft warnings on missing /
//      unreadable / malformed input; caller decides whether to abort.
//
//   2. buildDeepgramKeywords(vocab)
//      Returns Deepgram's `keywords` array — each entry is "<term>:<boost>",
//      boost = clamp(round(weight * vocab.deepgram.boost), 0, 10). Caps at
//      100 terms by weight desc; surplus terms drop with a soft
//      vocab_terms_truncated warning.
//
//   3. buildWhisperInitialPrompt(vocab)
//      Joins terms by ", " until the whitespace-token count reaches
//      vocab.whisper.initial_prompt_max_tokens (default 240). Surplus terms
//      drop with vocab_terms_truncated.
//
//   4. applyCaseRestore(transcript, vocab)
//      MUTATES transcript.words[].w in place. Replaces normalised-form
//      matches (lowercase + strip non-alphanumeric) with the case-preserving
//      term from vocab.terms[].term. Multi-word terms are matched as a
//      sliding window across consecutive transcript words; the window's words
//      receive the per-token casing from the vocab term split on whitespace.
//      Only .w is touched — start_ms / end_ms / confidence are never
//      modified. NEVER inserts new words; an empty .words[] stays empty
//      (hallucination guard at the lib level).
//
// Idempotency: same inputs → identical outputs. No Date.now, no Math.random,
// no process.env reads anywhere in this module. Importing this file performs
// zero I/O — loadVocabFile reads from disk only when called.

import { readFileSync, existsSync } from 'node:fs';

const DEFAULT_DEEPGRAM_BOOST = 8;
const DEEPGRAM_KEYWORD_CAP = 100;
const DEEPGRAM_BOOST_MIN = 0;
const DEEPGRAM_BOOST_MAX = 10;
const DEFAULT_WHISPER_PROMPT_MAX_TOKENS = 240;

export function loadVocabFile(path) {
  if (!existsSync(path)) {
    return {
      ok: false,
      data: null,
      warnings: [{ code: 'vocab_file_missing', message: 'vocab file not found: ' + path }],
    };
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    return {
      ok: false,
      data: null,
      warnings: [{ code: 'vocab_unreadable', message: 'vocab file unreadable: ' + e.message }],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      data: null,
      warnings: [{ code: 'vocab_unreadable', message: 'vocab JSON parse failed: ' + e.message }],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      data: null,
      warnings: [{ code: 'vocab_unreadable', message: 'vocab root must be an object' }],
    };
  }
  const termsRaw = Array.isArray(parsed.terms) ? parsed.terms : [];
  const terms = [];
  for (const t of termsRaw) {
    if (!t || typeof t !== 'object') continue;
    const term = typeof t.term === 'string' ? t.term : null;
    if (!term || term.trim().length === 0) continue;
    const caseMode = typeof t.case === 'string' ? t.case : 'preserve';
    const weight = typeof t.weight === 'number' && Number.isFinite(t.weight) ? t.weight : 1.0;
    const entry = { term, case: caseMode, weight };
    if (typeof t.lang === 'string' && t.lang.length > 0) entry.lang = t.lang;
    terms.push(entry);
  }
  const deepgram = (parsed.deepgram && typeof parsed.deepgram === 'object')
    ? { boost: typeof parsed.deepgram.boost === 'number' ? parsed.deepgram.boost : DEFAULT_DEEPGRAM_BOOST }
    : { boost: DEFAULT_DEEPGRAM_BOOST };
  const whisperMax = (parsed.whisper && typeof parsed.whisper === 'object'
    && typeof parsed.whisper.initial_prompt_max_tokens === 'number')
    ? parsed.whisper.initial_prompt_max_tokens
    : DEFAULT_WHISPER_PROMPT_MAX_TOKENS;
  const whisper = { initial_prompt_max_tokens: whisperMax };
  return {
    ok: true,
    data: {
      version: 1,
      terms,
      deepgram,
      whisper,
    },
    warnings: [],
  };
}

function sortedTerms(vocab) {
  const arr = (vocab && Array.isArray(vocab.terms)) ? vocab.terms.slice() : [];
  arr.sort((a, b) => {
    const wa = typeof a.weight === 'number' ? a.weight : 1.0;
    const wb = typeof b.weight === 'number' ? b.weight : 1.0;
    if (wb !== wa) return wb - wa;
    return a.term.localeCompare(b.term);
  });
  return arr;
}

function clampInt(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  const r = Math.round(n);
  if (r < lo) return lo;
  if (r > hi) return hi;
  return r;
}

export function buildDeepgramKeywords(vocab) {
  const warnings = [];
  if (!vocab || !Array.isArray(vocab.terms) || vocab.terms.length === 0) {
    return { keywords: [], warnings };
  }
  const baseBoost = (vocab.deepgram && typeof vocab.deepgram.boost === 'number')
    ? vocab.deepgram.boost
    : DEFAULT_DEEPGRAM_BOOST;
  const sorted = sortedTerms(vocab);
  const truncated = sorted.length > DEEPGRAM_KEYWORD_CAP;
  const kept = sorted.slice(0, DEEPGRAM_KEYWORD_CAP);
  const keywords = kept.map((t) => {
    const w = typeof t.weight === 'number' ? t.weight : 1.0;
    const boost = clampInt(w * baseBoost, DEEPGRAM_BOOST_MIN, DEEPGRAM_BOOST_MAX);
    return t.term + ':' + boost;
  });
  if (truncated) {
    warnings.push({
      code: 'vocab_terms_truncated',
      message: 'vocab.terms exceeded Deepgram keyword cap (' + DEEPGRAM_KEYWORD_CAP +
        '); ' + (sorted.length - DEEPGRAM_KEYWORD_CAP) + ' terms dropped (lowest weight first)',
    });
  }
  return { keywords, warnings };
}

function countPromptTokens(s) {
  if (!s) return 0;
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function buildWhisperInitialPrompt(vocab) {
  const warnings = [];
  if (!vocab || !Array.isArray(vocab.terms) || vocab.terms.length === 0) {
    return { prompt: '', warnings };
  }
  const cap = (vocab.whisper && typeof vocab.whisper.initial_prompt_max_tokens === 'number')
    ? vocab.whisper.initial_prompt_max_tokens
    : DEFAULT_WHISPER_PROMPT_MAX_TOKENS;
  const sorted = sortedTerms(vocab);
  const accepted = [];
  let truncated = false;
  for (let i = 0; i < sorted.length; i++) {
    const term = sorted[i].term;
    const candidate = accepted.length === 0 ? term : accepted.join(', ') + ', ' + term;
    if (countPromptTokens(candidate) > cap) {
      truncated = sorted.length - accepted.length > 0;
      break;
    }
    accepted.push(term);
  }
  if (truncated) {
    warnings.push({
      code: 'vocab_terms_truncated',
      message: 'whisper initial-prompt exceeded ' + cap + ' tokens; ' +
        (sorted.length - accepted.length) + ' term(s) dropped',
    });
  }
  return { prompt: accepted.join(', '), warnings };
}

function normaliseWord(s) {
  if (typeof s !== 'string') return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const lo = c.toLowerCase();
    if ((lo >= 'a' && lo <= 'z') || (lo >= '0' && lo <= '9')) out += lo;
  }
  return out;
}

function splitTermTokens(term) {
  return term.split(/\s+/).filter((t) => t.length > 0);
}

function preservePunctuation(originalWord, restoredCore) {
  // restoredCore is the casing-correct term token; preserve leading/trailing
  // punctuation from originalWord. We strip alpha-numerics from the leading
  // and trailing edges of originalWord to find punctuation runs.
  const m = originalWord.match(/^([^A-Za-z0-9]*)([\s\S]*?)([^A-Za-z0-9]*)$/);
  if (!m) return restoredCore;
  return (m[1] || '') + restoredCore + (m[3] || '');
}

export function applyCaseRestore(transcript, vocab) {
  const warnings = [];
  if (!transcript || !Array.isArray(transcript.words) || transcript.words.length === 0) {
    return { restored_count: 0, warnings };
  }
  if (!vocab || !Array.isArray(vocab.terms) || vocab.terms.length === 0) {
    return { restored_count: 0, warnings };
  }
  const sorted = sortedTerms(vocab);
  // Build matchable representations: per term, an array of normalised tokens
  // and the corresponding original (casing-preserving) tokens.
  const matchables = [];
  for (const t of sorted) {
    const origTokens = splitTermTokens(t.term);
    const normTokens = origTokens.map(normaliseWord).filter((s) => s.length > 0);
    if (normTokens.length === 0 || normTokens.length !== origTokens.length) continue;
    matchables.push({ origTokens, normTokens, length: normTokens.length });
  }
  // Sort by token length desc so longer multi-word phrases win over their
  // single-word substrings on the same window.
  matchables.sort((a, b) => b.length - a.length);

  const words = transcript.words;
  const taken = new Array(words.length).fill(false);
  let restored = 0;
  for (const m of matchables) {
    for (let i = 0; i + m.length <= words.length; i++) {
      let blocked = false;
      for (let k = 0; k < m.length; k++) {
        if (taken[i + k]) { blocked = true; break; }
      }
      if (blocked) continue;
      let matched = true;
      for (let k = 0; k < m.length; k++) {
        const norm = normaliseWord(words[i + k].w);
        if (norm !== m.normTokens[k]) { matched = false; break; }
      }
      if (!matched) continue;
      for (let k = 0; k < m.length; k++) {
        const original = words[i + k].w;
        const restoredCore = m.origTokens[k];
        const replacement = preservePunctuation(original, restoredCore);
        if (replacement !== original) {
          words[i + k].w = replacement;
          restored++;
        }
        taken[i + k] = true;
      }
    }
  }
  return { restored_count: restored, warnings };
}
