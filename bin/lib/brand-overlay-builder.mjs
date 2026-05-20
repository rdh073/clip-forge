// brand-overlay-builder.mjs — pure builders for v0.4.0 pillar 3 brand-kit
// overlays. Mirrors the shape of overlay-builder.mjs (pillar (i)): same
// inputs in → byte-identical strings out, no Date.now(), no process.env reads.
//
// Two responsibilities:
//
//   1. buildLogoOverlay({asset, canvasW, canvasH, inputIndex}) → {filter, args, warnings}
//      Returns an ffmpeg filter expression that overlays a logo at the
//      requested position with opacity + scale_px. Caller is responsible
//      for adding the file as an ffmpeg `-i` input (we just emit
//      [<inputIndex>:v]…[wm]; [<prev>][wm]overlay=… chain fragments).
//
//   2. buildLowerThirdOverlay({asset, canvasW, canvasH, inputIndex}) → {filter, args, warnings}
//      Same shape, time-gated via enable='between(t,start,end)'. Different
//      default position (bottom-left) and no scale_px (lower-thirds bring
//      their own dimensions; we centre them within a position quadrant).
//
//   3. positionExpr(position, canvasW, canvasH) → {x, y}
//      ffmpeg overlay-filter expressions for the five position names.
//      8 % padding from canvas edge (mirrors the existing `watermark`
//      subcommand). 'center' → centred.
//
// SVG handling: if the path ends in .svg we DO NOT add the input — ffmpeg
// needs librsvg compiled in, and the renderer must probe before invoking.
// Caller hooks into the returned `svg: true` flag to skip + warn rather
// than letting ffmpeg fail mid-render.

const POS_PADDING_PCT = 0.04;  // 4 % from edge

function isMp4Path(p) { return /\.mp4$/i.test(String(p)); }
function isSvgPath(p) { return /\.svg$/i.test(String(p)); }

/**
 * Compute ffmpeg overlay x/y expressions for the five position names.
 * Uses W/H (main video) and w/h (overlay) variables. Returns strings
 * suitable for direct interpolation into an `overlay=x=…:y=…` filter.
 */
export function positionExpr(position, canvasW, canvasH) {
  const padX = Math.floor(canvasW * POS_PADDING_PCT);
  const padY = Math.floor(canvasH * POS_PADDING_PCT);
  switch (position) {
    case 'bottom-right': return { x: 'W-w-' + padX,    y: 'H-h-' + padY };
    case 'bottom-left':  return { x: String(padX),     y: 'H-h-' + padY };
    case 'top-right':    return { x: 'W-w-' + padX,    y: String(padY) };
    case 'top-left':     return { x: String(padX),     y: String(padY) };
    case 'center':       return { x: '(W-w)/2',        y: '(H-h)/2' };
    default:             return { x: 'W-w-' + padX,    y: 'H-h-' + padY };
  }
}

/**
 * Build a filter expression that overlays a logo onto a stream labeled
 * `<inLabel>` and emits `<outLabel>`. The logo image is expected as
 * ffmpeg input <inputIndex>.
 *
 * Returns:
 *   { filter, warnings, skipped, svg }
 *
 *   filter:   "[<inputIndex>:v]format=rgba,scale=<scale_px>:-1,colorchannelmixer=aa=<opacity>[wm];[<inLabel>][wm]overlay=x=…:y=…[<outLabel>]"
 *   svg:      true when the asset path ends in .svg AND librsvg has not
 *             been verified — caller should probe + skip if absent.
 *   skipped:  true when caller-side checks decided to skip the asset
 *             (path missing, oversized, librsvg unavailable etc.)
 */
export function buildLogoOverlay(opts) {
  const { asset, canvasW = 1080, canvasH = 1920, inputIndex,
          inLabel = '0:v', outLabel = 'vwm', librsvgAvailable = true } = opts;
  const warnings = [];
  if (!asset || !asset.path) {
    return { filter: '', warnings, skipped: true, svg: false };
  }
  if (isSvgPath(asset.path) && !librsvgAvailable) {
    warnings.push({ code: 'librsvg_not_available',
                    message: 'SVG logo ' + asset.path + ' requires librsvg in ffmpeg build; skipped' });
    return { filter: '', warnings, skipped: true, svg: true };
  }
  const scalePx = Math.max(8, Math.min(1024, asset.scale_px ?? 96));
  const opacity = Math.max(0, Math.min(1, asset.opacity ?? 0.7));
  const pos = positionExpr(asset.position || 'bottom-right', canvasW, canvasH);
  // We emit:
  //   [<idx>:v]format=rgba,scale=<sp>:-1,colorchannelmixer=aa=<op>[wm]
  //   [<in>][wm]overlay=…[<out>]
  const wmTag = 'logo_wm_' + inputIndex;
  const filter =
    '[' + inputIndex + ':v]format=rgba,scale=' + scalePx + ':-1,colorchannelmixer=aa=' + opacity.toFixed(3) + '[' + wmTag + '];' +
    '[' + inLabel + '][' + wmTag + ']overlay=x=' + pos.x + ':y=' + pos.y + '[' + outLabel + ']';
  return { filter, warnings, skipped: false, svg: isSvgPath(asset.path) };
}

/**
 * Build the time-gated lower-third overlay. enable='between(t,A,B)' keeps
 * the layer visible only inside the [show_from_ms, show_until_ms] window.
 */
export function buildLowerThirdOverlay(opts) {
  const { asset, canvasW = 1080, canvasH = 1920, inputIndex,
          inLabel = '0:v', outLabel = 'vlt', librsvgAvailable = true } = opts;
  const warnings = [];
  if (!asset || !asset.path) {
    return { filter: '', warnings, skipped: true, svg: false };
  }
  if (isSvgPath(asset.path) && !librsvgAvailable) {
    warnings.push({ code: 'librsvg_not_available',
                    message: 'SVG lower-third ' + asset.path + ' requires librsvg; skipped' });
    return { filter: '', warnings, skipped: true, svg: true };
  }
  const opacity = Math.max(0, Math.min(1, asset.opacity ?? 0.9));
  const fromS = Math.max(0, (asset.show_from_ms  ?? 1500) / 1000);
  const untilS = Math.max(fromS + 0.05, (asset.show_until_ms ?? 4000) / 1000);
  const pos = positionExpr(asset.position || 'bottom-left', canvasW, canvasH);
  const wmTag = 'lt_wm_' + inputIndex;
  const filter =
    '[' + inputIndex + ':v]format=rgba,colorchannelmixer=aa=' + opacity.toFixed(3) + '[' + wmTag + '];' +
    '[' + inLabel + '][' + wmTag + ']overlay=x=' + pos.x + ':y=' + pos.y +
    ":enable='between(t," + fromS.toFixed(3) + ',' + untilS.toFixed(3) + ")'[" + outLabel + ']';
  return { filter, warnings, skipped: false, svg: isSvgPath(asset.path) };
}

/**
 * Compose logo + lower-third into a single -filter_complex string that
 * the renderer can pass to ffmpeg. The chain starts from `[0:v]` (main
 * input video), threads through each overlay, ends in a final labelled
 * stream `[vbrand]`.
 *
 *   inputIndexOffset — first ffmpeg input index allocated to brand-kit
 *                       assets (the renderer already used 0/1 for video/
 *                       audio, so caller passes the next available).
 *
 *   { brand, canvasW, canvasH, inputIndexOffset, librsvgAvailable }
 *
 * Returns:
 *   { chain, extraInputs, finalLabel, assetsBurned, warnings }
 *
 *     chain         — '' when no brand asset will burn (caller skips
 *                     wiring this; main video flows through unchanged).
 *                     Otherwise a comma-joined sequence of filter blocks
 *                     starting from [0:v] and ending in [<finalLabel>].
 *     extraInputs   — array of asset paths (in input-index order) the
 *                     renderer must pass as additional `-i <path>` args.
 *     finalLabel    — label of the last stream in `chain`, e.g. 'vbrand'.
 *                     '' when chain is empty.
 *     assetsBurned  — ['logo', 'lower_third'] subset (endcard handled
 *                     separately by the renderer via concat-demuxer).
 *     warnings      — collected from each builder.
 */
export function composeBrandKitFilter(opts) {
  const { brand, canvasW = 1080, canvasH = 1920, inputIndexOffset = 1,
          librsvgAvailable = true, startLabel = '0:v' } = opts;
  const warnings = [];
  const extraInputs = [];
  const assetsBurned = [];
  if (!brand || !brand.assets) {
    return { chain: '', extraInputs, finalLabel: '', assetsBurned, warnings };
  }
  const pieces = [];
  let prevLabel = startLabel;
  let inputIndex = inputIndexOffset;

  if (brand.assets.logo) {
    const outLabel = 'vlogo';
    const r = buildLogoOverlay({
      asset: brand.assets.logo,
      canvasW, canvasH, inputIndex,
      inLabel: prevLabel, outLabel,
      librsvgAvailable,
    });
    warnings.push(...r.warnings);
    if (!r.skipped) {
      pieces.push(r.filter);
      extraInputs.push(brand.assets.logo.path);
      assetsBurned.push('logo');
      prevLabel = outLabel;
      inputIndex++;
    }
  }
  if (brand.assets.lower_third) {
    const outLabel = 'vlt';
    const r = buildLowerThirdOverlay({
      asset: brand.assets.lower_third,
      canvasW, canvasH, inputIndex,
      inLabel: prevLabel, outLabel,
      librsvgAvailable,
    });
    warnings.push(...r.warnings);
    if (!r.skipped) {
      pieces.push(r.filter);
      extraInputs.push(brand.assets.lower_third.path);
      assetsBurned.push('lower_third');
      prevLabel = outLabel;
      inputIndex++;
    }
  }
  if (pieces.length === 0) {
    return { chain: '', extraInputs, finalLabel: '', assetsBurned, warnings };
  }
  return {
    chain: pieces.join(';'),
    extraInputs,
    finalLabel: prevLabel,
    assetsBurned,
    warnings,
  };
}

/**
 * Translate a token (e.g. "$brand.logo") to its filesystem path using
 * the resolved kit. Only `$brand.logo` is supported in this round —
 * colour tokens are deferred to v0.5.0 per the brief.
 */
export function resolveBrandToken(token, kit) {
  if (typeof token !== 'string') return null;
  if (token === '$brand.logo') {
    return kit?.assets?.logo?.path ?? null;
  }
  return null;
}

export { isMp4Path, isSvgPath };
