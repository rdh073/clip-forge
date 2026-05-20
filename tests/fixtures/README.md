# Test fixtures

`bin/lib/face-detector.test.mjs` runs MediaPipe against two RGB fixture
frames. The raw `.rgb` files aren't committed (they're large and derived);
instead you drop two PNG sources here and run the build step:

1. `tests/fixtures/single-face.png` — any photo with a clearly visible
   frontal face. ≥320×240. CC0 / your own / a press kit photo is fine —
   anything you're allowed to commit.
2. `tests/fixtures/empty-room.png` — any indoor scene without people.

Then:

```bash
npm run build-fixtures
```

This generates `single-face.rgb`, `empty-room.rgb`, and `dims.json` (which
records the canonical 320×240 frame size for the test code to read).

The fixture-dependent tests are **skipped** (not failed) when the `.rgb`
files are absent — so `npm test` is green on a fresh checkout even before
you've sourced fixtures. The CI matrix runs in skip-mode too; only an
explicit "with-fixtures" job (added when you supply fixtures) exercises
real detection.

## Audio enhancement fixture

`noisy-speech-5s.mp4` is a committed synthetic fixture for
`tests/integration/enhance.test.mjs`. It contains four seconds of a loud
speech-like tone over stationary white noise, followed by one second of noise
only. The final second is the deterministic noise-floor window used to assert
that `bin/cf-enhance` produces a normalized WAV with at least 12 dB lower RMS
noise than the input.

Regenerate it with:

```bash
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i color=c=black:s=320x240:r=30:d=5 \
  -f lavfi -i sine=frequency=440:duration=4:sample_rate=48000 \
  -f lavfi -i anullsrc=r=48000:cl=mono:d=1 \
  -f lavfi -i anoisesrc=color=white:amplitude=0.25:duration=5:sample_rate=48000 \
  -filter_complex "[1:a][2:a]concat=n=2:v=0:a=1[tone];[tone]volume=0.8[tonev];[tonev][3:a]amix=inputs=2:duration=first:normalize=0[a]" \
  -map 0:v -map "[a]" \
  -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -shortest \
  tests/fixtures/noisy-speech-5s.mp4
```
