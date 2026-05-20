# Changelog

All notable changes to ClipForge follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-05-20

### Added — Pillar C prompt-based clipping ("ClipAnything")

- `/clip-forge:clip --prompt "<topic>"` filters clip-scout candidates to
  on-topic spans, then re-ranks the filtered set by virality desc. IDs
  are reassigned `c01..` in the new sorted order.
- `/clip-forge:start --prompt "<topic>"` plumbs the flag through to the
  `Detect clips` step; under `--yolo` a zero-match aborts (does NOT
  silently fall back to no-prompt).
- New top-level `warning` block on `candidates.json` —
  `{ "code": "...", "message": "..." }`. Currently emitted codes:
  `"no_match"` (soft, prompt filtered everything; `fallback_used` stays
  `false`) and `"no_scout_backend"` (hard, dispatcher misconfigured).
  Schema is additive — v0.2.0 readers ignore the field.
- `bin/cf-clip` dispatcher script — auditable routing from the slash
  skill to either the real Agent backend (via `--emit-brief`) or a test
  mock (via `CF_CLIP_SCOUT_MOCK=<path>` env var). Exits 0 on every
  documented failure path; writes a valid `candidates.json` with
  `fallback_used` / `warning` so downstream skills never crash on
  missing artifacts.
- `tests/mocks/clip-scout-mock.mjs` — deterministic stand-in that honors
  the same I/O contract as `agents/clip-scout.md`. Reads brief on stdin,
  emits STRICT JSON on stdout, byte-identical given the same brief.
- `tests/fixtures/topic-transcript-60s.json` — committed 60 s
  synthesized transcript with three contiguous topic blocks (fitness,
  career, cooking) at ≈ 2 words/s. Deterministic mulberry32(20260520)
  seeded by `tests/fixtures/build-fixtures.mjs`.
- `tests/integration/clip-prompt.test.mjs` — 4 positive-evidence tests
  covering: no-prompt baseline spans all three topics, on-topic filter
  returns only matching candidates, zero-match honest empty, re-rank
  invariant inside filtered set. Runs green in CI with no
  `ANTHROPIC_API_KEY` set.

### Added — Pillar B audio enhance

- `/clip-forge:enhance` skill + `bin/cf-enhance` audio cleanup pipeline.
- Default CPU-first filter chain:
  `afftdn=nr=12:nf=-25` → optional `arnndn=m=bin/models/cb.rnnn` →
  adaptive `agate` → `dialoguenhance` → two-pass
  `loudnorm=I=-14:TP=-1.0:LRA=11`.
- Optional Demucs voice-isolation pre-pass via `--voice-isolate` or
  `--demucs`. Demucs is never required; missing or failed Demucs records a
  warning and continues from the original source.
- `enhanced.wav` and `enhance_report.json` output next to the source by
  default, with `integrated_loudness`, `true_peak`, `lra`, and
  `noise_reduction_db` metrics.
- `--edit-json <path>` patches render manifests with
  `"audio_source": "<enhanced.wav>"`; `bin/cf-ffmpeg render` now maps that
  audio source while preserving the original video stream.
- Graceful-degradation contract mirrors `cf-reframe`: documented failures
  exit 0 and write a valid JSON report with `fallback_used` and
  `fallback_reason`.
- RNNoise model installer support:
  `bin/install-models.mjs` fetches `GregorR/rnnoise-models`
  `conjoined-burgers-2018-08-28/cb.rnnn`, pins sha256
  `f1357c4e5be9dee8467bead486dfced2d75b640c26ad0b594fa7f102322371d9`,
  and supports `CF_RNNOISE_MODEL_URL` for caller-supplied model sources.

### Added — Filler-word & silence removal pipeline

- `/clip-forge:tighten` skill + `bin/cf-tighten` plan generator
- Locale-aware filler dictionaries (`en`, `id` v2 with two-tier
  always-cut vs context-only `context_fillers[]`)
- `--aggressive` mode: false-start detection (single repeat only, < 150 ms
  gap), context-filler cuts, confidence floor raised to 0.90,
  triple-or-more repeats kept as intentional emphasis
- `--dry-run`, `--json-logs`, `--keep-pause-ms`, `--min-confidence`,
  `--max-cut-ms`, `--silence-threshold-db`, `--min-silence-ms`,
  `--fillers <path>`, `--no-silence`, `--no-fillers`, `--locale en,id`
- Plan invariants I1–I5 with renderer enforcement (range bounds, sorted
  non-overlapping cuts, kept = complement(cuts), duration consistency,
  source/clip coordinate parity)
- Dual coordinate basis on every cut + kept segment (clip-relative
  `start_ms` / `end_ms` for renderer, source-absolute `source_start_ms`
  / `source_end_ms` for debug + cross-reference)
- Idempotency contract — same inputs produce byte-identical
  `tighten_plan.json` (stable key order, 2-space indent, trailing newline,
  no timestamps/PIDs/hostnames in plan)
- `warnings[]` array with structured `{code, message}` entries for soft
  issues (`no_confidence`, `locale_fallback`, `filler_punct_speech_act`,
  `triple_repeat_kept`, `context_filler_skipped_conservative`,
  `speaker_id_missing_multiword`)
- Punctuation-aware speech-act skip — filler matches followed by `?` or
  `!` are kept (interrogative/exclamatory, not filler)
- Stderr progress on long input seeks (`--start-ms > 0` AND seek > 5 s)

### Added — Splice renderer

- Two-pass render in `cf-ffmpeg`: audio splice encoded first, then
  video+mux with `-c:a copy` — fixes the AAC tail-truncation bug present
  in single-pass combined-encode mode (audio was losing ~160 ms when
  video EOFed slightly before audio)
- 8 ms `acrossfade` at each junction with `apad=pad_dur=(N-1)*0.008`
  silent-tail compensation to keep audio length sample-exact
- Junction quality telemetry (G1 sample-jump ratio with `kurtosis >= 3.0`
  outlier floor, G2 spectral flatness < 0.5 in 80 ms window, G3
  informational RMS spike). G3 status is `pass` or
  `informational_warning` — never fails the render
- `render_report.json` emitted next to every output mp4, schema-validated
  on every write against `schemas/render_report.v1.json`. Includes per-pass
  wall-clock, full per-junction telemetry, plan-warning passthrough, and
  render-level warnings
- `CF_RENDER_DETERMINISTIC=1` env var forces CPU encoder + bitexact +
  single-threaded x264 (`sliced-threads=0:threads=1`) for byte-identical
  per-stream MD5 across re-renders
- Mode-aware A/V drift convention — `render_mode: "splice"` accepts
  baseline negative drift (audio sample-exact, video frame-quantized at
  source fps); `render_mode: "passthrough"` requires tight bilateral
  drift. Warning codes: `av_drift_audio_overhang_excessive` (splice,
  < −50 ms), `av_drift_video_longer_in_splice` (splice, > +50 ms),
  `av_drift_unexpected_passthrough` (passthrough, |drift| > 10 ms)
- Skill ordering validator — `edit.json` carrying `cuts` AND any of
  `broll` / `transitions` / `music` exits non-zero with
  `render: skill ordering violation — tighten plan present after
  broll/transitions bake. Re-run tighten before broll/transitions.`
- Filter graph length warning at > 8 KB (`filter_graph_length_near_limit`)
- Zero-byte output guard exits non-zero and leaves no stub on disk
- NDJSON progress events emit per pass with `{event:"progress",pass,pct}`

### Added — Test infrastructure

- `tests/fixtures/jfk-speech-10s.{mp4,transcript.json,LICENSE.md}` —
  public-domain real-speech fixture (JFK 1961 inaugural address,
  17 USC §105; muxed from whisper.cpp `samples/jfk.wav`)
- `tests/fixtures/stress-plan-n50.json` — committed N=50 stress plan
  (mulberry32 seeded for byte-determinism)
- `tests/integration/tail-duration.test.mjs` (3 tests — 1 s, 5 s, 30 s)
- `tests/integration/tighten-render.test.mjs` (9 tests — R4a, R4d, R4e,
  R4f, R5, R6, ADD-1, ADD-3, ADD-4)
- `tests/integration/tighten-reasr.test.mjs` (R4c — Whisper re-ASR via
  `CF_WHISPER_URL`, skips cleanly on fresh checkouts)
- `tests/integration/tighten-stress.test.mjs` (Phase C — N=50 stress,
  ratio ≤ 2× baseline, schema valid, deterministic MD5 stable)
- `schemas/render_report.v1.json` — JSON Schema draft-07 contract
- `bin/lib/junction-analyzer.mjs` (pure FFT + sample-jump + kurtosis
  primitives, no external deps)
- `bin/lib/render-report.mjs` (hand-rolled JSON Schema validator subset
  to avoid an ajv runtime dep)
- `bin/lib/tighten-splice.mjs` (invariant assertions + splice graph
  builder exposing separate video/audio chains for the two-pass renderer)

### Performance

- 30 s source + 5 cuts: 5.0 s default · 9.3 s deterministic (≈ 6× / 3× realtime)
- 60 s source + 50 cuts: 8.0 s default — counterintuitively *faster* than
  the no-cut baseline of the same source (less audio + video to encode
  per pass)
- Two-pass cost: audio splice ~10 % of total time; video+mux dominates

### Known limitations (Phase C surfaces)

- `skipped_smooth_no_click` G1 status surfaces naturally on tonal content
  (sine waves, very clean speech) — kurtosis correctly identifies no
  outlier signature, gate skips. Documented in
  `skills/tighten/SKILL.md` "G1 status enum"
- At N ≥ 30 cuts on 30 fps source, video frame-grid accumulation can push
  `av_drift_ms` above +50 (audio remains splice-exact). Tracked in
  `docs/ROADMAP.md` v0.3.1 "Tighten splice known characteristics"
- `filter_complex` bytes scales linearly with N; warns at > 8 KB. Falls
  well under ffmpeg's effective limits through at least N = 50. amix
  fallback path documented in `docs/ROADMAP.md` v0.3.1 for future N > ~150

### Added (carried)

- Optional GPU acceleration with CPU fallback:
  `CF_FFMPEG_ENCODER=gpu` tries FFmpeg `h264_nvenc` before `libx264`, and
  `CF_ORT_PROVIDER=gpu|cuda|coreml|dml` tries the requested ONNX Runtime
  provider before CPU. README now documents the Ubuntu 24.04 CUDA/cuDNN
  runtime packages required for ONNX CUDA.

## [0.2.0] - 2026-05-19

This section will become **v0.2.0** when the `bench/v0.2.0` branch lands.

### Added

- **Ultraface RFB-320 face detection** (`onnxruntime@ultraface-rfb-320`)
  via `onnxruntime-node`. Replaces the v0.1.x browser-only `@mediapipe/tasks-vision`
  integration. No Node engine ceiling.
- **PFLD 68-point landmark stage** (`onnx@pfld-68`). Per-face mesh:
  jaw[17] · eyebrowL[5] · eyebrowR[5] · nose[9] · eyeL[6] · eyeR[6] ·
  mouthOuter[12] · mouthInner[8] + `mouth`/`eyeL_center`/`eyeR_center` centroid
  aliases for active-speaker compat. Sourced from `cunjian/pytorch_face_landmark`
  upstream (license caveat tracked in `docs/ROADMAP.md` v0.3.0).
- **`FaceTracker` module** — pure-logic IoU-based identity tracker. ~90 lines,
  deterministic, 8 unit tests. Replaces the v0.1.x Euclidean centroid heuristic
  in `active-speaker._matchTracks`.
- **Animated crop in `cf-ffmpeg`** via a piecewise `crop=W:H:exprX:exprY` ladder.
  Builder in `bin/lib/crop-expression-builder.mjs` (`computeCropDims`,
  `buildCropExpression`, `buildFilterArg`, `buildFilterScript`, `chooseRenderMode`,
  `escapeFilterArg`) — 20 unit tests. `cf-ffmpeg reframe-animated` subcommand
  for standalone crop testing.
- **Success-path integration test** (`tests/integration/success-path.test.mjs`)
  asserts positive evidence of face-tracked output:
    - detector === `onnxruntime@ultraface-rfb-320` (not fallback)
    - framesWithFace / framesProcessed > 0.8
    - 68 landmarks per face, mouth_y stddev > 1 px
    - tracker_flips / duration_s ≤ 1.0
    - rendered mp4 has 3 distinct frame hashes at t=1.0/2.5/4.0 (CR-2 guard)
- **`tests/fixtures/talking-head-5s.mp4`** — 188 KB CGI synth fixture used by
  the success-path test.
- **`docs/screenshots/v0.2.0-proof-t2.5s.png`** — visual proof frame.
- New diagnostic fields in `crop_path.json`: `landmark_detector`,
  `stats.trackerFlips`, `stats.samplesWithKeypoints`, `stats.totalLandmarksPerFace`,
  `stats.mouthYStddev`.

### Fixed

- **CR-1:** Browser-only MediaPipe replaced with Node-native ONNX stack
  (`onnxruntime-node` + `sharp`). The v0.1.x silent fallback path is gone.
- **CR-2:** `bin/cf-ffmpeg` now consumes the full `samples[]` timeline via the
  piecewise crop expression. v0.1.x collapsed everything to `samples[0]`.
  Original Phase 2D spec called for `ffmpeg sendcmd` — empirical test against
  `ffmpeg 6.1.1-3ubuntu5` showed the `crop` filter returns `AVERROR(ENOSYS)`
  for both `x`/`y` and generic `reinit` commands (upstream gap, not packaging).
  Pivoted to expression mode; bisected ffmpeg's nested-if ceiling at exactly
  99 levels; mitigated with stride-downsampling. See `docs/bench-v0.2.0.md`
  Phase 2D for the trace logs and bisection record.
- **CR-5:** Real-fixture success-path test prevents silent fallback regression.
  Run `npm test` before any release; the test class fails on any of: fallback
  detector, missing keypoints, static crop, or identical sample frames.

### Changed

- `package.json` deps: `@mediapipe/tasks-vision` removed; `onnxruntime-node`
  and `sharp` added. Engines: `node >=20` (no upper bound — onnxruntime
  supports 24+).
- `bin/install-models.mjs` downloads two ONNX models (~4 MB total) instead of
  the v0.1.x BlazeFace .tflite. Supports `CF_PFLD_MODEL_URL` env override.
- `bin/cf-reframe` defaults to `detector: 'onnxruntime@ultraface-rfb-320'`
  (was `mediapipe@blazeface-short`).
- Per-frame budget bumped to 1000 ms when the landmarker is active (was
  200 ms for face-only v0.1.x).

### Performance

Measured on Linux x86_64, Node 20.20, CPU only:

- Ultraface detect: **p50 9.5 ms / p95 21.8 ms** per frame
- PFLD landmarks: **p50 59 ms / p95 63 ms** per face (ORT-only)
- End-to-end per-face in pipeline: **p50 117 ms / p95 131 ms**
- Projected: **30-minute source processes in ~27 minutes** at 6 fps sampling

Speed-up tracked in `docs/ROADMAP.md` v0.3.0 — int8 quantization, worker-thread
pool, optional GPU execution provider.

### Removed

- v0.1.2 "⚠ Status" README section (MediaPipe doesn't work in Node) — the
  underlying issue is fixed. Historical note retained in this CHANGELOG.
- `bin/wasm/` directory (briefly added mid-v0.2.0 development for a MediaPipe
  vendoring attempt that was abandoned when we swapped to ONNX). `.gitignore`
  entry retained.

## [0.1.2] - 2026-05-19

### Fixed

- **CR-4:** version drift across `plugin.json`, `package.json`,
  `marketplace.json`, and git tags. New `scripts/bump-version.mjs`
  enforces single-source-of-truth bumping with working-tree-clean,
  `npm test`, `claude plugin validate .`, and CI-status guards.
- **CR-3:** dropped the fictional sha256 check in `bin/install-models.mjs`
  that printed a misleading "mismatch" warning on every install.

### Documented

- **README ⚠ Status (v0.1.2) section** discloses that face-tracked reframe
  does not function in Node — `@mediapipe/tasks-vision` is browser-only.
  Every `cf-reframe` invocation falls through to static center-crop. This
  was technically true in v0.1.0 and v0.1.1; the README + CHANGELOG misled.
- `bin/lib/face-detector.mjs` now hard-disables detector init with reason
  `mediapipe_not_supported_in_node`, surfaced in
  `crop_path.json.fallback_reason`.
- New `docs/ROADMAP.md` tracks v0.2.0 (library swap, animated crop, real
  success-path test), v0.2.x stability, v0.3.0 polish, v0.4.0 OAuth.
- `docs/REVIEW.md` self-audit (from v0.1.1) linked from README §Engineering.
- Integration tests rewritten to assert the *real* behaviour: every
  invocation lands in fallback with `mediapipe_not_supported_in_node` in
  `fallback_reason`. Reality-aligned, not aspirational.
- `CONTRIBUTING.md` documents the new release process: `npm run bump <kind>`.

### Not fixed in this patch

- **CR-1, CR-2, CR-5** require a library swap and renderer rewrite — out of
  scope for a 0.0.x patch. See `docs/ROADMAP.md` v0.2.0.

## [0.1.1] - 2026-05-20

### Added

- Code of Conduct (Contributor Covenant v2.1).
- `CONTRIBUTING.md` with setup, conventional-commits requirement, PR
  checklist, and triage policy.
- `SECURITY.md` reporting flow via GitHub Security Advisories.
- Issue forms — `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml`
  — and `.github/PULL_REQUEST_TEMPLATE.md`.

### Notes

- No code changes. Functionally identical to v0.1.0.
- Raises GitHub Community Standards score from 42 % to ≥ 90 %, unblocking
  community-marketplace submission.

## [0.1.0] - 2026-05-20

### Added — face-tracked reframe (`bin/cf-reframe` v2)

- Real MediaPipe BlazeFace short-range integration replacing the v0.1.0
  center-crop placeholder. Detection runs at 6 fps by default with all six
  BlazeFace keypoints (eyes, nose, mouth, ears) plumbed through.
- Active-speaker selection (`bin/lib/active-speaker.mjs`) — weighted score
  over four cues: audio (speaker→face mapping), mouth movement (rolling
  10-frame delta), centrality, detector confidence. Switching damper
  prevents target flips faster than 0.8 s + 24 frames.
- Speaker→face calibration: `--speaker-map auto|named|numeric` plus an
  `autoCalibrateSpeakerMap()` that takes a transcript + 5 s lead-in and
  picks the median face position per `speaker_id`.
- `bin/install-models.mjs` — idempotent BlazeFace model downloader with
  size check + sha256 warn.
- `bin/lib/frame-extractor.mjs` — async iterator over an ffmpeg rgb24 pipe
  with AbortSignal cancellation support and source-coord up-projection
  metadata.
- `bin/lib/debug-frame.mjs` — zero-dep PPM writer that overlays the chosen
  bbox + keypoints, emitted by `--debug` every 30 frames.
- New CLI flags on `cf-reframe`: positional source, `--output`, `--sample-fps`,
  `--target-aspect`, `--min-confidence`, `--weights`, `--no-active-speaker`,
  `--fallback center|topcrop`, `--speaker-map`, `--transcript`, `--debug`,
  `--json-logs`, `--help`. The v0.1.0 `--in / --out / --start-ms / --end-ms`
  surface remains valid for backwards compatibility.
- Robustness layer: detector init wrapped in try/catch with graceful
  degradation, per-frame 200 ms soft budget with skip-next cooldown,
  >50 % no-face yield → center-crop fallback, partial extraction handling
  on mid-stream ffmpeg errors. Exit code 0 in every failure mode.
- `crop_path.json` bumped to `version: 2`. New fields: `detector`, `stats`,
  `speaker_map`. The v1 sample shape (`samples[].cx/cy/scale/letterbox`)
  is preserved so `bin/cf-ffmpeg render` consumes both versions unchanged.
- Test suite (`npm test`) — 22 passing + 2 skipped: `parseSpeakerMap`
  variants, switching damper hold/release, auto-calibration median picking,
  deterministic scoring, detector idempotency, integration tests that
  generate a 5 s testsrc video and validate schema + fallback path. CI
  matrix now includes macOS in addition to Ubuntu.
- Docs: README "Reframe & active speaker" section, blueprint defaults entry,
  `tests/fixtures/README.md` for the bring-your-own-PNG fixture flow.

### Added — initial public scaffold

- Manifest, settings, README with architecture diagram.
- Entry skill `/clip-forge:start` orchestrating the full pipeline.
- Onboarding wizard `/clip-forge:onboard` writing `~/.clip-forge/profile.json`.
- Workflow skills: `import`, `transcribe`, `clip`, `reframe`, `caption`,
  `broll`, `music`, `render`, `publish`, `schedule`, `analytics`.
- Five specialist agents: `clip-director` (default), `clip-scout`,
  `caption-stylist`, `reframe-engineer`, `publisher`.
- MCP servers: Pexels (real), Deepgram (community), TikTok / YouTube /
  Instagram (stubbed pending OAuth).
- bin/ helpers: `cf-ytdlp`, `cf-ffmpeg`, `cf-reframe`, `cf-caption-burn`,
  `cf-whisper` (offline fallback), plus hook/monitor scripts.
- Hooks: SessionStart preflight, PostToolUse hints on new uploads and edit
  manifest changes.
- Monitors: `render-queue`, `publish-queue`, `new-uploads`.
- Caption templates: Beast, Submagic-Pop, Karaoke, Neon, Gradient.
- Thumbnail Remotion composition.
- CI: `claude plugin validate` + JSON / JS / sh syntax checks on every PR.
- LICENSE (MIT), placeholder demo GIF, marketplace.json snippet.

### Known limitations

- TikTok / YouTube / Instagram MCP servers return `auth_required` until
  the OAuth flows are wired (a separate engineering slice, deferred until
  API credentials are provisioned).
- `bin/cf-reframe`'s 200 ms per-frame budget is a soft limit. MediaPipe's
  `detectForVideo` is synchronous; pure-JS code cannot hard-interrupt a
  sync call without worker threads. The cooldown-skip strategy keeps slow
  frames from cascading but a single frame can still block briefly.
- No intro stingers ship by default; users provide their own.
