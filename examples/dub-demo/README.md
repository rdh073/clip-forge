# dub-demo — end-to-end /clip-forge:dub showcase

Mock-provider artifacts produced by `bin/cf-dub` to demonstrate the
v0.4.0 pillar 2 pipeline without burning real API keys.

## What's in this directory

| File | Origin |
|---|---|
| `uploads/demo/transcript.json` | Hand-curated 20s word-timed transcript (English source) |
| `uploads/demo/dub_report-id.json` | `cf-dub` Indonesian report — duration, cost estimate, voice metadata |
| `uploads/demo/dub_report-es.json` | `cf-dub` Spanish report |
| `clips/demo/c01/edit.dub-id.json` | Per-language render manifest variant — `{audio_source, dub: {...}}` |
| `clips/demo/c01/edit.dub-es.json` | Same shape for Spanish |
| `renders/demo/render_manifest.json` | Cumulative `ai_costs` ledger — every TTS charge tracked against `CF_AI_BUDGET_USD` |

The `dubbed-<lang>.wav` files are NOT committed — they're large binaries
that the mock regenerates deterministically. Reproduce them with the
command block below.

## Reproduce

```bash
cd <repo-root>
ELEVENLABS_API_KEY=sk-demo-mock \
CF_TTS_PROVIDER=elevenlabs \
CF_TTS_MOCK=./tests/mocks/tts-mock.mjs \
CF_TRANSLATE_MOCK=./tests/mocks/translate-mock.mjs \
node ./bin/cf-dub \
  --slug demo --clip-id c01 \
  --transcript ./examples/dub-demo/uploads/demo/transcript.json \
  --langs id,es \
  --source-lang en \
  --manifest ./examples/dub-demo/renders/demo/render_manifest.json
```

Expected output:
- `examples/dub-demo/uploads/demo/dubbed-id.wav` — ~30s placeholder WAV
- `examples/dub-demo/uploads/demo/dubbed-es.wav` — ~30s placeholder WAV
- `dub_report-{id,es}.json` rewritten with current timestamps
- `render_manifest.json.ai_costs` cumulative spend ≈ $0.085 (well under
  the $10 default cap)

To run against real providers, set `ELEVENLABS_API_KEY` to a real key
and unset `CF_TTS_MOCK` / `CF_TRANSLATE_MOCK`. Each provider's billing
hits your account directly — ClipForge brokers no traffic.

## Render handoff

After the dub artifacts exist, render the Indonesian variant:

```bash
node ./bin/cf-ffmpeg render \
  --manifest ./examples/dub-demo/clips/demo/c01/edit.dub-id.json
```

The renderer picks up `audio_source: ./uploads/demo/dubbed-id.wav` and
stamps `dub_languages: ["id"]` + `tts_nondeterministic: true` into the
emitted `render_report.json`.
