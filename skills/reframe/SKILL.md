---
name: clip-forge-reframe
description: Generate a 16:9 → 9:16 face-tracked crop path for a selected clip using MediaPipe face detection with Kalman smoothing. Writes ./clips/<slug>/<clip-id>/crop_path.json. Use when the user says "reframe", "make it vertical", runs /clip-forge:reframe, or when /clip-forge:start enters the reframe step.
allowed-tools: Bash, Read, Write, Agent
---

# /clip-forge:reframe

## Args

`$ARGUMENTS` = `<slug> <clip-id> [--mode face|object|center] [--fps 4]`

Default `mode=face`, sampling at `4 fps` (computed crop is interpolated to
the source fps at render time).

## Inputs

- `./uploads/<slug>/source.mp4`
- `./clips/<slug>/candidates.json` (to look up `start_ms` / `end_ms`)

## Pipeline

Delegate the "how" question to the **reframe-engineer** agent (face-track vs
object-track, pan-speed limits, when to letterbox) using the Agent tool with:

```
You are reframe-engineer. For clip <clip-id> (<duration>s, niche=<niche>),
choose:
- mode: face | object | center
- max_pan_px_per_sec: integer
- letterbox_when: rule (e.g. "two speakers >40% apart horizontally")
Reply STRICT JSON.
```

Then run the actual detection via `bin/cf-reframe`:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-reframe \
  --in ./uploads/<slug>/source.mp4 \
  --start-ms $START --end-ms $END \
  --mode $MODE --fps $FPS \
  --max-pan-px-s $MAX_PAN \
  --out ./clips/<slug>/<clip-id>/crop_path.json
```

`cf-reframe`:
1. Extracts an audio-stripped, downscaled (480p) sample at `--fps`.
2. Runs MediaPipe face landmarker per sample frame.
3. Picks the dominant face (largest area, weighted by center distance).
4. Kalman-smooths the bbox center over time (Q=1e-3, R=1e-1).
5. Clamps pan velocity to `max_pan_px_s`.
6. Falls back to OpenCV Haar if MediaPipe init fails; prints ⚠.
7. If no face detected for >1.5s of the clip, emits letterbox segments.

## Output schema — `crop_path.json`

```json
{
  "version": 1,
  "clip_id": "c01",
  "source_w": 1920,
  "source_h": 1080,
  "target_w": 1080,
  "target_h": 1920,
  "mode": "face",
  "samples": [
    { "t_ms": 0,    "cx": 940,  "cy": 540, "scale": 1.78, "letterbox": false },
    { "t_ms": 250,  "cx": 945,  "cy": 540, "scale": 1.78, "letterbox": false }
  ],
  "interp": "linear",
  "fallback_used": false
}
```

`scale` is the multiplier applied to `target_h` to determine source-crop
height (`crop_h = target_h / scale`), centered on `(cx, cy)`.

## Output

```
✅ reframed c01: 184 samples · 0 letterbox · max-pan 67px/s
```

## Failures

- MediaPipe model not cached → cf-reframe downloads once to
  `~/.clip-forge/models/face_landmarker.task`; print ⏳ on first run.
- All frames detect zero faces → fall back to `--mode center` automatically
  and ⚠ note "no faces detected — using center crop".
