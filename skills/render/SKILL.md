---
name: clip-forge-render
description: Render a final 9:16 1080×1920 MP4 for a selected clip — applies reframe crop path, burns captions, overlays B-roll, mixes music with ducking, adds brand watermark, optional intro/outro. Writes ./renders/<slug>/<clip-id>.mp4. Use when the user says "render", "export the clip", runs /clip-forge:render, or when /clip-forge:start enters the render step.
allowed-tools: Bash, Read, Write
---

# /clip-forge:render

## Args

`$ARGUMENTS` = `<slug> <clip-id> [--quality high|fast] [--no-broll] [--no-music] [--watermark off]`

Defaults: `quality=high` (CRF 18, slow preset), watermark on if logo in profile.

## Inputs

| File                                                | Required | Notes                       |
|-----------------------------------------------------|----------|-----------------------------|
| `./uploads/<slug>/source.mp4`                       | yes      | source                      |
| `./clips/<slug>/candidates.json`                    | yes      | clip boundaries             |
| `./clips/<slug>/<clip-id>/crop_path.json`           | yes      | reframe                     |
| `./clips/<slug>/<clip-id>/captions.ass`             | optional | skip burn-in if missing     |
| `./clips/<slug>/<clip-id>/broll.json` + files       | optional | skip overlays if missing    |
| `./clips/<slug>/<clip-id>/music.json`               | optional | skip music if missing/null  |
| `~/.clip-forge/profile.json`                         | yes      | brand watermark / colors    |

## Edit manifest

Write `./clips/<slug>/<clip-id>/edit.json` first — this is the contract the
PostToolUse hook can watch to re-trigger renders on edit:

```json
{
  "version": 1,
  "clip_id": "c01",
  "start_ms": 252000,
  "end_ms": 298000,
  "crop_path": "./clips/podcast-ep-42/c01/crop_path.json",
  "captions": "./clips/podcast-ep-42/c01/captions.ass",
  "broll":    "./clips/podcast-ep-42/c01/broll.json",
  "music":    "./clips/podcast-ep-42/c01/music.json",
  "watermark": "~/.clip-forge/assets/logo.png",
  "intro":     null,
  "outro":     null,
  "output":    "./renders/podcast-ep-42/c01.mp4",
  "quality":   "high"
}
```

Then call:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-ffmpeg render \
  --manifest ./clips/<slug>/<clip-id>/edit.json
```

`cf-ffmpeg render` builds a single filter_complex graph:
1. Trim source by `[start_ms, end_ms]`.
2. Apply animated crop using `crop_path.samples` as keyframes (sendcmd / zmq).
3. Scale to `1080×1920`.
4. Overlay each B-roll cutaway with crossfade.
5. Burn `.ass` subtitles.
6. Overlay watermark at bottom-right with 8% padding and 70% opacity.
7. Concat intro (if any) + body + outro (if any).
8. Mix music with sidechain ducking against the speech track.
9. Encode H.264 high profile, CRF 18 (or 22 for fast), AAC 192k.

Stream ffmpeg progress (read stderr `time=` lines, emit `⏳ 47%`).

## Output

```
✅ rendered c01 → ./renders/podcast-ep-42/c01.mp4 (8.4 MB · 46s · 1080×1920)
```

## Failures

- Missing required input → ❌ name the file.
- ffmpeg non-zero → tail the last 30 lines of stderr, surface it, ❌.
- Out of disk → check `df` for the target dir before encoding; abort early.

---

## Pillar (i) v0.3.0 additions

The fields below are all optional. v0.2.x edit.json files render
identically — every overlay/aspect/sidecar field defaults off.

### `edit.json` extended schema

```json
{
  "version": 1, "clip_id": "c01",
  "start_ms": 0, "end_ms": 5000,
  "source": "./uploads/<slug>/source.mp4",
  "crop_path": "./.../crop_path.json",
  "captions":      "./.../captions.ass",
  "captions_json": "./.../captions.json",
  "output": "./renders/<slug>/c01.mp4",
  "quality": "high",

  "target_aspect": "9:16",
  "hook_overlay":  {
    "text": "Nobody tells you this",
    "end_ms": 1800,
    "position": "upper-third"
  },
  "progress_bar":  {
    "enabled": true,
    "color": "#ffffff",
    "height_px": 8,
    "position": "bottom"
  }
}
```

### Aspect profiles

`target_aspect` maps to output canvas dimensions:

| value | canvas       |
|-------|--------------|
| `9:16` (default) | 1080 × 1920 |
| `1:1`            | 1080 × 1080 |
| `4:5`            | 1080 × 1350 |

Unknown values fall back to 9:16 + a soft `unknown_aspect` warning in
`render_report.json`.

**Framing rule — "same crop, smaller canvas".** The reframe stage stays
aspect-agnostic. The face-tracked crop CENTER (`crop_path.samples[].cx/cy`)
is unchanged when you switch aspects; only the output canvas dimensions
shrink. Trade-off: when you ship a 4:5 of a clip reframed at 9:16, the
subject sits in the same relative position but more head/shoulder space
is reserved. If you want tighter framing per-aspect, override at reframe
time:

```bash
cf-reframe ./source.mp4 --output ./crop_path.json --target-aspect 1:1
```

### Hook overlay

A bold text overlay rendered via a separate ASS layer (layer 5) sitting
above the caption Default layer (layer 0). Visible for `[0, end_ms]`.
Position values: `"upper-third"` (default) → ASS alignment 8 with
MarginV ≈ canvasH/3; `"center"` → ASS alignment 5.

Look comes from `templates/captions/<style>.json` → `hook_overlay`
block:

```json
{
  "hook_overlay": {
    "font_size_px": 88,
    "stroke_px": 6,
    "fill_primary": "$brand.primary",
    "stroke_color": "#000000",
    "shadow_px": 2,
    "default_position": "upper-third",
    "max_chars": 36
  }
}
```

`$brand.primary` substitutes against `captions.json.brand.primary` (the
brand color caption-stylist already chose). If `text` exceeds
`max_chars`, the overlay word-wraps and emits a `hook_overlay_wrapped`
soft warning. If the template lacks a `hook_overlay` block, the
renderer falls back to defaults (white text, black stroke) and emits
`template_missing_hook_overlay`.

### Progress bar

A horizontal bar at the bottom (or top) of the canvas whose fill grows
linearly from 0 % at `t=0` to 100 % at `t=end_ms - start_ms`. Rendered
via ffmpeg `drawbox`. The renderer chains 20 stepped drawbox calls
(one per `T/20` seconds) — ffmpeg 6.x's drawbox doesn't evaluate `w`
expressions per frame, so per-step `enable` predicates drive the
animation. 20 steps is smooth at 24–30 fps playback.

### Font handling

ASS layer rendering uses libass + fontconfig with system-fallback
defaults: Liberation Sans on Linux, Helvetica on macOS, Arial on
Windows. The plugin does NOT ship Inter / Noto Emoji / any other
font. Cross-platform emoji burning falls back to whatever the
system has installed; on a barebones Linux container without
Noto Color Emoji, emojis may render as monochrome glyph boxes. This
is a deliberate trade-off — shipping 8 MB of Noto Emoji to every
plugin install for one rarely-used render path isn't worth it.

### Sidecars (VTT + SRT)

When `edit.json.captions_json` is set (or `edit.json.captions` is a
`.ass` file with a sibling `.json`), the renderer emits two sidecar
files next to the MP4:

- `./renders/<slug>/<clip-id>.vtt` — WebVTT (web-embed ready).
- `./renders/<slug>/<clip-id>.srt` — SRT (universal compatibility,
  Premiere/DaVinci import).

Both timelines match the burned `.ass` file's word timing — same source,
three formats. Empty captions → sidecars skipped silently.

### `render_report.json` extension

The schema (`schemas/render_report.v1.json`) is additive — v0.2.x readers
ignore the new fields. New top-level keys:

- `target_aspect`: `"9:16" | "1:1" | "4:5" | null`
- `overlays`: `{ hook: {burned, wrapped, end_ms} | null, progress_bar: {burned, color, height_px, position} | null } | null`
- `sidecars`: `{ vtt: <abspath>|null, srt: <abspath>|null } | null`

New warning codes that may appear in `render_report.warnings`:
`unknown_aspect`, `hook_overlay_wrapped`, `template_missing_hook_overlay`,
`progress_bar_invalid_geometry`.

### v0.4.0 pillar 2 additions (additive)

- `edit.json.prepend_audio` and `edit.json.append_audio` (optional) —
  each may be either `{ tts: { text, voice_id?, provider? } }` (lazy
  synthesis via `bin/lib/tts.mjs`, cached to `<output>.<kind>.wav` next
  to the mp4) or `{ audio_path: <abs path> }` (use existing WAV
  directly). The renderer mux-concatenates these stingers around the
  main clip.
- `render_report.ai_costs` — snapshot of `render_manifest.json.ai_costs`
  at render time. Surfaces `total_usd`, `breakdown`, `budget_cap_usd`,
  `budget_used_pct`, `budget_exhausted`, `skipped_clips`.
- `render_report.tts_provider_used` — `"elevenlabs" | "cartesia" |
  "groq" | "piper" | "mock:<name>" | null`.
- `render_report.tts_nondeterministic` — `true` iff any TTS call ran
  during this render.
- `render_report.dub_languages` — target languages dubbed for this
  clip (echoed from `edit.json.dub.target_lang` and/or
  `edit.json.dub_languages`).

### Reproducibility / determinism (v0.4.0 pillar 2 contract)

`CF_RENDER_DETERMINISTIC` modes (PLAN-v0.4.0 §5 risks row 3):

| Value | Behavior |
|---|---|
| (unset) | Production. No determinism enforcement. |
| `strict` | Legacy v0.3.0. Fails the render if any TTS participated (`tts_nondeterministic: true`). |
| `audio` | Audio MD5 must be byte-identical across two runs; video allowed ±200 ms drift. |
| `visual` | Video MD5 must be byte-identical across two runs; audio drift OK. |
| `relaxed` | ±200 ms drift on both. Auto-applied when `tts_nondeterministic: true` and the user hasn't set the env var. |

The render skill detects TTS participation BEFORE the encoder runs by
inspecting `edit.json.{prepend_audio, append_audio, dub}` and the
existence of a `render_manifest.json.ai_costs.history[]` entry of kind
`"tts"`. If `CF_RENDER_DETERMINISTIC=strict` is set in any of those
cases, the render fails fast with code `tts_nondeterministic_in_strict_mode`
and a reminder pointing here.

For idempotency on a TTS-affected pipeline, the realistic-mock contract
keeps the test path byte-identical: same transcript + same voice_id +
same mock seed → byte-identical `dubbed.wav` (see
`tests/integration/dub.test.mjs` D4 assertion).
