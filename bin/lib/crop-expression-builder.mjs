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
