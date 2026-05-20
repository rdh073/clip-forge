# PLAN — ClipForge v0.3.0

**Status:** DRAFT — planning only, no code yet.
**Author:** clip-forge core (2026-05-20).
**Predecessor:** [docs/ROADMAP.md](ROADMAP.md), [docs/REVIEW.md](REVIEW.md),
[docs/bench-v0.2.0.md](bench-v0.2.0.md), [CHANGELOG.md](../CHANGELOG.md).
**Scope:** OUTPUT-QUALITY parity with OpusClip — bring the rendered MP4
indistinguishably close to an Opus output. UI / browser / timeline editor
explicitly out of scope. Local-first, scriptable, free, no-upload moat is
the unchanged north star.

> The existing roadmap's v0.3.0 ("license hardening + detection speed-up")
> remains valid but is **separately tracked**. This plan adds the
> OUTPUT-QUALITY pillar. Both slices ship under the v0.3.0 minor; the
> license-hardening + perf slice is mechanically smaller and lands first.

---

## 1. Gap analysis — ClipForge v0.2.0 vs OpusClip (output-quality features)

Legend — Complexity: S=≤300 LOC ≤2d · M=≤700 LOC ≤5d · L=≤1500 LOC ≤2w · XL>1500 LOC.

| # | Feature pillar                                              | ClipForge v0.2.0 today                                                                 | Opus parity gap                                                                                  | Complexity | LOC  | Dependencies                                                                                              | Risk                                                                                                                                          | Target  |
|---|-------------------------------------------------------------|----------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|------------|------|-----------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|---------|
| a | Filler-word & silence removal                               | None. Clips include "um/uh/like" + dead air.                                           | Word-timed cut plan + render that splices `select`/`concat`.                                     | M          | ~700 | ffmpeg `silencedetect`, `aselect`, `setpts`/`asetpts`, `concat`. Static filler-word list (en→i18n later). | Concat over many micro-segments can desync A/V if PTS reset is sloppy. Mitigation: render audio + video together through one filter_complex.   | v0.3.0  |
| b | Speech enhance / denoise / loudness norm                    | None. Source audio passes through untouched.                                           | Two-pass `loudnorm` to -14 LUFS, `afftdn` or RNNoise denoise pre-loudnorm.                       | S          | ~430 | ffmpeg `loudnorm` (two-pass), `afftdn` (built-in) or `arnndn` filter + RNNoise ONNX model (CC-by, 80 KB). | RNNoise model fetch adds 80 KB to `install-models.mjs`. Skip cleanly when model missing — `afftdn` alone is a real fallback (no model needed). | v0.3.0  |
| c | Prompt-based clipping ("ClipAnything")                      | clip-scout picks generically by virality score; no topical steering.                   | `--prompt <topic>` flag → scout filters/biases candidates to the topic.                          | S          | ~150 | None new — pure agent-prompt extension.                                                                   | Agent may over-filter and return 0 candidates. Mitigation: fall back to virality-sorted top-N with ⚠ note.                                    | v0.3.0  |
| d | Manual reframe / subject pin override                       | `--speaker-map` only (per-speaker static region). No per-time override.                | `pin_overrides.json` co-input: `[{t_start_ms,t_end_ms,cx,cy,radius?}, …]`, scorer respects it.   | M          | ~500 | None new — cf-reframe additive flag + active-speaker.mjs override hook.                                   | Schema sprawl on crop_path. Mitigation: keep override file separate; render reads only crop_path.                                              | v0.4.0  |
| e | Brand vocabulary (custom transcription dictionary)          | None. Proper nouns mangled.                                                            | `~/.clip-forge/vocab.json`; Deepgram `keywords`, Whisper `--initial-prompt`.                     | S          | ~200 | Deepgram MCP param; whisper.cpp `--prompt`.                                                               | Whisper bias from initial-prompt is fuzzy; can hallucinate. Mitigation: cap prompt at 240 tokens, document caveat.                            | v0.3.0  |
| f | Intro / outro stinger templates                             | `templates/intros/` is empty; edit.json has `intro`/`outro` fields but nothing wires.  | Ship 2–3 Remotion-rendered stinger MP4s + `cf-ffmpeg concat` step.                              | M          | ~600 | Remotion CLI (already a soft dep via thumbnails comp), node 20+, ffmpeg `concat` demuxer.                 | Remotion install footprint is large; keep CLI invocation optional, pre-render assets and ship as binary artifacts.                            | v0.5.0  |
| g | XML export (Premiere / DaVinci handoff)                     | None.                                                                                  | FCP7 XML (`.fcpxml` v1.10) emitter or simple EDL `.edl` from edit.json.                          | L          | ~1200| FCP7 XML schema; xmlbuilder2 npm (MIT, no native).                                                        | FCP7 XML is fiddly; partial support is worse than none. Mitigation: ship `.edl` first (text format, trivial), `.fcpxml` follows.              | v0.5.0  |
| h | Speaker diarization for multi-speaker reframe               | Deepgram diarizes; transcript carries `speaker` per word. Reframe does not auto-route. | Reframe consumes per-speaker timeline; renders split-screen letterbox when ≥2 speakers active.   | M          | ~650 | Existing transcript schema; cf-reframe `--speaker-route auto`.                                            | Whisper diarize quality is patchy. Mitigation: feature requires Deepgram OR opt-in `--diarize sherpa` (v0.4.0 add).                           | v0.4.0  |
| i | Hook overlay + progress bar + dynamic emoji captions        | Captions JSON has emoji-per-line + highlight flags but renderer doesn't burn overlays. | ASS overlay for hook text in first ≤2s; ffmpeg `drawbox` progress bar; emoji burned per line.    | M          | ~450 | ffmpeg `drawbox`, `drawtext`, ASS layers. Noto Emoji ttf (SIL OFL, 8 MB).                                 | drawtext + emoji needs fontconfig set up cross-platform. Mitigation: render emojis through ASS only (already proven path).                    | v0.3.0  |
| j | Real OAuth publish (TikTok → YT Shorts → IG Reels)          | MCP stubs return `auth_required`.                                                      | TikTok Content Posting API, YouTube Data API v3 resumable, Instagram Graph reel container.       | L          | ~1400| TikTok developer review; Google OAuth client; FB developer app; loopback HTTP server for auth dance.      | Each platform gates on developer-program approval the maintainer has to obtain. Mitigation: implement per-platform; release as each lands.    | v0.4.0  |

### Pillars NOT in the user's list but worth flagging

- **A/V re-sync on cuts.** Once we cut filler words, we need a smoke test that
  asserts audio energy aligns with mouth motion (PFLD already gives us mouth-y
  per frame — cheap reuse).
- **VTT/SRT sidecar export.** OpusClip emits SRT for download; we already
  build the word timing, ~20 LOC. Bundle into pillar (b).
- **Aspect-ratio profiles.** Beyond 9:16, OpusClip supports 1:1 and 4:5. We
  already accept `--target-aspect` on cf-reframe but render hard-codes
  1080×1920. ~50 LOC to plumb through edit.json. Bundle into pillar (i).

---

## 2. v0.3.0 milestone — 5 highest-leverage picks

Selection criteria (in order): (1) measurable visible/audible jump in output
quality, (2) honors the moat — local, scriptable, free, no required new SaaS
keys, (3) complexity ≤ M (one minor slice), (4) extends the existing
edit.json / crop_path.json / transcript.json schemas, never forks.

| Pick                                            | Why it wins on the moat                                                                                                                                                                                                                              |
|-------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **a. Filler-word + silence removal**            | Single biggest perceptible-quality jump per LOC. Pure-CPU (transcript-driven cut plan + ffmpeg). No new SaaS. The viral-shorts audience is *only* watching pruned audio — shipping this alone closes ~40 % of the perceived Opus gap.                |
| **b. Speech enhance: 2-pass loudnorm + denoise**| ffmpeg-native (`loudnorm`, `afftdn`) is free, CPU, no model needed for the loudnorm half. RNNoise model is 80 KB MIT-licensed for the denoise half — graceful-degrade-to-`afftdn` if missing. Brings clip audio to -14 LUFS social standard.         |
| **c. Brand vocabulary (custom dictionary)**     | ~200 LOC; pure config wiring on both transcribe branches. Niche creators (founders, brand names, product names) get correct transcription for the first time. Pure cost-aware: vocab.json is the user's own data, no API key needed.                 |
| **e. Prompt-based clipping `--prompt`**         | The cheapest of the lot (~150 LOC, pure prompt-engineering). Lifts ClipForge from "pick virality" to "find clips about X" — Opus's "ClipAnything" parity. The agent + transcript already exist; we're unlocking latent capability, not building new. |
| **i. Hook overlay + progress bar + emoji burn** | Closes the *visual* parity gap that everyone notices first. All ffmpeg-native, no new models. The caption-stylist already emits emoji/highlight metadata — renderer just has to honor it. Bundle in 1:1 / 4:5 aspect plumbing while we're in there.  |

### Explicitly deferred from v0.3.0

| Pick | Defer to | Reason |
|------|----------|--------|
| d. Manual reframe pin override          | v0.4.0 | Depends on a `pin_overrides.json` editor flow we haven't designed; manual override is power-user, not first-impression quality. |
| f. Intro/outro stinger templates        | v0.5.0 | Requires shipping Remotion-rendered MP4 assets and finalizing a brand-kit story. Low leverage — most viral creators skip stingers. |
| g. XML export                           | v0.5.0 | Large, niche audience, partial support is worse than none. Ship `.edl` (trivial) bundled with v0.5.0's pro-export slice. |
| h. Speaker-aware reframe auto-route     | v0.4.0 | Whisper diarization quality is patchy; gate on Deepgram-only would split the user base. Ship after sherpa-onnx-VAD diarize. |
| j. Real OAuth publish                   | v0.4.0 | Each platform gates on developer-program approval the maintainer must obtain. Per-platform release as approvals land. |

### Out-of-scope this plan (already on the v0.3.0 perf+licensing track)

- PFLD int8 quantization, worker-thread pool, MobileNet PFLD swap. See
  `docs/ROADMAP.md` v0.3.0 "Detection speedup".
- cunjian PFLD license replacement. See `docs/ROADMAP.md` v0.3.0 "License hardening".
- W-1 backpressure on frame extractor, W-2 numerical-correctness tests,
  W-4/W-5 CLI ergonomics. See `docs/REVIEW.md`.

These continue independently and merge into the same v0.3.0 tag.

---

## 3. Design — additive schema extensions only (no forks)

### 3.1 `edit.json` — additive fields

```jsonc
{
  "version": 1,                       // unchanged
  "clip_id": "c01",
  "start_ms": 252000,
  "end_ms": 298000,
  "crop_path": "./.../crop_path.json",
  "captions": "./.../captions.ass",
  "broll":    "./.../broll.json",
  "music":    "./.../music.json",
  "watermark": "~/.clip-forge/assets/logo.png",
  "intro":     null,
  "outro":     null,
  "output":    "./renders/<slug>/c01.mp4",
  "quality":   "high",

  // v0.3.0 additions — all optional, ignored by v0.2.0 readers
  "cuts":            "./.../cuts.json",       // pillar (a) — filler/silence cut plan
  "audio_enhanced":  "./.../audio.norm.wav",  // pillar (b) — replaces 0:a track
  "hook_overlay":    { "text": "Nobody tells you this", "end_ms": 1800 },  // pillar (i)
  "progress_bar":    { "enabled": true, "color": "#ffffff", "height_px": 8 },// pillar (i)
  "target_aspect":   "9:16"                   // pillar (i) bonus — propagate from crop_path
}
```

### 3.2 New artifact: `cuts.json` (pillar a)

```jsonc
{
  "version": 1,
  "clip_id": "c01",
  "source_duration_ms": 46000,
  "output_duration_ms": 39200,
  "segments_kept": [
    { "src_start_ms": 0,     "src_end_ms": 4280  },
    { "src_start_ms": 4620,  "src_end_ms": 11920 }
  ],
  "segments_cut": [
    { "src_start_ms": 4280,  "src_end_ms": 4620,
      "reason": "filler_word", "word": "um" },
    { "src_start_ms": 8900,  "src_end_ms": 9540,
      "reason": "silence",     "rms_db": -52 }
  ],
  "filler_dict_version": "en-v1",
  "silence_threshold_db": -40,
  "min_silence_ms": 600
}
```

### 3.3 Skill / bin / agent inventory

| Component                                     | Action       | Pillar      |
|-----------------------------------------------|--------------|-------------|
| `bin/cf-trim` (new)                           | create       | a           |
| `bin/cf-audio` (new)                          | create       | b           |
| `bin/cf-ffmpeg` (existing)                    | extend `render` to honor `cuts` + `audio_enhanced` + `hook_overlay` + `progress_bar` | a, b, i |
| `bin/lib/filler-dict.mjs` (new, data + helper)| create       | a           |
| `bin/lib/cuts-planner.mjs` (new)              | create       | a           |
| `bin/lib/loudnorm.mjs` (new)                  | create       | b           |
| `bin/cf-whisper` (existing)                   | add `--initial-prompt` plumb | c |
| `bin/install-models.mjs` (existing)           | add optional RNNoise download | b |
| `skills/trim/SKILL.md` (new)                  | create       | a           |
| `skills/enhance/SKILL.md` (new)               | create       | b           |
| `skills/transcribe/SKILL.md` (existing)       | wire `vocab.json` → both branches | c |
| `skills/clip/SKILL.md` (existing)             | add `--prompt` arg | e   |
| `skills/render/SKILL.md` (existing)           | document new edit.json fields | a, b, i |
| `skills/start/SKILL.md` (existing)            | insert trim + enhance between transcribe & clip | a, b |
| `agents/clip-scout.md` (existing)             | accept topic prompt | e     |
| `agents/caption-stylist.md` (existing)        | mark hook span on output | i |
| `~/.clip-forge/vocab.json` schema             | document     | c           |
| `tests/integration/trim.test.mjs` (new)       | positive evidence (see §4) | a |
| `tests/integration/enhance.test.mjs` (new)    | positive evidence | b   |
| `tests/integration/vocab.test.mjs` (new)      | positive evidence | c   |
| `tests/integration/clip-prompt.test.mjs` (new)| positive evidence | e   |
| `tests/integration/overlay.test.mjs` (new)    | positive evidence | i   |

### 3.4 Pipeline order in `/clip-forge:start`

```
1. onboard          (unchanged)
2. import           (unchanged)
3. transcribe       (consumes vocab.json — pillar c)
4. enhance          ⟵ NEW (pillar b)            writes uploads/<slug>/audio.norm.wav
5. trim             ⟵ NEW (pillar a)            writes clips/<slug>/<clip-id>/cuts.json
6. clip             (now accepts --prompt — pillar e)
7. reframe          (unchanged)
8. caption          (caption-stylist emits hook span — pillar i)
9. broll + music    (unchanged)
10. render          (honors cuts + audio_enhanced + hook_overlay + progress_bar)
11. publish         (unchanged stubs — v0.4.0 work)
```

Important: **trim runs AFTER clip-scout chooses boundaries** is also valid
and arguably faster (fewer words to scan), but running it BEFORE saves the
scout from picking a clip whose hook is buried under "um". We will A/B both
orderings against the success-path fixture during implementation; current
plan defaults to the order shown above (transcribe → enhance → trim →
clip), with the trim plan applied per-clip at render time via
filter-graph splicing, not at source.

---

## 4. Test contract — positive-evidence integration tests

Following the pattern of `tests/integration/success-path.test.mjs`. Every
test asserts the *effect*, not the *exit code*.

### 4.1 `tests/integration/trim.test.mjs` (pillar a)

- Fixture: a 10-second talking-head with two scripted "um" insertions and one
  1.2 s silent gap (build via existing `tests/fixtures/build-fixtures.mjs`
  extended).
- Assertions:
  - `cuts.json.segments_cut.length === 3`
  - one cut has `reason === "filler_word"` with `word === "um"`
  - one cut has `reason === "silence"` and `(end-start) >= 600`
  - rendered MP4 duration < source duration − 1.5 s (proves cuts applied)
  - rendered MP4 audio waveform contains no "um" hit at the original
    timestamps (cheap proxy: assert RMS at original-um timestamps ≤ -45 dB
    after PTS remap)

### 4.2 `tests/integration/enhance.test.mjs` (pillar b)

- Fixture: existing 5-s talking-head; sister fixture with white-noise floor
  mixed at -25 dBFS (built via existing fixtures script).
- Assertions:
  - `audio.norm.wav` exists, sample-rate 48 000, bit-depth 16
  - measured integrated loudness via `ffmpeg -af ebur128 -f null -` is
    -14 ± 1.0 LUFS (proves loudnorm two-pass ran with target params)
  - noise floor RMS in the silent tail < -50 dBFS (proves denoise reduced it
    by ≥ 25 dB)
  - skip-on-RNNoise-missing branch still produces a valid `audio.norm.wav`
    via `afftdn` alone, and writes `enhance.json` with `denoiser: "afftdn"`
    so the success path is observable.

### 4.3 `tests/integration/vocab.test.mjs` (pillar c)

- Fixture: 3-s clip with the spoken word "ClipForge" (currently transcribed
  as "clip force" or "clip-forge").
- Assertions:
  - With `vocab.json` containing `"ClipForge"`, the transcript contains
    `"ClipForge"` as a word (case-preserving).
  - Without vocab, transcript contains the misspelled form. (This proves
    vocab is the cause; not just that the word happened to land right.)
- Skips cleanly if Deepgram key absent AND whisper.cpp absent.

### 4.4 `tests/integration/clip-prompt.test.mjs` (pillar e)

- Fixture: synthesized 60-s transcript JSON (no audio needed) with three
  topic blocks: "fitness", "career", "cooking".
- Assertions:
  - Without `--prompt`, candidate IDs span all three topics.
  - With `--prompt "career advice"`, returned candidates' `transcript_excerpt`
    fields all match `/career|job|quit|salary/i`; no fitness/cooking topics.
  - Edge: `--prompt "underwater basket weaving"` (no match) → response has
    `candidates.length === 0` and a `warning: "no candidates matched prompt"`
    field; success path is "honest empty" not "fall back silently".
- Uses a mock agent stub (no real API call) so the test runs in CI.

### 4.5 `tests/integration/overlay.test.mjs` (pillar i)

- Fixture: existing 5-s talking-head.
- Assertions:
  - With `hook_overlay: {text:"Nobody tells you this", end_ms:1800}`:
    sample frame at t=0.5 s contains a high-luminance horizontal band in the
    upper third (cheap proxy: average luminance of a 20-px-tall row in the
    upper third > +30 over baseline frame at t=4.0 s).
  - With `progress_bar.enabled: true`: bottom 8 px row at t=2.5 s has more
    fill than at t=0.5 s (sum of pixel luminance ratio ≥ 1.5 ×).
  - Both overlays absent if not enabled (baseline frame matches v0.2.0
    success-path render byte-for-byte sans the new filter chain).

### 4.6 Graceful-degradation contract (mirrors cf-reframe)

Every new `bin/cf-*` script must:
- Exit 0 on every documented failure path.
- Write a valid JSON artifact recording `fallback_used: true/false` and a
  `fallback_reason` string when degraded.
- Never break a downstream consumer — e.g. if `cf-trim` finds zero filler
  words and zero silence segments, it still writes a `cuts.json` with
  empty `segments_cut[]` and the renderer is unaffected.

---

## 5. Risks & mitigations

| Risk                                                                                                  | Mitigation                                                                                                                                                                              |
|-------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Concatenating many micro-segments via ffmpeg `aselect`/`select`+`concat` desyncs A/V at boundaries.   | Use a single `filter_complex` graph with paired `aselect`/`select` and shared `setpts=PTS-STARTPTS` so audio and video re-clock identically. Integration test asserts duration parity.  |
| Two-pass loudnorm doubles render time on long sources.                                                | Run enhance once on the *source* (not per clip); cache `audio.norm.wav`. Per-clip render slices the cached track.                                                                       |
| RNNoise ONNX licence text drift on upstream CDN.                                                      | Pin a specific commit hash in `install-models.mjs`; download via raw URL with sha256 verification (real one this time — no fictional placeholder).                                      |
| Filler-word dictionary balloons to a multilingual feature unintentionally.                            | Ship `en-v1.json` only in v0.3.0. Public schema accepts `{ lang, words[] }`; community PRs add `id-v1`, `es-v1`, etc. Mark non-English as best-effort.                                  |
| Prompt-based clipping degrades scout's virality scoring on broad prompts.                             | Two-pass: filter to prompt-matched clips first, then re-rank by virality within the filtered set. Document the trade in `skills/clip/SKILL.md`.                                        |
| Hook overlay text bleeds outside 9:16 safe area.                                                      | Caption-stylist already knows the platform's safe area for caption layout; reuse the same margins for hook overlay. Add a unit test on the geometry.                                    |
| `vocab.json` initial-prompt injection on Whisper hallucinates the brand name into silence.            | Cap initial-prompt at 240 tokens. Add a regression test on a silent fixture: assert transcript words list is empty even when vocab contains "ClipForge".                                |

---

## 6. LOC budget summary

| Pick                                              | New | Modified | Tests | Subtotal |
|---------------------------------------------------|-----|----------|-------|----------|
| a. Filler-word + silence removal                  | 480 | 110      | 220   | ~810     |
| b. Speech enhance (loudnorm + denoise)            | 250 | 60       | 160   | ~470     |
| c. Brand vocabulary                               | 90  | 70       | 90    | ~250     |
| e. Prompt-based clipping                          | 0   | 110      | 110   | ~220     |
| i. Hook overlay + progress bar + emoji + aspect   | 290 | 100      | 180   | ~570     |
| **Total**                                         | **1110** | **450** | **760** | **~2320 LOC** |

Realistic shipping window: **~3 weeks of focused work**, assuming the
v0.3.0 perf+licensing slice ships first (it's mostly already underway).

---

## 7. Open questions for review

These are decisions I want to align with the maintainer before any code
lands. None block planning, all block implementation.

1. **Filler-word dictionary scope.** Ship `en-v1` only, or design the
   `{lang, words[]}` schema and ship a stub `id-v1` so Indonesian-language
   creators (the maintainer's primary audience) aren't second-class on day
   one? Plan above assumes English-only ship + i18n hook.
2. **Trim ordering.** Apply trim plan (a) to *source* before clip-scout
   sees it, or *per-clip at render time*? Plan assumes per-clip at render —
   simpler, but means clip-scout may pick boundaries that include filler
   words it can't see being removed. The A/B test in §3.4 decides this.
3. **Enhance opt-out.** Default `enhance: on` or `enhance: off`? Audio
   processing is opinionated; some podcasters already master to -16 LUFS
   and resent re-normalization. Plan assumes default ON with
   `--no-enhance` flag.
4. **RNNoise model fetch behavior.** Mandatory (fail SessionStart if
   missing) or optional (fall back to `afftdn`)? Plan above assumes
   optional + graceful fallback — matches the existing PFLD-model story.
5. **Hook overlay font.** Default to system font (`drawtext` falls back to
   Liberation Sans on Linux, Helvetica on macOS) or ship a font with the
   plugin? Plan currently leaves font selection to caption-stylist (which
   already chose Inter for captions).

---

## 8. Cross-cutting concerns

Concerns that don't belong to a single pillar but must stay coordinated as
the v0.3.0 slices land:

- **Caption re-timeline after apad (pillars a + i).** The tighten splice in
  `bin/lib/tighten-splice.mjs` chains `N-1` `acrossfade=d=JUNCTION_XFADE_S`
  filters and compensates with `apad=pad_dur=(N-1)*JUNCTION_XFADE_S` to
  match the video length. On long clips with many junctions, the audio tail
  drifts by ≈ N × 8 ms relative to a hypothetical "no apad, no xfade
  consumption" baseline. Caption .ass files generated by `caption-stylist`
  against the tightened timeline assume the splice produces a zero-drift
  output. If caption sync ends up off by milliseconds proportional to the
  cut count, this is the root cause — the fix lives in the caption-stylist
  emitter, not the renderer. See the TODO marker above the `apad` call in
  `bin/cf-ffmpeg` (`planSpliceArgs`).

- **Skill ordering enforcement (pillars a + i + the deferred broll/music
  pillars).** Renderer hard-fails if `edit.json` carries `cuts` AND any of
  `broll` / `transitions` / `music`. Documented in
  `skills/tighten/SKILL.md` → "Skill ordering". When the deferred pillars
  land, their skills must run BEFORE tighten's plan is generated so the
  baked overlays can be cut around, or the renderer composition order must
  be reworked to splice-then-overlay.

- **Deterministic-render env var (pillars a + tests across all pillars).**
  `CF_RENDER_DETERMINISTIC=1` forces CPU x264 + bitexact + single-threaded
  encoding. Used by the tighten idempotency assertion and any future per-
  stream MD5 assertions. Production renders leave it unset for speed.
  Documented in `README.md` → "Reproducibility".

## 9. Decision log

- 2026-05-20 — first draft of this plan; awaiting maintainer review before
  any v0.3.0 code lands.
- 2026-05-20 — added §8 Cross-cutting concerns (caption re-timeline TODO,
  skill ordering enforcement, deterministic-render env var) once the
  pillar-(a) splice integration landed.
