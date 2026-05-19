---
name: clip-forge-transcribe
description: Generate a word-timed transcript with speaker labels for a ClipForge upload. Uses Deepgram MCP when DEEPGRAM_API_KEY is set, otherwise falls back to local whisper.cpp via bin/cf-whisper. Writes ./uploads/<slug>/transcript.json. Use when the user says "transcribe this", runs /clip-forge:transcribe, or whenever the pipeline needs word-level timing.
allowed-tools: Bash, Read, Write
---

# /clip-forge:transcribe

## Args

`$ARGUMENTS` = `<slug> [--force] [--offline] [--language <code>]`

Resolve the source: `./uploads/<slug>/source.mp4`. Bail with ❌ if missing.

Resolve the target: `./uploads/<slug>/transcript.json`. If it exists and
`--force` not passed, print `⏭ transcript already exists` and exit 0 — emit
the existing file's word count so the caller can keep going.

## Path selection

| Condition                                    | Engine                  |
|----------------------------------------------|-------------------------|
| `--offline` passed                           | Whisper (local)         |
| `DEEPGRAM_API_KEY` set and not `--offline`   | Deepgram MCP            |
| Neither                                       | Whisper (local) + ⚠ note |

## Deepgram branch

Invoke the `deepgram` MCP server's `transcribe` tool with:
```json
{
  "file_path": "./uploads/<slug>/source.mp4",
  "options": {
    "model": "nova-3",
    "smart_format": true,
    "diarize": true,
    "punctuate": true,
    "language": "${language|auto}",
    "utterances": true
  }
}
```

Normalize the response to ClipForge's canonical shape (next section).

## Whisper branch

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-whisper \
  --in ./uploads/<slug>/source.mp4 \
  --out ./uploads/<slug>/transcript.json \
  --model small.en \
  --diarize
```

The wrapper handles the model download (cached at `~/.clip-forge/models/`),
audio extraction, and shape normalization.

## Canonical schema

```json
{
  "version": 1,
  "engine": "deepgram|whisper",
  "language": "en",
  "duration_s": 1842.3,
  "speakers": [
    {"id": 0, "label": "Host"},
    {"id": 1, "label": "Guest"}
  ],
  "words": [
    {
      "w": "everything",
      "start_ms": 12340,
      "end_ms": 12780,
      "speaker": 0,
      "confidence": 0.98
    }
  ],
  "sentences": [
    {
      "text": "Everything changed when I quit.",
      "start_ms": 12340,
      "end_ms": 14210,
      "speaker": 0,
      "sentiment": 0.41
    }
  ]
}
```

`sentences` is grouped server-side by Deepgram; for Whisper, group with a
50-character or 4-second window.

## Output

```
✅ transcribed: 12,481 words · 30m 42s · 2 speakers · engine=deepgram
```

`/clip-forge:clip` reads this file directly — do not re-run unless the source
changed (compare `mtime` of source.mp4 vs transcript.json).
