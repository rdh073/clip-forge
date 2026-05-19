# Changelog

All notable changes to ClipForge follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
