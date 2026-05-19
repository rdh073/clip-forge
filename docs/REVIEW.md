# Code review — clip-forge v0.1.1

Date: 2026-05-20 · Reviewer: self (skeptical mode)

## TL;DR

**5 critical, 6 warnings, 5 nits, 6 strengths.**

The plugin **ships in a non-functional state for its headline feature**.
Face-tracked reframe is broken end-to-end through two independent critical
bugs (CR-1 detector init, CR-2 renderer static crop). Tests pass because
neither bug is in the path the test suite exercises. The supporting
scaffolding (graceful degradation, fallback paths, CLI, CI, packaging) is
solid and ship-quality, but the **central value proposition does not run**.

> **Honest grade: B-.** Without CR-1 and CR-2, this would be a clean B+
> on scaffold quality. The "shipped feature doesn't actually work" gap
> is the dominant factor.

| Area         | Grade | One-liner                                              |
|--------------|-------|--------------------------------------------------------|
| Architecture | B+    | Clean module boundaries; the cf-reframe→cf-ffmpeg contract is broken (CR-2). |
| Robustness   | A-    | Every fallback exits 0 with reason; **success path is never exercised**. |
| Testing      | C+    | Happy-path + fallback-path covered; success path of face detection has 0 % coverage. |
| Docs         | A-    | Comprehensive README + troubleshooting; doesn't surface the cf-ffmpeg `samples[0]`-only limitation. |
| Security     | A     | spawn arrays only, no shell exec, env-only secrets.    |
| Ergonomics   | B     | CLI surface is friendly; `--debug` + `--json-logs` interaction is wrong. |
| Performance  | C     | No flow control between ffmpeg pipe and consumer; only tested on 5 s clips. |

---

## Critical (must fix before v1.0)

### CR-1: MediaPipe detector never initializes — face detection is 100 % broken

- **Files:** `bin/lib/face-detector.mjs:46-58`
- **Detail:** `import.meta.resolve('@mediapipe/tasks-vision/package.json')` throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED` because the package's `exports` map doesn't
  declare `./package.json`. Every invocation marks the detector `_disabled`
  with reason `wasm_path_unresolved`. **`cf-reframe` then always falls
  through to center-crop**, regardless of model presence, video content, or
  flags. None of the 22 passing tests catches this: the integration test
  uses `testsrc` (no faces → fallback regardless) and the fixture tests are
  marked SKIP when the `.rgb` files are absent (always, in CI).
- **Reproduction:**
  ```
  node bin/install-models.mjs
  node bin/cf-reframe samples/demo-5s.mp4 --output /tmp/c.json
  # → fallback_used: true, reason: "wasm_path_unresolved: ..."
  ```
- **Proposed fix:** Stop trying to discover the wasm dir via
  `import.meta.resolve('@mediapipe/tasks-vision/package.json')`. Use the
  package's exported subpath instead:
  ```js
  // wasm files ship under the package's wasm subpath
  const pkgWasm = await import.meta.resolve('@mediapipe/tasks-vision/wasm/vision_wasm_internal.js');
  const wasmDir = new URL('.', pkgWasm).href;
  ```
  Or hard-code the relative location: `node_modules/@mediapipe/tasks-vision/wasm`.
- **Test to prevent regression:** Add a smoke test that asserts
  `isDetectorReady()` is `true` after `initDetector()` when the model is
  present. Currently no test does this — the only init test passes a
  bogus path on purpose, asserting the *failure* mode.

### CR-2: cf-ffmpeg renderer only honours `samples[0]` — Kalman / velocity / active-speaker work is wasted

- **Files:** `bin/cf-ffmpeg:122-132` (`buildCropExpr`)
- **Detail:** The renderer reads `samples[0].cx/cy/scale` and emits a static
  `crop=W:H:X:Y` filter. The 180-keyframe path produced for a 30 s video at
  6 fps sampling is collapsed to one position for the entire output clip.
  Comment at line 125 candidly notes: *"For the scaffold: just take the
  first sample's center as a static crop."* This is a **silent breakage of
  the v0.1.0 → v0.1.1 storytelling**: the README, CHANGELOG, and release
  notes claim "face-tracked reframe" — what ships is "face-*positioned*".
- **Reproduction:**
  ```
  grep -A3 buildCropExpr bin/cf-ffmpeg
  ```
- **Proposed fix:** Generate a `sendcmd` script per keyframe and pass via
  `ffmpeg -filter_complex` with `sendcmd=f=<script>` driving the `crop`
  filter, or compile an `if(...)` ladder expression. Either of those
  actually animates the crop using all samples.
- **Test to prevent regression:** Integration test that compares a real
  face video against expected crop trajectory — assert that
  `samples.length > 1` AND that the output frames at t=0 vs t=N have
  different center pixels.

### CR-3: install-models.mjs hash check is fictional

- **Files:** `bin/install-models.mjs:14-22`
- **Detail:** The hardcoded sha256 `1f6bb7a1f1f019b6f86feaa6ce15b27f1ddc2db6ff03f3b0d4d7a8c0826d8d1e`
  was invented during scaffolding. The actual BlazeFace short-range float16
  model's sha256 is `b4578f35940b...`. The "warning" message fires on every
  install, so the user is conditioned to ignore it. The check provides
  **zero integrity value** and actively reduces signal.
- **Reproduction:**
  ```
  rm -rf bin/models && node bin/install-models.mjs 2>&1 | grep sha256
  # → ⚠ sha256 mismatch for face_detector.tflite (got b4578f35940b... expected 1f6bb7a1f1f0...) — continuing anyway
  ```
- **Proposed fix:** Either (a) compute the real hash once and pin it, or
  (b) delete the hash check entirely with a comment that we trust the
  Google CDN's HTTPS. Half-measures invite ignored warnings.
- **Test to prevent regression:** If we keep the check, add a fixture that
  asserts the real model matches the pinned hash. If the hash drifts, CI
  fails — that's the *point*.

### CR-4: Version drift — v0.1.1 tag pushed but plugin.json + package.json still say "0.1.0"

- **Files:** `.claude-plugin/plugin.json:4`, `package.json:3`
- **Detail:** We tagged + released `v0.1.1` but neither the plugin manifest
  nor `package.json` got bumped. `claude plugin list` will continue showing
  "0.1.0" for users who clone v0.1.1. Discovery breaks: someone reading
  the plugin manifest sees one version, the GitHub release page another.
- **Reproduction:**
  ```
  jq .version .claude-plugin/plugin.json package.json
  # → "0.1.0"
  # → "0.1.0"
  git tag -l
  # → v0.1.0
  # → v0.1.1
  ```
- **Proposed fix:** Bump both files in the same commit as the
  community-health files. Add a `release.mjs` script (or a `.github/workflows/`
  step) that asserts `package.json.version === git describe --tags --abbrev=0`
  on every CI run — fail the job on drift.
- **Test to prevent regression:** CI step (one-liner) that fails when the
  manifest version disagrees with the tag.

### CR-5: Success path of face detection has 0 % test coverage

- **Files:** `bin/lib/face-detector.test.mjs:46-69`, `tests/integration/reframe.test.mjs:54-93`
- **Detail:** Every detector-related test is one of: (a) initDetector with a
  bogus path → asserts the *failure* mode; (b) detectFaces with detector
  not ready → asserts `[]`; (c) the two real-detection tests skip when
  fixture PNGs are missing (always, in CI). The integration suite uses
  `testsrc` which generates a colour-bars pattern with zero faces, so it
  walks the **fallback** path even when MediaPipe works. **Conclusion:**
  if I had typed `return []` at the top of `detectFaces()`, no test would
  fail. This is why CR-1 was hidden for the whole development cycle.
- **Proposed fix:** Ship at least one face fixture. CC0-licensed face photos
  are findable in seconds (e.g. NASA imagery of astronauts, or
  Wikimedia Commons under "Face"). Generating one programmatically via
  ffmpeg `lavfi`+`drawtext` doesn't trip MediaPipe — confirmed in scaffold.
- **Test to prevent regression:** Mandatory integration test that runs
  cf-reframe against a committed face fixture and asserts `fallback_used: false`.

---

## Warnings (should fix in v0.2)

### W-1: Frame extractor has no flow control — unbounded memory on slow consumers

- **Files:** `bin/lib/frame-extractor.mjs:74-92`
- **Detail:** The extractor pushes every frame into a `queue` array.
  `proc.stdout.on('data', ...)` buffers regardless of how fast the
  consumer reads. With MediaPipe at ~50 ms/frame and ffmpeg at >300 fps
  on a 720p source, the queue can grow to thousands of frames on a long
  video. Each frame is ~700 KB at 640×360 RGB. On a 30-minute podcast at
  6 sample fps = 10 800 frames = 7.5 GB peak.
- **Fix:** `proc.stdout.pause()` when `queue.length > 4`; `resume()` when
  it drains. Or use a Readable stream with `highWaterMark`.

### W-2: Numerical correctness of clampVelocity / kalman1d / _audioScore has no test

- **Files:** `bin/cf-reframe:114-130`, `bin/lib/active-speaker.mjs:194-204`
- **Detail:** Mutation test simulation — change `>` to `>=` in clampVelocity,
  change `q=1e-3` to `q=1e-2` in kalman1d, change `1 - d/0.4` to `1 - d/0.5`
  in _audioScore. **None** of those mutations would fail a current test.
  Tests verify control flow ("does it call the function") not behaviour
  ("does the function produce the right number").
- **Fix:** Add unit tests on known-good fixtures (e.g. feed a sinusoid into
  kalman1d, assert smoothness; feed a 200 px/s overshoot into clampVelocity,
  assert the clamp).

### W-3: face-detector uses `import.meta.resolve` (Node 20.6+) but engines says >=20

- **Files:** `bin/lib/face-detector.mjs:52`, `package.json:9`
- **Detail:** `import.meta.resolve()` became stable in Node 20.6.0. Users on
  20.0–20.5 hit a runtime error. The engines field permits those versions.
- **Fix:** Either bump engines to `>=20.6` or implement a fallback resolver.
  Since CR-1 already requires changing this code, fold the fix in.

### W-4: cf-reframe accepts both `--in <p>` and positional `<p>` silently — should error on conflict

- **Files:** `bin/cf-reframe:48-72`
- **Detail:** `else if (!a.startsWith('--') && !out.in) out.in = a;` silently
  drops the positional when `--in` is also given. User intent is ambiguous;
  current behaviour is "first one wins by parse order". An explicit error
  message would catch typos.
- **Fix:** Track which source set `out.in`; if both fire, die with "pass
  source as positional OR --in, not both."

### W-5: `--debug` write failures are silenced unless `--json-logs` is also on

- **Files:** `bin/cf-reframe:312-318`
- **Detail:** Debug PPM write failures go through `jlog()`, which only emits
  when `--json-logs` is set. A user troubleshooting why no debug frames are
  appearing has no path to see the actual error.
- **Fix:** Route debug-write errors to stderr unconditionally; `jlog()` is
  for *normal* progress events.

### W-6: `low_face_yield` threshold (0.5) is hard-coded and untested

- **Files:** `bin/cf-reframe:342`
- **Detail:** The choice of 50 % is a tuning parameter dressed as a constant.
  No flag, no doc, no test asserting the boundary. A clip where exactly
  half of frames have a face triggers fallback — surprising for users.
- **Fix:** Make `--min-face-yield 0.5` a CLI flag with the current value
  as default; add a unit test that asserts the exact boundary.

---

## Nits (style, micro-optimizations)

### N-1: Imports at the bottom of frame-extractor.mjs

- **Files:** `bin/lib/frame-extractor.mjs:154`
- **Detail:** `import { spawnSync } from 'node:child_process'` sits **below**
  the `probe()` function that uses it. ES modules hoist, so it works, but
  it reads like a left-behind merge artefact. Move to the top.

### N-2: `--weights a,m,c,k` mnemonic is misleading

- **Files:** `bin/cf-reframe:108`, `README.md` Score weights section
- **Detail:** "K" for confidence is unusual. Spec inherited it; consider
  renaming the documented mnemonic to `a,m,c,c` (with a clarifying note)
  or just spelling out `audio,mouth,central,confidence` in --help.

### N-3: `--debug` output is PPM — viewers won't open it

- **Files:** `bin/lib/debug-frame.mjs`, README troubleshooting
- **Detail:** Most graphical viewers can't open PPM. ffmpeg-as-converter is
  required: `ffmpeg -i debug/frame-00030.ppm out.png`. Surface this in
  the README so users don't think the debug feature is broken.

### N-4: install-models.mjs writes "downloading..." to stderr and JSON event to stdout

- **Files:** `bin/install-models.mjs:46, 76`
- **Detail:** Mixed channels. Some users pipe stderr to /dev/null and miss
  the progress line. Or pipe stdout to jq and break on the human-readable
  bit. Pick one.

### N-5: SECURITY.md `7-day acknowledgement / 30-day fix` is a single-maintainer promise

- **Files:** `SECURITY.md:21-23`
- **Detail:** Not a bug per se, but the SLA is aggressive for a hobby
  project. Soft to "*we aim for* 7 days; if maintainer capacity is constrained,
  expect 30." Avoids over-promising at the legal/optics level.

---

## Strengths (validate what's good so we don't regress it)

### S-1: Graceful degradation contract holds

Every fallback path I forced — detector unavailable, model missing,
low_face_yield, mid-stream extractor failure, no transcript, no
speaker map — exits 0 and writes a valid `crop_path.json` consumable
by `cf-ffmpeg`. The `fallback_reason` field documents *why* we fell
back. This is genuinely good plumbing and the most-tested part of the
codebase. **Don't regress it.**

### S-2: Active-speaker logic is well-factored

`ActiveSpeakerTracker` keeps identity tracking, switching damper, and
weighted scoring cleanly separated. Switching damper holds correctly
under the unit test (`tracker: switching damper holds chosen target for
≥0.8s`). `parseSpeakerMap` handles three input forms with explicit tests
for each. If we fix CR-1, this layer is ready.

### S-3: No shell exec anywhere

Every subprocess (ffmpeg, ffprobe, yt-dlp, whisper-cli) is invoked via
`spawn(name, [args])` with array arguments. Zero shell interpolation.
Path injection / shell quoting bugs are structurally impossible.

### S-4: Cross-platform hygiene is correct

- Shebangs: `#!/usr/bin/env node` and `#!/bin/sh` — portable across
  Linux, macOS, WSL2.
- Exec bits committed: `100755` for executable scripts, `100644` for
  library imports. Survives a fresh clone.
- JSON files lint clean on both ubuntu-latest and macos-latest in CI.

### S-5: CI matrix is real, not theatre

The workflow installs ffmpeg per-OS and runs `npm test`, not just lint.
Both platforms surfaced the same green status on the same commit. Catches
real platform divergence (e.g. ffmpeg version differences).

### S-6: Documentation is comprehensive

README has Requirements, Install, Development, Reframe deep-dive, Score
weights table, Graceful-degradation matrix, Troubleshooting matrix, and
Roadmap. CHANGELOG follows Keep a Changelog. CONTRIBUTING gates on
conventional commits + tests + plugin validate. The doc layer is the
project's clearest strength.

---

## Verification commands run

All commands run from `/home/xtrzy/playground/plugins/clip-forge` on the
v0.1.1 tip (commit `d747283`) with `node v24.13.1` and `ffmpeg 6.x`.

```bash
# CR-1: confirm import.meta.resolve fails on the package.json subpath
node -e "import.meta.resolve('@mediapipe/tasks-vision/package.json')"
# → ERR_PACKAGE_PATH_NOT_EXPORTED

# Confirm detector is always disabled end-to-end
node bin/install-models.mjs
node bin/cf-reframe samples/demo-5s.mp4 --output /tmp/c.json --sample-fps 4
jq '{fallback_used, fallback_reason, "stats?": (.stats // null)}' /tmp/c.json
# → fallback_used: true, fallback_reason: "detector_unavailable: wasm_path_unresolved: ..."

# CR-2: confirm cf-ffmpeg's static-crop strategy
grep -B1 -A8 buildCropExpr bin/cf-ffmpeg
# → "For the scaffold: just take the first sample's center as a static crop."

# CR-3: confirm sha256 in install-models.mjs is fictional
rm -rf bin/models && node bin/install-models.mjs 2>&1 | grep sha256
# → ⚠ sha256 mismatch ... got b4578f35940b… expected 1f6bb7a1f1f0… — continuing anyway

# CR-4: confirm version drift
jq .version .claude-plugin/plugin.json package.json
git tag -l | tail -2
# → "0.1.0", "0.1.0" ; tags include v0.1.1

# CR-5: confirm tests do not exercise the success path
grep -l "isDetectorReady.*true\|fallback_used.*false" bin/lib/*.test.mjs tests/**/*.test.mjs
# → (no matches)

# W-1: confirm extractor has no flow control
grep -E "pause|resume|highWaterMark|backpressure" bin/lib/frame-extractor.mjs
# → (no matches)

# RSS sanity on a 30s clip (exited early due to CR-1)
ffmpeg -y -f lavfi -i testsrc=duration=30:size=1280x720:rate=30 -c:v libx264 -preset ultrafast /tmp/30s.mp4
node bin/cf-reframe /tmp/30s.mp4 --output /tmp/30s.json --sample-fps 6 &
# RSS ~49 MB at t=1s, process exited at t<2s due to detector_unavailable
# Without CR-1, this measurement is invalid for steady-state RSS.

# Cross-platform exec bits
git ls-files --stage bin/ | awk '$1 != "100755" && $4 ~ /^bin\/cf-|install-models/' 
# → (no rows printed = every executable has +x)
```

## Aftermath: marketplace-readiness

ClipForge v0.1.1 should **not** be submitted to the official plugins
marketplace in its current state. The headline feature does not run.
Suggested release order:

1. **v0.1.2 (immediate, blocking marketplace):** fix CR-1 (wasm path
   resolution) and CR-4 (version drift). Add S-5 success-path test.
   Once detection works, the rest of the pipeline can be measured for
   real.
2. **v0.2.0 (blocking "production" claim):** fix CR-2 (renderer should
   honour all samples via sendcmd) and CR-3 (drop or pin the hash check).
   Address W-1 backpressure once steady-state RSS is measurable.
3. **v0.3.0:** ship face fixtures, address W-2 numerical correctness,
   bump engines per W-3, fix CLI ergonomics per W-4 / W-5 / W-6.

---

*Reviewer's note:* The scaffolding work in v0.1.0 + v0.1.1 was carried out
honestly and the failure modes are well-documented. The two critical bugs
slipped through because the test design verified "the pipe doesn't break"
rather than "the pipe carries data correctly". That's a fixable habit;
the structural choices (Kalman-untouched, schema-versioned, fallback-first)
remain sound and will pay off once CR-1 and CR-2 land.
