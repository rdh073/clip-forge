// speaker-timeline.mjs — pure-logic builder that turns a transcript's
// per-word `speaker` field into a window timeline marking which speakers
// are active in each interval. Used by cf-reframe to decide where to
// emit split_screen samples vs single-face samples.
//
// Source of speaker labels: transcript.words[].speaker (Deepgram populates
// this natively; Whisper does not — graceful warnings cover that case).
// We do NOT call any model here — purely a stream-of-words → windows
// transformation.
//
// Window semantics:
//   - Walk words in start_ms order. Whenever ≥2 distinct speakers
//     coexist in any 1.5s sliding window, that interval is `multi`.
//   - Contiguous multi-speaker intervals collapse into a single window
//     whose end is the last word touching that interval.
//   - Each window carries:
//        active_speakers: sorted ascending list of distinct speaker_ids
//        dominant: speaker_id with the most words in the window
//        start_ms / end_ms (inclusive of all participating words)
//   - Brief overlap (window duration < minWindowMs) → the caller treats
//     it as single-speaker (dominant), no split_screen. We still RETURN
//     the window so the caller can decide; the dispatcher applies the
//     ≥ minWindowMs threshold to filter.
//
// Idempotency contract: pure function. No Date.now(), no Math.random(),
// no process.env reads. Same `transcript` in → byte-identical output.

const DEFAULT_MIN_WINDOW_MS = 1500;

/**
 * @param {object}    opts
 * @param {object}    opts.transcript        transcript.json content
 * @param {number}    [opts.minWindowMs=1500] threshold for emitting a window
 *                                              as split_screen-eligible
 * @returns {{
 *   windows: Array<{start_ms:number, end_ms:number, active_speakers:number[], dominant:number, duration_ms:number}>,
 *   speakers: {[id:string]: {word_count:number, total_speaking_ms:number}},
 *   warnings: Array<{code:string, message:string}>
 * }}
 */
export function buildSpeakerTimeline({ transcript, minWindowMs = DEFAULT_MIN_WINDOW_MS } = {}) {
  const warnings = [];
  const speakers = {};
  const words = (transcript && Array.isArray(transcript.words)) ? transcript.words : [];

  if (words.length === 0) {
    return { windows: [], speakers, warnings };
  }

  let missingLabel = 0;
  let lowConfidence = 0;
  const distinct = new Set();

  for (const w of words) {
    const sp = w.speaker;
    if (sp === undefined || sp === null) {
      missingLabel++;
      continue;
    }
    if (typeof w.confidence === 'number' && w.confidence < 0.6) lowConfidence++;
    distinct.add(sp);
    const key = String(sp);
    if (!speakers[key]) speakers[key] = { word_count: 0, total_speaking_ms: 0 };
    speakers[key].word_count++;
    const dur = Math.max(0, (w.end_ms ?? 0) - (w.start_ms ?? 0));
    speakers[key].total_speaking_ms += dur;
  }

  if (missingLabel === words.length) {
    warnings.push({
      code: 'no_speaker_labels',
      message: 'transcript words carry no `speaker` field — speaker timeline empty. Re-transcribe with a diarizing provider (Deepgram) to enable split-screen.',
    });
    return { windows: [], speakers, warnings };
  }
  if (distinct.size <= 1) {
    warnings.push({
      code: 'single_speaker',
      message: 'transcript reports only one distinct speaker; no split-screen windows possible.',
    });
    return { windows: [], speakers, warnings };
  }
  if (lowConfidence > 0) {
    warnings.push({
      code: 'diarize_low_confidence',
      message: lowConfidence + ' word(s) carry confidence < 0.6 on speaker assignment; treat split-screen output as best-effort.',
    });
  }

  const sorted = words
    .filter((w) => w.speaker !== undefined && w.speaker !== null)
    .slice()
    .sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0));

  const windows = [];
  let cur = null;
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    const wStart = w.start_ms ?? 0;
    const wEnd   = w.end_ms ?? wStart;

    const peers = peerSpeakersWithin(sorted, i, wStart, minWindowMs);
    const isMulti = peers.size >= 2;

    if (isMulti) {
      if (cur && wStart - cur.end_ms <= minWindowMs) {
        cur.end_ms = Math.max(cur.end_ms, wEnd);
        for (const sp of peers) cur.speakerSet.add(sp);
        bumpCount(cur.wordCounts, w.speaker);
      } else {
        if (cur) windows.push(finalizeWindow(cur));
        cur = {
          start_ms: wStart,
          end_ms: wEnd,
          speakerSet: new Set(peers),
          wordCounts: { [w.speaker]: 1 },
        };
      }
    } else if (cur && wStart - cur.end_ms <= minWindowMs) {
      cur.end_ms = Math.max(cur.end_ms, wEnd);
      bumpCount(cur.wordCounts, w.speaker);
    }
  }
  if (cur) windows.push(finalizeWindow(cur));

  return { windows, speakers, warnings };
}

function peerSpeakersWithin(sorted, idx, anchorStart, windowMs) {
  const peers = new Set();
  for (let j = idx; j < sorted.length; j++) {
    const ws = sorted[j].start_ms ?? 0;
    if (ws - anchorStart > windowMs) break;
    peers.add(sorted[j].speaker);
  }
  for (let j = idx - 1; j >= 0; j--) {
    const we = sorted[j].end_ms ?? sorted[j].start_ms ?? 0;
    if (anchorStart - we > windowMs) break;
    peers.add(sorted[j].speaker);
  }
  return peers;
}

function bumpCount(map, sp) {
  map[sp] = (map[sp] || 0) + 1;
}

function finalizeWindow(w) {
  const active = Array.from(w.speakerSet).sort((a, b) => a - b);
  let dominant = active[0];
  let best = -1;
  for (const sp of active) {
    const c = w.wordCounts[sp] || 0;
    if (c > best) { best = c; dominant = sp; }
  }
  return {
    start_ms: w.start_ms,
    end_ms: w.end_ms,
    active_speakers: active,
    dominant,
    duration_ms: Math.max(0, w.end_ms - w.start_ms),
  };
}

/**
 * Filter the windows array to those eligible for split-screen rendering.
 * Brief overlap (duration < minWindowMs) collapses to dominant-only and
 * is excluded here; the renderer falls through to single-face for those
 * intervals.
 */
export function filterSplitScreenWindows(windows, minWindowMs = DEFAULT_MIN_WINDOW_MS) {
  return (windows || []).filter((w) =>
    w.active_speakers && w.active_speakers.length >= 2 && w.duration_ms >= minWindowMs);
}

/**
 * Sum the total_duration_ms of all split-screen-eligible windows.
 */
export function totalSplitDurationMs(windows, minWindowMs = DEFAULT_MIN_WINDOW_MS) {
  return filterSplitScreenWindows(windows, minWindowMs)
    .reduce((acc, w) => acc + w.duration_ms, 0);
}
