# Roadmap

This file tracks the post-v0.1.2 work captured by the v0.1.1 self-audit
([docs/REVIEW.md](REVIEW.md)) plus follow-on polish. Versions follow
[SemVer](https://semver.org); 0.x means "we may break public surfaces
between minors".

## v0.2.0 — Real face-tracked reframe

**Theme:** make the headline feature actually work.

- **Swap detector library.** Replace `@mediapipe/tasks-vision` (browser-only)
  with a Node-native alternative. Candidate shortlist:
  - [`@vladmandic/human`](https://github.com/vladmandic/human) — TF.js backend,
    478-point landmarks, BlazeFace-class detector, active maintenance.
  - [`@vladmandic/face-api`](https://github.com/vladmandic/face-api) —
    lighter alternative, fewer features.
  - `onnxruntime-node` + a RetinaFace ONNX model — leanest install, lowest
    abstraction.

  Pick is gated on Node install size + first-detect latency benchmarks.

- **Animated crop in the renderer (fixes CR-2).** `bin/cf-ffmpeg` currently
  reads `samples[0]` only. Replace with an `ffmpeg sendcmd` timeline driving
  the `crop` filter, or a piecewise `if(lt(t, T_n), …)` expression for
  ≤ 60 keyframes. Either honours the full path the reframe pipeline produces.

- **Real-face success-path integration test (fixes CR-5).** Ship a
  CC0-licensed face fixture (5 s mp4 < 500 KB). Test asserts:
  - `out.detector === '<new-library>@<model>'` (not fallback)
  - `out.stats.framesWithFace / out.stats.framesProcessed > 0.8`
  - `stddev(samples.map(s => s.cx)) > 5` (crop actually moves)
  - `samples.length > 30` for a 5 s clip at 6 fps sampling

- **Benchmark + publish numbers.** Per-frame detect latency on a 1080p
  source, cross-platform (Linux + macOS). Surface in README.

## v0.2.x — Renderer + stability follow-ups

- **CR-3 mitigation:** drop the fictional sha256 in `install-models.mjs`
  (already gone in v0.1.2) or pin a real hash for the next model fetch.
- **W-1 backpressure:** add `pause()`/`resume()` flow control to
  `bin/lib/frame-extractor.mjs` so a slow consumer doesn't buffer the entire
  source.
- **Numerical-correctness tests (W-2):** mutation-style coverage on
  `clampVelocity`, `kalman1d`, `_audioScore`. Today these are exercised at
  control-flow level only.
- **Worker-thread offload:** move detection into a `worker_thread` so the
  200 ms per-frame budget becomes a hard cancel rather than a soft cooldown.

## v0.3.0 — Polish

- **Mutation test pass.** Stryker-style sweep over `bin/lib/*`. Surface a
  coverage delta in CI.
- **Speaker → face calibration as its own skill.** Today's `--speaker-map`
  is buried inside `cf-reframe`. Promote to `/clip-forge:reframe --calibrate`.
- **Real demo GIF.** vhs / asciinema recording of `/clip-forge:start --yolo`
  on the sample, replacing the v0.1.2 solid-colour placeholder.
- **Fix CLI ergonomics (W-4, W-5):** error on conflicting `--in` + positional,
  route debug-write errors to stderr unconditionally.
- **Node engines bump (W-3):** require `>=20.6` once anything starts using
  `import.meta.resolve` (after the library swap, the dependency may return).

## v0.4.0 — Real publishing

- TikTok OAuth flow (currently stubbed `auth_required`).
- Instagram Graph API + Reels container upload.
- YouTube Data API v3 resumable upload for Shorts.

OAuth is gated on each platform's developer-program approval, which is on
the maintainer to obtain; we ship the MCP stubs today so the wiring is
ready when credentials arrive.

## Tracking

Each item above maps to a GitHub issue once
[v0.1.2 ships](https://github.com/rdh073/clip-forge/releases). If something
isn't represented here and you'd like it considered, open a feature request
via [.github/ISSUE_TEMPLATE/feature_request.yml](../.github/ISSUE_TEMPLATE/feature_request.yml).
