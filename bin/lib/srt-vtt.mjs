// srt-vtt.mjs — pure builders for the v0.3.0 pillar (i) sidecar artifacts.
//
// captions.json is the single source of truth for the burned ASS + the
// VTT + the SRT sidecars. All three render the same word timing so a
// downstream consumer (web embed, podcast platform, Premiere import) can
// pick whichever format they need.
//
// Pure functions, no IO. Tested via srt-vtt.test.mjs.

function pad(n, w) { return String(n).padStart(w, '0'); }

/**
 * Format milliseconds as `HH:MM:SS.mmm` (VTT) or `HH:MM:SS,mmm` (SRT).
 * The only difference between the two formats is the decimal separator.
 */
function fmtTime(ms, sep) {
  const m = Math.max(0, Math.floor(ms));
  const millis = m % 1000;
  const totalS = Math.floor(m / 1000);
  const s = totalS % 60;
  const min = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  return pad(h, 2) + ':' + pad(min, 2) + ':' + pad(s, 2) + sep + pad(millis, 3);
}

function lineText(line) {
  const words = Array.isArray(line.words) ? line.words : [];
  let text = words.map((w) => String(w.w ?? '')).join(' ').trim();
  if (line.emoji) text = text ? (text + ' ' + line.emoji) : line.emoji;
  return text;
}

/**
 * Build a WebVTT document from captions.json.
 *
 *   WEBVTT
 *
 *   00:00:00.000 --> 00:00:01.840
 *   Nobody tells you this 🎯
 *
 *   00:00:01.840 --> 00:00:03.200
 *   …
 *
 * Empty captions → `'WEBVTT\n\n'` (a valid empty document).
 *
 * @param {object} captionsJson
 * @returns {string}
 */
export function buildVtt(captionsJson) {
  const lines = (captionsJson && Array.isArray(captionsJson.lines)) ? captionsJson.lines : [];
  const cues = [];
  for (const line of lines) {
    const start = fmtTime(line.start_ms ?? 0, '.');
    const end   = fmtTime(line.end_ms ?? 0, '.');
    const text  = lineText(line);
    cues.push(start + ' --> ' + end + '\n' + text);
  }
  if (cues.length === 0) return 'WEBVTT\n\n';
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}

/**
 * Build an SRT document from captions.json.
 *
 *   1
 *   00:00:00,000 --> 00:00:01,840
 *   Nobody tells you this 🎯
 *
 *   2
 *   00:00:01,840 --> 00:00:03,200
 *   …
 *
 * Empty captions → `''` (a valid empty document per the de-facto SRT
 * spec: zero blocks).
 *
 * @param {object} captionsJson
 * @returns {string}
 */
export function buildSrt(captionsJson) {
  const lines = (captionsJson && Array.isArray(captionsJson.lines)) ? captionsJson.lines : [];
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = fmtTime(line.start_ms ?? 0, ',');
    const end   = fmtTime(line.end_ms ?? 0, ',');
    const text  = lineText(line);
    blocks.push((i + 1) + '\n' + start + ' --> ' + end + '\n' + text);
  }
  if (blocks.length === 0) return '';
  return blocks.join('\n\n') + '\n';
}
