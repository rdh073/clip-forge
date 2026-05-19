// face-tracker.mjs — deterministic IoU-based per-frame identity tracker.
//
// Replaces the bespoke nearest-neighbour Euclidean-distance heuristic that
// lived inside active-speaker.mjs._matchTracks for v0.1.x. The substitution
// happened because Phase 2A swapped MediaPipe (which provided face.id
// natively) for Ultraface (which doesn't), so we need our own.
//
// Pure logic, no model. Unit-testable, mutation-test-ready, deterministic.
//
// API:
//   const tracker = new FaceTracker({ iouThreshold: 0.3, staleAfterMs: 2000 });
//   const facesWithIds = tracker.assignIds(faces, frameTMs);
//   tracker.reset();
//
// Each input face must have { x, y, w, h } in *consistent* coordinates
// (source pixels are conventional in ClipForge). Output faces carry the
// same fields plus a `id` (positive integer) that stays sticky across
// frames as long as the same physical face keeps overlapping its prior
// bbox above the IoU threshold.

const DEFAULT_IOU_THRESHOLD = 0.3;
const DEFAULT_STALE_AFTER_MS = 2000;

export class FaceTracker {
  /**
   * @param {object} opts
   * @param {number} [opts.iouThreshold=0.3]   Min IoU with a previous bbox to inherit its ID
   * @param {number} [opts.staleAfterMs=2000]  Drop tracks not seen for this long (memory hygiene)
   */
  constructor(opts = {}) {
    this.iouThreshold = opts.iouThreshold ?? DEFAULT_IOU_THRESHOLD;
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this._tracks = new Map();   // id → { lastSeen: tMs, x, y, w, h }
    this._nextId = 1;
  }

  reset() {
    this._tracks.clear();
    this._nextId = 1;
  }

  /**
   * Assign stable IDs to this frame's faces.
   *
   * Algorithm — greedy IoU matching:
   *   1. For each incoming face (in input order), compute IoU against every
   *      not-yet-claimed track. Pair it with the best-match track if that
   *      IoU exceeds the threshold.
   *   2. Unmatched incoming faces get fresh IDs.
   *   3. Tracks not seen for `staleAfterMs` are evicted.
   *
   * @param {Array<{x:number,y:number,w:number,h:number}>} faces
   * @param {number} tMs
   * @returns {Array<{x,y,w,h,id:number, …}>} Same faces with `id` field added.
   */
  assignIds(faces, tMs) {
    const claimed = new Set();
    const out = [];
    for (const face of faces) {
      let bestId = null;
      let bestIou = this.iouThreshold;
      for (const [id, t] of this._tracks) {
        if (claimed.has(id)) continue;
        const i = iou(face, t);
        if (i > bestIou) { bestIou = i; bestId = id; }
      }
      const id = bestId ?? (this._nextId++);
      claimed.add(id);
      this._tracks.set(id, { lastSeen: tMs, x: face.x, y: face.y, w: face.w, h: face.h });
      out.push({ ...face, id });
    }
    // Reap stale tracks so the matcher stays fast on long videos.
    for (const [id, t] of this._tracks) {
      if (tMs - t.lastSeen > this.staleAfterMs) this._tracks.delete(id);
    }
    return out;
  }

  // Expose internal state for tests; not part of the public contract.
  get _internalTrackCount() { return this._tracks.size; }
}

/**
 * IoU between two axis-aligned bboxes specified by center (x, y) + size (w, h).
 * Returns 0 when boxes don't overlap.
 */
export function iou(a, b) {
  const aL = a.x - a.w / 2, aR = a.x + a.w / 2, aT = a.y - a.h / 2, aB = a.y + a.h / 2;
  const bL = b.x - b.w / 2, bR = b.x + b.w / 2, bT = b.y - b.h / 2, bB = b.y + b.h / 2;
  const xL = Math.max(aL, bL);
  const yT = Math.max(aT, bT);
  const xR = Math.min(aR, bR);
  const yB = Math.min(aB, bB);
  if (xR <= xL || yB <= yT) return 0;
  const inter = (xR - xL) * (yB - yT);
  const aArea = a.w * a.h;
  const bArea = b.w * b.h;
  return inter / (aArea + bArea - inter);
}
