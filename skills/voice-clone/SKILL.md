---
name: clip-forge-voice-clone
description: Capture a ~30 s sample from a source video, upload it to the selected TTS provider (ElevenLabs → Cartesia → Groq → Piper local), and persist the returned voice_id in voices.json — global (~/.clip-forge/voices.json) or per-project (./uploads/<slug>/voices.json, wins). Required precursor for /clip-forge:dub when the user wants their own voice rather than a generic catalog voice. Use when the user says "clone my voice", "use my voice for the dub", "set up voice clone", "register a voice", "save my voice", "saya mau pakai suara saya sendiri", "kloning suara", or runs /clip-forge:voice-clone.
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# /clip-forge:voice-clone

## Args

`$ARGUMENTS` = `<slug> [--sample-start-ms N] [--sample-end-ms N] [--voice-key <key>] [--provider elevenlabs|cartesia|groq|piper] [--uses csv] [--global]`

Defaults — chosen to make the first invocation a no-question wizard:

| Flag | Default | Purpose |
|---|---|---|
| `--sample-start-ms` | `0` | Start of the slice ffmpeg extracts from `source.mp4` |
| `--sample-end-ms` | `30000` | End of the slice (30 s ≥ provider clone minimums) |
| `--voice-key` | `creator-main` | Key under `voices.<key>` in voices.json |
| `--provider` | (auto) | Force a specific TTS adapter — overrides `CF_TTS_PROVIDER` |
| `--uses` | (empty) | Comma-separated use-tags, e.g. `hook,outro,dub-id` |
| `--global` | off | Write to `~/.clip-forge/voices.json` (default is per-project) |

## Bilingual UX

Voice cloning is the most-friction-prone slice in the v0.4.0 pillar. Surface
key prompts in BOTH Indonesian and English so the maintainer (and other
non-native English creators) can confirm the action without context-
switching.

When asking the user before destructive provider calls:

> **ID**: "Saya akan upload sample 30 detik ke {provider}. Sample ini akan
> dipakai untuk kloning suara permanen. Lanjut? (y/N)"
> **EN**: "I'm about to upload a 30 s sample to {provider}. This sample
> will be used to permanently clone the voice. Continue? (y/N)"

Use the `AskUserQuestion` tool with both languages embedded; never proceed
on `y/Y` alone — require an explicit affirmative.

## Inputs

| File | Required | Notes |
|---|---|---|
| `./uploads/<slug>/source.mp4` | yes (unless `--sample-path` is set) | The slice's source |
| `~/.clip-forge/voices.json` | optional | Existing global library — merged with per-project |

## Pipeline

1. Validate `source.mp4` exists.
2. Surface the bilingual consent prompt above. Abort cleanly on `N`.
3. Invoke the dispatcher:

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/bin/cf-voice-clone \
     --slug <slug> \
     --source ./uploads/<slug>/source.mp4 \
     --sample-start-ms ${sample_start_ms:-0} \
     --sample-end-ms   ${sample_end_ms:-30000} \
     --voice-key       ${voice_key:-creator-main} \
     ${provider:+--provider $provider} \
     ${uses:+--uses $uses} \
     ${global:+--global}
   ```

4. Read the dispatcher's `event: "done"` NDJSON line. Surface the result
   table (provider used, voice_id, voices.json path, voice_clone_supported).

## voices.json schema

```jsonc
{
  "version": 1,
  "default": "creator-main",
  "voices": {
    "creator-main": {
      "provider":    "elevenlabs",
      "voice_id":    "abc123",
      "sample_path": "/abs/path/voice-sample.wav",
      "created_at":  "2026-05-21T...",
      "uses":        ["hook", "outro", "dub-id", "dub-en"]
    }
  }
}
```

Resolution order (loader in `bin/lib/voices.mjs`):
1. `./uploads/<slug>/voices.json` — per-project (wins entirely; no merge).
2. `~/.clip-forge/voices.json` — global default.

## Graceful degrade

| Condition | Behavior |
|---|---|
| No TTS keys + Piper not installed | Dispatcher exits 0 with `fallback_used: true`, `fallback_reason: no_provider`. Skill surfaces the message; no voices.json mutation. |
| Groq selected (no clone) | Persists `provider: groq` + `voice_id: <default>` + `warning: voice_clone_disabled_groq`. Bilingual message: "Groq tidak support voice clone — pakai voice generik / Groq has no voice clone — using generic voice." |
| Piper selected (no clone) | Same shape with `warning: voice_clone_disabled_piper`. Sample file is staged into `~/.clip-forge/piper/voices/<key>.wav` for record-keeping. |
| ffmpeg slice fails | `fallback_used: true`, `fallback_reason: ffmpeg_slice_failed`. |

In every case the dispatcher exits 0 — the calling skill never crashes.

## Test injection

`CF_TTS_MOCK=<path>` short-circuits the clone API. The mock receives the
brief JSON on stdin and emits `{voice_id, cost_usd}` JSON on stdout —
deterministic, no network. Used by `tests/integration/voice-clone.test.mjs`.

## Failures

- Source missing → ❌ print path + abort.
- All providers absent + Piper missing → ⚠ ID/EN message + exit 0.
- Provider returned malformed JSON → ❌ print first 240 chars + abort.
