---
name: clip-forge-enhance
description: Denoise, de-reverb, optionally voice-isolate, and loudness-normalize ClipForge source audio to a social-ready -14 LUFS / -1.0 dBTP WAV. Writes enhanced.wav and enhance_report.json next to the source, then patches edit.json with audio_source when requested. Use when the user says "enhance audio", "denoise", "normalize loudness", "clean speech", or runs /clip-forge:enhance.
allowed-tools: Bash, Read, Write
---

# /clip-forge:enhance

## Args

`$ARGUMENTS` = `<slug|source-path> [--nr N] [--noise-floor-db DB] [--voice-isolate] [--edit-json <path>] [--force]`

Defaults:

| Flag | Default | Purpose |
|---|---:|---|
| `--nr` | `12` | `afftdn` noise reduction amount in dB. |
| `--noise-floor-db` | `-25` | Estimated noise floor for `afftdn`. |
| `--voice-isolate` | off | Optional Demucs vocals pre-pass. CPU/GPU behavior is Demucs-owned and opt-in. |
| `--no-noise-gate` | off | Skip the adaptive post-denoise gate that suppresses residual room/noise bed. |
| `--edit-json` | unset | Patch a clip manifest with `"audio_source": "./uploads/<slug>/enhanced.wav"`. |
| `--force` | off | Re-run even when `enhanced.wav` and `enhance_report.json` already exist. |

Resolve `<slug>` to `./uploads/<slug>/source.mp4`. If the argument is an
existing file path, use it directly.

## Pipeline

Call:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-enhance \
  --in ./uploads/<slug>/source.mp4 \
  --out ./uploads/<slug>/enhanced.wav \
  --report ./uploads/<slug>/enhance_report.json \
  --nr ${nr:-12} \
  --noise-floor-db ${noise_floor_db:--25} \
  ${no_noise_gate:+--no-noise-gate} \
  ${voice_isolate:+--voice-isolate} \
  ${edit_json:+--edit-json "$edit_json"}
```

`cf-enhance` runs:

1. Optional Demucs voice-isolation pre-pass when `--voice-isolate` is set and
   `demucs` is installed.
2. `afftdn=nr=<nr>:nf=<noise-floor-db>`.
3. `arnndn=m=bin/models/cb.rnnn` when the model exists and ffmpeg supports
   the `arnndn` filter.
4. Adaptive `agate` noise-floor suppression so `loudnorm` does not lift the
   residual noise bed back up after denoise.
5. `dialoguenhance` as a best-effort speech clarity / de-reverb stage.
6. Two-pass `loudnorm=I=-14:TP=-1.0:LRA=11`.

## Output

`./uploads/<slug>/enhanced.wav`

`./uploads/<slug>/enhance_report.json`:

```json
{
  "version": 1,
  "input": "./uploads/demo/source.mp4",
  "output": "./uploads/demo/enhanced.wav",
  "integrated_loudness": -14.0,
  "true_peak": -1.1,
  "lra": 7.4,
  "noise_reduction_db": 14.2,
  "filters": {
    "afftdn": { "enabled": true, "nr": 12, "noise_floor_db": -25 },
    "rnnoise": { "enabled": true, "model": ".../bin/models/cb.rnnn" },
    "noise_gate": { "enabled": true, "filter": "agate", "threshold": 0.03 },
    "dereverb": { "enabled": true, "filter": "dialoguenhance" },
    "voice_isolate": { "requested": false, "enabled": false },
    "loudnorm": { "target_i": -14, "target_tp": -1, "target_lra": 11 }
  },
  "fallback_used": false,
  "fallback_reason": null,
  "warnings": []
}
```

## Graceful Degradation

| Condition | Behavior |
|---|---|
| `cb.rnnn` missing | Skip RNNoise, run `afftdn` + `dialoguenhance` + `loudnorm`, write warning. |
| ffmpeg lacks `arnndn` | Skip RNNoise, write warning. |
| `--voice-isolate` passed but `demucs` missing | Skip voice isolation, write warning. |
| Demucs fails | Continue from original source, write warning. |
| Input missing or no audio stream | Exit 0, write valid `enhance_report.json` with `fallback_used: true`. |
| Post-loudnorm true peak exceeds `-1.0 dBTP` | Retry with lower TP targets; if still unsafe, remove output and report fallback. |

In every documented degradation path, `cf-enhance` exits 0 and writes a valid
JSON report so downstream skills can decide whether to use `enhanced.wav`.

## Render Handoff

When an enhanced WAV exists, add this to the clip manifest:

```json
{
  "audio_source": "./uploads/<slug>/enhanced.wav"
}
```

`bin/cf-ffmpeg render` uses `audio_source` for the audio stream while keeping
the original video source for reframe/caption rendering.

## Display

```text
✅ enhanced audio: -14.0 LUFS · -1.1 dBTP · noise -14.2 dB
   rnnoise=on · dereverb=dialoguenhance · voice-isolate=skipped
```
