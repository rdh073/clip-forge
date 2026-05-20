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

**Face-tracked reframe is working end-to-end** — Ultraface RFB-320 face
detection (`onnxruntime@ultraface-rfb-320`) → PFLD 68-point landmarks →
IoU tracker → Kalman smoother → **animated crop** at render time. The
v0.1.x MediaPipe gap is closed; the v0.1.x renderer's "static crop from
samples[0] only" (CR-2) is fixed via a piecewise crop expression that
honours the full timeline.

### Output-quality parity vs OpusClip

Tracked from the v0.3.0 gap analysis ([docs/PLAN-v0.3.0.md](docs/PLAN-v0.3.0.md)).
Each row is one of the five output-quality pillars OpusClip ships that
ClipForge is closing.

| Feature                              | ClipForge | OpusClip |
|--------------------------------------|-----------|----------|
| Face-tracked reframe (9:16 / 1:1)    | ✅        | ✅       |
| Karaoke captions w/ emoji highlight  | ✅        | ✅       |
| **Filler-word & pause removal**      | **✅**    | ✅       |
| Speech enhance (loudnorm + denoise)  | ✅        | ✅       |
| Brand vocabulary (custom dictionary) | ✅        | ✅       |
| **Prompt-based clipping**            | **✅**    | ✅       |
| **Hook overlay + progress bar**      | **✅**    | ✅       |
| **Voice cloning (hook / outro / dub)** | **✅**  | ✅       |
| **Multi-language dub**               | **✅**    | partial  |
| **Brand kit / custom assets**        | **✅**    | ✅       |
| **Partial re-render (cf-edit)**      | **✅**    | ✅       |
| **Prompt-driven editing**            | **✅**    | ✅       |
| **AI B-roll fallback**               | **✅**    | ✅       |
| **Avatar stingers**                  | **✅**    | ✅       |
| **Speaker-aware reframe (split-screen)** | **✅**    | ✅       |

Pillar (a) Filler-word & pause removal landed as `/clip-forge:tighten` —
locale-aware filler dicts (en + id), silence detection, plan invariants,
two-pass splice renderer with 8 ms acrossfade, schema-validated render
report telemetry. See [skills/tighten/SKILL.md](skills/tighten/SKILL.md).

Pillar (b) Speech enhance landed as `/clip-forge:enhance` — CPU-first
`afftdn` denoise, optional RNNoise `arnndn`, adaptive `agate`,
`dialoguenhance`, and two-pass `loudnorm` to -14 LUFS / -1.0 dBTP. It writes
`enhanced.wav` plus `enhance_report.json`, then can patch `edit.json` with
`audio_source` so render uses the cleaned WAV without touching the video.

Pillar (c) Prompt-based clipping landed as `/clip-forge:clip --prompt
"<topic>"` — clip-scout does a two-pass selection (filter to on-topic
candidates, then re-rank the filtered set by virality desc). Zero matches
return an "honest empty" `candidates: []` plus a structured `warning`
block rather than silently falling back to virality-sort. See
[skills/clip/SKILL.md](skills/clip/SKILL.md) and
[agents/clip-scout.md](agents/clip-scout.md).

Pillar (e) Brand vocabulary landed as `--vocab ~/.clip-forge/vocab.json` on
`bin/cf-whisper` (and a Deepgram `keywords[]` passthrough in
`skills/transcribe/SKILL.md`). Per-user `vocab.json` carries a list of
brand / product / proper-noun terms; transcripts run a case-restore
post-pass so "clipforge", "Clip-Forge", or "Clipforge!" all canonicalise
to the casing in `vocab.json`. Hallucination-guarded — a silent input
stays silent. See [skills/transcribe/SKILL.md](skills/transcribe/SKILL.md).

v0.4.0 Pillar 2 — Multi-language dub + voice clone landed as
`/clip-forge:voice-clone` and `/clip-forge:dub`. Voice clone uploads a
30-second sample from `source.mp4` to the configured TTS provider
(ElevenLabs → Cartesia → Groq PlayAI → Piper local) and saves the
returned `voice_id` in `voices.json` (per-project `./uploads/<slug>/`
wins over global `~/.clip-forge/`). Dub translates the transcript and
synthesizes timeline-aligned WAVs per target language, emits
`dubbed-<lang>.wav` + `dub_report-<lang>.json` + per-language
`edit.dub-<lang>.json` variants ready for render. Every paid call is
budget-tracked in `render_manifest.json.ai_costs` against
`CF_AI_BUDGET_USD` (default $10 — 80 % checkpoint, 100 % hard-stop).
edit.json gains optional `prepend_audio` / `append_audio` fields so the
render skill can mux a hook/outro stinger via the same TTS abstraction
without re-writing `audio_source`. See
[skills/voice-clone/SKILL.md](skills/voice-clone/SKILL.md) and
[skills/dub/SKILL.md](skills/dub/SKILL.md).

## Brand Kit (v0.4.0 pillar 3)

Register a logo, endcard, and lower-third overlay once, burn them into
every clip. Two scopes — global at `~/.clip-forge/brand-kit.json` and
per-project at `./uploads/<slug>/brand-kit.json` (project wins entirely
over global, mirrors `voices.json`).

One-screen tutorial:

```bash
# 1. Register a logo (PNG ≤ 2 MB) — defaults to bottom-right, 70% opacity, 96 px wide.
${CLAUDE_PLUGIN_ROOT}/bin/cf-brand-kit add \
  --asset logo --path /abs/path/logo.png \
  --position bottom-right --opacity 0.7 --scale-px 96 \
  --global

# 2. Add an endcard (PNG or MP4 ≤ 3 s, ≤ 3 MB for MP4 / ≤ 2 MB for PNG).
${CLAUDE_PLUGIN_ROOT}/bin/cf-brand-kit add \
  --asset endcard --path /abs/path/endcard.mp4 --duration-ms 3000 --global

# 3. Add a lower-third banner (PNG with alpha, time-gated).
${CLAUDE_PLUGIN_ROOT}/bin/cf-brand-kit add \
  --asset lower_third --path /abs/path/lt.png \
  --position bottom-left --show-from-ms 1500 --show-until-ms 4000 --global

# 4. Inspect the active kit.
${CLAUDE_PLUGIN_ROOT}/bin/cf-brand-kit list --global

# 5. Render — brand kit applies automatically. No edit.json changes needed.
${CLAUDE_PLUGIN_ROOT}/bin/cf-ffmpeg render --manifest ./clips/<slug>/<clip-id>/edit.json
```

`edit.json` accepts three brand-kit shapes (precedence order):

```jsonc
{ "brand_kit": { "version": 1, ... } }                 // 1. inline (highest)
{ "watermark": { "brand_kit_ref": "/abs/path.json" } } // 2. reference
{ "watermark": "/abs/path/logo.png" }                  // 3. legacy string (still works)
```

When none of the above is set, the per-project / global brand-kit.json
loads automatically. Missing assets degrade gracefully — `brand_asset_missing:<key>`
warning surfaces in `render_report.json.brand_kit.warnings`, and the
render proceeds with whatever IS available. SVG assets fall back when
ffmpeg lacks librsvg (`librsvg_not_available` warning).

See [skills/brand-kit/SKILL.md](skills/brand-kit/SKILL.md).

## Partial re-render + prompt-driven editing (v0.4.0 pillar 4)

`/clip-forge:edit` adds a content-hash diff against `./renders/<slug>/render_manifest.json`
so only the clips whose inputs changed (edit.json, crop_path, captions.ass,
cuts_plan, audio_source, brand_kit) are re-rendered. Hash mismatch → stale;
matching hashes → skip. Two modes:

```bash
# Diff mode — re-render only changed clips (default)
${CLAUDE_PLUGIN_ROOT}/bin/cf-edit --slug podcast-ep-42

# Dry-run — print the stale set without rendering
${CLAUDE_PLUGIN_ROOT}/bin/cf-edit --slug podcast-ep-42 --dry-run

# Force a full re-render of one clip
${CLAUDE_PLUGIN_ROOT}/bin/cf-edit --slug podcast-ep-42 --only c03 --force

# Prompt mode — LLM emits an RFC 6902 patch against edit.json
${CLAUDE_PLUGIN_ROOT}/bin/cf-edit --slug podcast-ep-42 \
  --prompt "change hook text to 'NEW INTRO' and progress bar to red"
```

Prompt mode uses Groq Llama 3.3 70B by default (~$0.001/edit). Set
`ANTHROPIC_API_KEY` and `CF_LLM_PROVIDER=anthropic` to force Claude Haiku
4.5 fallback. With no LLM keys, diff mode still works — prompt mode exits
gracefully with `fallback_reason: "no_llm_provider"`.

Three-layer validation on every patch: (1) JSON Schema
(`schemas/edit-patch.v1.json`), (2) whitelisted JSON Pointer paths only
(`/hook_overlay/*`, `/progress_bar/*`, `/target_aspect`, `/brand_kit`,
`/watermark`, `/cuts` — `/audio_source` and `/crop_path` are FORBIDDEN),
(3) auto dry-run preview before apply. One retry on validation failure
then manual fallback.

The manifest write is atomic (write-then-rename with fsync). Pillar 2's
`ai_costs` block is preserved byte-for-byte across cf-edit rewrites —
new breakdown keys (`groq_llm`, `anthropic_llm`, `anthropic_translate`)
are additive.

See [skills/edit/SKILL.md](skills/edit/SKILL.md).

## Anthropic translate fallback (v0.4.0 pillar 4)

`/clip-forge:dub` translate path completes the Anthropic adapter that was
stubbed in pillar 2. Provider precedence:

```
CF_TRANSLATE_PROVIDER=<name>  → explicit override (groq | anthropic)
GROQ_API_KEY      set         → Groq Llama 3.3 70B  (~$0.0001/clip)
ANTHROPIC_API_KEY set         → Claude Haiku 4.5    (~$0.001/clip)
neither                        → fallback_reason: no_translate_provider
```

Per-word `start_ms` / `end_ms` timing is preserved via `reattachTiming()`
across both providers. Live test coverage gates behind
`CF_TRANSLATE_REAL_E2E=1` + the relevant API key.

Pillar (i) Hook overlay + progress bar + emoji caption burn + aspect
profiles + VTT/SRT sidecars closes the *visual* parity gap with OpusClip.
`edit.json` now carries optional `hook_overlay`, `progress_bar`, and
`target_aspect` fields; the renderer composes a separate ASS layer for
the hook (libass + system-fallback fonts), a 20-step `drawbox` chain for
the progress bar, and remaps the output canvas to 1080×1920 / 1080×1080
/ 1080×1350 for `9:16` / `1:1` / `4:5` respectively. `cf-caption-burn`
now honors `lines[].emoji` and `lines[].words[].highlight` from
`captions.json` (previously ignored). Every render emits `<output>.vtt`
+ `<output>.srt` next to the MP4 when captions are present. See
[skills/render/SKILL.md](skills/render/SKILL.md) and
[skills/caption/SKILL.md](skills/caption/SKILL.md).

**Known characteristics:**
- PFLD inference is ~60 ms per face on CPU. A 30-minute source at 6 fps
  sampling processes in ~27 minutes end-to-end. See [Performance](#performance).
- The crop expression caps at 99 keyframes (ffmpeg's nested-if ceiling);
  longer timelines are stride-downsampled with first/last preservation.
  Kalman smoothing keeps the motion continuous; on a 30-minute source that's
  one crop update every ~18 s, well within face-tracking bandwidth.
  ffmpeg's `sendcmd` on the `crop` filter would let us bypass the cap but is
  not implemented upstream — see [docs/bench-v0.2.0.md](docs/bench-v0.2.0.md)
  Phase 2D, tracked for v0.3.0.

---

## Requirements

| Dependency      | Minimum | Notes                                                  |
|-----------------|---------|--------------------------------------------------------|
| Claude Code     | 2.1.128 | The CLI agent that hosts the plugin.                    |
| Node.js         | 20      | Used by every `bin/` script and the test runner.        |
| ffmpeg          | 6       | Required for ingest, enhance, reframe, render, music mix. |
| yt-dlp          | latest  | Required for `/clip-forge:import` URL ingestion.        |

The SessionStart hook checks all four on every Claude Code boot and warns if
anything is missing.

## Optional GPU Acceleration

ClipForge stays CPU-first by default. To opt into GPU paths with CPU fallback:

```bash
CF_FFMPEG_ENCODER=gpu ./bin/cf-ffmpeg render --manifest ./path/to/edit.json
CF_ORT_PROVIDER=gpu ./bin/cf-reframe ./uploads/demo/source.mp4 --output ./crop_path.json
```

- `CF_FFMPEG_ENCODER=gpu` uses FFmpeg `h264_nvenc` and retries with `libx264`
  if NVENC is unavailable or rejects the job.
- `CF_ORT_PROVIDER=gpu` maps to ONNX Runtime `cuda` and retries session
  creation with `cpu`. You can also set `CF_ORT_PROVIDER=cpu|cuda|coreml|dml`.

### Ubuntu 24.04 CUDA Runtime

For ONNX Runtime CUDA on Ubuntu 24.04, install the CUDA runtime libraries plus
cuDNN 9. The cuDNN 9 package comes from NVIDIA's CUDA apt repo:

```bash
curl -fsSL -o /tmp/cuda-keyring_1.1-1_all.deb \
  https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i /tmp/cuda-keyring_1.1-1_all.deb
sudo apt-get update
sudo apt-get install -y \
  libcublaslt12 libcublas12 libcurand10 libcufft11 libcudart12 libcudnn9-cuda-12
```

Verify the ONNX CUDA provider can load:

```bash
ldd node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so
CF_ORT_PROVIDER=gpu ./bin/cf-reframe tests/fixtures/talking-head-5s.mp4 \
  --output /tmp/cf-gpu-provider-test.json --sample-fps 1
node -e "const o=require('/tmp/cf-gpu-provider-test.json'); console.log(o.detector_provider, o.landmark_provider)"
```

Expected provider output is `cuda cuda`. If either provider falls back to
`cpu`, inspect `detector_provider_fallback_reason` or
`landmark_provider_fallback_reason` in the generated crop path.

## AI Tier-2 Features — Hard Constraints (v0.4.0 pillar 5)

ClipForge's moat is "AI assists your primary footage; it never *becomes*
it." The pillar-5 AI B-roll + avatar-stinger skills enforce that with
three layers:

1. **Segment-level flag.** Every `broll.json` segment carries
   `is_primary: true|false`. AI skills refuse to operate on
   `is_primary: true` segments — no API call made, segment left untouched.
2. **Auto-detect.** `crop_path.json.stats.framesWithFace /
   framesProcessed > 0.5` → refused with `avatar_overlaps_primary_face`.
   Conservative on purpose: false-positive refusal beats false-negative
   AI-over-creator.
3. **Renderer.** `bin/cf-ffmpeg render` refuses to mux any asset whose
   own descriptor declares `is_primary: true`. Defense in depth — one
   bypass at the dispatcher layer still gets caught at the renderer.

Hard duration caps:

| Asset type | Max duration |
|---|---|
| AI B-roll cutaway   | 3 s |
| Avatar stinger      | 5 s |

Avatar generation also requires a **two-gate consent system**:

- **Gate 1** (one-time per machine, bilingual EN+ID prompt). Recorded
  in `~/.clip-forge/.consent-log` with a sha256 of `hostname + user`.
  `CF_AVATAR_CONSENT=1` bypasses the interactive prompt (CI / headless).
- **Gate 2** (per-photo sha256 cache). New portrait triggers a fresh
  prompt; re-using the same photo skips the prompt and bumps `use_count`.

`/clip-forge:avatar --no-avatar` overrides every gate at run-time —
zero prompts, zero API calls, zero consent log mutation.

Consent log path: `~/.clip-forge/.consent-log`. To revoke a single
photo's consent, delete its `photos[<hash>]` entry. To revoke ALL
consent, delete the file — next `/clip-forge:avatar` invocation
re-prompts gate 1.

## Multi-speaker content (v0.4.0 pillar 6)

When a transcript carries per-word `speaker` labels (Deepgram diarizes
natively), `cf-reframe` now detects sustained co-speech windows
(≥ 1500 ms with ≥ 2 distinct speakers) and emits **split-screen
samples** into `crop_path.json` (schema v3). The renderer composes a
stack at render time, axis driven by `target_aspect`:

| target_aspect | Stack axis | Panel dims (per speaker) |
|---|---|---|
| 9:16 | vstack (top / bottom) | 1080 × 960 |
| 4:5  | vstack | 1080 × 675 |
| 1:1  | hstack (left / right) | 540 × 1080 |
| 16:9 | hstack | 960 × 1080 |

**Identity stability:** within a split-screen window, `speaker_id 0`
always occupies the LEFT (hstack) or TOP (vstack) panel. No mid-window
flips.

**Disable per clip:** pass `--speaker-route none` to `cf-reframe` to
force single-face crop even on multi-speaker transcripts. The flag
defaults to `auto` which behaves like v0.2.0 single-face when the
transcript reports < 2 distinct speakers.

**Splice interaction:** when a tighten plan with cuts is present
alongside split-screen samples, the renderer emits a
`split_screen_disabled_by_splice` warning and falls back to single-face.
The combination is deferred to v0.5.0.

Telemetry surfaces in `crop_path.json.speaker_timeline` (producer side)
and `render_report.json.split_screen` (renderer side).

## 🔑 BYO API Keys (Optional Tier 2 Features)

ClipForge ships local-first. Tier 2 features require your own API
keys and bill directly from those providers (ClipForge takes nothing):

| Feature                  | Provider              | ~Cost per clip |
|--------------------------|-----------------------|----------------|
| Voice clone hook/outro   | ElevenLabs            | ~$0.05         |
| Multi-lang dub (5 langs) | ElevenLabs + Groq     | ~$0.30         |
| AI B-roll fallback       | fal.ai                | ~$0.20         |
| Avatar stinger           | HeyGen                | ~$1.00         |
| Prompt-driven re-edit    | Groq (or Claude)      | ~$0.001        |

Set `CF_AI_BUDGET_USD=N` to cap total per pipeline (default `$10`).
Local fallback: Piper TTS (offline, no voice clone, generic voice) —
install via `node bin/install-models.mjs --piper`.

### BYO API Keys Cost Cheatsheet (pillar 5)

| Provider             | Env var                  | Use                         | Per-call cost |
|----------------------|--------------------------|-----------------------------|---------------|
| fal.ai Flux Schnell  | `FAL_API_KEY`            | AI B-roll (default)         | ~$0.003/img   |
| Gemini Nano Banana   | `GEMINI_API_KEY`         | AI B-roll (brand-consistent)| ~$0.04/img    |
| Replicate            | `REPLICATE_API_TOKEN`    | AI B-roll fallback          | varies        |
| HeyGen               | `HEYGEN_API_KEY`         | Avatar stinger (best)       | ~$1.00/clip   |
| D-ID                 | `DID_API_KEY`            | Avatar stinger (mid)        | ~$0.30/clip   |
| fal.ai LivePortrait  | `FAL_API_KEY`            | Avatar stinger (OSS)        | ~$0.10/clip   |

Override precedence with `CF_VISUAL_PROVIDER=<name>` (image) or
`CF_AVATAR_PROVIDER=<name>` (avatar). All keys optional — missing
keys degrade gracefully (B-roll AI silently skipped, avatar silently
skipped, Pexels broll + dub paths unaffected).

The TTS-related precedence (`/clip-forge:voice-clone` and
`/clip-forge:dub`) walks down the list `ELEVENLABS_API_KEY →
CARTESIA_API_KEY → GROQ_API_KEY → Piper local`. Override the resolver
with `CF_TTS_PROVIDER=<name>`. Missing every key + missing Piper degrades
gracefully — the skill exits 0 with a structured warning, no crash.

## Install

> **Marketplace status:** ClipForge isn't on the official Claude Code marketplace yet.
> Until it's approved, install via `--plugin-dir` from a local checkout.

```bash
git clone https://github.com/rdh073/clip-forge
cd clip-forge
npm install
node bin/install-models.mjs  # one-time Ultraface + PFLD + RNNoise model fetch
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
| `CF_RNNOISE_MODEL_URL` | Optional custom RNNoise/arnndn model URL | `/clip-forge:enhance` model override |
| `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET` | TikTok upload | `/clip-forge:publish tiktok` |
| `YT_CLIENT_ID` + `YT_CLIENT_SECRET` | YouTube Shorts upload | `/clip-forge:publish youtube` |
| `IG_APP_ID` + `IG_APP_SECRET` | Instagram Reels upload | `/clip-forge:publish instagram` |
| `ELEVENLABS_API_KEY` | Voice clone + multilingual TTS | `/clip-forge:voice-clone`, `/clip-forge:dub` (degrades to Cartesia → Groq → Piper local) |
| `CARTESIA_API_KEY` | Low-latency TTS (voice clone) | same — second in precedence |
| `GROQ_API_KEY` | Cheap generic-voice TTS (no clone) | same — third in precedence |
| `CF_TTS_PROVIDER` | Force a specific TTS adapter | overrides precedence; `elevenlabs\|cartesia\|groq\|piper` |
| `CF_AI_BUDGET_USD` | Cumulative paid-skill cost cap | default `10.00`; 80 % checkpoint + 100 % hard-stop |
| `CF_LLM_PROVIDER` | Force LLM provider for cf-edit + translate fallback | `groq\|anthropic`; precedence is groq → anthropic |
| `CF_TRANSLATE_PROVIDER` | Force translate provider for `/clip-forge:dub` | `groq\|anthropic`; mirrors `CF_LLM_PROVIDER` shape |
| `FAL_API_KEY` | AI B-roll (Flux Schnell, default) + avatar (LivePortrait) | `/clip-forge:broll-ai`, `/clip-forge:avatar` |
| `GEMINI_API_KEY` | Nano Banana B-roll (brand-consistent) | `/clip-forge:broll-ai` |
| `REPLICATE_API_TOKEN` | Replicate B-roll fallback | `/clip-forge:broll-ai` |
| `HEYGEN_API_KEY` | HeyGen avatar stinger (best quality) | `/clip-forge:avatar` |
| `DID_API_KEY` | D-ID avatar stinger (mid-tier) | `/clip-forge:avatar` |
| `CF_VISUAL_PROVIDER` | Force visual provider | `fal\|nanobanana\|replicate` |
| `CF_AVATAR_PROVIDER` | Force avatar provider | `heygen\|did\|fal_lip` |
| `CF_AVATAR_CONSENT` | Set to `1` to bypass the one-time avatar consent prompt (CI / headless) | `/clip-forge:avatar` |

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
| `/clip-forge:enhance`      | Denoise, de-reverb, and loudness-normalize source audio |
| `/clip-forge:clip`         | Calls clip-scout agent to pick up to 15 viral moments |
| `/clip-forge:reframe`      | 16:9 → 9:16 crop path (face tracking **deferred to v0.2.0**, center-crop today) |
| `/clip-forge:caption`      | Word-timed captions in your default style → `.ass` file |
| `/clip-forge:broll`        | Pexels stock cutaways matched to each sentence |
| `/clip-forge:music`        | Royalty-free music bed with auto-ducking under speech |
| `/clip-forge:render`       | Final 9:16 1080×1920 MP4 per clip (ffmpeg presets) |
| `/clip-forge:voice-clone`  | Upload a 30 s sample to ElevenLabs/Cartesia/Groq/Piper; save `voice_id` to `voices.json` |
| `/clip-forge:dub`          | Translate + TTS-dub the transcript into N languages; emit per-lang `edit.dub-<lang>.json` |
| `/clip-forge:brand-kit`    | Register logo / endcard / lower-third in `brand-kit.json`; renderer burns them into every clip |
| `/clip-forge:edit`         | Content-hash diff + partial re-render via `render_manifest.json`; LLM-driven JSON-patch edits with `--prompt "<text>"` |
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

## Audio enhance

`bin/cf-enhance` cleans source audio once, writes `enhanced.wav` plus
`enhance_report.json` next to the source by default, and can patch
`edit.json` with `"audio_source": "<enhanced.wav>"`. The renderer then keeps
the original video stream and swaps in the cleaned WAV for audio.

Default filter chain:

```text
afftdn=nr=12:nf=-25
→ arnndn=m=bin/models/cb.rnnn      # only when model + ffmpeg arnndn exist
→ agate                            # adaptive residual noise-floor gate
→ dialoguenhance                   # best-effort de-reverb / speech clarity
→ loudnorm two-pass I=-14 TP=-1.0 LRA=11
```

### Graceful degradation

| Condition | Behavior |
|---|---|
| `bin/models/cb.rnnn` missing | Skip RNNoise, run `afftdn` + `agate` + `dialoguenhance` + `loudnorm`. |
| ffmpeg lacks `arnndn` | Skip RNNoise and record `arnndn_filter_unavailable`. |
| `--demucs` / `--voice-isolate` set but Demucs is missing | Skip voice isolation and record `demucs_not_installed`. |
| Demucs fails or produces no vocals stem | Continue from the original source and record the reason. |
| Input missing or no audio stream | Exit 0, write a valid JSON report with `fallback_used: true`. |
| True peak cannot be verified at `<= -1.0 dBTP` | Remove unsafe output and write a fallback report. |

### Troubleshooting

| Symptom | Fix |
|---|---|
| `rnnoise_model_missing` warning | Run `node bin/install-models.mjs`, or set `CF_RNNOISE_MODEL_URL` to your own `arnndn` model URL. |
| `arnndn_filter_unavailable` | Install an ffmpeg build with the `arnndn` filter, or pass `--no-rnnoise`. |
| `demucs_not_installed` | Install Demucs in the active Python environment, or omit `--demucs`. |
| Output sounds over-gated | Pass `--no-noise-gate` or lower `--gate-threshold`. |
| Loudness is not your target | Use `--target-lufs <LUFS>`; social default is `-14`. |
| Render ignores enhanced audio | Confirm `edit.json` contains `"audio_source": "<path-to-enhanced.wav>"`. |

### Common invocations

```bash
# Default CPU-first enhance next to the source:
node bin/cf-enhance --in ./uploads/demo/source.mp4

# Force afftdn-only denoise:
node bin/cf-enhance --in ./uploads/demo/source.mp4 --no-rnnoise

# Optional Demucs vocals pre-pass:
node bin/cf-enhance --in ./uploads/demo/source.mp4 --demucs

# Custom loudness target and render handoff:
node bin/cf-enhance \
  --in ./uploads/demo/source.mp4 \
  --out ./uploads/demo/enhanced.wav \
  --report ./uploads/demo/enhance_report.json \
  --target-lufs -14 \
  --edit-json ./clips/demo/c01/edit.json
```

## Brand vocabulary

`~/.clip-forge/vocab.json` (per-user, v0.3.0) biases both transcription
backends toward correct casing of brand names, product names, and proper
nouns. The Deepgram branch passes `keywords[]` to the MCP `transcribe`
tool; the Whisper branch passes `--prompt` to `whisper.cpp`. A
case-restoring post-pass runs against the produced transcript regardless of
backend, so "clipforge", "Clip-Forge", and "Clipforge!" all canonicalise to
the casing in `vocab.json`.

### Schema

```jsonc
{
  "version": 1,
  "terms": [
    { "term": "ClipForge", "case": "preserve", "weight": 1.0 },
    { "term": "Anthropic", "case": "preserve", "weight": 1.0 },
    { "term": "Sumayyah",  "case": "preserve", "weight": 1.0, "lang": "en" }
  ],
  "deepgram": { "boost": 8.0 },
  "whisper":  { "initial_prompt_max_tokens": 240 }
}
```

| Field                                  | Default      | Meaning                                                                                  |
|----------------------------------------|--------------|------------------------------------------------------------------------------------------|
| `terms[].term`                         | required     | Casing-preserving brand or proper noun.                                                  |
| `terms[].case`                         | `"preserve"` | Only mode for v0.3.0 — restore the term's casing in the transcript.                      |
| `terms[].weight`                       | `1.0`        | Tie-break + boost scaler. Higher = preferred when terms compete for the same span.        |
| `terms[].lang`                         | omitted      | Optional ISO code; reserved for v0.3.1 language-scoped matching (no-op today).            |
| `deepgram.boost`                       | `8.0`        | Multiplied by term weight → integer 0–10 Deepgram boost.                                 |
| `whisper.initial_prompt_max_tokens`    | `240`        | Whitespace-token cap on the synthesized Whisper prompt.                                  |

### Example invocation

```bash
node bin/cf-whisper \
  --in   ./uploads/demo/source.mp4 \
  --out  ./uploads/demo/transcript.json \
  --vocab ~/.clip-forge/vocab.json
```

When `--vocab` is set, the produced transcript carries a top-level `vocab`
block (`{applied:true, restored_count:N, warnings:[...]}`). When the flag
is omitted, the field is absent. Missing `~/.clip-forge/vocab.json` is the
unset default — no warning, no fallback. See
[skills/transcribe/SKILL.md](skills/transcribe/SKILL.md) for the full
contract including the Deepgram-branch wiring and the
`CF_WHISPER_TRANSCRIPT_MOCK` testing hook.

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

### Tighten render performance (v0.3.0)

Measured on synthetic fixtures with `cf-ffmpeg render` (two-pass splice
+ ASR-quality telemetry generation). Numbers are median of 3 runs on
Node 20, 4-core CPU.

| Workload                                  | Mode                          | Wall-clock | Realtime ratio |
|-------------------------------------------|-------------------------------|------------|----------------|
| 30 s source, 5 cuts                       | Default (multi-threaded x264) | ~5.0 s     | 6× faster      |
| 30 s source, 5 cuts                       | `CF_RENDER_DETERMINISTIC=1`   | ~9.3 s     | 3× faster      |
| 60 s source, 50 cuts (Phase C stress)     | Default (multi-threaded x264) | ~8.0 s     | 7× faster      |

Stress observation: at N = 50 cuts the wall-clock drops below the no-cut
baseline of the same 60 s source — cuts reduce the amount of audio and
video each encoder pass has to process. Performance scales gracefully
through at least 50 junctions on a 9 KB `filter_complex`. See
[`docs/ROADMAP.md`](docs/ROADMAP.md) v0.3.1 for known-issue notes
(video frame-grid drift, filter graph length warnings).

These numbers measure **only** the tighten splice render. Face-tracked
reframe + caption bake + B-roll mix add their own costs as per the
existing table above.

## Models & licenses

| Model | Source | License | Notes |
|---|---|---|---|
| Ultraface RFB-320 (face detection) | [Linzaer/Ultra-Light-Fast-Generic-Face-Detector](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB) via `onnx/models` | MIT | Verified clean |
| PFLD 68-point (face landmarks) | [`cunjian/pytorch_face_landmark`](https://github.com/cunjian/pytorch_face_landmark) | **None stated** [^pfld-lic] | Replacement tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md) v0.3.0 |
| `cb.rnnn` (RNNoise / `arnndn`) | [`GregorR/rnnoise-models`](https://github.com/GregorR/rnnoise-models) | README states model files are not subject to copyright | Optional acceleration for `/clip-forge:enhance`; sha256 pinned in `bin/install-models.mjs`, override with `CF_RNNOISE_MODEL_URL` |

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
node bin/install-models.mjs       # one-time Ultraface + PFLD + RNNoise model fetch
npm test                          # 86 tests pass, 3 skipped (fixture-gated)
claude plugin validate .          # 0 errors, 0 warnings expected
claude --plugin-dir .             # boot Claude Code with this plugin loaded
```

### Success-path regression guard

`tests/integration/success-path.test.mjs` is the test that should have
existed since v0.1.0. It asserts **positive evidence** that the pipeline
produced a real face-tracked render — not just that exit code was 0:

- Ultraface detector ran (`detector === 'onnxruntime@ultraface-rfb-320'`,
  not a fallback variant), framesWithFace > 80 % of framesProcessed
- PFLD landmarks populated 68/face, mouth-y stddev > 1 px (proves
  per-frame inference, not cache)
- Tracker flip rate ≤ 1.0/s
- Crop center stddev > 5 px in `samples[]`
- `cf-ffmpeg reframe-animated` produces a 1080×1920 mp4 whose 3 sampled
  frames have 3 distinct sha256 hashes (the CR-2 regression guard)

The test skips cleanly when fixtures or ONNX models aren't installed
locally, so `npm test` on a fresh checkout stays green; the gate is on
releases. Run `npm test` before any tag.

### Reproducibility

Production renders run multi-threaded x264 (or h264_nvenc on CUDA boxes)
for speed. The tradeoff is that two runs of the same input produce
byte-different MP4s — frames are scheduled across threads non-deterministically
and the muxer stamps creation time into the container.

For tests that need byte-identical output (e.g. the tighten splice
idempotency assertion), set `CF_RENDER_DETERMINISTIC=1` before invoking
`bin/cf-ffmpeg`:

```bash
CF_RENDER_DETERMINISTIC=1 node bin/cf-ffmpeg render --manifest edit.json
```

When the env var is set, `cf-ffmpeg` forces:

- CPU encoder (`libx264`) — h264_nvenc has no deterministic mode
- `-fflags +bitexact` — strips muxer timestamps / encoder identifier from output
- `-tune zerolatency` + `-x264-params sliced-threads=0:threads=1` — single-threaded encode

Determinism is asserted at the per-stream level (not file-level) using
`ffmpeg -map 0:v -f md5 -` and `ffmpeg -map 0:a -f md5 -` separately — this
isolates encoder determinism from any container-level non-determinism that
might still leak through.

Production renders should leave `CF_RENDER_DETERMINISTIC` unset.

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
