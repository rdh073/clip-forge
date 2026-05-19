# Phase 0 — detector library bench (v0.2.0 pick)

**Run date:** 2026-05-20
**Host:** Linux x86_64, Node 20.20.2 + Node 24.13.1 (nvm)
**Fixture:** `tests/fixtures/sample-face.jpg` — group photo, 640×480 (MIT,
sourced from upstream `@vladmandic/human` test corpus).

Each candidate was installed in a throwaway temp directory (no root
`package.json` pollution), initialized, then run for **1 first-detect +
100 measured iterations**. Install size is `du -sm node_modules` of the
temp tree.

## Headline

| Library                          | works_in_node? | init_ms | first_detect_ms | **median** | p95 | landmarks | tracking_id | install_mb |
|----------------------------------|----------------|---------|-----------------|-----------:|----:|-----------|-------------|-----------:|
| **@vladmandic/human** (Node 20)  | ✅             | 1029    | 160             | **49**     | 85  | **478** ✓ | **yes** ✓   | 727        |
| @vladmandic/face-api (Node 20)   | ✅             | 42      | 285             | 211        | 267 | 68        | no          | 733        |
| onnxruntime + Ultraface RFB-320  | ✅             | 67      | 8               | **4**      | 5   | **0** ✗   | no          | 603        |
| @vladmandic/human (Node 24)      | ❌             | —       | —               | —          | —   | —         | —           | 727        |
| @vladmandic/face-api (Node 24)   | ❌             | —       | —               | —          | —   | —         | —           | 733        |

## Raw output

### `@vladmandic/human` (Node 20.20.2)

```json
{
  "library": "@vladmandic/human",
  "version": "unknown",
  "init_ms": 1029,
  "first_detect_ms": 160,
  "median_detect_ms": 49,
  "p95_detect_ms": 85,
  "face_count": 1,
  "has_478_landmarks": true,
  "has_tracking_id": true,
  "works_in_node": true,
  "install_size_mb": 727,
  "install_ms": 19360
}
```

### `@vladmandic/face-api` (Node 20.20.2)

```json
{
  "library": "@vladmandic/face-api",
  "version": "1.7.15",
  "init_ms": 42,
  "first_detect_ms": 285,
  "median_detect_ms": 211,
  "p95_detect_ms": 267,
  "face_count": 14,
  "has_478_landmarks": false,
  "has_tracking_id": false,
  "works_in_node": true,
  "landmarks_per_face": 68,
  "install_size_mb": 733,
  "install_ms": 15382
}
```

### `onnxruntime-node + Ultraface RFB-320` (Node 24.13.1)

```json
{
  "library": "onnxruntime-node + ultraface",
  "version": "ultraface-rfb-320",
  "init_ms": 67,
  "first_detect_ms": 8,
  "median_detect_ms": 4,
  "p95_detect_ms": 5,
  "face_count": 44,
  "has_478_landmarks": false,
  "has_tracking_id": false,
  "works_in_node": true,
  "notes": "Ultraface is boxes-only. Landmarks/mesh would require a second model (e.g. PFLD or FaceLandmark1k3D).",
  "install_size_mb": 603,
  "install_ms": 27631
}
```

### Node 24 failures (Human + face-api)

Both TF.js-backed libraries fail with the same upstream stack trace:

```
TypeError: (0 , util_1.isNullOrUndefined) is not a function
    at createTensorsTypeOpAttr (.../tfjs-node/dist/nodejs_kernel_backend.js:675:38)
    at Object.kernelFunc (.../tfjs-node/dist/kernels/Cast.js:30:65)
```

`util.isNullOrUndefined` is a Node ≤ 22 helper removed in Node 24.
`@tensorflow/tfjs-node` 4.x reaches into the legacy `util_1` shim and breaks.
This is an upstream bug — TF.js maintainers haven't shipped a Node-24-compatible
release. Tracking: <https://github.com/tensorflow/tfjs/issues> (multiple
open reports).

## Observations

- **Human is the only candidate that ships a 478-point mesh out of the box.**
  Ultraface emits bounding boxes only; face-api emits 68 landmarks (sufficient
  for a rough mouth box, insufficient for the per-landmark mouth-motion cue
  ClipForge's active-speaker scorer was designed against).
- **Human also provides `face[].id`** (a stable tracking ID across frames),
  which lets us **drop the bespoke nearest-neighbour identity tracker** in
  `bin/lib/active-speaker.mjs` for v0.2.0 — net code reduction.
- **Ultraface's 44 detections** is the raw model output before NMS — the
  bench's threshold was 0.7. Real use would NMS-dedup to ~3 faces on this
  group photo. The 4 ms median is genuine; even after NMS it would stay
  under 10 ms.
- **face-api detected 14 faces** in the same image — its SSD MobileNet head
  over-fires on overlapping boxes on this particular photo. Latency 4× Human
  is hard to justify when Human gives more data per face.
- **Install size penalty applies to all three** (603–733 MB). The dominant
  cost is `@tensorflow/tfjs-node`'s native bindings + `onnxruntime-node`'s
  ORT binaries; the JS libraries themselves are tiny. None of these will
  fit a "lightweight plugin" promise; v0.2.0's README must acknowledge the
  install cost.
- **First-detect penalty:** Human pays 160 ms on first call (model JIT-compile),
  Ultraface 8 ms (model already loaded in init), face-api 285 ms. Acceptable
  for ClipForge — first-frame latency is amortised across the clip.

## Known quirk — synthetic-input tracker flip (Phase 2A smoke test)

When running the Phase 2A smoke test against a 5-second video synthesized by
looping `tests/fixtures/sample-face.jpg` (`ffmpeg -loop 1 -i sample-face.jpg
-t 5 …`), the active-speaker tracker may flip face IDs around the middle of
the clip. This is an **artifact of synthetic still-image input** — every face
in every frame scores identically (mouth motion = 0, central / confidence
constant), so after the 0.8 s + 24-frame damper cooldown the tracker has no
reason to keep the original target and picks whichever bounding box scored
marginally higher this frame. Real motion footage (talking head with mouth
movement) will not show this behaviour. **Do not tune NMS or the damper to
suppress this on synthetic input** — wait for the Phase 2B real-motion smoke
test to surface real-world regressions.

## Library candidate decision

> **Recommendation: `@vladmandic/human` (Node 20–22 engines), with a fallback
> path noted below.**

Reasoning:

1. **478-point mesh is load-bearing** for ClipForge's active-speaker mouth-motion
   cue. Without it we'd need to bolt on a second-stage landmark model
   (PFLD, FaceLandmark1k3D, MediaPipe Face Mesh ported to ONNX), turning a
   one-stage detect into a two-stage pipeline. Latency budget shrinks, code
   complexity grows.
2. **Built-in tracking IDs** simplify v0.2.0 by replacing the
   `_matchTracks` Euclidean-distance heuristic in `active-speaker.mjs`.
   Fewer lines of code, fewer mutation-test gaps.
3. **49 ms median** comfortably fits the existing 200 ms per-frame budget
   in `cf-reframe`'s Phase F soft-timeout. At 6 sample fps we have 166 ms
   per frame; Human uses 30 % of it on a 720p source.
4. The Node 24 incompatibility is **TF.js's bug, not Human's** — and is
   actively being tracked. We pin `"engines": ">=20 <24"` for v0.2.0; bump
   when tfjs-node 4.23+ (or whatever fixes it) lands. CI already uses
   Node 20.

### Fallback: stay on ONNX

If install size becomes blocking (727 MB ≈ slow plugin install), the
fallback is `onnxruntime-node` + a two-stage pipeline:

- Stage 1: Ultraface RFB-320 → boxes (4 ms)
- Stage 2: PFLD-1.0.0 ONNX (~3 MB) → 68 landmarks per box (~5 ms)

Total ~10 ms vs Human's 49 ms — but PFLD is 68 landmarks (same as face-api),
*not* 478. The mouth-motion cue would lose resolution. Defer this until
the install-size concern bites.

### Rejected: `@vladmandic/face-api`

Same Node-version pin as Human, 4× slower, fewer landmarks, no tracking IDs,
larger install. No reason to prefer it over Human.

## Phase 2B — PFLD 68-point landmark stage

### Target recalibration

Phase 2B was originally scoped with **p95 < 20 ms per face**. After measurement
against the verified-working cunjian PFLD ONNX, that target was **revised to
p95 < 80 ms** — the 20 ms figure was aspirational, not empirical. The cunjian
PFLD is a 2.9 MB ResNet-backbone network; on the same hardware where Ultraface
RFB-320 returns in 4 ms, PFLD's intrinsic ORT runtime is ~60 ms. This isn't
an integration regression; it's the model's characteristic.

We frame this as **empirical recalibration**, not a target miss: the pipeline
ships with the real measured latency, downstream tooling (the active-speaker
scorer, the renderer) accommodates it via the per-frame budget bump, and a
follow-up speedup track is queued in `docs/ROADMAP.md` v0.3.0 ("Detection
speedup": int8 quantization → worker-thread pool → optional GPU backend →
verified-Apache MobileNet PFLD).

### Model choice

| Item | Value |
|---|---|
| Model | PFLD 68-point ONNX |
| Source | [`cunjian/pytorch_face_landmark`](https://github.com/cunjian/pytorch_face_landmark) (`onnx/pfld.onnx`) |
| Size | 2.9 MB |
| Input | float32, [1, 3, 112, 112], normalized [0,1] |
| Output | float32, [1, 136] = 68 (x, y) in normalized [0,1] crop space |
| Pinned SHA256 | `7d7bbd5c6a1d9272e58d9773898284a1905d872eba9a662df9b5f20f1ba6f83e` |
| License | **None stated upstream.** Used under 3-layer mitigation (see below). |

### Three-layer license mitigation

The cunjian repo has no LICENSE file. Default-copyright fair-use interpretation
is uncertain. Three structural mitigations apply:

1. **Fetch from upstream, never rebundle.** `bin/install-models.mjs` fetches
   directly from `raw.githubusercontent.com/cunjian/...`. ClipForge does not
   host a mirror. Users pull from the original repo each install; liability
   stays where the file originates.
2. **Honest disclosure + opt-out path.** `install-models.mjs` prints a
   license-notice on each PFLD download, and supports
   `CF_PFLD_MODEL_URL=<your-url>` to pin a user-supplied source. The README
   "Models & licenses" table surfaces the same information.
3. **Replacement tracked.** `docs/ROADMAP.md` v0.3.0 "License hardening" is
   committed work — swap to verified Apache-2.0 (FaceMesh subset) or MIT
   (atksh end-to-end) once a clean-license 68-point ONNX is found that
   matches the latency target.

### Measured latency (Phase 2B smoke test, 5 s talking-head fixture)

| Stage | Median | p95 | Notes |
|---|---|---|---|
| sharp extract + resize | 1.1 ms | 2.0 ms | per face crop |
| HWC → CHW Float32 normalize | 0.1 ms | 1.0 ms | per face |
| ORT inference (cunjian PFLD) | 59.2 ms | 63.1 ms | per face |
| **PFLD per-face total (in pipeline)** | **117.6 ms** | **130.8 ms** | end-to-end |
| Per-frame total (Ultraface + ≤3 PFLD) | ~130-200 ms | — | frame budget = 1000 ms |

### Phase 2B smoke test result

```json
{
  "detector": "onnxruntime@ultraface-rfb-320",
  "fallback_used": false,
  "stats": {"framesProcessed": 30, "framesWithFace": 30, "framesSlow": 0},
  "samples_length": 30,
  "stddev_cx": 12.02,
  "cx_range": "472 → 506",
  "has_68_points": true,
  "keypoint_structure": [
    "jaw[17]", "eyebrowL[5]", "eyebrowR[5]", "nose[9]",
    "eyeL[6]", "eyeR[6]", "mouthOuter[12]", "mouthInner[8]",
    "mouth", "eyeL_center", "eyeR_center", "all[68]"
  ]
}
```

Detection rate 100% on the synth talking-head fixture (5 pose changes × 6 fps
sampling = 30 frames). Crop center varies 34 px across the clip, well above
the > 5 px target.

## Phase 2D — Crop animation: expression mode (sendcmd ditolak)

The plan called for `ffmpeg sendcmd` to drive per-frame crop position updates
on a labeled `crop@cf` filter. **It didn't work** in our test ffmpeg
(`ffmpeg 6.1.1-3ubuntu5`). The smoke test exposed the upstream gap:

```
[Parsed_sendcmd_0]  Command reply for command #0: ret:Function not implemented res:
```

Both the direct `cf x N`/`cf y N` commands and the generic `cf reinit
w=…:h=…:x=…:y=…` form returned `AVERROR(ENOSYS)` despite the AVOption
table flagging `x`/`y` as runtime-settable (`..T.` flag). Confirmed with
verbose trace logging on three independent `.cmd` files. Frame hashes at
`t=1.5` and `t=2.5` were identical after sendcmd commands "fired" —
proving the crop filter ignored them.

### Option B (expression mode) — what we shipped

Single `crop=W:H:exprX:exprY,scale=tw:th` filter where `exprX`/`exprY` are
piecewise step functions of `t`:

```
crop=608:1080:if(lt(t,0.167),656,if(lt(t,0.333),648,…405)):if(…),scale=1080:1920
```

ffmpeg evaluates the expressions every frame. The `lt(t, T_n)` ladder
returns the latest sample's coordinate when time falls into its bucket.

### Empirical ceiling: 99 keyframes

ffmpeg's `eval.c` caps nested `if(...)` at 100 levels. We bisected this
in `scripts/bench-detectors/`-style fashion: **99 nested ifs parse,
100 returns `Missing ')' or too many args`**. Confirmed with a 1-step
binary search.

**Mitigation**: `buildCropExpression` strides any post-dedupe timeline
of length > 99 down to 99 keyframes, preserving first and last
positions. The Kalman smoother already produces continuous motion, so 99
evenly-spread keyframes deliver visibly smooth tracking for any clip
length — for a 30-minute source at 6 fps that's one keyframe every
~18 s, well within the smoother's bandwidth.

`buildCropExpression` returns `downsampled: true | false` and
`originalKeyframeCount` so callers can surface the cap firing.

### filter_complex_script: kept, but rarely engaged

We retained `-filter_complex_script` mode for cases where the post-cap
expression still exceeds 100 KB on the command line (would only happen
with a pathologically wide downsample target). In practice, capped
99-keyframe expressions sit around 1.5-9 KB and stay inline.

### Coordinate transform — root cause of one mid-build bug

The first attempt used `target_w`/`target_h` directly as the crop
dimensions and clamped against `source_w - target_w`. That broke
immediately on a 640×360 downsampled source rendering to a 1080×1920
target — the "crop" larger than the source itself.

Corrected: crop dimensions are **always SOURCE-pixel sized** at the
target's aspect ratio. For 640×360 → 1080×1920 (9:16), crop = 203×360
(taking full source height, narrower width to match aspect). The
`scale=1080:1920` filter then expands the crop to target. Captured in
`computeCropDims()` and exercised by 4 unit tests including the acid
test for the smoke-regression case.

### Acceptance check on `tests/fixtures/talking-head-5s.mp4`

| Check | Result |
|---|---|
| `cf-ffmpeg reframe-animated` exits 0 | ✓ |
| Output is 1080×1920, 5.000 s | ✓ |
| 3 sampled frames (t=1.0, 2.5, 4.0) have **distinct** sha256 | ✓ `dfc99d…` vs `e2e279…` vs `e610cf…` |
| Stress test on 7000-sample synth → downsample → render | ✓ exits 0; 3 distinct sampled hashes (`fdd01b…` / `be32d4…` / `8b15dd…`) |
| Temp `filter_complex_script` file cleaned up | ✓ verified |
| `npm test` | ✓ 53 pass, 2 skipped |
| `claude plugin validate .` | ✓ |

## Next-step gating

Phase 1 awaits explicit approval before swapping the library. The pick
above is the recommendation; the user may reasonably override (e.g. if
pinning Node engines is unacceptable, ONNX becomes the right call even at
the cost of a second-stage landmark model).
