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
