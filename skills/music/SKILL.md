---
name: clip-forge-music
description: Pick a royalty-free music bed for a clip from templates/music/ matching the clip's mood (energetic, calm, inspirational, dramatic, playful) and configure auto-ducking under speech. Writes ./clips/<slug>/<clip-id>/music.json. Use when the user says "add music", runs /clip-forge:music, or when /clip-forge:start has auto_music enabled.
allowed-tools: Bash, Read, Write, Agent
---

# /clip-forge:music

## Args

`$ARGUMENTS` = `<slug> <clip-id> [--mood <name>] [--volume 0.0-1.0] [--no-duck]`

Defaults: mood inferred from clip sentiment, `volume=0.18` (under speech),
ducking on.

## Mood inference

Read the clip's sentence slice from `transcript.json`. Compute average
sentiment + use the candidate's `hook` as context. Ask **caption-stylist**
(agent) — it already has the niche context — to pick one of:

| Mood          | When                                                            |
|---------------|-----------------------------------------------------------------|
| `energetic`   | Avg sentiment > 0.4, high-pace hook                              |
| `calm`        | Avg sentiment 0.0–0.4, narrative                                 |
| `inspirational` | Story-arc clips, "and that's when I…" beats                    |
| `dramatic`    | Negative sentiment, conflict, reveal                             |
| `playful`     | Niche=gaming/marketing with positive sentiment                   |

## Track picking

Look in `${CLAUDE_PLUGIN_ROOT}/templates/music/<mood>/*.mp3` (or `.flac`).
Pick the longest track that exceeds the clip duration. If none long enough,
pick the longest and let ffmpeg loop it.

If `templates/music/<mood>/` is empty, ⏭ skip cleanly — no music is better
than bad music.

## Ducking

Default sidechain ducking is applied at render time by `bin/cf-ffmpeg
music-mix`. This skill just emits the plan:

```json
{
  "version": 1,
  "clip_id": "c01",
  "track": "${CLAUDE_PLUGIN_ROOT}/templates/music/energetic/uplift-128bpm.mp3",
  "mood": "energetic",
  "volume": 0.18,
  "duck": {
    "enabled": true,
    "threshold_db": -28,
    "ratio": 6,
    "attack_ms": 5,
    "release_ms": 250
  },
  "fade_in_ms": 400,
  "fade_out_ms": 800
}
```

## Output

```
✅ music c01: mood=energetic · uplift-128bpm.mp3 · ducked -28dB ratio 6:1
```

## Failures

- `templates/music/` entirely empty → ⏭ "no music templates shipped" and
  write an empty plan with `"track": null`. Render skips music gracefully.
