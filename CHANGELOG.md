# Changelog

All notable changes to ClipForge follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  >50% no-face yield → center-crop fallback, partial extraction handling
  on mid-stream ffmpeg errors. Exit code 0 in every failure mode.
- `crop_path.json` bumped to `version: 2`. New fields: `detector`, `stats`,
  `speaker_map`. The v1 sample shape (`samples[].cx/cy/scale/letterbox`)
  is preserved so `bin/cf-ffmpeg render` consumes both versions unchanged.
- Test suite (`npm test`) — 18 passing + 2 skipped: parseSpeakerMap variants,
  switching damper hold/release, auto-calibration median picking,
  deterministic scoring, detector idempotency, integration tests that
  generate a 5 s testsrc video and validate schema + fallback path. CI
  matrix now includes macOS in addition to Ubuntu.
- Docs: README "Reframe & active speaker" section, blueprint defaults entry,
  `tests/fixtures/README.md` for the bring-your-own-PNG fixture flow.

### Added

- Initial public scaffold of the ClipForge Claude Code plugin.
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
- CI: `claude plugin validate` + JSON/JS/sh syntax checks on every PR.

### Known limitations

- TikTok / YouTube / Instagram MCP servers return `auth_required` until
  the OAuth flows are wired (a separate engineering slice, deferred until
  API credentials are provisioned).
- `bin/cf-reframe`'s 200 ms per-frame budget is a soft limit. MediaPipe's
  `detectForVideo` is synchronous; pure-JS code cannot hard-interrupt a
  sync call without worker threads. The cooldown-skip strategy keeps slow
  frames from cascading but a single frame can still block briefly.
- No intro stingers ship by default; users provide their own.

## [0.1.0] - 2026-05-20

Initial development tag.
