// primary-detect.mjs — auto-detect whether a target segment overlaps the
// creator's primary face track (v0.4.0 pillar 5).
//
// Defense-in-depth heuristic. We DO NOT run a fresh face-detection pass;
// the renderer's cf-reframe already produced crop_path.json with
// stats.framesWithFace + stats.framesProcessed. If yield > 0.5 across the
// whole source, ANY avatar overlay risks landing on the speaker's face —
// the moat invariant says AI never operates on primary footage, so we
// refuse with `avatar_overlaps_primary_face`.
//
// This is intentionally conservative — false positives (refuse a stinger
// at a moment where the speaker happens to be off-camera) are preferable
// to false negatives (paste an AI face over the actual creator).
//
// Used by both cf-broll-ai (to refuse stylization/gap-fill on segments
// flagged is_primary or with high face yield) and cf-avatar (to refuse
// stingers that overlap the primary track).

import { existsSync, readFileSync } from 'node:fs';

export const FACE_YIELD_THRESHOLD = 0.5;

/**
 * Read crop_path.json and return its stats block (or null on missing /
 * unreadable file). NEVER throws — caller decides what missing stats means.
 */
export function loadCropStats(cropPathFile) {
  if (!cropPathFile || !existsSync(cropPathFile)) return null;
  try {
    const raw = JSON.parse(readFileSync(cropPathFile, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    if (!raw.stats || typeof raw.stats !== 'object') return null;
    const fp = Number(raw.stats.framesProcessed);
    const fw = Number(raw.stats.framesWithFace);
    if (!Number.isFinite(fp) || !Number.isFinite(fw)) return null;
    return {
      framesProcessed: fp,
      framesWithFace:  fw,
      yield_ratio:     fp > 0 ? fw / fp : 0,
    };
  } catch { return null; }
}

/**
 * Decide whether a (start_ms, end_ms) segment window overlaps the primary
 * face track strongly enough to refuse AI operation.
 *
 * Returns:
 *   { overlaps_primary: true,  ratio, reason }
 *   { overlaps_primary: false, ratio, reason }
 *
 * `reason` documents WHY the decision was made — surfaces in the dispatcher
 * NDJSON event so the caller can debug.
 */
export function detectsPrimaryFace(cropStats, { start_ms, end_ms } = {}) {
  if (!cropStats) {
    return { overlaps_primary: false, ratio: 0, reason: 'no_crop_stats' };
  }
  if (cropStats.framesProcessed === 0) {
    return { overlaps_primary: false, ratio: 0, reason: 'no_frames_processed' };
  }
  const ratio = cropStats.yield_ratio;
  // The brief specifies global-yield heuristic; we annotate with the
  // requested window so the caller can audit. A per-segment refinement
  // would require per-frame face stamps which the current crop_path.json
  // doesn't carry (samples[] are dense regardless of detection success).
  if (ratio > FACE_YIELD_THRESHOLD) {
    return {
      overlaps_primary: true,
      ratio:            +ratio.toFixed(3),
      reason:           'avatar_overlaps_primary_face',
      window_ms:        { start_ms: start_ms ?? null, end_ms: end_ms ?? null },
    };
  }
  return {
    overlaps_primary: false,
    ratio:            +ratio.toFixed(3),
    reason:           'low_face_yield_below_threshold',
  };
}

/**
 * Hard-refusal check across segment.is_primary flag + auto-detect.
 * The dispatcher uses this so the refusal logic lives in one place.
 *
 * Returns { allowed: bool, refusal_reason?: string, detail?: object }
 */
export function gateAiOnSegment({ segment, cropStats }) {
  if (segment && segment.is_primary === true) {
    return { allowed: false, refusal_reason: 'is_primary_segment',
             detail: { explicit_flag: true } };
  }
  const probe = detectsPrimaryFace(cropStats, {
    start_ms: segment ? segment.start_ms : null,
    end_ms:   segment ? segment.end_ms   : null,
  });
  if (probe.overlaps_primary) {
    return { allowed: false, refusal_reason: probe.reason, detail: probe };
  }
  return { allowed: true, refusal_reason: null, detail: probe };
}
