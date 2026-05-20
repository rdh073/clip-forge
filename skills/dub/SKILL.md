---
name: clip-forge-dub
description: Translate the source transcript into one or more target languages and synthesize aligned-timeline TTS audio per language, producing ./uploads/<slug>/dubbed-<lang>.wav plus a per-language edit.dub-<lang>.json variant ready for render. Uses the configured voice from voices.json (per-project wins) or a generic catalog voice if voice-clone hasn't been run. Use when the user says "dub this in Indonesian", "make Spanish and French versions", "translate the clip", "buat versi bahasa Indonesia", "multi-language dub", "dubbing", or runs /clip-forge:dub.
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# /clip-forge:dub

## Args

`$ARGUMENTS` = `<slug> <clip-id> --langs <csv> [--source-lang en|id|...] [--voice-key <key>] [--yolo]`

Example: `/clip-forge:dub podcast-ep-42 c01 --langs id,en,es,fr,ja`

| Flag | Default | Purpose |
|---|---|---|
| `--langs` | (required) | Comma-separated BCP-47 language codes (`id,en,es,fr,ja`) |
| `--source-lang` | `en` | Source transcript language |
| `--voice-key` | (auto) | Pick a specific voice from voices.json by key |
| `--yolo` | off | Silent skip at 100% budget instead of AskUserQuestion |

## Inputs

| File | Required | Notes |
|---|---|---|
| `./uploads/<slug>/transcript.json` | yes | Word-timed (Whisper or Deepgram shape) |
| `./clips/<slug>/<clip-id>/edit.json` | optional | Per-lang variants merge on top of this |
| `~/.clip-forge/voices.json` | optional | Global voice library |
| `./uploads/<slug>/voices.json` | optional | Per-project override (wins) |

## Pipeline

1. Resolve TTS provider per `bin/lib/tts.mjs` precedence:
   `ELEVENLABS_API_KEY → CARTESIA_API_KEY → GROQ_API_KEY → Piper local`.
2. Resolve voice for `uses: "dub-<lang>"` (falls back to `voices.default`).
3. Load `render_manifest.json.ai_costs` — refuses to start if
   `cumulative_usd ≥ budget_cap_usd` and `--yolo` not set.
4. For each `<lang>`:
   - Translate transcript (via `bin/lib/translate.mjs` — mock + offline
     fallback path; real LLM lands in pillar 4).
   - Window into sentences (~14 words or punctuation boundary).
   - Synthesize each window via `tts.synthesize` → cache to
     `./uploads/<slug>/dub-chunks-<lang>/wNNNN.wav`.
   - Concat into `./uploads/<slug>/dubbed-<lang>.wav` aligned to source
     `start_ms`. D3 invariant: dubbed ≈ source ±200 ms; pad silence
     when shorter, warn when longer.
   - Write `./uploads/<slug>/dub_report-<lang>.json`.
   - Write `./clips/<slug>/<clip-id>/edit.dub-<lang>.json` —
     `{audio_source, dub: {source_lang, target_lang, voice_id, provider, report}}`.
5. Update `./renders/<slug>/render_manifest.json.ai_costs`.

Invocation:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-dub \
  --slug <slug> \
  --clip-id <clip-id> \
  --transcript ./uploads/<slug>/transcript.json \
  --langs <csv> \
  --source-lang ${source_lang:-en} \
  ${voice_key:+--voice-key $voice_key} \
  ${yolo:+--yolo}
```

## Budget enforcement (PLAN-v0.4.0 §7 Q4)

`CF_AI_BUDGET_USD` is cumulative across the entire `/clip-forge:start`
invocation chain via `render_manifest.json.ai_costs.cumulative_usd`.

- **80 % checkpoint** — dispatcher emits `event: budget_checkpoint` on
  stdout when crossing the 80 % line. The skill asks the user via
  `AskUserQuestion`:

  > **ID**: "Biaya saat ini ${used} dari ${cap}. Naikkan cap ke $20? (y/N)"
  > **EN**: "Cost so far ${used} of ${cap}. Raise the cap to $20? (y/N)"

  `y` → re-invoke with `CF_AI_BUDGET_USD=20`; `N` → graceful finish.
- **100 % hard-stop** — further TTS calls inside the dispatcher refuse
  and append to `ai_costs.skipped[]` with `reason: "budget_exhausted"`.
  `--yolo` → silent skip (no AskUserQuestion).

## Graceful degrade matrix

| Condition | Behavior |
|---|---|
| No TTS keys AND Piper not installed | Dispatcher writes empty `dub_report-<lang>.json` with `fallback_reason: no_tts_provider`. Exit 0. |
| Translate provider absent + no mock | Per-lang report `fallback_reason: no_translate_provider`. Other langs untouched. |
| Single chunk TTS fails | Silence-pad that window, continue. `dub_report.tts_skipped` counter increments. |
| Empty translated transcript | Write a silent `dubbed-<lang>.wav` of `duration_source_ms`. `hallucination_guard: true`. |

## Output schema — `dub_report-<lang>.json`

```jsonc
{
  "version": 1,
  "schema":  "dub_report.v1",
  "slug": "podcast-ep-42",
  "clip_id": "c01",
  "source_lang": "en", "target_lang": "id",
  "provider": "elevenlabs", "voice_key": "creator-main",
  "voice_id": "abc123", "voice_clone_used": true,
  "tts_nondeterministic": true,
  "dubbed_path": "/abs/path/dubbed-id.wav",
  "duration_source_ms": 46000, "duration_dubbed_ms": 45820,
  "drift_ms": -180,
  "cost_usd_estimate": 0.087,
  "tts_calls": 12, "tts_skipped": 0,
  "budget_exhausted": false,
  "fallback_used": false, "fallback_reason": null,
  "warnings": [],
  "generated_at": "2026-05-21T..."
}
```

## Render handoff

After this skill finishes, run `/clip-forge:render` with the per-lang
variant:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-ffmpeg render \
  --manifest ./clips/<slug>/<clip-id>/edit.dub-<lang>.json
```

The renderer picks up `audio_source` and stamps `dub_languages: ["<lang>"]`
+ `tts_nondeterministic: true` into the render report.

## Test injection

| Env var | Effect |
|---|---|
| `CF_TTS_MOCK=<path>` | Every TTS call routes through the mock |
| `CF_TRANSLATE_MOCK=<path>` | Every translate call routes through the mock |
| `CF_AI_BUDGET_USD=N` | Cap testing — set to 0.50 to trigger 100% hard-stop early |
| `CF_TTS_PROVIDER=<name>` | Force a specific provider (overrides precedence) |

Realistic-mock contract — TTS mocks MUST emit WAVs whose duration matches
input text length (`1 word ≈ 400 ms`, ±50 ms tolerance). Translate mocks
MUST preserve word `start_ms` / `end_ms` from the source transcript.
