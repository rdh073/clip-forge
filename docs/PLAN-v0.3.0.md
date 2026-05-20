# PLAN — ClipForge v0.3.0 (output-quality parity with OpusClip)

**Status:** REVISION 2 — pillars (a) tighten and (b) enhance landed in the
working tree on 2026-05-20. Remaining v0.3.0 picks are (c) prompt-based
clipping, (e) brand vocabulary, and (i) hook overlay + progress bar +
emoji caption burn. Pillars (d), (f), (g), (h), (j) deferred.
**Author:** clip-forge core (2026-05-20 → revised 2026-05-20).
**Predecessor:** [docs/ROADMAP.md](ROADMAP.md), [docs/REVIEW.md](REVIEW.md),
[docs/bench-v0.2.0.md](bench-v0.2.0.md), [CHANGELOG.md](../CHANGELOG.md).
**Scope:** OUTPUT-QUALITY parity with OpusClip — bring the rendered MP4
indistinguishably close to an Opus output. UI / browser / timeline editor
explicitly out of scope. Local-first, scriptable, free, no-upload moat is
the unchanged north star.

> The existing roadmap's v0.3.0 ("license hardening + detection speed-up")
> remains valid and **separately tracked**. This plan adds the
> OUTPUT-QUALITY pillar. Both slices ship under the same v0.3.0 minor; the
> license-hardening + perf slice is mechanically smaller and lands first.

---

## 0. What changed since revision 1

Revision 1 (2026-05-20 early) selected 5 picks for v0.3.0: **a, b, c, e, i**.
Four of those have now landed on master:

| Pillar | Skill / bin                        | Status                                       |
|--------|------------------------------------|----------------------------------------------|
| a      | `/clip-forge:tighten` · `bin/cf-tighten` · `bin/lib/tighten-splice.mjs` · `bin/lib/junction-analyzer.mjs` · `bin/lib/render-report.mjs` · `schemas/render_report.v1.json` | shipped at commit `e05d1ae` (2026-05-20) |
| b      | `/clip-forge:enhance` · `bin/cf-enhance` · `tests/fixtures/noisy-speech-5s.mp4` · `tests/integration/enhance.test.mjs` · `tests/integration/enhance-render.test.mjs` | shipped at commit `eb7dd47` (2026-05-20)  |
| c      | `/clip-forge:clip --prompt` · `bin/cf-clip` · `agents/clip-scout.md` (Prompt-based filtering section) · `tests/mocks/clip-scout-mock.mjs` · `tests/fixtures/topic-transcript-60s.json` · `tests/integration/clip-prompt.test.mjs` | shipped at commit `27626ef` (2026-05-20)  |
| e      | `bin/cf-whisper --vocab` · `bin/lib/vocab.mjs` · `bin/lib/vocab.test.mjs` · `skills/transcribe/SKILL.md` (Brand vocabulary section) · `tests/fixtures/{mock-transcript-clipforge-3s,mock-transcript-silent-3s,sample-vocab,large-vocab}.json` · `tests/integration/vocab.test.mjs` | shipped at commit `7ddac74` (2026-05-20) |

That leaves one pick for the v0.3.0 minor: **i**. The deferral
table in §2 is unchanged.

This revision rewrites:
- **§1 gap table** — collapses (a) and (b) into ✅ shipped rows; recomputes
  the LOC budget for the remaining work.
- **§2 milestone** — drops the "selection rationale" entries for shipped
  pillars; keeps the rationale for c/e/i.
- **§3 schema extensions** — narrows to the three pillars still to land.
  The `edit.json.audio_source` field already ships with (b); `cuts` already
  ships with (a). Both are now part of the v0.2.x → v0.3.0-tip baseline,
  not a v0.3.0 add.
- **§4 test contract** — drops the trim and enhance test entries (both
  shipped); narrows to the three remaining positive-evidence tests.
- **§6 LOC budget** — drops shipped totals; ~1040 LOC remaining.

The decision log at §9 carries forward every prior decision verbatim.

---

## 1. Gap analysis — ClipForge (master tip) vs OpusClip (output-quality)

Legend — Complexity: S=≤300 LOC ≤2d · M=≤700 LOC ≤5d · L=≤1500 LOC ≤2w · XL>1500 LOC.

| # | Feature pillar                                              | ClipForge today (master tip + working tree)                                                                       | Opus parity gap                                                                                  | Complexity | LOC  | Dependencies                                                                                              | Risk                                                                                                                                          | Target  |
|---|-------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|------------|------|-----------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|---------|
| a | ✅ Filler-word & silence removal                            | Landed `e05d1ae`. `/clip-forge:tighten` writes `tighten_plan.json`; `cf-ffmpeg render` two-pass splices with 8 ms `acrossfade`; G1/G2/G3 junction telemetry in `render_report.json`. Locales `en` + `id` v2 (always-cut + context-only). | —                                                                                                | M          | ~810 (shipped) | ffmpeg `silencedetect`, `aselect`/`select`, `concat`, `acrossfade`, `apad`, two-pass renderer.            | Shipped. Watch items in `docs/ROADMAP.md` v0.3.1: high-N video frame-grid drift, filter-graph length warnings.                                | v0.3.0  |
| b | ✅ Speech enhance / denoise / loudness norm                 | Landed in working tree (commit pending, base `e05d1ae`). `/clip-forge:enhance` + `bin/cf-enhance`: `afftdn` → optional `arnndn` (pinned `cb.rnnn`) → adaptive `agate` → `dialoguenhance` → two-pass `loudnorm=I=-14:TP=-1.0:LRA=11`. Optional Demucs pre-pass. `enhanced.wav` + `enhance_report.json`; `edit.json.audio_source` patches render handoff. | —                                                                                                | S          | ~470 (shipped) | ffmpeg `loudnorm`, `afftdn`, `agate`, `dialoguenhance`; optional `arnndn` + pinned `cb.rnnn`; optional Demucs. | Shipped. Watch items: ensure final commit message + version bump + README link to skill ship together; CI fixture `noisy-speech-5s.mp4` is gitignored-safe. | v0.3.0  |
| c | ✅ Prompt-based clipping ("ClipAnything")                   | Landed at commit `27626ef`. `/clip-forge:clip --prompt "<topic>"` + `bin/cf-clip` dispatcher + agent two-pass filter+re-rank. Zero-match returns `candidates:[]` + `warning.code:"no_match"` (honest empty, `fallback_used` stays `false`). | —                                                                                                | S          | ~270 (shipped) | None new — agent-prompt extension + `bin/cf-clip` dispatcher + `tests/mocks/clip-scout-mock.mjs` for CI.   | Shipped. Watch items: real-Agent dispatch path lives in the slash-skill markdown (cf-clip handles `--emit-brief` for production handoff); `no_scout_backend` fallback degrades gracefully when neither mock nor emit-brief is wired. | v0.3.0  |
| d | Manual reframe / subject pin override                       | `--speaker-map` only (per-speaker static region). No per-time override.                                              | `pin_overrides.json` co-input: `[{t_start_ms,t_end_ms,cx,cy,radius?}, …]`, scorer respects it.   | M          | ~500 | None new — cf-reframe additive flag + active-speaker.mjs override hook.                                   | Schema sprawl on crop_path. Mitigation: keep override file separate; render reads only crop_path.                                              | v0.4.0  |
| e | ✅ Brand vocabulary (custom transcription dictionary)        | Landed at commit `7ddac74`. `~/.clip-forge/vocab.json` carries per-user brand terms; `bin/cf-whisper --vocab` plumbs them through whisper.cpp's `--prompt` and applies a case-restoring post-pass. Deepgram branch passes `buildDeepgramKeywords()` to the MCP `transcribe` tool. Hallucination guard: empty `words[]` stays empty. | —                                                                                                | S          | ~260 (shipped) | `bin/lib/vocab.mjs` (pure-logic, no deps); whisper.cpp `--prompt`; Deepgram MCP `keywords` param.        | Shipped. Watch items: per-project overlay (`./.clip-forge/vocab.json`) deferred to v0.3.1; `CF_WHISPER_TRANSCRIPT_MOCK` is the only test entry point until a TTS-driven real-audio fixture lands. | v0.3.0  |
| f | Intro / outro stinger templates                             | `templates/intros/` is empty; `edit.json` carries `intro` / `outro` fields but renderer doesn't honor them yet.       | Ship 2–3 Remotion-rendered stinger MP4s + `cf-ffmpeg concat` step.                              | M          | ~600 | Remotion CLI (already a soft dep via thumbnails comp), node 20+, ffmpeg `concat` demuxer.                 | Remotion install footprint is large; keep CLI invocation optional, pre-render assets and ship as binary artifacts. Low leverage — most viral creators skip stingers. | v0.5.0  |
| g | XML export (Premiere / DaVinci handoff)                     | None.                                                                                                                | FCP7 XML (`.fcpxml` v1.10) emitter or simple EDL `.edl` from `edit.json` + `tighten_plan.json`.   | L          | ~1200| FCP7 XML schema; xmlbuilder2 npm (MIT, no native).                                                        | FCP7 XML is fiddly; partial support is worse than none. Mitigation: ship `.edl` first (text format, trivial), `.fcpxml` follows.              | v0.5.0  |
| h | Speaker diarization for multi-speaker reframe               | Deepgram diarizes; transcript carries `speaker` per word. Reframe accepts `--speaker-map` but does not auto-route timeline. | Reframe consumes per-speaker timeline; renders split-screen letterbox when ≥2 speakers active.   | M          | ~650 | Existing transcript schema; cf-reframe `--speaker-route auto`; sherpa-onnx VAD for the offline path.       | Whisper diarize quality is patchy. Mitigation: feature requires Deepgram OR opt-in `--diarize sherpa` (v0.4.0 add).                           | v0.4.0  |
| i | Hook overlay + progress bar + dynamic emoji captions + aspect profiles | Captions JSON carries emoji-per-line + highlight flags but renderer doesn't burn hook overlay or progress bar. `cf-reframe` accepts `--target-aspect` but `cf-ffmpeg render` hard-codes 1080×1920. | ASS overlay for hook text in first ≤2 s; ffmpeg `drawbox` progress bar; emoji burned per line via ASS; plumb `target_aspect` through `edit.json` for 1:1 / 4:5 / 9:16. | M          | ~560 | ffmpeg `drawbox`, ASS layers. Noto Emoji ttf (SIL OFL, ~8 MB) — optional, ships only if user opts in.     | drawtext + emoji needs fontconfig set up cross-platform. Mitigation: render emojis through ASS only (already proven via Submagic-Pop template path). | v0.3.0  |
| j | Real OAuth publish (TikTok → YT Shorts → IG Reels)          | MCP stubs (`bin/mcp/tiktok.mjs`, `youtube.mjs`, `instagram.mjs`) return `auth_required`.                              | TikTok Content Posting API, YouTube Data API v3 resumable, Instagram Graph reel container.       | L          | ~1400| TikTok developer review; Google OAuth client; FB developer app; loopback HTTP server for auth dance.      | Each platform gates on developer-program approval the maintainer has to obtain. Mitigation: implement per-platform; release as each lands.    | v0.4.0  |

### Pillars NOT in the user's list but worth flagging

- **A/V re-sync smoke test on cuts.** Now that pillar (a) ships filler cuts,
  we want a smoke test that asserts audio energy aligns with mouth motion
  (PFLD already gives us mouth-y per frame — cheap reuse). Tracked under
  `docs/ROADMAP.md` v0.3.1.
- **VTT/SRT sidecar export.** OpusClip emits SRT for download; we already
  build word timing, ~30 LOC + 60 LOC test. Bundle into the (i) slice
  since the caption-stylist artifact is open at that point.
- **Aspect-ratio profiles.** Beyond 9:16, OpusClip supports 1:1 and 4:5.
  `cf-reframe` already accepts `--target-aspect` but `cf-ffmpeg render`
  hard-codes 1080×1920. ~80 LOC to plumb through `edit.json`. Folded into
  pillar (i) as the "aspect bonus" — same code path touches the renderer
  filter graph.

---

## 2. v0.3.0 remaining milestone — 3 picks

Pillars (a) and (b) have landed. The remaining v0.3.0 picks are **c, e, i**.

Selection criteria (unchanged from rev 1): (1) measurable visible/audible
jump in output quality, (2) honors the moat — local, scriptable, free, no
required new SaaS keys, (3) complexity ≤ M (one minor slice), (4) extends
the existing `edit.json` / `crop_path.json` / `transcript.json` schemas,
never forks.

| Pick                                            | Why it wins on the moat                                                                                                                                                                                                                              |
|-------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **c. Prompt-based clipping `--prompt`**         | The cheapest of the lot (~220 LOC, mostly prompt-engineering + skill wiring). Lifts ClipForge from "pick virality" to "find clips about X" — Opus's "ClipAnything" parity. The agent + transcript already exist; we're unlocking latent capability, not building new. No new SaaS keys. |
| **e. Brand vocabulary (custom dictionary)**     | ~260 LOC; pure config wiring on both transcribe branches (Deepgram `keywords` + Whisper `--initial-prompt`). Niche creators (founders, brand names, product names) get correct transcription for the first time. vocab.json is the user's own data, no API key required. |
| **i. Hook overlay + progress bar + emoji burn + aspect profiles** | Closes the *visual* parity gap that everyone notices first. All ffmpeg-native, no new models. The caption-stylist already emits emoji/highlight metadata — renderer just has to honor it. Bundle 1:1 / 4:5 aspect plumbing + VTT/SRT sidecar while we're touching the renderer + captions. |

### Explicitly deferred from v0.3.0

| Pick | Defer to | Reason |
|------|----------|--------|
| d. Manual reframe pin override          | v0.4.0 | Depends on a `pin_overrides.json` editor flow we haven't designed; manual override is power-user, not first-impression quality. |
| f. Intro/outro stinger templates        | v0.5.0 | Requires shipping Remotion-rendered MP4 assets and finalizing a brand-kit story. Low leverage — most viral creators skip stingers. |
| g. XML export                           | v0.5.0 | Large, niche audience, partial support is worse than none. Ship `.edl` (trivial) bundled with v0.5.0's pro-export slice. |
| h. Speaker-aware reframe auto-route     | v0.4.0 | Whisper diarization quality is patchy; gating on Deepgram-only would split the user base. Ship after sherpa-onnx-VAD diarize. |
| j. Real OAuth publish                   | v0.4.0 | Each platform gates on developer-program approval the maintainer must obtain. Per-platform release as approvals land. |

### Out-of-scope this plan (already on the v0.3.0 perf+licensing track)

- PFLD int8 quantization, worker-thread pool, MobileNet PFLD swap. See
  `docs/ROADMAP.md` v0.3.0 "Detection speedup".
- cunjian PFLD license replacement. See `docs/ROADMAP.md` v0.3.0 "License hardening".
- W-1 backpressure on frame extractor, W-2 numerical-correctness tests,
  W-4 / W-5 / W-6 CLI ergonomics. See `docs/REVIEW.md`.

These continue independently and merge into the same v0.3.0 tag.

---

## 3. Design — additive schema extensions only (no forks)

### 3.1 `edit.json` — fields after pillars (a), (b), (i)

```jsonc
{
  "version": 1,
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

  // shipped with pillar (a) + (b) — already part of baseline:
  "cuts":         "./.../tighten_plan.json",
  "audio_source": "./.../enhanced.wav",

  // pillar (i) additions — all optional, ignored by v0.2.0 readers:
  "hook_overlay":  { "text": "Nobody tells you this", "end_ms": 1800, "position": "upper-third" },
  "progress_bar":  { "enabled": true, "color": "#ffffff", "height_px": 8, "position": "bottom" },
  "target_aspect": "9:16"     // "9:16" | "1:1" | "4:5"; renderer maps to 1080×1920 | 1080×1080 | 1080×1350
}
```

### 3.2 New artifact: `~/.clip-forge/vocab.json` (pillar e)

```jsonc
{
  "version": 1,
  "terms": [
    { "term": "ClipForge",   "case": "preserve", "weight": 1.0 },
    { "term": "OpusClip",    "case": "preserve", "weight": 0.8 },
    { "term": "Anthropic",   "case": "preserve", "weight": 1.0 },
    { "term": "Sumayyah",    "case": "preserve", "weight": 1.0, "lang": "en" }
  ],
  "deepgram": { "boost": 8.0 },
  "whisper":  { "initial_prompt_max_tokens": 240 }
}
```

- `case: "preserve"` — restore casing of the term in the transcript even if
  the ASR engine lowercases it.
- `weight` — caps at 1.0; the post-pass uses it to pick winners when two
  vocab terms compete for the same span (e.g. "Anthropic" vs "anthropic").
- `lang` — when omitted, the term is matched language-agnostically; when
  set, the post-pass only applies casing within that language's words.
- The whisper initial-prompt is constructed by joining `terms[].term` with
  ", " until 240 tokens are reached (English-tokenizer heuristic; `tiktoken`
  not required — cheap whitespace split is sufficient as a cap proxy).

### 3.3 New artifact: `templates/captions/<style>.json` — hook_overlay block

We add an optional `hook_overlay` block to the existing caption templates
so the burn step can read its colours from the same place as captions:

```jsonc
{
  // … existing Submagic-Pop fields …
  "hook_overlay": {
    "font_size_px": 88,
    "stroke_px": 6,
    "fill_primary": "$brand.primary",
    "stroke_color": "#000000",
    "shadow": "1px 2px rgba(0,0,0,0.6)",
    "default_position": "upper-third",
    "max_chars": 36
  }
}
```

`$brand.primary` is the existing token-substitution syntax used by
`bin/cf-caption-burn`.

### 3.4 Skill / bin / agent inventory (delta from rev 1)

| Component                                     | Action       | Pillar      |
|-----------------------------------------------|--------------|-------------|
| `bin/cf-ffmpeg` (existing)                    | extend `render` filter chain with `hook_overlay`, `progress_bar`, `target_aspect` | i |
| `bin/cf-whisper` (existing)                   | add `--initial-prompt <s>` plumb + vocab-aware casing post-pass | e |
| `bin/lib/vocab.mjs` (new)                     | create — load `vocab.json`, build Deepgram `keywords[]` + Whisper prompt, apply case-restore post-pass | e |
| `bin/lib/overlay-builder.mjs` (new)           | create — pure builder for the ASS overlay layer + ffmpeg `drawbox` progress filter; unit-tested without ffmpeg | i |
| `bin/mcp/deepgram.mjs` (existing, community)  | plumb `keywords` array from vocab | e |
| `skills/transcribe/SKILL.md` (existing)       | wire `~/.clip-forge/vocab.json` → both branches | e |
| `skills/clip/SKILL.md` (existing)             | add `--prompt <topic>` arg, two-pass filter→re-rank, honest-empty fallback | c |
| `skills/caption/SKILL.md` (existing)          | caption-stylist emits `hook_span` + `progress_bar_color`; cf-caption-burn passes `hook_overlay` block | i |
| `skills/render/SKILL.md` (existing)           | document new edit.json fields; document `target_aspect` mapping | i |
| `skills/start/SKILL.md` (existing)            | thread `--prompt` through Step 4 (Detect clips) | c |
| `agents/clip-scout.md` (existing)             | accept topic prompt — two-pass: filter to prompt-matched candidates, re-rank by virality | c |
| `agents/caption-stylist.md` (existing)        | emit `hook_span: {start_ms, end_ms}` + `progress_bar: {color, position}` blocks | i |
| `~/.clip-forge/vocab.json` schema             | document in README + skills/transcribe/SKILL.md | e |
| `tests/integration/vocab.test.mjs` (new)      | positive evidence (§4.1) | e |
| `tests/integration/clip-prompt.test.mjs` (new)| positive evidence (§4.2) | c |
| `tests/integration/overlay.test.mjs` (new)    | positive evidence (§4.3) | i |
| `tests/fixtures/clipforge-name-3s.mp4` (new)  | new fixture for vocab test — 3 s clip with spoken "ClipForge" | e |
| `tests/fixtures/topic-transcript-60s.json` (new) | synthetic transcript for prompt test, no audio needed | c |

### 3.5 Pipeline order in `/clip-forge:start`

```
1. onboard          (unchanged)
2. import           (unchanged)
3. transcribe       (consumes vocab.json — pillar e)            ⟵ EXTEND
4. enhance          ✅ shipped (pillar b)                         writes uploads/<slug>/enhanced.wav
5. tighten          ✅ shipped (pillar a)                         writes clips/<slug>/<clip-id>/tighten_plan.json
6. clip             accepts --prompt — pillar c                  ⟵ EXTEND
7. reframe          (unchanged)
8. caption          caption-stylist emits hook_span — pillar i  ⟵ EXTEND
9. broll + music    (unchanged)
10. render          honors hook_overlay + progress_bar + target_aspect — pillar i  ⟵ EXTEND
11. publish         (unchanged stubs — v0.4.0 work)
```

Order rationale unchanged: tighten runs BEFORE clip would over-rotate the
candidate boundaries; the shipped order (transcribe → enhance → tighten →
clip) puts tighten AFTER clip-scout so scout sees the source word stream
intact. The trim plan is applied per-clip at render time via filter-graph
splicing, not at source. This is the order the shipped `cf-ffmpeg render`
already enforces via skill-ordering invariants.

---

## 4. Test contract — positive-evidence integration tests (remaining)

Following the pattern of `tests/integration/success-path.test.mjs` and the
already-shipped `tests/integration/enhance.test.mjs` /
`tests/integration/tighten-render.test.mjs`. Every test asserts the
*effect*, not the *exit code*.

### 4.1 `tests/integration/vocab.test.mjs` (pillar e)

- Fixture: `tests/fixtures/clipforge-name-3s.mp4` — 3 s clip with the
  spoken word "ClipForge" (mux a TTS sample + a brief carrier sentence so
  Whisper has acoustic context). Build deterministically from
  `tests/fixtures/build-fixtures.mjs`.
- Assertions:
  - With `~/.clip-forge/vocab.json` containing `{"term":"ClipForge"}`, the
    transcript contains `"ClipForge"` as a word (case-preserving).
  - Without vocab, the transcript contains the misspelled form (e.g.
    `"clip force"` or `"clip-forge"`). The contrast proves vocab is the
    cause; not just that the word happened to land right.
  - **Hallucination guard:** with vocab containing `"ClipForge"` AND a
    silent fixture (`tests/fixtures/silence-3s.mp4`, separately built),
    transcript words list is empty. Asserts the initial-prompt cap (240
    tokens) does not bias silence into spurious brand names.
- Skips cleanly if Deepgram key absent AND whisper.cpp absent — same
  pattern as `tighten-reasr.test.mjs`'s skip on `CF_WHISPER_URL`.

### 4.2 `tests/integration/clip-prompt.test.mjs` (pillar c)

- Fixture: `tests/fixtures/topic-transcript-60s.json` — synthesized 60 s
  word-timed transcript JSON (no audio needed; pure structured data) with
  three topic blocks: "fitness" (0–20 s), "career" (20–40 s), "cooking"
  (40–60 s). Build deterministically.
- Assertions:
  - Without `--prompt`, candidate IDs span all three topics.
  - With `--prompt "career advice"`, returned candidates' `transcript_excerpt`
    fields all match `/career|job|quit|salary/i`; no fitness/cooking
    excerpts appear in the top-N.
  - Edge: `--prompt "underwater basket weaving"` (no match) → response has
    `candidates.length === 0` and a top-level `warning` field
    `{"code":"no_match","message":"no candidates matched prompt — re-run without --prompt or broaden the topic"}`.
    Success path is "honest empty" not "fall back silently to virality
    sort".
- Uses a mock agent stub (`tests/mocks/clip-scout-mock.mjs`) so the test
  runs in CI without ANTHROPIC_API_KEY. The stub honors the same I/O
  contract documented in `agents/clip-scout.md`.

### 4.3 `tests/integration/overlay.test.mjs` (pillar i)

- Fixture: `tests/fixtures/talking-head-5s.mp4` (existing v0.2.0
  success-path fixture).
- Assertions:
  - With `hook_overlay: {text:"Nobody tells you this", end_ms:1800,
    position:"upper-third"}`: sample frame at t=0.5 s contains a
    high-luminance horizontal band in the upper third (cheap proxy: mean
    luminance of a 40-px-tall row at y=600 in the 1920-tall frame > +30
    over baseline frame at t=4.0 s after overlay end). At t=2.5 s the
    overlay is gone, baseline luminance restored.
  - With `progress_bar.enabled: true, height_px: 8, color: "#ffffff"`:
    bottom 8 px row at t=2.5 s has more white fill than at t=0.5 s (sum of
    pixel luminance ratio ≥ 1.5×).
  - With `target_aspect: "1:1"`: rendered MP4 is 1080×1080 (ffprobe
    `width` / `height` fields). With `target_aspect: "4:5"`: 1080×1350.
    With `target_aspect: "9:16"` or unset: 1080×1920 (baseline).
  - Both overlays absent if not enabled (baseline frame matches v0.2.0
    success-path render byte-for-byte sans the new filter chain — assert
    via per-stream MD5 with `CF_RENDER_DETERMINISTIC=1`).
  - **VTT sidecar:** when `target_aspect` is unset, `cf-ffmpeg render`
    also writes `./renders/<slug>/<clip-id>.vtt` next to the MP4 with
    the same timing as the burned `.ass`. Assert file exists and parses
    as valid WebVTT (first line `WEBVTT`, ≥1 cue block).

### 4.4 Graceful-degradation contract (mirrors cf-reframe / cf-tighten / cf-enhance)

Every new `bin/cf-*` script and every new code path inside an existing
`bin/cf-*` must:
- Exit 0 on every documented failure path.
- Write a valid JSON artifact recording `fallback_used: true/false` and a
  `fallback_reason` string when degraded.
- Never break a downstream consumer. Examples:
  - **Pillar (c):** if scout returns 0 candidates because of `--prompt`,
    candidates.json carries `candidates: []` + a top-level
    `warning: {code:"no_match", ...}`. The render skill exits early with
    "no candidates to render" rather than crashing on a missing edit.json.
  - **Pillar (e):** if `~/.clip-forge/vocab.json` is missing or malformed,
    `cf-whisper` proceeds without an initial prompt and records a soft
    `warning: {code:"vocab_unreadable", ...}` in the transcript JSON. No
    transcription failure.
  - **Pillar (i):** if the chosen `target_aspect` is invalid (e.g.
    "5:4"), the renderer falls back to "9:16" and records
    `warning: {code:"unknown_aspect", ...}` in `render_report.json`. If
    `hook_overlay.text` overflows the safe area, the overlay-builder
    word-wraps at the template's `max_chars` and records
    `warning: {code:"hook_overlay_wrapped", ...}`.

---

## 5. Risks & mitigations

| Risk                                                                                                  | Mitigation                                                                                                                                                                              |
|-------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Prompt-based clipping degrades scout's virality scoring on broad prompts.                             | Two-pass: filter to prompt-matched clips first, then re-rank by virality within the filtered set. Document the trade in `skills/clip/SKILL.md`. Test 4.2 asserts the no-match warning.  |
| `vocab.json` initial-prompt injection on Whisper hallucinates the brand name into silence.            | Cap initial-prompt at 240 tokens. Regression test on a silent fixture asserts transcript words list is empty even when vocab contains "ClipForge" (test 4.1 hallucination guard).      |
| Hook overlay text bleeds outside 9:16 safe area.                                                      | Reuse caption-stylist's safe-area margins; template carries `max_chars`; overlay-builder word-wraps + records `hook_overlay_wrapped` warning. Geometry unit test in `bin/lib/overlay-builder.test.mjs`. |
| `target_aspect` change between reframe (1080×1920 source samples) and render (1080×1080 target) breaks crop-expression math. | `cf-ffmpeg render` re-derives the crop dimensions from `crop_path.samples[].scale` against the *target* width/height, not hard-coded 1080×1920. The crop-expression-builder already supports this — we wire `targetW` / `targetH` from `edit.json.target_aspect` instead of literals. |
| Deepgram `keywords` array hits per-request size limit on large vocabs.                                | `bin/lib/vocab.mjs` caps at 100 terms by `weight` descending; surplus terms recorded in transcript JSON `warnings[]` as `vocab_terms_truncated`.                                       |
| Caption-stylist emits hook_span that overlaps the regular caption timeline.                            | `cf-caption-burn` reads hook_span from caption-stylist output but renders it on layer 1, regular captions on layer 0; ASS layer compositing handles the visual stack. Unit test in `bin/lib/overlay-builder.test.mjs`. |
| VTT sidecar drifts from the tightened timeline (post-splice).                                          | VTT is generated from the *tightened* word list (same source as `.ass`), not the source transcript. Renderer emits both files from the same in-memory model. Test 4.3 asserts cue count parity. |

---

## 6. LOC budget (remaining)

| Pick                                                       | New | Modified | Tests | Subtotal |
|------------------------------------------------------------|-----|----------|-------|----------|
| c. Prompt-based clipping                                    | 60  | 100      | 110   | ~270     |
| e. Brand vocabulary                                         | 130 | 90       | 110   | ~330     |
| i. Hook overlay + progress bar + emoji burn + aspect + VTT  | 300 | 100      | 200   | ~600     |
| **Total remaining**                                        | **490** | **290** | **420** | **~1200 LOC** |

Already shipped (for reference):

| Pick                                              | New | Modified | Tests | Subtotal |
|---------------------------------------------------|-----|----------|-------|----------|
| a. Filler-word + silence removal (shipped)        | 480 | 110      | 220   | ~810     |
| b. Speech enhance (shipped, commit pending)       | 250 | 60       | 160   | ~470     |

**Grand total v0.3.0 output-quality pillar:** ~2480 LOC (~1280 shipped,
~1200 remaining).

Realistic shipping window for the remaining work: **~1.5–2 weeks of
focused work**, assuming the v0.3.0 perf+licensing slice ships alongside.

---

## 7. Open questions for review

These are decisions to align with the maintainer before any code lands.
None block planning, all block implementation.

1. **Prompt-based clipping — over-filter behavior.** If `--prompt "X"`
   yields zero matches, do we (a) exit with `candidates: []` + warning, or
   (b) silently fall back to virality-sorted top-N + warning? Plan above
   chooses (a) "honest empty" — matches the `cf-tighten` contract of
   "structured warnings, no silent fallbacks". OpusClip's UI behavior is
   (b), but they have a screen to surface the fallback; we don't.
2. **Vocab.json scope.** Per-user (`~/.clip-forge/vocab.json`) only, or
   also per-project (`./.clip-forge/vocab.json` in the working directory)?
   Per-project allows brand vocab to ride along in git. Plan currently
   assumes both, with project overriding user, but both is more code.
3. **Hook overlay font.** Default to system font (`drawtext` falls back to
   Liberation Sans on Linux, Helvetica on macOS) or ship Inter ttf with
   the plugin (~150 KB)? caption-stylist already picks Inter for captions.
   Plan currently leaves font selection to caption-stylist (already Inter)
   and burns through ASS, sidestepping the cross-platform fontconfig
   issue entirely.
4. **VTT vs SRT sidecar.** Plan picks VTT (web-native, supports styling).
   OpusClip emits SRT. Cost of shipping both is trivial — ~20 LOC each.
   Recommend: ship both, write SRT first (universal compatibility), VTT
   second for stylable web embed. Open: opinion?
5. **Aspect-ratio defaults.** When `target_aspect` is unset, render
   defaults to 9:16. When `target_aspect: "1:1"` or `"4:5"`, the
   reframe crop still targets the face center as before — only the output
   canvas changes. Is that the right contract, or should 1:1 / 4:5 also
   change the framing rules (e.g. tighter scale to keep the face larger
   in a smaller canvas)? Plan currently says "same crop, smaller canvas".

---

## 8. Cross-cutting concerns

Concerns that don't belong to a single pillar but must stay coordinated as
the remaining v0.3.0 slices land:

- **Caption re-timeline after apad (pillars a + i).** The tighten splice
  in `bin/lib/tighten-splice.mjs` chains `N-1`
  `acrossfade=d=JUNCTION_XFADE_S` filters and compensates with
  `apad=pad_dur=(N-1)*JUNCTION_XFADE_S` to match the video length. On long
  clips with many junctions, the audio tail drifts by ≈ N × 8 ms relative
  to a hypothetical "no apad, no xfade consumption" baseline. Caption .ass
  files generated by `caption-stylist` against the tightened timeline
  assume the splice produces a zero-drift output. If caption sync ends up
  off by milliseconds proportional to the cut count, this is the root
  cause — the fix lives in the caption-stylist emitter, not the renderer.
  Pillar (i) burn step inherits this constraint: hook_overlay and
  progress_bar are clip-relative against the *post-splice* output
  duration, not pre-splice.

- **Skill ordering enforcement (pillars a + i + the deferred broll/music
  pillars).** Renderer hard-fails if `edit.json` carries `cuts` AND any of
  `broll` / `transitions` / `music`. Documented in
  `skills/tighten/SKILL.md` → "Skill ordering". When the deferred pillars
  land (f intro/outro), their skills must run BEFORE tighten's plan is
  generated so the baked overlays can be cut around, or the renderer
  composition order must be reworked to splice-then-overlay. Pillar (i)
  burn step runs AT render time, not pre-baked, so it composes naturally
  with the existing two-pass splice.

- **Deterministic-render env var (pillars a + tests across all pillars).**
  `CF_RENDER_DETERMINISTIC=1` forces CPU x264 + bitexact + single-threaded
  encoding. Used by the tighten idempotency assertion and the overlay
  test's per-stream MD5 assertion in §4.3. Production renders leave it
  unset for speed. Documented in `README.md` → "Reproducibility".

- **Telemetry-schema extension (pillar i).** `render_report.json` schema
  `render_report.v1` currently has no fields for overlay / aspect /
  sidecar telemetry. Pillar (i) needs to add (without breaking schema v1
  validation):
  - `target_aspect: "9:16" | "1:1" | "4:5"`
  - `overlays: { hook: { burned: bool, wrapped: bool, end_ms: int }, progress_bar: { burned: bool } }`
  - `sidecars: { vtt: string|null, srt: string|null }`

  These are additive — schema v1 allows extra keys. If we want to gate
  them via the validator, bump to `render_report.v2` and add the fields.
  Plan currently leaves at v1 + additive — same approach we took for the
  tighten block.

- **Vocab.json + tighten interaction (pillars e + a).** Tightened plans
  reference transcript word indices; if vocab post-pass changes word
  casing (e.g. "clip force" → "ClipForge"), the underlying word *index*
  stays the same — we mutate `w` only, not `start_ms` / `end_ms` /
  `confidence`. cf-tighten reads `w` for filler-dict matching against
  normalized tokens (lowercased + punct-stripped), so case changes are
  no-ops at the matcher. No test needed beyond the existing filler-match
  unit tests.

---

## 9. Decision log

- 2026-05-20 — first draft of this plan; awaiting maintainer review before
  any v0.3.0 code lands.
- 2026-05-20 — added §8 Cross-cutting concerns (caption re-timeline TODO,
  skill ordering enforcement, deterministic-render env var) once the
  pillar-(a) splice integration landed.
- 2026-05-20 — Pillar B (`/clip-forge:enhance`) landed at commit `eb7dd47`.
  Deviations from the draft: implementation uses `audio_source` instead of
  `audio_enhanced`; `bin/cf-enhance` replaced the planned `bin/cf-audio`;
  the production chain adds `dialoguenhance`, adaptive `agate`, and
  optional Demucs voice isolation, none of which were in the original plan.
- 2026-05-20 — Revision 2: collapsed shipped pillars (a) and (b) into ✅
  rows in the gap table; narrowed §3 schema, §4 tests, §6 LOC budget to
  the three remaining picks (c, e, i). Bundled VTT/SRT sidecar export and
  aspect-ratio profiles (1:1, 4:5) into pillar (i) since they touch the
  same renderer + caption code paths. Added §8 telemetry-schema extension
  and vocab.json + tighten interaction notes. Five open questions queued
  for maintainer review at §7.
- 2026-05-20 — Pillar (c) Prompt-based clipping shipped:
  `/clip-forge:clip --prompt "<topic>"` + `bin/cf-clip` dispatcher +
  `tests/mocks/clip-scout-mock.mjs` + `tests/integration/clip-prompt.test.mjs`.
  Zero-match contract resolved per §5 risk row 1 — chose "honest empty"
  (`candidates:[]` + `warning.code:"no_match"`, `fallback_used` stays
  `false`) over silent virality-sort fallback. Caller surfaces the
  warning verbatim; `--yolo` aborts rather than broadening. Implemented
  by subagent against base `eb7dd47`; rebased onto master to land alongside
  pillar B.
- 2026-05-20 — Pillar (e) Brand vocabulary shipped:
  `bin/cf-whisper --vocab <path>` + `bin/lib/vocab.mjs` +
  `tests/integration/vocab.test.mjs`. Decisions resolved:
  * §7 Q2 (vocab.json scope) — **per-user only** for v0.3.0
    (`~/.clip-forge/vocab.json`). Per-project overlay
    (`./.clip-forge/vocab.json`) deferred to v0.3.1. Rationale: per-user is
    the 90 % use case (creator's own brand kit), the overlay adds a
    layering rule (project wins over user) that wants its own slice with
    explicit precedence tests; pillar (e) was already at the LOC budget
    edge and the overlay is additive on top of the lib.
  * §5 risk row 2 (Whisper hallucination from initial-prompt bias) —
    addressed by `buildWhisperInitialPrompt`'s 240-token cap + the
    `applyCaseRestore` lib-level hallucination guard (empty `words[]`
    stays empty regardless of vocab size). Both guards are exercised by
    the silent-transcript integration test.
  * §5 risk row 5 (Deepgram `keywords` per-request size) — addressed by
    `buildDeepgramKeywords`'s 100-term cap + `vocab_terms_truncated`
    soft warning (`fallback_used` stays `false`). Truncation is
    weight-descending — surplus low-weight terms drop first.
  * Routing — shared post-pass via `cf-whisper --apply-vocab-only` so
    the Deepgram branch reuses the same lib code path; alternative
    "import vocab.mjs from the skill" was rejected because skills are
    markdown-only.
  * Test entry point — `CF_WHISPER_TRANSCRIPT_MOCK=<path>` env hook,
    mirroring pillar (c)'s `CF_CLIP_SCOUT_MOCK`. TTS-driven real-audio
    fixtures explicitly out of scope; the mock-transcript JSON pattern
    is sufficient to exercise every code path of the lib + plumbing.
  * `bin/cf-whisper` migrated from `sh` to Node so vocab plumbing, the
    mock hook, and the post-pass share the same lib without a
    shell-to-Node trampoline. Canonical JSON shape, model-cache
    behaviour, and exit semantics preserved.
