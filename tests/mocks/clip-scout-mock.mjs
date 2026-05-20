#!/usr/bin/env node
// clip-scout-mock.mjs — deterministic stand-in for the clip-scout agent,
// honoring the I/O contract documented in agents/clip-scout.md:
//
//   • Read a brief on stdin
//   • Emit STRICT JSON on stdout matching the candidates schema
//   • When the brief contains a `Prompt: <topic>` line, do a two-pass:
//     filter sentences whose text matches the topic via a keyword bag,
//     then re-rank the matched candidates by a deterministic virality
//     score
//   • When no `Prompt:` line is present, return one candidate per
//     transcript topic block to simulate the "spans all three topics"
//     baseline used by the no-prompt regression test
//   • Zero-match case → {"candidates": [], "warning": {"code":"no_match",...}}
//
// No randomness, no Date.now, no Math.random. Same brief → byte-identical
// stdout. Used by tests/integration/clip-prompt.test.mjs to exercise the
// /clip-forge:clip contract without spending ANTHROPIC_API_KEY.

import { readFileSync } from 'node:fs';

const TOPIC_BAGS = {
  career: /\b(career|job|quit|salary|raise|promotion)\b/i,
  fitness: /\b(fitness|gym|squat|cardio|protein|rep|reps)\b/i,
  cooking: /\b(cook|cooks|cooking|recipe|sauce|onion|pan|knife)\b/i,
};

function readStdin() {
  // Node's readFileSync('/dev/stdin') works on POSIX; fd 0 fallback otherwise.
  try { return readFileSync(0, 'utf-8'); }
  catch { return readFileSync('/dev/stdin', 'utf-8'); }
}

function extractPrompt(brief) {
  const m = brief.match(/^Prompt:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

function extractTranscript(brief) {
  const m = brief.match(/^Transcript:\s*(\{[\s\S]+\})\s*$/m);
  if (!m) return null;
  try { return JSON.parse(m[1]); }
  catch { return null; }
}

// Pick topic bag(s) implied by the prompt. A prompt mentioning a bag's
// keyword (or the bag name itself) activates that bag. Empty result →
// caller treats the prompt as "no known topic" → zero-match contract.
function resolveTopicBags(prompt) {
  const out = [];
  for (const [topic, re] of Object.entries(TOPIC_BAGS)) {
    if (re.test(prompt) || new RegExp('\\b' + topic + '\\b', 'i').test(prompt)) {
      out.push({ topic, re });
    }
  }
  return out;
}

// Group transcript words into sentences. A sentence ends when the word's `w`
// field contains '.', '!' or '?' (post-ASR glued punctuation, same convention
// as cf-tighten).
function groupSentences(transcript) {
  const words = Array.isArray(transcript?.words) ? transcript.words : [];
  const sents = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (/[.!?]/.test(w.w)) {
      sents.push(cur);
      cur = [];
    }
  }
  if (cur.length) sents.push(cur);
  return sents;
}

function sentenceText(sent) {
  return sent.map((w) => w.w).join(' ');
}

function sentenceTopic(sent) {
  // Use the transcript's per-word `topic` tag when present; otherwise None.
  const topics = sent.map((w) => w.topic).filter(Boolean);
  if (!topics.length) return null;
  // All words in a synthesized block share one topic.
  return topics[0];
}

// Deterministic 32-bit string hash (FNV-1a-ish). No external dependency.
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function clampInt(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }

function buildCandidate(idx, sent, matchedTopic) {
  const text = sentenceText(sent);
  const startMs = sent[0].start_ms;
  const endMs   = sent[sent.length - 1].end_ms;
  const virality = clampInt(80 + (hashStr(text) % 15), 70, 99);
  const firstWord = sent[0].w.replace(/[^A-Za-z]/g, '') || 'Clip';
  const title = (matchedTopic || firstWord.toLowerCase()) + ' moment ' + (idx + 1);
  return {
    id: 'c' + String(idx + 1).padStart(2, '0'),
    start_ms: startMs,
    end_ms: endMs,
    duration_s: Math.round((endMs - startMs) / 100) / 10,
    title: title.slice(0, 60),
    hook: text.slice(0, 80),
    virality,
    scores: {
      hook_strength: virality,
      emotional_peak: clampInt(virality - 5, 0, 100),
      narrative_complete: clampInt(virality - 10, 0, 100),
      platform_fit: clampInt(virality - 2, 0, 100),
      quotability: clampInt(virality - 8, 0, 100),
    },
    reasoning: 'mock-deterministic pick on ' + (matchedTopic || 'topic') + ' for sentence: "' + text.slice(0, 60) + '"',
    hashtags: ['#' + (matchedTopic || 'clip'), '#fyp', '#shorts'],
    platform_fit: { tiktok: virality, reels: virality - 4, shorts: virality - 8, x: virality - 12 },
    transcript_excerpt: text.slice(0, 200),
  };
}

function emitAndExit(obj) {
  // STRICT JSON, no markdown, no prose. Single trailing newline.
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(0);
}

function main() {
  const brief = readStdin();
  const transcript = extractTranscript(brief);
  if (!transcript) {
    emitAndExit({ candidates: [], error: 'mock could not parse Transcript: line' });
  }
  const sentences = groupSentences(transcript);
  const prompt = extractPrompt(brief);

  // Baseline path: no prompt → one candidate per distinct topic block, ranked
  // by virality desc.
  if (!prompt) {
    const seenTopics = new Set();
    const picks = [];
    for (const sent of sentences) {
      const t = sentenceTopic(sent);
      if (!t || seenTopics.has(t)) continue;
      seenTopics.add(t);
      picks.push(buildCandidate(picks.length, sent, t));
    }
    // If transcript carries no per-word topic tags, fall back to first three sentences.
    if (picks.length === 0) {
      for (let i = 0; i < Math.min(3, sentences.length); i++) {
        picks.push(buildCandidate(i, sentences[i], null));
      }
    }
    picks.sort((a, b) => b.virality - a.virality);
    picks.forEach((c, i) => { c.id = 'c' + String(i + 1).padStart(2, '0'); });
    emitAndExit({ candidates: picks });
  }

  // Prompt path: two-pass filter then re-rank.
  const bags = resolveTopicBags(prompt);
  if (bags.length === 0) {
    emitAndExit({
      candidates: [],
      warning: {
        code: 'no_match',
        message: 'no candidates matched prompt — re-run without --prompt or broaden the topic',
      },
    });
  }
  const matched = [];
  for (const sent of sentences) {
    const text = sentenceText(sent);
    for (const { topic, re } of bags) {
      if (re.test(text)) {
        matched.push({ sent, topic });
        break;
      }
    }
  }
  if (matched.length === 0) {
    emitAndExit({
      candidates: [],
      warning: {
        code: 'no_match',
        message: 'no candidates matched prompt — re-run without --prompt or broaden the topic',
      },
    });
  }
  const cands = matched.map((m, i) => buildCandidate(i, m.sent, m.topic));
  cands.sort((a, b) => b.virality - a.virality);
  cands.forEach((c, i) => { c.id = 'c' + String(i + 1).padStart(2, '0'); });
  emitAndExit({ candidates: cands });
}

main();
