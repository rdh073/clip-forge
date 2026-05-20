// crop-expression-builder.mjs — builds ffmpeg crop x/y expressions from a
// crop_path.json samples timeline.
//
// Why expressions (not sendcmd): ffmpeg's `crop` filter in 6.x reports its
// `x`/`y` options as runtime-settable (AVOption flag T), but the actual
// process_command implementation returns ENOSYS (`Function not implemented`)
// for both direct option commands and the generic `reinit` command. We
// confirmed this in Phase 2D smoke tests against ffmpeg 6.1.1. The expression
// path uses ffmpeg's first-class expression evaluator on the `x`/`y`
// option strings — works on every modern ffmpeg, no command-channel hack.
//
// Output shape:
//   buildCropExpression(cropPath)            → { exprX, exprY }  (raw, unescaped)
//   buildFilterArg(cropPath)                 → 'crop=W:H:exprX:exprY,scale=W:H'
//                                              with commas escaped for -vf
//   buildFilterScript(cropPath)              → '[0:v]<filter-chain>[v]\n'
//                                              ready for -filter_complex_script
//
// Coordinate transform: samples[].cx/cy is the SOURCE-frame face CENTER;
// ffmpeg's crop filter expects the TOP-LEFT corner. We map center → top-left,
// then clamp to [0, source_w - target_w] × [0, source_h - target_h] so the
// crop never falls off the source frame.
//
// Optimization: consecutive samples whose post-transform (x, y) are identical
// collapse to a single step in the if-ladder. The Kalman smoother already
// produces nearly-flat regions when the face is still; dedupe saves
// expression bytes without losing information.

/**
 * Compute the crop rectangle's dimensions in SOURCE pixel space, sized so its
 * aspect matches the target's. The crop slice is then scaled up to the target
 * by the renderer's `scale=targetW:targetH` filter.
 *
 * @returns {{cropW: number, cropH: number}}
 */
export function computeCropDims(sourceW, sourceH, targetW, targetH) {
  if (sourceW <= 0 || sourceH <= 0 || targetW <= 0 || targetH <= 0) {
    throw new Error('computeCropDims: all dims must be positive');
  }
  const targetAspect = targetW / targetH;
  const sourceAspect = sourceW / sourceH;
  let cropW, cropH;
  if (sourceAspect > targetAspect) {
    // Source is WIDER than target's aspect → use full source height, narrower width.
    cropH = sourceH;
    cropW = Math.round(sourceH * targetAspect);
  } else {
    // Source is NARROWER → use full source width, shorter height.
    cropW = sourceW;
    cropH = Math.round(sourceW / targetAspect);
  }
  // Guard against rounding pushing us off-source by one pixel.
  return { cropW: Math.min(cropW, sourceW), cropH: Math.min(cropH, sourceH) };
}

// ffmpeg's eval.c caps nested-if expressions at 100 levels. Empirically:
// 99 nested `if(...)` parses; 100 returns "Missing ')' or too many args".
// We cap to 99 keyframes via stride-sampling on the way in.
const MAX_KEYFRAMES = 99;

/**
 * Stride-sample an array down to ≤ maxLen, keeping endpoints. Returns a new
 * array; original untouched.
 */
function strideSample(arr, maxLen) {
  if (arr.length <= maxLen) return arr.slice();
  const stride = arr.length / maxLen;
  const out = [];
  for (let i = 0; i < maxLen; i++) {
    out.push(arr[Math.min(arr.length - 1, Math.floor(i * stride))]);
  }
  // Ensure the very last sample is preserved so the timeline tail stays accurate.
  if (out[out.length - 1] !== arr[arr.length - 1]) out[out.length - 1] = arr[arr.length - 1];
  return out;
}

/**
 * Build raw (unescaped) x/y expressions for ffmpeg's crop filter from a
 * crop_path.json blob. Returns either a constant pixel value (static cases)
 * or a piecewise `if(lt(t, T_n), X_n, …)` step function.
 *
 * Coordinates are TOP-LEFT in source pixel space, clamped so the crop never
 * falls off the source frame. The crop dimensions returned alongside are
 * SOURCE-pixel sized (so the filter chain is `crop=cropW:cropH:x:y,scale=targetW:targetH`).
 *
 * If the post-dedupe timeline exceeds `opts.maxKeyframes` (default 99 — see
 * the comment near MAX_KEYFRAMES for the ffmpeg-imposed ceiling), we
 * stride-sample down and set `downsampled: true` in the return so callers
 * can surface it.
 *
 * @param {object} cropPath crop_path.json content
 * @param {object} [opts]
 * @param {number} [opts.maxKeyframes=99]
 * @returns {{exprX: string, exprY: string, cropW: number, cropH: number, keyframeCount: number, downsampled: boolean, originalKeyframeCount: number}}
 */
export function buildCropExpression(cropPath, opts = {}) {
  const maxKeyframes = opts.maxKeyframes ?? MAX_KEYFRAMES;
  const sw = cropPath.source_w | 0;
  const sh = cropPath.source_h | 0;
  const tw = cropPath.target_w | 0;
  const th = cropPath.target_h | 0;
  if (sw <= 0 || sh <= 0 || tw <= 0 || th <= 0) {
    throw new Error('buildCropExpression: source_w/source_h/target_w/target_h must be positive');
  }
  const { cropW, cropH } = computeCropDims(sw, sh, tw, th);
  const maxX = Math.max(0, sw - cropW);
  const maxY = Math.max(0, sh - cropH);

  const samples = cropPath.samples || [];

  if (samples.length === 0) {
    // No timeline → centered static crop.
    const x = Math.floor(maxX / 2);
    const y = Math.floor(maxY / 2);
    return { exprX: String(x), exprY: String(y), cropW, cropH,
             keyframeCount: 0, downsampled: false, originalKeyframeCount: 0 };
  }

  // Project + clamp + dedupe consecutive identical points.
  const pts = [];
  for (const s of samples) {
    const t = (s.t_ms ?? 0) / 1000;
    const x = clamp(Math.round((s.cx ?? sw / 2) - cropW / 2), 0, maxX);
    const y = clamp(Math.round((s.cy ?? sh / 2) - cropH / 2), 0, maxY);
    if (pts.length > 0) {
      const prev = pts[pts.length - 1];
      if (prev.x === x && prev.y === y) continue;
    }
    pts.push({ t, x, y });
  }

  const originalKeyframeCount = pts.length;
  // ffmpeg's expression parser caps nested `if(...)` at 99 levels. If our
  // post-dedupe timeline exceeds that, stride-sample down. Kalman smoothing
  // already produces continuous motion, so 99 keyframes spread across the
  // clip length yields visibly smooth tracking for any realistic source.
  const downsampledPts = strideSample(pts, maxKeyframes);
  const downsampled = downsampledPts.length < pts.length;

  if (downsampledPts.length === 1) {
    return { exprX: String(downsampledPts[0].x), exprY: String(downsampledPts[0].y),
             cropW, cropH, keyframeCount: 1, downsampled, originalKeyframeCount };
  }

  // Build right-associative if-ladders: the LAST point is the unconditional
  // tail; earlier points wrap it with lt(t, T_next).
  const exprX = buildLadder(downsampledPts, 'x');
  const exprY = buildLadder(downsampledPts, 'y');
  return { exprX, exprY, cropW, cropH,
           keyframeCount: downsampledPts.length, downsampled, originalKeyframeCount };
}

function buildLadder(pts, comp) {
  let expr = String(pts[pts.length - 1][comp]);
  for (let i = pts.length - 2; i >= 0; i--) {
    const nextT = pts[i + 1].t.toFixed(3);
    expr = 'if(lt(t,' + nextT + '),' + pts[i][comp] + ',' + expr + ')';
  }
  return expr;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Escape an expression for inclusion as a value inside a `-vf` argument.
 * Within a filter option's value, commas (which separate ffmpeg filter
 * arguments) and colons (which separate filter options) must be escaped
 * with a single backslash; we only escape commas because our expressions
 * never contain colons.
 */
export function escapeFilterArg(expr) {
  return expr.replace(/,/g, '\\,');
}

/**
 * Build the full crop+scale filter chain string for `-vf` inline usage.
 *
 * @returns {string} e.g. 'crop=1080:1920:if(lt(t\\,1)\\,100\\,200):0,scale=1080:1920'
 */
export function buildFilterArg(cropPath) {
  const { exprX, exprY, cropW, cropH } = buildCropExpression(cropPath);
  const tw = cropPath.target_w | 0;
  const th = cropPath.target_h | 0;
  return 'crop=' + cropW + ':' + cropH + ':' + escapeFilterArg(exprX) + ':' + escapeFilterArg(exprY)
       + ',scale=' + tw + ':' + th;
}

/**
 * Build a filter-graph file body for `ffmpeg -filter_complex_script <file>`.
 * Uses the same comma-escaping as `-vf` because ffmpeg parses the script
 * with the same grammar — newlines are just cosmetic. Maps the first input's
 * video stream into a labeled [v] output that the caller maps with -map.
 *
 * @returns {string} e.g. '[0:v]crop=1080:1920:...:0,scale=1080:1920[v]\n'
 */
export function buildFilterScript(cropPath) {
  return '[0:v]' + buildFilterArg(cropPath) + '[v]\n';
}

// ----- v0.4.0 pillar 6: split-screen (speaker-aware reframe) -----
//
// crop_path.json schema v3 adds `split_screen` sample shape. A split-screen
// sample carries per-speaker (cx, cy, scale) instead of the single-face
// shape. The renderer stacks the two crops along an axis driven by
// target_aspect (NOT source aspect):
//   9:16 → vstack (top/bottom), each panel canvasH/2 tall
//   4:5  → vstack
//   1:1  → hstack (left/right), each panel canvasW/2 wide
//   16:9 → hstack
//
// Identity stability invariant (S3): speaker_id 0 is ALWAYS the LEFT
// (hstack) or TOP (vstack) panel within a single split_screen window.
// We sort speakers ascending by speaker_id at build time so the stack
// order is deterministic across the whole window.

/**
 * Pick the stack axis for a given target_aspect.
 * @param {string} targetAspect e.g. '9:16', '1:1', '4:5', '16:9'
 * @returns {'vstack'|'hstack'}
 */
export function chooseSplitAxis(targetAspect) {
  switch (targetAspect) {
    case '9:16': return 'vstack';
    case '4:5':  return 'vstack';
    case '1:1':  return 'hstack';
    case '16:9': return 'hstack';
    default:     return 'vstack';
  }
}

/**
 * Build the filter graph fragment for a single split-screen sample. Returns
 * the body of a filter_complex chain that:
 *   1. takes two copies of [0:v] (or upstream label),
 *   2. crops each to the speaker's region,
 *   3. scales each panel to (panelW × panelH),
 *   4. stacks them via hstack or vstack into [outLabel].
 *
 * Caller is responsible for wiring this into the full -filter_complex
 * graph (or filter-script file). speaker order in the sample MUST be
 * ascending by speaker_id (the builder sorts to enforce S3).
 *
 * @param {object} sample      crop_path.json split_screen sample
 * @param {number} sourceW
 * @param {number} sourceH
 * @param {number} targetW
 * @param {number} targetH
 * @param {string} targetAspect 'vstack' or 'hstack' driven via chooseSplitAxis
 * @param {string} [inLabel='0:v']
 * @param {string} [outLabel='vss']
 * @returns {{filter:string, axis:'hstack'|'vstack', panelW:number, panelH:number, speakerOrder:number[]}}
 */
export function buildSplitScreenFilter({ sample, sourceW, sourceH, targetW, targetH, targetAspect, inLabel = '0:v', outLabel = 'vss' }) {
  const axis = chooseSplitAxis(targetAspect);
  const speakers = (sample && Array.isArray(sample.split_screen?.speakers))
    ? sample.split_screen.speakers.slice().sort((a, b) => (a.speaker_id ?? 0) - (b.speaker_id ?? 0))
    : [];
  if (speakers.length < 2) {
    return { filter: '', axis, panelW: targetW, panelH: targetH, speakerOrder: speakers.map((s) => s.speaker_id) };
  }

  // Panel dims: hstack splits width, vstack splits height.
  const panelW = axis === 'hstack' ? Math.floor(targetW / 2) : targetW;
  const panelH = axis === 'vstack' ? Math.floor(targetH / 2) : targetH;

  // Source-pixel crop region per panel sized to the panel's aspect.
  const { cropW, cropH } = computeCropDims(sourceW, sourceH, panelW, panelH);
  const maxX = Math.max(0, sourceW - cropW);
  const maxY = Math.max(0, sourceH - cropH);

  const pieces = [];
  const labels = [];
  for (let i = 0; i < 2; i++) {
    const sp = speakers[i];
    const cx = sp.cx ?? sourceW / 2;
    const cy = sp.cy ?? sourceH / 2;
    const x = clamp(Math.round(cx - cropW / 2), 0, maxX);
    const y = clamp(Math.round(cy - cropH / 2), 0, maxY);
    const lbl = outLabel + '_p' + i;
    pieces.push('[' + inLabel + ']crop=' + cropW + ':' + cropH + ':' + x + ':' + y + ',scale=' + panelW + ':' + panelH + '[' + lbl + ']');
    labels.push(lbl);
  }
  pieces.push('[' + labels[0] + '][' + labels[1] + ']' + axis + '[' + outLabel + ']');

  return {
    filter: pieces.join(';'),
    axis,
    panelW,
    panelH,
    speakerOrder: speakers.map((s) => s.speaker_id),
  };
}

/**
 * Group consecutive split_screen samples into time windows. Each window
 * spans [first_sample.t_ms, next_non_split_sample.t_ms OR Infinity).
 * Returns `[{start_ms, end_ms, speakers}]` sorted by start_ms; speakers
 * is the FIRST split sample's speakers array (window-locked per R4).
 *
 * @param {object} cropPath
 * @returns {Array<{start_ms:number, end_ms:number, speakers:Array}>}
 */
export function groupSplitScreenWindows(cropPath) {
  const samples = (cropPath && Array.isArray(cropPath.samples)) ? cropPath.samples : [];
  const windows = [];
  let cur = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s && s.split_screen) {
      if (!cur) {
        cur = { start_ms: s.t_ms ?? 0, end_ms: s.t_ms ?? 0,
                speakers: s.split_screen.speakers || [] };
      } else {
        cur.end_ms = s.t_ms ?? cur.end_ms;
      }
    } else if (cur) {
      cur.end_ms = s.t_ms ?? cur.end_ms;
      windows.push(cur);
      cur = null;
    }
  }
  if (cur) {
    // Open-ended; close at last non-split sample time or the cropPath's
    // effective end. We can't know without external duration so use
    // Number.MAX_SAFE_INTEGER as sentinel; renderer clamps via -t/-to.
    cur.end_ms = Number.MAX_SAFE_INTEGER;
    windows.push(cur);
  }
  return windows;
}

/**
 * Build the full -filter_complex script for a crop_path containing
 * split_screen samples. Strategy:
 *   1. Base [0:v] runs through the single-face crop+scale chain (the
 *      existing if-ladder expression), producing [vbase].
 *   2. For each split window, two crops + scale → vstack/hstack → [ss_i].
 *   3. Each [ss_i] is overlaid onto [vbase] with `enable='between(t,t0,t1)'`.
 *   4. Final stream is labelled [v] for the renderer's `-map [v]`.
 *
 * Returns the script body (newline-terminated) ready to write to a
 * filter-script file.
 *
 * @param {object} cropPath
 * @param {string} targetAspect e.g. '9:16'
 * @returns {{script:string, axis:'hstack'|'vstack', windows:Array}}
 */
export function buildSplitScreenScript(cropPath, targetAspect) {
  const sw = cropPath.source_w | 0;
  const sh = cropPath.source_h | 0;
  const tw = cropPath.target_w | 0;
  const th = cropPath.target_h | 0;
  const baseChain = buildFilterArg(cropPath);
  const windows = groupSplitScreenWindows(cropPath);
  const axis = chooseSplitAxis(targetAspect);

  const lines = [];
  lines.push('[0:v]' + baseChain + '[vbase]');

  let prevLabel = 'vbase';
  const winMeta = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const ssLabel = 'ss_' + i;
    // Build a per-window split fragment using a SYNTHETIC sample so we
    // reuse buildSplitScreenFilter. Replace its [0:v] inputs with
    // [0:v] (re-read source for each window — ffmpeg handles fan-out).
    const fragment = buildSplitScreenFilter({
      sample: { t_ms: w.start_ms, split_screen: { speakers: w.speakers } },
      sourceW: sw, sourceH: sh, targetW: tw, targetH: th,
      targetAspect, inLabel: '0:v', outLabel: ssLabel,
    });
    if (!fragment.filter) continue;
    lines.push(fragment.filter);

    const t0 = (w.start_ms / 1000).toFixed(3);
    const t1Raw = (w.end_ms === Number.MAX_SAFE_INTEGER) ? 999999 : w.end_ms / 1000;
    const t1 = t1Raw.toFixed(3);
    const outLabel = (i === windows.length - 1) ? 'v' : ('vbase' + (i + 1));
    lines.push('[' + prevLabel + '][' + ssLabel + ']overlay=x=0:y=0:enable=\'between(t,' + t0 + ',' + t1 + ')\'[' + outLabel + ']');
    prevLabel = outLabel;
    winMeta.push({ start_ms: w.start_ms, end_ms: w.end_ms, axis: fragment.axis });
  }

  // If no windows (shouldn't happen — caller checks first), passthrough
  // base as [v].
  if (winMeta.length === 0) {
    lines.push('[vbase]null[v]');
  } else if (prevLabel !== 'v') {
    // The last overlay didn't get labelled [v] (shouldn't happen because
    // we set outLabel='v' on the final iteration; defensive).
    lines.push('[' + prevLabel + ']null[v]');
  }
  return { script: lines.join(';\n') + '\n', axis, windows: winMeta };
}

/**
 * Inspect a crop_path and return summary stats about its split_screen
 * samples. Used by the renderer to emit telemetry.
 *
 * @param {object} cropPath
 * @returns {{count:number, total_duration_ms:number, speakers:number[]}}
 */
export function summarizeSplitScreenSamples(cropPath) {
  const samples = (cropPath && Array.isArray(cropPath.samples)) ? cropPath.samples : [];
  const ssSamples = samples.filter((s) => s && s.split_screen);
  const speakerSet = new Set();
  let totalMs = 0;
  for (let i = 0; i < ssSamples.length; i++) {
    const s = ssSamples[i];
    const sNext = ssSamples[i + 1];
    const dur = sNext ? Math.max(0, (sNext.t_ms ?? 0) - (s.t_ms ?? 0)) : 0;
    totalMs += dur;
    for (const spk of (s.split_screen.speakers || [])) {
      speakerSet.add(spk.speaker_id);
    }
  }
  return {
    count: ssSamples.length,
    total_duration_ms: totalMs,
    speakers: Array.from(speakerSet).sort((a, b) => a - b),
  };
}

/**
 * Pick the rendering mode for a given crop_path. Single source of truth so
 * tests can drive `cf-ffmpeg` mode decisions without invoking ffmpeg.
 *
 * Modes:
 *   - 'static'        — samples.length ≤ 1  → emit a constant `crop=W:H:X:Y`
 *   - 'inline'        — expression < threshold → pass full filter chain via -vf
 *   - 'filter-script' — expression ≥ threshold → write to a tempfile and use
 *                       -filter_complex_script (bypasses shell ARG_MAX)
 *
 * Threshold rationale: macOS ARG_MAX is ~256 KB once env overhead is netted;
 * we cap inline at 100 KB to leave headroom for the rest of the ffmpeg
 * command line.
 *
 * @param {object} cropPath
 * @param {number} [thresholdBytes=100_000]
 * @returns {{mode: 'static'|'inline'|'filter-script', filterArg: string, byteSize: number, keyframeCount: number}}
 */
export function chooseRenderMode(cropPath, thresholdBytes = 100_000) {
  const built = buildCropExpression(cropPath);
  const { exprX, exprY, cropW, cropH, keyframeCount, downsampled, originalKeyframeCount } = built;
  const tw = cropPath.target_w | 0;
  const th = cropPath.target_h | 0;
  const filterArg = 'crop=' + cropW + ':' + cropH + ':' + escapeFilterArg(exprX) + ':' + escapeFilterArg(exprY)
                  + ',scale=' + tw + ':' + th;
  const byteSize = Buffer.byteLength(filterArg, 'utf-8');
  const mode = keyframeCount <= 1
    ? 'static'
    : (byteSize < thresholdBytes ? 'inline' : 'filter-script');
  return { mode, filterArg, byteSize, keyframeCount, cropW, cropH, downsampled, originalKeyframeCount };
}
