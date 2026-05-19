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
