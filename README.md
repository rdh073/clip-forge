# 🎬 ClipForge

[![ci](https://github.com/rdh073/clip-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/rdh073/clip-forge/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-43853d)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> Turn long videos into 10+ viral shorts — AI clip detection, auto-reframe, viral captions, render, schedule, publish. **All from your terminal.**

ClipForge is a [Claude Code](https://code.claude.com) plugin that gives video creators
the Opus Clip / Klap / Vizard / Submagic workflow without a browser. `cd` into a
folder, run `/clip-forge:start`, and a fleet of specialist agents takes a podcast,
sermon, lecture, or stream and ships you ten platform-ready 9:16 clips with burned-in
captions, B-roll, and a music bed — ready to publish to TikTok, Reels, Shorts, and X.

![demo](docs/screenshots/demo.gif)

---

## ✅ Status (v0.2.0)

**Face-tracked reframe is working** — Ultraface RFB-320 face detection
(`onnxruntime@ultraface-rfb-320`) followed by 68-point PFLD landmark
extraction, both pure-ONNX, no browser dependencies, no Node-version pin
ceiling. The v0.1.x MediaPipe gap is closed.

**Known characteristics:** PFLD inference is ~60 ms per face on CPU. A
30-minute source at 6 fps sampling processes in ~27 minutes end-to-end.
This is the local-CLI trade-off for not needing a cloud GPU or
subscription — see the [Performance](#performance) section. Speed-up track
in [docs/ROADMAP.md](docs/ROADMAP.md) (int8 quantization, worker threads,
optional GPU backend).

---

## Requirements

| Dependency      | Minimum | Notes                                                  |
|-----------------|---------|--------------------------------------------------------|
| Claude Code     | 2.1.128 | The CLI agent that hosts the plugin.                    |
| Node.js         | 20      | Used by every `bin/` script and the test runner.        |
| ffmpeg          | 6       | Required for ingest, reframe, render, music mix.        |
| yt-dlp          | latest  | Required for `/clip-forge:import` URL ingestion.        |

The SessionStart hook checks all four on every Claude Code boot and warns if
anything is missing.

## Install

> **Marketplace status:** ClipForge isn't on the official Claude Code marketplace yet.
> Until it's approved, install via `--plugin-dir` from a local checkout.

```bash
git clone https://github.com/rdh073/clip-forge
cd clip-forge
npm install                  # pulls @mediapipe/tasks-vision and friends
node bin/install-models.mjs  # ~230 KB BlazeFace short-range model
claude --plugin-dir .
```

Once the plugin lands on the marketplace, the install will simplify to:

```bash
/plugin marketplace add rdh073/clip-forge
/plugin install clip-forge
```

## Required env vars

Copy `.env.example` to `.env` and fill in the keys you have. ClipForge degrades
gracefully — if a key is missing, the related step falls back to a local
alternative (e.g. Whisper instead of Deepgram) or is skipped with a warning.

| Variable | Purpose | Required for |
|---|---|---|
| `DEEPGRAM_API_KEY` | Cloud transcription | `/clip-forge:transcribe` (falls back to local Whisper) |
| `ANTHROPIC_API_KEY` | Already set by Claude Code | clip-scout, caption-stylist |
| `PEXELS_API_KEY` | Stock B-roll | `/clip-forge:broll` |
| `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET` | TikTok upload | `/clip-forge:publish tiktok` |
| `YT_CLIENT_ID` + `YT_CLIENT_SECRET` | YouTube Shorts upload | `/clip-forge:publish youtube` |
| `IG_APP_ID` + `IG_APP_SECRET` | Instagram Reels upload | `/clip-forge:publish instagram` |

## Quickstart

```bash
cd ~/Videos/podcast-ep-42
claude
> /clip-forge:start
```

First run walks you through the onboarding wizard (platform, niche, brand kit,
caption style). Subsequent runs jump straight to import → clip → render.

Pass `--yolo` to skip every approval gate and ship 10 clips unattended:

```text
/clip-forge:start --yolo
```

---

## Skills

| Slash command | What it does |
|---|---|
| `/clip-forge:start`        | Orchestrates the whole pipeline; the only command you need |
| `/clip-forge:onboard`      | 4-step wizard: platform, niche, brand kit, caption style |
| `/clip-forge:import`       | Pull source from local file, YouTube/Vimeo, or Drive/Dropbox |
| `/clip-forge:transcribe`   | Word-timed transcript via Deepgram (or local Whisper) |
| `/clip-forge:clip`         | Calls clip-scout agent to pick up to 15 viral moments |
| `/clip-forge:reframe`      | 16:9 → 9:16 crop path (face tracking **deferred to v0.2.0**, center-crop today) |
| `/clip-forge:caption`      | Word-timed captions in your default style → `.ass` file |
| `/clip-forge:broll`        | Pexels stock cutaways matched to each sentence |
| `/clip-forge:music`        | Royalty-free music bed with auto-ducking under speech |
| `/clip-forge:render`       | Final 9:16 1080×1920 MP4 per clip (ffmpeg presets) |
| `/clip-forge:publish`      | Post to TikTok, Reels, Shorts, X |
| `/clip-forge:schedule`     | Queue posts for later; monitor drains the queue |
| `/clip-forge:analytics`    | Per-clip views, watch-time, retention report |

## Agents

- **clip-director** — lead producer; default agent set via `settings.json`
- **clip-scout** — viral-pattern recognition (hook, peak, completeness)
- **caption-stylist** — picks caption style per niche/platform/sentiment
- **reframe-engineer** — face-track vs object-track, pan-speed limits
- **publisher** — knows each platform's caption length, hashtag rules, posting times

## Architecture

```
    ┌────────────────────┐
    │   user terminal    │
    └──────────┬─────────┘
               │  /clip-forge:start
               ▼
    ┌────────────────────┐         ┌─────────────────────────┐
    │  clip-director     │◄────────┤ ~/.clip-forge/profile   │
    │     (agent)        │         └─────────────────────────┘
    └──┬───┬───┬───┬───┬─┘
       │   │   │   │   │
       ▼   ▼   ▼   ▼   ▼
   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
   │import│ │trans-│ │ clip │ │refrm │ │capt. │  …skills
   └──┬───┘ │cribe │ │scout │ │engr. │ │stylst│
      │     └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘
      ▼        ▼        ▼        ▼        ▼
   ┌─────────────────────────────────────────────┐
   │   .mcp.json: deepgram · pexels · tiktok ·   │
   │              youtube · instagram            │
   └─────────────────────────────────────────────┘
      │
      ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐
   │bin/cf-   │    │bin/cf-   │    │bin/cf-   │
   │ ytdlp    │    │ ffmpeg   │    │ reframe  │
   └──────────┘    └──────────┘    └──────────┘
      │
      ▼
   ┌──────────────────────────┐
   │ ./renders/<slug>/*.mp4   │
   └──────────────────────────┘
      │
      ▼  monitors/publish-queue drains on schedule
   ┌──────────────────────────┐
   │ TikTok · Reels · Shorts  │
   └──────────────────────────┘
```

## Reframe & active speaker

> **v0.1.2 reality check:** the MediaPipe path described below is **wired
> but disabled** in this release — see [Status](#-status-v012). Every
> invocation falls through to center-crop. The pipeline shape is preserved
> so v0.2.0 can drop in a Node-native detector with minimal churn. Sections
> below describe the *target* design.

`bin/cf-reframe` does the 16:9 → 9:16 cropping. Under the hood it pipes
downsampled RGB frames out of ffmpeg, runs MediaPipe **BlazeFace
short-range** for detection *[v0.2.0]*, applies a weighted active-speaker
scorer over four cues *[v0.2.0]* (audio, mouth motion, centrality,
confidence), and feeds the chosen face center into a Kalman smoother +
velocity clamp before writing the crop path.

### One-time setup

```bash
npm install                           # pulls @mediapipe/tasks-vision
node bin/install-models.mjs           # downloads BlazeFace short-range (~230 KB)
```

The model lands at `bin/models/face_detector.tflite` (gitignored). The
SessionStart hook warns if the file is missing.

### Common invocations

```bash
# Simplest — defaults pick the most-likely speaker per frame:
node bin/cf-reframe ./source.mp4 --output ./crop.json

# With a transcript for the audio cue (auto-calibrate speaker→face map):
node bin/cf-reframe ./source.mp4 --output ./crop.json \
  --transcript ./transcript.json --speaker-map auto

# Explicit map (left=speaker 0, right=speaker 1):
node bin/cf-reframe ./source.mp4 --output ./crop.json \
  --transcript ./transcript.json --speaker-map "0:left,1:right"

# Single speaker / no active-speaker logic — just track the most confident face:
node bin/cf-reframe ./source.mp4 --output ./crop.json --no-active-speaker

# Render at a different aspect:
node bin/cf-reframe ./source.mp4 --output ./crop.json --target-aspect 1:1

# Debug: dump a PPM frame every 30 detections with bbox + keypoint overlay:
node bin/cf-reframe ./source.mp4 --output ./crop.json --debug

# Stream NDJSON per-frame events to stdout (useful for monitors / dashboards):
node bin/cf-reframe ./source.mp4 --output ./crop.json --json-logs
```

### Score weights

The active-speaker scorer mixes four cues — `audio`, `mouth`, `central`,
`confidence` — using one of two weight profiles depending on whether you've
supplied a transcript + speaker map.

| Profile             | When                                                   | audio | mouth | central | confidence |
|---------------------|--------------------------------------------------------|-------|-------|---------|------------|
| **with audio cue**  | `--transcript <path>` AND `--speaker-map <spec>` set   | 0.30  | 0.50  | 0.10    | 0.10       |
| **without audio**   | transcript or speaker-map missing (default)            | 0.00  | 0.60  | 0.25    | 0.15       |

The "without audio" profile is hand-tuned — not just a naive renormalization
of the default. With no audio signal, mouth-motion alone is noisier, so
centrality and detector confidence get a bigger say.

Override with `--weights` (always 4 comma-separated floats, in the order
`audio,mouth,central,confidence`):

```bash
--weights 0.4,0.3,0.2,0.1
```

When you pass `--weights` without an audio cue, the audio component is
zeroed and the remaining three are renormalized so the total stays 1.

### Graceful degradation

| Condition                              | Behavior                                              |
|----------------------------------------|-------------------------------------------------------|
| `bin/models/face_detector.tflite` missing | Fall back to center-crop, record reason in metadata |
| `@mediapipe/tasks-vision` import fails  | Fall back to center-crop                              |
| Detector throws on a single frame       | Skip that frame, coast on last-known-good             |
| One frame takes >200ms                  | Soft skip the next 1–4 frames as cooldown             |
| <50% of frames yield a face             | Fall back to center-crop with `low_face_yield` reason |
| ffmpeg dies mid-stream                  | Use the frames we got; mark as partial extraction     |

In every case, `cf-reframe` exits 0 and writes a valid `crop_path.json` so
`bin/cf-ffmpeg render` never breaks.

### Troubleshooting

| Symptom                              | Fix                                                    |
|--------------------------------------|--------------------------------------------------------|
| `model_missing` in fallback_reason   | `node bin/install-models.mjs`                          |
| `mediapipe_import_failed`            | `npm install` in plugin root                           |
| `wasm_path_unresolved`               | Reinstall `@mediapipe/tasks-vision`                    |
| `low_face_yield` on a single-speaker video | Lower `--min-confidence` (default 0.5) or check lighting |
| Crop pans too aggressively           | Lower `--max-pan-px-s` (default 80)                    |
| Wrong speaker chosen                 | Pass `--speaker-map "0:left,1:right"` explicitly       |

## File layout in your project

```
your-project/
├── uploads/<slug>/source.mp4        # raw imports
├── uploads/<slug>/transcript.json   # word-timed
├── clips/<slug>/candidates.json     # clip-scout output
├── clips/<slug>/<clip-id>/
│   ├── crop_path.json               # reframe-engineer output
│   ├── captions.json + .ass         # caption-stylist output
│   ├── broll.json                   # cutaway timeline
│   └── edit.json                    # render manifest (triggers hook)
└── renders/<slug>/<clip-id>.mp4     # final 9:16 export
```

## Performance

Measured on a 5-second talking-head fixture (Linux, Node 20, Apple-Silicon-class CPU):

| Stage | Median | p95 |
|---|---|---|
| Ultraface detect | 9.5 ms | 21.8 ms |
| PFLD landmark (per face) | 117.6 ms | 130.8 ms |
| Per-frame total | ~130 ms | ~200 ms |

Projected processing time on real podcast / talking-head sources at default
6 fps sampling:

| Source length | Frames | Est. pipeline time |
|---|---|---|
| 5 min | 1,800 | ~5 min |
| 15 min | 5,400 | ~14 min |
| 30 min | 10,800 | ~27 min |
| 60 min | 21,600 | ~55 min |

**Honest framing**: this is **3-5× slower than cloud-GPU tools** like Opus
Clip or Klap. The trade-off is intentional — ClipForge runs entirely on
your machine, no API quotas, no subscriptions, no upload of source video.
The [v0.3.0 roadmap](docs/ROADMAP.md) tracks the speed-up path: int8
quantization, worker-thread parallelism, optional GPU execution provider.

## Models & licenses

| Model | Source | License | Notes |
|---|---|---|---|
| Ultraface RFB-320 (face detection) | [Linzaer/Ultra-Light-Fast-Generic-Face-Detector](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB) via `onnx/models` | MIT | Verified clean |
| PFLD 68-point (face landmarks) | [`cunjian/pytorch_face_landmark`](https://github.com/cunjian/pytorch_face_landmark) | **None stated** [^pfld-lic] | Replacement tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md) v0.3.0 |

[^pfld-lic]: The upstream PFLD model has no explicit LICENSE file. ClipForge
    fetches it directly from the upstream raw URL on every install (never
    rebundles), prints a license-notice during install, and supports a
    `CF_PFLD_MODEL_URL` env override to pin your own source. Replacement
    with a verified-Apache or verified-MIT 68-point ONNX is on the v0.3.0
    work plan. See `bin/install-models.mjs` header for the full mitigation
    layout.

## Engineering

- [docs/REVIEW.md](docs/REVIEW.md) — v0.1.1 critical self-audit.
- [docs/bench-v0.2.0.md](docs/bench-v0.2.0.md) — detector + landmark library
  benches and decisions.
- [docs/ROADMAP.md](docs/ROADMAP.md) — what's planned for v0.3.0+.
- [docs/blueprint.md](docs/blueprint.md) — original design notes.
- [CHANGELOG.md](CHANGELOG.md) — release-by-release detail.

## Development

```bash
git clone https://github.com/rdh073/clip-forge
cd clip-forge
npm install
node bin/install-models.mjs       # one-time BlazeFace model fetch
npm test                          # 22 tests, runs under ~1s
claude plugin validate .          # 0 errors, 0 warnings expected
claude --plugin-dir .             # boot Claude Code with this plugin loaded
```

Test fixtures for the real-detection paths aren't committed — drop your own
PNGs into `tests/fixtures/` and run `npm run build-fixtures` to enable the
two currently-skipped detector tests. See `tests/fixtures/README.md`.

## Roadmap

Things that are scoped but not yet shipped:

- Real OAuth flows for TikTok / YouTube Shorts / Instagram Reels publishing
  (MCP stubs are wired; auth is gated until API credentials are provisioned).
- Real face-fixture suite — committed PNG sources so the detector tests can
  run without bring-your-own-fixture setup.
- Worker-thread offload for MediaPipe so the per-frame 200 ms timeout becomes
  a hard cancel rather than a soft cooldown.
- Intro/outro stinger templates beyond the empty `templates/intros/` folder.

## License

MIT © 2026 [rdh073](https://github.com/rdh073) — see [LICENSE](LICENSE).
