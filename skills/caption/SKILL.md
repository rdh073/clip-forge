---
name: clip-forge-caption
description: Generate word-timed burnable captions for a selected clip in the user's chosen viral style (Beast, Submagic-Pop, Karaoke, Neon, Gradient). Writes captions.json and a .ass file ready for ffmpeg burn-in. Use when the user says "caption this", runs /clip-forge:caption, or when /clip-forge:start enters the caption step.
allowed-tools: Bash, Read, Write, Agent
---

# /clip-forge:caption

## Args

`$ARGUMENTS` = `<slug> <clip-id> [--style <name>] [--emoji on|off|auto]`

Style default: `profile.caption.style` from `~/.clip-forge/profile.json`.

## Inputs

- `./uploads/<slug>/transcript.json`  (slice by clip start/end)
- `./clips/<slug>/candidates.json`     (for clip boundaries + title/hashtags)
- `${CLAUDE_PLUGIN_ROOT}/templates/captions/<style>.json`
- `~/.clip-forge/profile.json`         (brand colors, font)

## Slice

Extract words whose `start_ms` falls within `[clip.start_ms, clip.end_ms]`.
Re-base timestamps so the clip starts at `0`.

## Delegate style choice to caption-stylist

The `--style` flag wins. Otherwise call **caption-stylist** with:

```
You are caption-stylist. Given:
  platform = <profile.platform>
  niche    = <profile.niche>
  sentiment = <avg of slice sentiment>
  hook      = <candidate.hook>

Pick:
  style_name: one of [Beast, Submagic-Pop, Karaoke, Neon, Gradient]
  emoji_per_sentence: array of one emoji per sentence (or "")
  highlight_words: array of indices to pop (max 1 per 3 words)
Reply STRICT JSON.
```

Merge the agent's picks with `templates/captions/<style>.json` to form the
render plan.

## Output 1 — `captions.json`

```json
{
  "version": 1,
  "clip_id": "c01",
  "style": "Submagic-Pop",
  "brand": { "primary": "#ff0066", "accent": "#00d4ff" },
  "font": "Inter",
  "lines": [
    {
      "start_ms": 0,
      "end_ms": 1840,
      "words": [
        {"w": "Nobody",    "start_ms": 0,    "end_ms": 320,  "highlight": false},
        {"w": "tells",     "start_ms": 320,  "end_ms": 580,  "highlight": false},
        {"w": "you",       "start_ms": 580,  "end_ms": 760,  "highlight": false},
        {"w": "this",      "start_ms": 760,  "end_ms": 1100, "highlight": true}
      ],
      "emoji": "🎯"
    }
  ]
}
```

Group at most 4 words per line; respect natural pauses (>250ms = new line).

## Output 2 — `captions.ass`

Run `bin/cf-caption-burn` to convert `captions.json` → ASS subtitle file:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-caption-burn \
  --in  ./clips/<slug>/<clip-id>/captions.json \
  --tpl ${CLAUDE_PLUGIN_ROOT}/templates/captions/<style>.json \
  --out ./clips/<slug>/<clip-id>/captions.ass
```

`cf-caption-burn` handles ASS escaping, animation tags, gradient fills, and
karaoke `\k` timing.

## Output

```
✅ captioned c01: 38 lines · style=Submagic-Pop · 6 emojis · 14 highlights
```

## Failures

- Style file missing → fall back to `Beast` and ⚠ note "style <x> not found".
- Empty words slice (silent clip) → write an empty `.ass` file and ⚠ note.
