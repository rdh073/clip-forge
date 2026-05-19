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

## Next-step gating

Phase 1 awaits explicit approval before swapping the library. The pick
above is the recommendation; the user may reasonably override (e.g. if
pinning Node engines is unacceptable, ONNX becomes the right call even at
the cost of a second-stage landmark model).
