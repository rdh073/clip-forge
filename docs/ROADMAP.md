# Roadmap

This file tracks the post-v0.1.x work captured by the v0.1.1 self-audit
([docs/REVIEW.md](REVIEW.md)) plus follow-on polish. Versions follow
[SemVer](https://semver.org); 0.x means "we may break public surfaces
between minors".

## ✅ Shipped in v0.2.0 — Real face-tracked reframe

- **Detector library swap.** `@mediapipe/tasks-vision` (browser-only) →
  `onnxruntime-node` + Ultraface RFB-320. Node-version-agnostic, no engine
  ceiling. Bench data: [docs/bench-v0.2.0.md](bench-v0.2.0.md).
- **PFLD 68-point landmark stage.** Two-stage pipeline: Ultraface bbox →
  PFLD per-face → structured 68-point keypoint object (jaw / eyebrowL /
  eyebrowR / nose / eyeL / eyeR / mouthOuter / mouthInner + centroid
  aliases for active-speaker compat).
- **Renderer (cf-ffmpeg)** still reads `samples[0]` — the animated-crop
  rewrite (was CR-2) moves to v0.2.1 below.

## ✅ Shipped in v0.2.0 (continued) — Animated crop (CR-2)

- **Crop animation via piecewise crop expression.** `bin/cf-ffmpeg`
  consumes the full `samples[]` timeline through
  `bin/lib/crop-expression-builder.mjs`. ffmpeg's `sendcmd` did not work on
  the `crop` filter in our test build — confirmed `Function not implemented`
  upstream gap. See `docs/bench-v0.2.0.md` Phase 2D for the diagnostic.
- **99-keyframe cap with stride-downsample.** ffmpeg's expression parser
  hard-stops at 100 nested `if(...)`. We strip to 99 first/last-preserving.
  Note this in v0.3.0 to revisit when upstream sendcmd lands or the eval
  cap is raised.
- **IoU tracker module (Phase 2C).** Identity tracking moved from
  `active-speaker.mjs._matchTracks` into `bin/lib/face-tracker.mjs`. Pure
  IoU > 0.3 matching, deterministic.

## v0.2.1 — Success-path integration tests

- **Real-face success-path test (CR-5).** Wire the talking-head fixture
  + Ultraface + PFLD chain under `tests/integration/` with explicit
  assertions:
    - `out.detector === 'onnxruntime@ultraface-rfb-320'` (not fallback)
    - `out.stats.framesWithFace / out.stats.framesProcessed > 0.8`
    - 68-point keypoints populated on every face
    - `stddev(samples.map(s => s.cx)) > 5` (crop moves)
- **Merge `bench/v0.2.0` → `master`, tag `v0.2.0`.** Pre-release flag OFF
  this time (v0.2.0 ships a working feature, not a disclosure patch).

## v0.3.0 — License hardening + detection speed-up

### Output-quality: Pillar B shipped

- **Audio enhance (`/clip-forge:enhance`).** `bin/cf-enhance` now writes a
  normalized enhanced WAV plus `enhance_report.json` using `afftdn`,
  optional `arnndn` with pinned `cb.rnnn`, adaptive `agate`,
  `dialoguenhance`, and two-pass `loudnorm` to -14 LUFS / -1.0 dBTP.
- **Render handoff.** `edit.json.audio_source` lets `bin/cf-ffmpeg render`
  use the enhanced WAV for audio while keeping the original source for video.
  Missing RNNoise/Demucs paths degrade gracefully and record the reason in
  the report.

### Crop animation polish

- **Revisit `ffmpeg sendcmd` on the crop filter.** Track upstream
  (https://trac.ffmpeg.org/). When `process_command` lands for `crop`,
  swap the expression ladder for a sendcmd timeline — smaller
  command-lines, smoother (sendcmd interpolates), and the 99-keyframe
  cap goes away.
- **`between(t, a, b)` masked-sum alternative.** If sendcmd never lands,
  benchmark a flat `X_0*between(t,0,T_1) + X_1*between(t,T_1,T_2) + …`
  expression against the nested-if ladder — flat sums may bypass the
  100-level nesting cap.

### Detection speedup

- **int8 quantize the PFLD model.** Offline via
  `onnxruntime.quantization.quantize_dynamic`. Target: halve inference
  latency (~30 ms / face vs current 60 ms). Risk: accuracy drop on small
  mouth/eye keypoints — measure NME on a held-out set before adopting.
- **Worker-thread pool.** Move PFLD inference into a `worker_thread` pool
  (2-4 workers). Parallelize per-face landmarking. Hardens the per-frame
  budget into a real hard-cancel.
- **Benchmark optional GPU execution providers.** `CF_ORT_PROVIDER=gpu|cuda|coreml|dml`
  now attempts the requested ONNX Runtime provider and falls back to CPU.
  Next step: measure whether CUDA/CoreML beats CPU on the small Ultraface/PFLD
  models enough to recommend it by default.
- **MobileNet-class PFLD when verified-Apache lands.** Smaller model in the
  300-500 KB range with ~10 ms inference. Tracked alongside the license
  swap below.

### License hardening

- **Replace cunjian PFLD with a verified-license alternative.** Candidates
  to bench in `docs/bench-v0.3.0.md`:
  - MediaPipe FaceMesh Apache-2.0 ONNX export (verify a stable URL with
    license inheritance documented)
  - atksh/onnx-facial-lmk-detector MIT 106-point — subset to 68 effective
  - Own export from polarisZhao/PFLD-pytorch's MIT-licensed training code
- **Tracker issue:**
  [License hardening: replace cunjian PFLD model](https://github.com/rdh073/clip-forge/issues)
  (label: `license-debt`, `v0.3.0`).

### Stability + polish carry-over from v0.1.1 review

- **W-1 backpressure:** add `pause()`/`resume()` flow control to
  `bin/lib/frame-extractor.mjs` so a slow consumer doesn't buffer the
  entire source.
- **Numerical-correctness tests (W-2):** mutation-style coverage on
  `clampVelocity`, `kalman1d`, `_audioScore`. Today these are exercised at
  control-flow level only.
- **Speaker → face calibration as its own skill.** Today's `--speaker-map`
  is buried inside `cf-reframe`. Promote to `/clip-forge:reframe --calibrate`.
- **Real demo GIF.** vhs / asciinema recording of `/clip-forge:start --yolo`
  on the sample, replacing the v0.1.2 solid-colour placeholder.
- **Fix CLI ergonomics (W-4, W-5):** error on conflicting `--in` +
  positional source, route debug-write errors to stderr unconditionally.

## v0.3.1 — Tighten splice known characteristics

Tracked from Phase C (N=50) stress measurements landed alongside the
v0.3.0 filler/silence removal pillar. Each item is observable today via
the `av_drift_*` or `filter_graph_length_near_limit` warnings in
`render_report.json`. None block ship; revisit if/when production
telemetry shows them on real footage.

- **High-N video frame-grid drift.** At 50 cuts on a 30 fps source, the
  rendered video runs ~158 ms longer than audio (audio is splice-exact at
  48 kHz; video accumulates ~0.1 frame of quantization at each cut
  boundary). Surfaces as `av_drift_video_longer_in_splice` warning when
  drift > 50 ms. Functional impact is negligible at typical N (≤ 10);
  becomes a several-frame tail-pad at N ≥ 30. Two known mitigations if
  the warning gets noisy:
  - Round each cut's `start_ms` / `end_ms` down to the source-fps frame
    grid (changes invariants — would need plan-schema rework).
  - Crop the video tail to match audio in the muxer (Option B from the
    original A/V sync design; we rejected it for low-N where dropping a
    final frame mid-syllable is worse than a few ms of silence pad).
- **filter_graph_length_near_limit at high N.** At N = 50 the
  `filter_complex` string is ~9 KB — just above the 8 KB warn threshold,
  well under ffmpeg's effective ~64 KB hard limit on modern builds. No
  action needed; warning is preventive telemetry. If a future plan hits
  a hard limit, the fallback would be `amix=inputs=N`-based audio
  reconstruction instead of chained `acrossfade`, plus
  `concat=n=N:v=1:a=0` already used for video. Decision threshold based
  on measurement: trigger the amix fallback only when actual graph
  approaches ~32 KB (still leaves headroom).
- **Performance scaling at high N is non-monotonic.** Phase C measured
  the N = 50 stress render as ~0.81× the wall-clock of a single-cut
  baseline on the same 60 s source — counterintuitively *faster* because
  cuts reduce the total samples each pass has to process. Don't bake any
  perf-regression assertion around N alone; future regression tests
  should hold N constant and vary content / cut layout.

## v0.4.0 — Real publishing

- TikTok OAuth flow (currently stubbed `auth_required`).
- Instagram Graph API + Reels container upload.
- YouTube Data API v3 resumable upload for Shorts.

OAuth is gated on each platform's developer-program approval, which is on
the maintainer to obtain; we ship the MCP stubs today so the wiring is
ready when credentials arrive.

## Tracking

Each item above maps to a GitHub issue once the corresponding release is
cut. If something isn't represented here and you'd like it considered,
open a feature request via
[`.github/ISSUE_TEMPLATE/feature_request.yml`](../.github/ISSUE_TEMPLATE/feature_request.yml).
