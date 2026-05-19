// active-speaker.mjs — picks one face per frame as the "active speaker"
// using a weighted score over four cues:
//
//   - audio    (which speaker is talking right now × speaker→face mapping)
//   - mouth    (rolling delta of the mouth keypoint over the last N frames)
//   - central  (inverse distance from frame center)
//   - confidence (the detector's own bbox confidence)
//
// Plus a switching damper that prevents zig-zag flips faster than
// switchCooldownMs / frameLockN.
//
// Stateless I/O:
//   const tracker = new ActiveSpeakerTracker({...})
//   tracker.pickActiveFace(faces, { tMs, frameWidth, frameHeight }) → Face | null
//   tracker.reset()

// When a transcript + speakerMap are both supplied the audio cue contributes
// 30% of the score. When either is absent we don't fall through to a naive
// renormalization (which over-weights mouth motion) — instead we use a
// hand-tuned set that leans more on centrality/confidence, since mouth motion
// alone tends to be noisy in talking-head clips.
const DEFAULT_WEIGHTS = { audio: 0.3, mouth: 0.5, central: 0.1, confidence: 0.1 };
const DEFAULT_NO_AUDIO_WEIGHTS = { audio: 0, mouth: 0.6, central: 0.25, confidence: 0.15 };
const DEFAULT_SWITCH_COOLDOWN_MS = 800;
const DEFAULT_FRAME_LOCK = 24;
const MOUTH_WINDOW_FRAMES = 10;
const IDENTITY_MAX_DIST_FACTOR = 0.25; // 25% of min(frame_w, frame_h)

export class ActiveSpeakerTracker {
  /**
   * @param {object} opts
   * @param {{audio,mouth,central,confidence}} [opts.weights]
   * @param {number} [opts.switchCooldownMs=800]
   * @param {number} [opts.frameLockN=24]
   * @param {boolean} [opts.disableActiveSpeaker=false]  Use highest-confidence face only.
   * @param {object} [opts.transcript]    transcript.json (for audio cue)
   * @param {object} [opts.speakerMap]    { "<speaker_id>": { x: 0..1, y: 0..1 }, ... }
   *                                      Use `null` to disable audio cue.
   */
  constructor(opts = {}) {
    const audioAvailable = !!opts.transcript && !!opts.speakerMap;
    if (opts.weights) {
      // User passed explicit weights — renormalize, zeroing audio if no transcript.
      this.weights = normalizeWeights({ ...DEFAULT_WEIGHTS, ...opts.weights }, audioAvailable);
    } else {
      // No explicit weights — pick the appropriate default set.
      this.weights = { ...(audioAvailable ? DEFAULT_WEIGHTS : DEFAULT_NO_AUDIO_WEIGHTS) };
    }
    this.switchCooldownMs = opts.switchCooldownMs ?? DEFAULT_SWITCH_COOLDOWN_MS;
    this.frameLockN = opts.frameLockN ?? DEFAULT_FRAME_LOCK;
    this.disabled = !!opts.disableActiveSpeaker;
    this.transcript = opts.transcript || null;
    this.speakerMap = opts.speakerMap || null;

    // Identity tracking state
    this._tracks = new Map();        // faceId → { lastSeen: tMs, x, y, mouthHistory: [{tMs, mx, my}] }
    this._nextFaceId = 1;

    // Switching state
    this._currentId = null;
    this._currentSinceTMs = -Infinity;
    this._currentSinceFrame = -Infinity;
    this._frameCounter = 0;
  }

  reset() {
    this._tracks.clear();
    this._nextFaceId = 1;
    this._currentId = null;
    this._currentSinceTMs = -Infinity;
    this._currentSinceFrame = -Infinity;
    this._frameCounter = 0;
  }

  /**
   * Pick the active face for a frame.
   * @param {Face[]} faces — output of detectFaces, in SOURCE coords
   * @param {{tMs:number, frameWidth:number, frameHeight:number}} ctx
   * @returns {{face: Face|null, faceId: number|null, scores: object}}
   */
  pickActiveFace(faces, ctx) {
    this._frameCounter++;

    if (!faces || faces.length === 0) {
      // Keep the current track ID but don't update its position; caller will
      // use Kalman to coast through. We do NOT clear `_currentId` so the
      // damper still gates future flips.
      return { face: null, faceId: this._currentId, scores: {} };
    }

    // 1) Match incoming detections to existing tracks (or create new).
    const matched = this._matchTracks(faces, ctx);

    if (this.disabled) {
      // Highest confidence face wins; no damper logic except still update mouth history.
      const top = matched.slice().sort((a, b) => b.face.confidence - a.face.confidence)[0];
      if (top) {
        this._currentId = top.faceId;
        this._currentSinceTMs = ctx.tMs;
        this._currentSinceFrame = this._frameCounter;
      }
      return top ? { face: top.face, faceId: top.faceId, scores: { confidence: top.face.confidence } }
                 : { face: null, faceId: null, scores: {} };
    }

    // 2) Score each face.
    const scored = matched.map(({ face, faceId, mouthDelta }) => {
      const s = {
        audio:      this._audioScore(face, ctx),
        mouth:      mouthDelta,           // raw rolling delta; will be normalized below
        central:    centralScore(face, ctx.frameWidth, ctx.frameHeight),
        confidence: face.confidence,
      };
      return { face, faceId, raw: s };
    });

    // Normalize mouth deltas across this frame's faces (so weighted sum is comparable).
    const maxMouth = Math.max(1e-6, ...scored.map((s) => s.raw.mouth));
    for (const s of scored) s.raw.mouth = s.raw.mouth / maxMouth;

    // 3) Weighted sum.
    for (const s of scored) {
      s.total =
        s.raw.audio      * this.weights.audio +
        s.raw.mouth      * this.weights.mouth +
        s.raw.central    * this.weights.central +
        s.raw.confidence * this.weights.confidence;
    }

    scored.sort((a, b) => b.total - a.total);
    const winner = scored[0];

    // 4) Switching damper: only switch if current track is gone OR cooldown passed.
    let chosen = winner;
    if (this._currentId != null) {
      const currentStill = scored.find((s) => s.faceId === this._currentId);
      const sinceMs = ctx.tMs - this._currentSinceTMs;
      const sinceFrames = this._frameCounter - this._currentSinceFrame;
      const cooledDown = sinceMs >= this.switchCooldownMs && sinceFrames >= this.frameLockN;
      if (currentStill && !cooledDown) {
        chosen = currentStill;
      }
    }

    if (chosen.faceId !== this._currentId) {
      this._currentId = chosen.faceId;
      this._currentSinceTMs = ctx.tMs;
      this._currentSinceFrame = this._frameCounter;
    }

    return { face: chosen.face, faceId: chosen.faceId, scores: chosen.raw };
  }

  // ---- internals ----

  _matchTracks(faces, ctx) {
    const maxDist = Math.min(ctx.frameWidth, ctx.frameHeight) * IDENTITY_MAX_DIST_FACTOR;
    const matched = [];
    const usedIds = new Set();
    for (const face of faces) {
      // Nearest existing track by Euclidean distance.
      let bestId = null;
      let bestD = Infinity;
      for (const [id, t] of this._tracks) {
        if (usedIds.has(id)) continue;
        const d = Math.hypot(face.x - t.x, face.y - t.y);
        if (d < bestD) { bestD = d; bestId = id; }
      }
      let faceId;
      if (bestId != null && bestD <= maxDist) {
        faceId = bestId;
        usedIds.add(bestId);
      } else {
        faceId = this._nextFaceId++;
      }
      // Update track + mouth history.
      const t = this._tracks.get(faceId) || { mouthHistory: [] };
      t.lastSeen = ctx.tMs;
      t.x = face.x; t.y = face.y;
      const mouth = face.keypoints && face.keypoints.mouth;
      if (mouth) {
        t.mouthHistory.push({ tMs: ctx.tMs, mx: mouth.x, my: mouth.y });
        if (t.mouthHistory.length > MOUTH_WINDOW_FRAMES + 1) {
          t.mouthHistory.shift();
        }
      }
      this._tracks.set(faceId, t);

      // Compute mouth delta for this face (sum of frame-to-frame distances over the window).
      const mh = t.mouthHistory;
      let mouthDelta = 0;
      for (let i = 1; i < mh.length; i++) {
        mouthDelta += Math.hypot(mh[i].mx - mh[i - 1].mx, mh[i].my - mh[i - 1].my);
      }
      matched.push({ face, faceId, mouthDelta });
    }

    // Reap tracks not seen for >2s — keeps the matcher cheap on long videos.
    for (const [id, t] of this._tracks) {
      if (ctx.tMs - t.lastSeen > 2000) this._tracks.delete(id);
    }

    return matched;
  }

  _audioScore(face, ctx) {
    if (!this.transcript || !this.speakerMap) return 0;
    const speakerId = currentSpeakerAt(this.transcript, ctx.tMs);
    if (speakerId == null) return 0;
    const target = this.speakerMap[String(speakerId)];
    if (!target) return 0;
    // target.x/target.y are normalized 0..1 across the source frame.
    const dx = (face.x / ctx.frameWidth) - target.x;
    const dy = (face.y / ctx.frameHeight) - target.y;
    const d = Math.hypot(dx, dy); // 0..√2
    // Convert distance to a 0..1 score; faces within ~15% of mapped point get ~1.0.
    return Math.max(0, 1 - d / 0.4);
  }
}

// ---- score helpers ----

function centralScore(face, frameW, frameH) {
  const dx = (face.x - frameW / 2) / (frameW / 2);
  const dy = (face.y - frameH / 2) / (frameH / 2);
  const d = Math.min(1, Math.hypot(dx, dy));
  return 1 - d;
}

function normalizeWeights(w, audioAvailable) {
  // If transcript/speakerMap are unset, drop the audio weight and renormalize
  // the remaining cues so the weighted sum still sums to 1.
  const effective = { ...w };
  if (!audioAvailable) effective.audio = 0;
  const sum = effective.audio + effective.mouth + effective.central + effective.confidence;
  if (sum <= 0) return DEFAULT_WEIGHTS;
  for (const k of Object.keys(effective)) effective[k] /= sum;
  return effective;
}

function currentSpeakerAt(transcript, tMs) {
  const words = (transcript && transcript.words) || [];
  // Binary search would be nicer but linear is fine for clip-length transcripts.
  for (const w of words) {
    if (w.start_ms <= tMs && tMs <= w.end_ms) {
      return w.speaker ?? null;
    }
  }
  return null;
}

// ---- speaker → face calibration ----

/**
 * Parse a --speaker-map flag value.
 *
 * Accepted forms:
 *   "auto"                        → returns null (caller should auto-calibrate)
 *   "0:left,1:right"              → predefined slots (left/right/center/top/bottom)
 *   "0:0.25,0.5,1:0.75,0.5"       → explicit normalized x,y per speaker
 *
 * @returns {{x:number, y:number} | 'auto' | null}  null = no map / disable audio cue
 */
export function parseSpeakerMap(spec) {
  if (!spec || spec === 'none' || spec === 'off') return null;
  if (spec === 'auto') return 'auto';

  const slots = {
    left:   { x: 0.25, y: 0.5 },
    right:  { x: 0.75, y: 0.5 },
    center: { x: 0.5,  y: 0.5 },
    top:    { x: 0.5,  y: 0.3 },
    bottom: { x: 0.5,  y: 0.7 },
  };

  const out = {};
  // Try named-slot form first: "0:left,1:right"
  const tokens = spec.split(',');
  // Reassemble: keys may be like "0:0.25" + "0.5" pairs (when the value is x,y)
  // We'll process tokens in order, peeking ahead.
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i].trim();
    const colonIdx = t.indexOf(':');
    if (colonIdx === -1) {
      // Numeric continuation belonging to the previous key? Then bail to numeric form.
      return parseSpeakerMapNumeric(spec);
    }
    const key = t.slice(0, colonIdx).trim();
    const val = t.slice(colonIdx + 1).trim();
    if (slots[val]) {
      out[key] = { ...slots[val] };
      i++;
    } else if (isFiniteNumber(val) && i + 1 < tokens.length && isFiniteNumber(tokens[i + 1].trim())) {
      out[key] = { x: clamp01(parseFloat(val)), y: clamp01(parseFloat(tokens[i + 1].trim())) };
      i += 2;
    } else {
      return parseSpeakerMapNumeric(spec); // fall through
    }
  }
  return out;
}

function parseSpeakerMapNumeric(spec) {
  // Form "0:0.25,0.5,1:0.75,0.5" — split by "<id>:" markers.
  const out = {};
  const re = /(\d+):\s*([-\d.]+)\s*,\s*([-\d.]+)/g;
  let m;
  while ((m = re.exec(spec)) !== null) {
    out[m[1]] = { x: clamp01(parseFloat(m[2])), y: clamp01(parseFloat(m[3])) };
  }
  return Object.keys(out).length ? out : null;
}

const isFiniteNumber = (s) => !Number.isNaN(parseFloat(s)) && isFinite(parseFloat(s));
const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * Auto-calibrate speaker → face mapping by running detection over a short
 * lead-in (the first `windowMs` of the clip) and finding the modal face
 * position per speaker_id from the transcript.
 *
 * @param {Array<{tMs:number, faces:Face[]}>} samples   — already-detected lead-in
 * @param {object} transcript                            — transcript.json
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @returns {object}                                     — { '0': {x,y}, '1': {x,y} }
 */
export function autoCalibrateSpeakerMap(samples, transcript, frameWidth, frameHeight) {
  const accum = new Map(); // speakerId → array of {x,y} normalized
  for (const { tMs, faces } of samples) {
    const spk = currentSpeakerAt(transcript, tMs);
    if (spk == null || !faces.length) continue;
    // Heuristic: during this speaker's words, the face most likely to be talking
    // is the one with the largest bbox (closest to camera) AND highest
    // confidence. We accept the top candidate.
    const top = faces.slice().sort((a, b) => (b.confidence * b.w * b.h) - (a.confidence * a.w * a.h))[0];
    const arr = accum.get(spk) || [];
    arr.push({ x: top.x / frameWidth, y: top.y / frameHeight });
    accum.set(spk, arr);
  }

  const out = {};
  for (const [spk, pts] of accum) {
    if (!pts.length) continue;
    // Use median to be robust against outliers (e.g. brief crowd shots).
    const xs = pts.map((p) => p.x).sort((a, b) => a - b);
    const ys = pts.map((p) => p.y).sort((a, b) => a - b);
    out[String(spk)] = {
      x: xs[Math.floor(xs.length / 2)],
      y: ys[Math.floor(ys.length / 2)],
    };
  }
  return out;
}
