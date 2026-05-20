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
  "hook_span": { "start_ms": 0, "end_ms": 1800, "text": "Nobody tells you this" },
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

### `hook_span` (pillar (i), v0.3.0)

When `caption-stylist` is invoked with a brief that includes a `hook:`
line, it returns a `hook_span: {start_ms, end_ms, text}` block. The
caption skill passes this through verbatim into `captions.json`. The
hook is rendered as a separate ASS layer (5) sitting above the regular
caption Default layer (0) — same colours / strokes / shadow as the
caption template's `hook_overlay` block, system font fallback (Liberation
Sans on Linux, Helvetica on macOS), word-wrap at `max_chars` with a
`hook_overlay_wrapped` soft warning.

If the brief omits `hook:` (rare — clip-scout almost always emits one),
`hook_span` is omitted from `captions.json`. Renderer treats `captions`
exactly as in v0.2.x and does not emit a hook layer.

### Emoji + highlight burning (pillar (i), v0.3.0)

`cf-caption-burn` now honors `captions.json` metadata that was already
present in v0.2.x but ignored by the renderer:

- `lines[].emoji` — one emoji per line, appended at end of last word.
  Burned via the same ASS layer as captions; relies on system font
  fallback for the emoji glyph. No Noto Emoji ttf is shipped with the
  plugin per the v0.3.0 font-handling decision.
- `lines[].words[].highlight` — word gets a colour-flip (`brand.accent`
  or template `highlight`) + scale-up (108 %) on its dialogue token.
  Caption-stylist picks at most 1 highlight per 3 consecutive words.

## Output 2 — `captions.ass`

Run `bin/cf-caption-burn` to convert `captions.json` → ASS subtitle file:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-caption-burn \
  --in  ./clips/<slug>/<clip-id>/captions.json \
  --tpl ${CLAUDE_PLUGIN_ROOT}/templates/captions/<style>.json \
  --out ./clips/<slug>/<clip-id>/captions.ass \
  [--sidecar-dir ./renders/<slug>] [--target-aspect 9:16|1:1|4:5]
```

`cf-caption-burn` handles ASS escaping, animation tags, gradient fills, and
karaoke `\k` timing. Pillar (i) v0.3.0 flags:

- `--sidecar-dir <dir>` — also emit `<out-base>.vtt` + `<out-base>.srt`
  next to the .ass file. Same timeline, just two extra formats. Skipped
  when the captions are empty.
- `--target-aspect <name>` — sets PlayResX/PlayResY in the ASS header so
  ASS positioning math matches the renderer's output canvas. Defaults to
  9:16 when unset. Unknown aspects fall back to 9:16 and emit a soft
  `unknown_aspect` warning.

`cf-ffmpeg render` also emits VTT + SRT sidecars (when `edit.json.captions_json`
or `edit.json.captions` point at a captions file with a sibling .json),
independent of the caption skill — see `skills/render/SKILL.md`.

## Output

```
✅ captioned c01: 38 lines · style=Submagic-Pop · 6 emojis · 14 highlights
```

## Failures

- Style file missing → fall back to `Beast` and ⚠ note "style <x> not found".
- Empty words slice (silent clip) → write an empty `.ass` file and ⚠ note.
