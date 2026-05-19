# Contributing to ClipForge

Thanks for your interest! ClipForge is a [Claude Code](https://code.claude.com)
plugin and any improvement — bug fix, doc edit, new skill, new MCP integration —
is welcome.

## Quick setup

```bash
git clone https://github.com/rdh073/clip-forge
cd clip-forge
npm install
npm run install-models
npm test
```

You'll need Node ≥ 20, ffmpeg ≥ 6, and yt-dlp on PATH. See [README.md →
Requirements](README.md#requirements).

## Running locally

```bash
claude --plugin-dir .
# inside Claude Code:
/reload-plugins
/clip-forge:start
```

## Before opening a PR

- Use **[Conventional Commits](https://www.conventionalcommits.org)**:
  `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `ci:`.
- `npm test` and `claude plugin validate .` must pass.
- Update `CHANGELOG.md` under the **`[Unreleased]`** section.
- Update docs (README, CHANGELOG, blueprint) if behaviour changed.
- Keep PRs **small and focused** — one concern per commit, one topic per PR.
- Add tests for new behaviour, especially in `bin/lib/`.

## What we look for

- Small, focused PRs over sweeping rewrites.
- Cross-platform safety (macOS + Linux + WSL2 covered by CI).
- Graceful degradation — every external dep (API key, model file, system
  binary) should have a sensible fallback or a clear warning path.
- Sensible logging — NDJSON for monitors, status markers for skills.

## Triage

- We aim to acknowledge issues within **7 days**.
- Common labels: `bug`, `enhancement`, `good-first-issue`, `needs-repro`,
  `triage`, `wontfix`.
- If your bug report doesn't include `npm` + `ffmpeg` + `node` versions and
  a reproduction case, expect a `needs-repro` label and a request for more
  detail.

## Questions, ideas, polls

Open a [GitHub Discussion](https://github.com/rdh073/clip-forge/discussions)
instead of an issue. Issues are for bugs and concrete feature requests
with a clear definition of done.

## License

By submitting a contribution you agree it ships under the project's
[MIT License](LICENSE).
