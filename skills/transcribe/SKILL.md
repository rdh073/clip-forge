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

## Brand vocabulary (pillar e — v0.3.0)

### Vocab scope

Per-user only for v0.3.0: `~/.clip-forge/vocab.json`. The per-project overlay
(`./.clip-forge/vocab.json` next to the working directory's `uploads/`) is
**deferred to v0.3.1** per the decision in
[docs/PLAN-v0.3.0.md](../../docs/PLAN-v0.3.0.md) §7 Q2 / §9.

### Vocab schema

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
| `terms[].weight`                       | `1.0`        | Tie-break + boost scaler. Higher = preferred when two terms compete for the same span.   |
| `terms[].lang`                         | omitted      | Optional ISO code; reserved for v0.3.1 language-scoped matching (no-op today).           |
| `deepgram.boost`                       | `8.0`        | Multiplied by term weight → integer 0–10 Deepgram boost.                                 |
| `whisper.initial_prompt_max_tokens`    | `240`        | Whitespace-token cap on the synthesized Whisper prompt.                                  |

### Vocab loading

When `~/.clip-forge/vocab.json` exists, the skill loads it and:

- **Deepgram branch.** Build the Deepgram `keywords` array via
  `bin/lib/vocab.mjs` `buildDeepgramKeywords(vocab)` and pass it as the
  `keywords` option of the deepgram MCP `transcribe` tool. After Deepgram
  returns, run the case-restore post-pass to canonicalise the transcript
  even when Deepgram's `keywords` boost did not produce the desired casing.
- **Whisper branch.** Pass `--vocab ~/.clip-forge/vocab.json` to
  `cf-whisper`. The wrapper builds the Whisper `--prompt` internally
  (`buildWhisperInitialPrompt`) AND applies the case-restore post-pass on
  the produced transcript.
- **Shared post-pass route.** To run case-restore on a transcript that
  already exists (e.g. Deepgram output written to disk), shell out:

  ```bash
  ${CLAUDE_PLUGIN_ROOT}/bin/cf-whisper \
    --apply-vocab-only \
    --in  ./uploads/<slug>/transcript.json \
    --out ./uploads/<slug>/transcript.json \
    --vocab ~/.clip-forge/vocab.json
  ```

  This reuses `bin/lib/vocab.mjs` without re-running ASR.

If `~/.clip-forge/vocab.json` is absent the skill does nothing extra. No
warning is emitted — missing vocab is the unset default.

### Canonical schema additions (transcript.json)

When `--vocab` was applied, transcript JSON carries an extra `vocab` block:

```json
{
  "vocab": {
    "applied": true,
    "restored_count": 1,
    "warnings": []
  }
}
```

When vocab load fails (file unreadable / malformed), the block records the
soft failure but transcription proceeds:

```json
{
  "vocab": {
    "applied": false,
    "error": "vocab_unreadable"
  }
}
```

When no `--vocab` was passed at all, the `vocab` field is omitted entirely.

### Testing

`cf-whisper` honors `CF_WHISPER_TRANSCRIPT_MOCK=<path>`. When set, the
wrapper does NOT invoke whisper.cpp; it reads the path as a canonical
transcript JSON, runs canonical-shape normalisation, and then applies the
vocab post-pass exactly as for a real ASR run. This is the entry point
used by `tests/integration/vocab.test.mjs` so CI runs green without
whisper.cpp installed. Modeled on `CF_CLIP_SCOUT_MOCK` from pillar (c).

### Graceful degradation

| Condition                                        | Behaviour                                                                                                              |
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| `~/.clip-forge/vocab.json` missing               | Skip vocab entirely. No warning. `transcript.vocab` is omitted.                                                        |
| Vocab JSON unreadable                            | Soft warning. `transcript.vocab = {applied:false, error:"vocab_unreadable"}`. Transcription proceeds without bias.     |
| Vocab > 100 terms                                | Soft warning `vocab_terms_truncated` recorded in the Deepgram keyword build path. `fallback_used` stays `false`.       |
| Whisper initial-prompt > 240 tokens              | Soft warning `vocab_terms_truncated`. Prompt truncated; transcription still runs.                                      |
| `--initial-prompt` (raw) > 240 tokens            | Stderr warning. Prompt truncated to 240 tokens. cf-whisper still exits 0.                                              |
| Silent input + vocab                             | `transcript.words = []`, `transcript.vocab.restored_count = 0`. Vocab MUST NOT inject brand terms into empty input.    |
