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

## Release process

Maintainers cut releases via:

```bash
npm run bump <patch|minor|major>     # 0.1.1 → 0.1.2 / 0.2.0 / 1.0.0
# or pin an explicit version:
npm run bump 0.1.5
```

This single command:

1. **Refuses** if the working tree is dirty, `npm test` fails,
   `claude plugin validate .` fails, or CI on the current commit is not
   green (when `gh` + a remote are available).
2. Updates the `version` field in `.claude-plugin/plugin.json`,
   `package.json`, and `marketplace.json` — all in lockstep, so CR-4
   (version drift) can't recur.
3. Moves the **`[Unreleased]`** entries in `CHANGELOG.md` into a new
   `[<version>] - <today>` section.
4. Creates the bump commit (`chore: bump version to X.Y.Z`) and an
   annotated git tag (`vX.Y.Z`) whose body is the changelog section.

Nothing is pushed — the script prints the exact next step:

```text
git push origin master vX.Y.Z
```

After pushing, create the GitHub Release from the new tag (pre-release
flag for any 0.x build).

## License

By submitting a contribution you agree it ships under the project's
[MIT License](LICENSE).
