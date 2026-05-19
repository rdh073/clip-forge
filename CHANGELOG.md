# Changelog

All notable changes to ClipForge follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- `bin/cf-reframe` ships with a center-crop fallback path; the real
  MediaPipe face-tracking path is gated behind installing
  `@mediapipe/tasks-vision` plus the landmarker model.
- No intro stingers ship by default; users provide their own.

## [0.1.0] - 2026-05-20

Initial development tag.
