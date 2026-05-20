# Changelog

All notable changes to ClipForge follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — v0.4.0 pillar 4: cf-edit (partial re-render) + prompt-driven re-edit + Anthropic translate completion

- New `/clip-forge:edit` skill + `bin/cf-edit` dispatcher. Two modes:
  - **Diff mode (default)** — content-hash diff against
    `./renders/<slug>/render_manifest.json`. Hashes six inputs per clip
    (`edit_json`, `crop_path`, `captions_ass`, `cuts_plan`,
    `audio_source`, `brand_kit`); stale clips re-render via
    `cf-ffmpeg render`, fresh clips skip. Manifest writes are atomic
    (write-then-rename with `fsync`). Flags: `--slug`, `--force`,
    `--dry-run`, `--only c01,c03`. Invariants E1–E7 from PLAN-v0.4.0
    §3.4 enforced.
  - **Prompt mode (`--prompt "<text>"`)** — LLM emits RFC 6902 JSON
    patch against `edit.json`; three-layer validation (schema +
    whitelist + dry-run preview) before apply; one retry on validation
    failure then manual fallback. `--auto-apply` / `--yolo` skips the
    preview gate.
- New pure-logic library `bin/lib/llm.mjs` — dispatcher mirroring the
  `tts.mjs` shape from pillar 2. Provider precedence per PLAN-v0.4.0
  §7 Q6: `CF_LLM_PROVIDER=<name>` override → `GROQ_API_KEY` →
  `ANTHROPIC_API_KEY` → graceful `no_llm_provider` fallback. Adapter
  files: `bin/lib/llm/groq.mjs` (llama-3.3-70b-versatile, JSON-mode,
  ~$0.001/edit) and `bin/lib/llm/anthropic.mjs` (claude-haiku-4-5,
  ~$0.02/edit). Mock injection via `CF_LLM_MOCK=<path>` mirrors
  `CF_TTS_MOCK` / `CF_TRANSLATE_MOCK`.
- New pure-logic library `bin/lib/render-manifest.mjs` — sha256 input
  hashing, `diffClips` (cold-start, no-change, mid-change),
  `saveManifestAtomic` (write `<path>.tmp`, `fsync`, rename). Loads /
  saves preserve the pillar-2 `ai_costs` block byte-for-byte modulo
  additive breakdown keys (`groq_llm`, `anthropic_llm`,
  `anthropic_translate`). `recordClipRender` upserts a clip entry with
  `output`, `input_hashes`, `rendered_sha256`, `rerender_reason`.
- New pure-logic library `bin/lib/edit-patch.mjs` — JSON-patch
  validator (RFC 6902 ops + the schema at
  `schemas/edit-patch.v1.json`), whitelist enforcement, applier (no
  external deps), and `summarisePatch` helper for the preview gate.
  Editable JSON Pointer whitelist: `/cuts`, `/hook_overlay/*`,
  `/progress_bar/*`, `/target_aspect`, `/brand_kit`, `/watermark`.
  FORBIDDEN: `/crop_path`, `/audio_source`, `/clip_id`, `/source`,
  `/output`, `/version` — off-whitelist patches reject with
  `rejected_reason: "off_whitelist"`.
- `bin/lib/translate.mjs` extended with the real-network Anthropic
  adapter that pillar 2 deferred. Provider precedence updated to honor
  `CF_TRANSLATE_PROVIDER=<name>` override. New fallback codes:
  `anthropic_key_missing`, `anthropic_network_error`,
  `anthropic_http_<status>`, `anthropic_invalid_json`,
  `anthropic_payload_invalid_json`, `anthropic_empty_translation`.
  Per-word `start_ms` / `end_ms` timing preserved via the shared
  `reattachTiming()` helper.
- `schemas/render_manifest.v1.json` (new) — formal contract for the
  pillar-4 `clips` block + pillar-2 `ai_costs` block. `additionalProperties:
  true` at the top level so forward extensions are non-breaking.
- `schemas/edit-patch.v1.json` (new) — shape contract for the LLM patch
  payload (`{patch: [...], warning: null}`).
- `schemas/render_report.v1.json` extended additively with `rerender:
  {reason, stale_keys, manifest_path}` and `llm: {patch_applied,
  provider_used, retry_count, rejected_reason, cost_usd}` top-level
  fields. Existing required-field list unchanged.
- `config/llm-prompts/cf-edit-v1.md` (new) — versioned system prompt
  for prompt-mode, documenting the editable whitelist + the
  `{"patch": [], "warning": {"code": "ambiguous_prompt", ...}}` refusal
  shape.
- Tests: 41 unit (`bin/lib/llm.test.mjs` × 13 — precedence, override,
  mock injection, no-keys; `bin/lib/render-manifest.test.mjs` × 15 —
  hashing, diff, atomic write, ai_costs preservation;
  `bin/lib/edit-patch.test.mjs` × 25 — schema + whitelist + applier;
  `bin/lib/translate.test.mjs` × 9 — Anthropic adapter, precedence,
  CF_TRANSLATE_PROVIDER override). 12 integration
  (`tests/integration/cf-edit.test.mjs` × 7 — cold-start, idempotency
  E4, partial re-render, --force E3, --dry-run E1, --only subset,
  pillar-2 ai_costs preservation E7;
  `tests/integration/cf-edit-prompt.test.mjs` × 5 — patch applied,
  off-whitelist reject, retry-then-succeed, no-LLM-keys degrade,
  composition gate hook+aspect on one clip while the other stays
  untouched). 3 new live-gated translate-real cases for the Anthropic
  path (skipped when `ANTHROPIC_API_KEY` unset).
- Source: `docs/PLAN-v0.4.0.md` §3.4 + §7 Q5/Q6 + §10 decision log.

### Added — v0.4.0 pillar 3: brand kit / custom assets

- New `~/.clip-forge/brand-kit.json` (global) / `./uploads/<slug>/brand-kit.json`
  (per-project, wins entirely over global — mirrors `voices.json` from
  pillar 2). Schema `schemas/brand-kit.v1.json` v1:
  `{version, name, assets: {logo, endcard, lower_third}}` — each asset
  carries its own position / opacity / scale_px / duration_ms /
  show_from_ms / show_until_ms knobs.
- `/clip-forge:brand-kit` (new) — wizard slash command +
  `bin/cf-brand-kit` dispatcher with four subcommands: `add` (interactive
  with `AskUserQuestion`), `list`, `set-default`, `remove`. Writes to
  the global file by default; `--slug <slug>` redirects to the per-project
  file. File-size limits enforced at WRITE time (logo / lower-third PNG ≤
  2 MB, endcard PNG ≤ 2 MB, endcard MP4 ≤ 3 MB) so oversized assets are
  caught immediately.
- `bin/lib/brand-kit.mjs` (new, pure-logic) — `loadKit({globalPath,
  projectPath})` precedence loader (per-project wins, no merge),
  `resolveKitForEdit(editJson, …)` carrying the three-way precedence
  (inline `brand_kit` → `watermark.brand_kit_ref` → legacy `watermark`
  string → project/global file), `enforceAssetLimits(kit, warnings)`
  which strips oversize/missing assets BEFORE the filter graph is
  built. 12 unit tests in `bin/lib/brand-kit.test.mjs`.
- `bin/lib/brand-overlay-builder.mjs` (new, pure-logic) — builds the
  ffmpeg `-filter_complex` chains: `buildLogoOverlay()` (positioned +
  scaled + colorchannelmixer-tinted), `buildLowerThirdOverlay()`
  (time-gated via `enable='between(t, show_from, show_until)'`),
  `composeBrandKitFilter()` (chains the two with shared input
  indexing). All builders idempotent — no `Date.now()`, no `Math.random()`,
  no `process.env` reads. 14 unit tests in
  `bin/lib/brand-overlay-builder.test.mjs`.
- `edit.json` schema additions (additive — older readers ignore):
  - `brand_kit: { … }` — inline kit object (highest precedence)
  - `watermark.brand_kit_ref: "<path>"` — pointer to a brand-kit.json
  - Legacy `watermark: "<path>"` string still maps to a logo-only kit
    with default position bottom-right + opacity 0.7 (B5 backward-compat
    regression-guarded by an integration test).
- `bin/cf-ffmpeg render` extended to:
  - Resolve the brand kit per the precedence chain above (lazy probe of
    `~/.clip-forge/brand-kit.json` and `./uploads/<slug>/brand-kit.json`
    when edit.json carries no inline brand info).
  - Compose the brand-kit filter chain into both the splice
    (`buildSpliceGraph`) and non-splice (`planCropArgs`) paths. Brand-kit
    chain inserts BEFORE the progress-bar drawbox + caption burn so
    overlays sit above the logo but below the hook text layer.
  - Append endcard via the concat demuxer when `assets.endcard` is set
    — PNG endcards are still-rendered at `duration_ms`, MP4 endcards
    play through their own duration (capped at 5 s). Output container
    is re-muxed to keep V/A in sync.
  - Probe `ffmpeg -buildconf` once for `--enable-librsvg`; SVG assets
    in a librsvg-less build are skipped with `librsvg_not_available`
    warning while PNG assets in the same kit render normally.
  - `CF_FORCE_NO_LIBRSVG=1` env var simulates a librsvg-less build for
    integration tests.
- `bin/lib/tighten-splice.mjs.buildSpliceGraph` accepts new
  `brandKitChain` + `brandKitFinalLabel` args. The chain reads from
  `[vconcat]` (splice's concat output) and emits a labelled stream that
  feeds the existing overlay/captions tail. ADDITIVE: undefined → identical
  graph to pillar 2; every prior tighten-splice test still passes.
- `bin/lib/render-report.mjs.buildRenderReport` writes a new top-level
  `brand_kit` field — `{applied, source, assets_burned: ["logo",
  "endcard", "lower_third"], warnings: [{code, asset?, message}]}` —
  null when no brand kit applies. Schema `render_report.v1.json`
  extended additively (existing required fields unchanged).
- `agents/caption-stylist.md` documents `$brand.logo` token substitution
  as wired in v0.4.0 pillar 3, with `$brand.colors.primary/.accent` as
  a reserved-but-not-yet-implemented hook (deferred to v0.5.0 per
  `docs/PLAN-v0.4.0.md` §10 decision log).
- `schemas/brand-kit.v1.json` (new) — JSON Schema for the brand-kit file
  format. Documentation only; runtime validation lives in
  `bin/lib/brand-kit.mjs` (zero new deps).
- Tests: 26 new unit (`bin/lib/brand-kit.test.mjs` × 12 +
  `bin/lib/brand-overlay-builder.test.mjs` × 14) + 9 new integration
  (`tests/integration/brand-kit.test.mjs` — logo luminance, endcard
  duration, lower-third time-gating, B1 missing-no-warning, B2
  malformed-warning, B3 missing-asset-warning, B5 legacy-string
  backward-compat regression guard, SVG graceful-degrade,
  composition gate: brand-kit + 16:9 + dub.audio_source + tighten
  cuts + hook_overlay all in ONE render).
- Source: `docs/PLAN-v0.4.0.md` §3.3 + §10 decision log.

### Added — v0.4.0 pillar 2: multi-language dub + voice clone

- New TTS abstraction layer at `bin/lib/tts.mjs` with four backend
  adapters under `bin/lib/tts/`: `elevenlabs.mjs`, `cartesia.mjs`,
  `groq.mjs`, `piper.mjs`. Provider resolution per PLAN-v0.4.0 §7 Q1:
  `ELEVENLABS_API_KEY → CARTESIA_API_KEY → GROQ_API_KEY → Piper local`.
  Override via `CF_TTS_PROVIDER=<name>`. Test injection via
  `CF_TTS_MOCK=<path>` script that emits realistic-duration WAVs
  (~400 ms/word).
- `/clip-forge:voice-clone` (new) — wizard slash command +
  `bin/cf-voice-clone` dispatcher. Slices a 30-second sample from
  `source.mp4`, uploads to the configured provider, persists the
  returned `voice_id` in `voices.json`. Per-project (`./uploads/<slug>/
  voices.json`) wins entirely over global (`~/.clip-forge/voices.json`)
  per Q2. Schema carries `default` + `uses: ["hook", "outro",
  "dub-id", "dub-en", …]` fields. Non-cloning providers (Groq, Piper)
  degrade gracefully with a `voice_clone_disabled_*` warning rather
  than crashing.
- `/clip-forge:dub <lang-codes>` (new) — translate + TTS-dub the
  transcript into one or more target languages. Pipeline: translate
  via `bin/lib/translate.mjs` (mock path now; LLM real-network call
  lands in pillar 4), window into sentences, synthesize per-window
  WAVs via `tts.synthesize`, concat aligned to source `start_ms`,
  silence-pad shorter / warn longer (D3 ±200 ms invariant). Emits
  `./uploads/<slug>/dubbed-<lang>.wav` + `dub_report-<lang>.json` +
  `./clips/<slug>/<clip-id>/edit.dub-<lang>.json` per-lang variants.
- `edit.json` schema additions (additive — v0.3.0 readers ignore):
  `prepend_audio` and `append_audio`, each accepting either
  `{tts: {text, voice_id?, provider?}}` (lazy synthesis cached as
  `<output>.<kind>.wav`) or `{audio_path: <abs path>}`. The renderer
  mux-concatenates these around the main clip, surfacing
  `tts_provider_used` + `tts_nondeterministic` in the render_report.
- New cumulative-spend tracker at `bin/lib/budget.mjs` writing to
  `./renders/<slug>/render_manifest.json.ai_costs`. Honors
  `CF_AI_BUDGET_USD` (default $10) — 80 % checkpoint emits
  `event:budget_checkpoint` NDJSON for the skill to surface via
  `AskUserQuestion`; 100 % hard-stop appends to `skipped[]` with
  `reason: budget_exhausted` and never charges further. `--yolo`
  silent skip at 100 %.
- `schemas/render_report.v1.json` extended additively with
  `ai_costs`, `tts_provider_used`, `tts_nondeterministic`,
  `dub_languages`. Existing render_report consumers see no breaking
  change; `dub_languages` defaults to `[]`, `tts_nondeterministic`
  defaults to `false`.
- `bin/install-models.mjs --piper` (new flag) — downloads the Piper
  TTS binary + one generic English voice model into
  `~/.clip-forge/piper/`. Required only when `/clip-forge:dub` runs
  with no TTS keys; otherwise the resolver picks a paid provider.
- `.env.example` gains `ELEVENLABS_API_KEY`, `CARTESIA_API_KEY`,
  `GROQ_API_KEY`, `CF_TTS_PROVIDER`, `CF_AI_BUDGET_USD` (all optional
  — default install touches none of them).
- README gains a "🔑 BYO API Keys (Optional Tier 2 Features)" section
  above the install instructions, and the OpusClip parity table flips
  Voice cloning row (new) → ✅ + adds a Multi-language dub row → ✅.
- Tests: 36 unit (`bin/lib/tts.test.mjs` × 15 — precedence /
  override / brand_voice_override / mock injection / hallucination
  guard; `bin/lib/voices.test.mjs` × 10; `bin/lib/budget.test.mjs`
  × 12), 11 integration (`tests/integration/dub.test.mjs` × 7 —
  1-lang, 3-lang, D4 idempotency, hallucination guard, budget
  100 % hard-stop, budget 80 % checkpoint event, no-keys + no-piper
  graceful; `tests/integration/voice-clone.test.mjs` × 4;
  `tests/integration/dub-render.test.mjs` × 2 including the
  composition gate — dub.audio_source + 16:9 + tighten + hook_overlay
  + render_manifest.json ai_costs surfaced in render_report).
- Source: `docs/PLAN-v0.4.0.md` §3.2 + §7 Q1/Q2/Q4 + §8 cross-cutting.

### Added — v0.4.0 pillar 1: 16:9 aspect profile

- `target_aspect: "16:9"` in `edit.json` produces a 1920×1080 landscape
  render. Same-crop-smaller-canvas rule from v0.3.0 Q5 extended to the
  first landscape target. crop_path samples unchanged; overlay-builder
  + hook + progress-bar positioning survive the wider canvas.
- `ASPECT_TABLE` in `bin/lib/overlay-builder.mjs` gains the `16:9` entry.
- Tests: 1 unit (`chooseAspectCanvas: "16:9" → 1920x1080`) + 2
  integration (`target_aspect "16:9" → rendered MP4 is 1920x1080` and
  `hook overlay positioning math survives wider canvas`).
- Source: `docs/PLAN-v0.4.0.md` §3.1. See §9 EXIT CRITERIA for the rest
  of v0.4.0.

## [0.3.0] - 2026-05-20

### Added — Pillar I hook overlay + progress bar + emoji burn + aspect profiles + VTT/SRT sidecars

- `edit.json.hook_overlay` (new optional field) —
  `{text: string, end_ms: int, position: "upper-third"|"center"}`. The
  renderer burns a separate ASS layer (layer 5) sitting above the regular
  caption Default layer (0). Look comes from
  `templates/captions/<style>.json.hook_overlay`; `$brand.primary` token
  substitutes against `captions.json.brand.primary`.
- `edit.json.progress_bar` (new optional field) —
  `{enabled: bool, color: hex, height_px: int, position: "bottom"|"top"}`.
  Rendered via a 20-step `drawbox` chain (ffmpeg 6.x's drawbox doesn't
  eval `w` expressions per frame, so per-step `enable` predicates drive
  the animation — 20 steps is smooth at 24-30 fps playback). Fill grows
  linearly from 0 % at t=0 to 100 % at t=duration.
- `edit.json.target_aspect` (new optional field) — `"9:16"` (default) |
  `"1:1"` | `"4:5"`. Maps to 1080×1920 / 1080×1080 / 1080×1350 output
  canvas dims. The renderer overrides `crop_path.target_w/h` in memory;
  same crop CENTER, smaller canvas (see `docs/PLAN-v0.3.0.md` §7 Q5 for
  the framing-rule trade-off). Unknown values fall back to 9:16 + soft
  `unknown_aspect` warning.
- `bin/lib/overlay-builder.mjs` (new, pure-logic, no deps) — four
  builders:
  - `chooseAspectCanvas(targetAspect)` → `{w, h, name, warning|null}`.
  - `buildHookOverlayAss({text, end_ms, position, …})` → `{ass, warnings[]}`.
  - `buildProgressBarDrawbox({enabled, color, heightPx, position, canvasW, canvasH, durationMs})` → `{filter, warnings[]}`.
  - `applyEmojiHighlightToAss(captionsJson, templateBlock)` → `{ass, warnings[]}`. Replaces the inline emoji + highlight logic previously in `cf-caption-burn`.
  All four functions: idempotent (no `Date.now`, no `Math.random`, no
  `process.env` reads); same inputs → byte-identical output. 28 unit
  tests in `bin/lib/overlay-builder.test.mjs`.
- `bin/lib/srt-vtt.mjs` (new, pure-logic, no deps) — `buildVtt(captions)` +
  `buildSrt(captions)`. Both consume the same `captions.json` schema as
  the burned `.ass`, so the three formats stay in lockstep. 15 unit tests
  in `bin/lib/srt-vtt.test.mjs`.
- `bin/cf-ffmpeg render` extended to:
  - Read the three new edit.json fields and thread them through the
    crop expression builder (`target_aspect` → crop.target_w/h
    override) + filter graph (`progress_bar` → 20-step drawbox chain
    inserted before captions burn) + composed ASS file (`hook_overlay`
    → Layer-5 dialogue spliced into a copy of `captions.ass`,
    original never mutated).
  - Emit `<output>.vtt` and `<output>.srt` sidecars next to the MP4
    when `edit.json.captions_json` (or a sibling `.json` to
    `edit.json.captions`) is set + non-empty. Best-effort: skipped
    silently otherwise.
  - Honor `CF_RENDER_DETERMINISTIC=1` on the non-splice (passthrough)
    path too — previously only the splice path forced CPU + bitexact.
    Required for the new overlay.test.mjs idempotency assertion.
- `bin/lib/tighten-splice.mjs.buildSpliceGraph` accepts a new
  `overlayFilter` argument — chain inserted between the concat output
  and the captions burn step. ADDITIVE: undefined / null → identical
  graph to v0.3.0 pillar (a). All tighten-render regression tests
  still pass.
- `bin/lib/render-report.mjs.buildRenderReport` writes three new
  top-level fields: `target_aspect`, `overlays: {hook, progress_bar}`,
  `sidecars: {vtt, srt}`. Schema `render_report.v1` extended additively
  (existing required fields unchanged).
- `schemas/render_report.v1.json` extended with the three new fields
  + four new warning codes (`unknown_aspect`, `hook_overlay_wrapped`,
  `template_missing_hook_overlay`, `progress_bar_invalid_geometry`).
- `bin/cf-caption-burn` extended:
  - Honors `lines[].emoji` and `lines[].words[].highlight` from
    `captions.json` (previously these were already supported; refactored
    onto the new `applyEmojiHighlightToAss` lib for DRY with the
    renderer's burn step).
  - Reads `templates/captions/<style>.json.hook_overlay` block; when
    `captions.json.hook_span` is also present, renders the hook layer
    inline (no separate composed-ass step needed).
  - New `--sidecar-dir <path>` flag: when set, writes `<base>.vtt` +
    `<base>.srt` next to the `.ass` file.
  - New `--target-aspect <name>` flag: sets PlayResX/PlayResY in the
    ASS header so positioning math matches the renderer's output
    canvas. Defaults to 9:16 when unset.
- `templates/captions/Submagic-Pop.json` + `templates/captions/Beast.json`
  carry a `hook_overlay` block per the v0.3.0 design. Karaoke / Neon /
  Gradient deferred to v0.3.1 — they use the default fallback
  (white text, black stroke) at render time with a
  `template_missing_hook_overlay` soft warning.
- `agents/caption-stylist.md` extended: emit a `hook_span: {start_ms,
  end_ms, text}` block in the agent's STRICT JSON output when the
  caller's brief includes a `hook:` line. Existing output fields
  unchanged.
- `skills/caption/SKILL.md` documents `hook_span`, emoji + highlight
  burning, and the new `cf-caption-burn` flags.
- `skills/render/SKILL.md` documents aspect profiles (with the
  same-crop-smaller-canvas framing rule), hook overlay, progress bar,
  font handling (system-fallback only), and sidecar emission.
- `tests/integration/overlay.test.mjs` — 11 positive-evidence
  integration tests:
  - hook overlay luminance band at t=0.5s vs t=4s (after end_ms=1800);
  - progress bar bottom-row fill at t=2.5s vs t=0.5s (≥ 1.5× ratio);
  - 1:1, 4:5, default 9:16 aspect → ffprobed canvas dims;
  - no-overlay + CF_RENDER_DETERMINISTIC=1 → byte-identical per-stream
    video MD5 across two runs;
  - VTT sidecar exists + starts with WEBVTT + has cue blocks;
  - SRT sidecar exists + has numbered blocks + comma timestamps;
  - long hook text → render_report records `hook_overlay_wrapped`;
  - emoji rendered vs. not → caption-region luma differs (≥ 0.01);
  - unknown aspect "5:4" → exit 0, falls back to 9:16, records
    `unknown_aspect` warning.
- Graceful-degradation contract preserved across pillar (i): every
  invalid input becomes a soft warning + sensible default, never a
  render failure. Hard failures (ffmpeg exits non-zero) only when the
  environment itself is broken (libass missing, drawbox unavailable,
  unwritable output path).

### Added — Pillar E brand vocabulary

- `~/.clip-forge/vocab.json` — per-user dictionary of brand / product /
  proper-noun terms with the schema documented in
  [skills/transcribe/SKILL.md](skills/transcribe/SKILL.md). Per-project
  overlay (`./.clip-forge/vocab.json`) deferred to v0.3.1.
- `--vocab <path>` flag on `bin/cf-whisper` plumbs the vocab through
  whisper.cpp's `--prompt` for in-ASR biasing and applies a case-restoring
  post-pass on the produced transcript.
- `--initial-prompt <str>` flag on `bin/cf-whisper` passes a raw prompt
  through to whisper.cpp; prompts longer than 240 whitespace-split tokens
  are truncated with a stderr warning.
- `--apply-vocab-only` mode on `bin/cf-whisper` runs the case-restore
  post-pass on an existing transcript JSON without invoking whisper.cpp —
  used by `skills/transcribe` after the Deepgram branch produces a
  transcript.
- New transcript JSON field `vocab` (additive — v0.2.0 readers ignore it).
  Shape:
  - `{applied:true, restored_count:N, warnings:[…]}` on success.
  - `{applied:false, error:'<reason>'}` on soft vocab-load failure.
  - Absent when `--vocab` was not passed.
- Case-restore matcher: normalises to lowercase + alphanumeric-only,
  matches single-word and multi-word terms via a sliding window across
  consecutive transcript words. Preserves punctuation
  (`"Clipforge!"` → `"ClipForge!"`). Only mutates `words[].w`; `start_ms`,
  `end_ms`, and `confidence` are never touched. Empty `words[]` stays
  empty (hallucination guard at the lib level).
- `bin/lib/vocab.mjs` (new, pure-logic, no deps) — `loadVocabFile`,
  `buildDeepgramKeywords` (100-term cap with `vocab_terms_truncated`
  soft warning, weight × `deepgram.boost` → 0–10 integer), `buildWhisperInitialPrompt`
  (240-token cap, same warning), `applyCaseRestore`. 17 unit tests in
  `bin/lib/vocab.test.mjs` cover defaults, caps, idempotency, multi-word
  matching, punctuation, silent-input guard.
- `skills/transcribe/SKILL.md` documents both branches (Deepgram
  `keywords[]` build + Whisper `--vocab` passthrough), the
  `--apply-vocab-only` shared post-pass route, and the
  `CF_WHISPER_TRANSCRIPT_MOCK` testing hook.
- `CF_WHISPER_TRANSCRIPT_MOCK=<path>` env hook on `bin/cf-whisper`: when
  set, the wrapper skips whisper.cpp and uses the path as the canonical
  transcript JSON. Vocab post-pass still applies. Modeled on
  `CF_CLIP_SCOUT_MOCK` from pillar (c).
- `tests/integration/vocab.test.mjs` — 5 positive-evidence tests covering:
  vocab applied (`clipforge` → `ClipForge`), no-vocab passthrough,
  hallucination guard on silent transcript, truncation warning + honest
  100-term Deepgram cap, byte-identical idempotency across two runs.
- Fixtures committed (deterministic, generated by
  `tests/fixtures/build-fixtures.mjs`):
  `mock-transcript-clipforge-3s.json`, `mock-transcript-silent-3s.json`,
  `sample-vocab.json`, `large-vocab.json` (200 terms).
- `bin/cf-whisper` rewritten from `sh` to Node so the vocab plumbing,
  the mock injection hook, and the post-pass can share the same lib
  without a shell-to-Node trampoline. Real whisper.cpp + ffmpeg path is
  preserved verbatim — same canonical JSON shape, same model cache
  behaviour, same exit semantics. CPU-first, no new npm deps.

### Added — Pillar C prompt-based clipping ("ClipAnything")

- `/clip-forge:clip --prompt "<topic>"` filters clip-scout candidates to
  on-topic spans, then re-ranks the filtered set by virality desc. IDs
  are reassigned `c01..` in the new sorted order.
- `/clip-forge:start --prompt "<topic>"` plumbs the flag through to the
  `Detect clips` step; under `--yolo` a zero-match aborts (does NOT
  silently fall back to no-prompt).
- New top-level `warning` block on `candidates.json` —
  `{ "code": "...", "message": "..." }`. Currently emitted codes:
  `"no_match"` (soft, prompt filtered everything; `fallback_used` stays
  `false`) and `"no_scout_backend"` (hard, dispatcher misconfigured).
  Schema is additive — v0.2.0 readers ignore the field.
- `bin/cf-clip` dispatcher script — auditable routing from the slash
  skill to either the real Agent backend (via `--emit-brief`) or a test
  mock (via `CF_CLIP_SCOUT_MOCK=<path>` env var). Exits 0 on every
  documented failure path; writes a valid `candidates.json` with
  `fallback_used` / `warning` so downstream skills never crash on
  missing artifacts.
- `tests/mocks/clip-scout-mock.mjs` — deterministic stand-in that honors
  the same I/O contract as `agents/clip-scout.md`. Reads brief on stdin,
  emits STRICT JSON on stdout, byte-identical given the same brief.
- `tests/fixtures/topic-transcript-60s.json` — committed 60 s
  synthesized transcript with three contiguous topic blocks (fitness,
  career, cooking) at ≈ 2 words/s. Deterministic mulberry32(20260520)
  seeded by `tests/fixtures/build-fixtures.mjs`.
- `tests/integration/clip-prompt.test.mjs` — 4 positive-evidence tests
  covering: no-prompt baseline spans all three topics, on-topic filter
  returns only matching candidates, zero-match honest empty, re-rank
  invariant inside filtered set. Runs green in CI with no
  `ANTHROPIC_API_KEY` set.

### Added — Pillar B audio enhance

- `/clip-forge:enhance` skill + `bin/cf-enhance` audio cleanup pipeline.
- Default CPU-first filter chain:
  `afftdn=nr=12:nf=-25` → optional `arnndn=m=bin/models/cb.rnnn` →
  adaptive `agate` → `dialoguenhance` → two-pass
  `loudnorm=I=-14:TP=-1.0:LRA=11`.
- Optional Demucs voice-isolation pre-pass via `--voice-isolate` or
  `--demucs`. Demucs is never required; missing or failed Demucs records a
  warning and continues from the original source.
- `enhanced.wav` and `enhance_report.json` output next to the source by
  default, with `integrated_loudness`, `true_peak`, `lra`, and
  `noise_reduction_db` metrics.
- `--edit-json <path>` patches render manifests with
  `"audio_source": "<enhanced.wav>"`; `bin/cf-ffmpeg render` now maps that
  audio source while preserving the original video stream.
- Graceful-degradation contract mirrors `cf-reframe`: documented failures
  exit 0 and write a valid JSON report with `fallback_used` and
  `fallback_reason`.
- RNNoise model installer support:
  `bin/install-models.mjs` fetches `GregorR/rnnoise-models`
  `conjoined-burgers-2018-08-28/cb.rnnn`, pins sha256
  `f1357c4e5be9dee8467bead486dfced2d75b640c26ad0b594fa7f102322371d9`,
  and supports `CF_RNNOISE_MODEL_URL` for caller-supplied model sources.

### Added — Filler-word & silence removal pipeline

- `/clip-forge:tighten` skill + `bin/cf-tighten` plan generator
- Locale-aware filler dictionaries (`en`, `id` v2 with two-tier
  always-cut vs context-only `context_fillers[]`)
- `--aggressive` mode: false-start detection (single repeat only, < 150 ms
  gap), context-filler cuts, confidence floor raised to 0.90,
  triple-or-more repeats kept as intentional emphasis
- `--dry-run`, `--json-logs`, `--keep-pause-ms`, `--min-confidence`,
  `--max-cut-ms`, `--silence-threshold-db`, `--min-silence-ms`,
  `--fillers <path>`, `--no-silence`, `--no-fillers`, `--locale en,id`
- Plan invariants I1–I5 with renderer enforcement (range bounds, sorted
  non-overlapping cuts, kept = complement(cuts), duration consistency,
  source/clip coordinate parity)
- Dual coordinate basis on every cut + kept segment (clip-relative
  `start_ms` / `end_ms` for renderer, source-absolute `source_start_ms`
  / `source_end_ms` for debug + cross-reference)
- Idempotency contract — same inputs produce byte-identical
  `tighten_plan.json` (stable key order, 2-space indent, trailing newline,
  no timestamps/PIDs/hostnames in plan)
- `warnings[]` array with structured `{code, message}` entries for soft
  issues (`no_confidence`, `locale_fallback`, `filler_punct_speech_act`,
  `triple_repeat_kept`, `context_filler_skipped_conservative`,
  `speaker_id_missing_multiword`)
- Punctuation-aware speech-act skip — filler matches followed by `?` or
  `!` are kept (interrogative/exclamatory, not filler)
- Stderr progress on long input seeks (`--start-ms > 0` AND seek > 5 s)

### Added — Splice renderer

- Two-pass render in `cf-ffmpeg`: audio splice encoded first, then
  video+mux with `-c:a copy` — fixes the AAC tail-truncation bug present
  in single-pass combined-encode mode (audio was losing ~160 ms when
  video EOFed slightly before audio)
- 8 ms `acrossfade` at each junction with `apad=pad_dur=(N-1)*0.008`
  silent-tail compensation to keep audio length sample-exact
- Junction quality telemetry (G1 sample-jump ratio with `kurtosis >= 3.0`
  outlier floor, G2 spectral flatness < 0.5 in 80 ms window, G3
  informational RMS spike). G3 status is `pass` or
  `informational_warning` — never fails the render
- `render_report.json` emitted next to every output mp4, schema-validated
  on every write against `schemas/render_report.v1.json`. Includes per-pass
  wall-clock, full per-junction telemetry, plan-warning passthrough, and
  render-level warnings
- `CF_RENDER_DETERMINISTIC=1` env var forces CPU encoder + bitexact +
  single-threaded x264 (`sliced-threads=0:threads=1`) for byte-identical
  per-stream MD5 across re-renders
- Mode-aware A/V drift convention — `render_mode: "splice"` accepts
  baseline negative drift (audio sample-exact, video frame-quantized at
  source fps); `render_mode: "passthrough"` requires tight bilateral
  drift. Warning codes: `av_drift_audio_overhang_excessive` (splice,
  < −50 ms), `av_drift_video_longer_in_splice` (splice, > +50 ms),
  `av_drift_unexpected_passthrough` (passthrough, |drift| > 10 ms)
- Skill ordering validator — `edit.json` carrying `cuts` AND any of
  `broll` / `transitions` / `music` exits non-zero with
  `render: skill ordering violation — tighten plan present after
  broll/transitions bake. Re-run tighten before broll/transitions.`
- Filter graph length warning at > 8 KB (`filter_graph_length_near_limit`)
- Zero-byte output guard exits non-zero and leaves no stub on disk
- NDJSON progress events emit per pass with `{event:"progress",pass,pct}`

### Added — Test infrastructure

- `tests/fixtures/jfk-speech-10s.{mp4,transcript.json,LICENSE.md}` —
  public-domain real-speech fixture (JFK 1961 inaugural address,
  17 USC §105; muxed from whisper.cpp `samples/jfk.wav`)
- `tests/fixtures/stress-plan-n50.json` — committed N=50 stress plan
  (mulberry32 seeded for byte-determinism)
- `tests/integration/tail-duration.test.mjs` (3 tests — 1 s, 5 s, 30 s)
- `tests/integration/tighten-render.test.mjs` (9 tests — R4a, R4d, R4e,
  R4f, R5, R6, ADD-1, ADD-3, ADD-4)
- `tests/integration/tighten-reasr.test.mjs` (R4c — Whisper re-ASR via
  `CF_WHISPER_URL`, skips cleanly on fresh checkouts)
- `tests/integration/tighten-stress.test.mjs` (Phase C — N=50 stress,
  ratio ≤ 2× baseline, schema valid, deterministic MD5 stable)
- `schemas/render_report.v1.json` — JSON Schema draft-07 contract
- `bin/lib/junction-analyzer.mjs` (pure FFT + sample-jump + kurtosis
  primitives, no external deps)
- `bin/lib/render-report.mjs` (hand-rolled JSON Schema validator subset
  to avoid an ajv runtime dep)
- `bin/lib/tighten-splice.mjs` (invariant assertions + splice graph
  builder exposing separate video/audio chains for the two-pass renderer)

### Performance

- 30 s source + 5 cuts: 5.0 s default · 9.3 s deterministic (≈ 6× / 3× realtime)
- 60 s source + 50 cuts: 8.0 s default — counterintuitively *faster* than
  the no-cut baseline of the same source (less audio + video to encode
  per pass)
- Two-pass cost: audio splice ~10 % of total time; video+mux dominates

### Known limitations (Phase C surfaces)

- `skipped_smooth_no_click` G1 status surfaces naturally on tonal content
  (sine waves, very clean speech) — kurtosis correctly identifies no
  outlier signature, gate skips. Documented in
  `skills/tighten/SKILL.md` "G1 status enum"
- At N ≥ 30 cuts on 30 fps source, video frame-grid accumulation can push
  `av_drift_ms` above +50 (audio remains splice-exact). Tracked in
  `docs/ROADMAP.md` v0.3.1 "Tighten splice known characteristics"
- `filter_complex` bytes scales linearly with N; warns at > 8 KB. Falls
  well under ffmpeg's effective limits through at least N = 50. amix
  fallback path documented in `docs/ROADMAP.md` v0.3.1 for future N > ~150

### Added (carried)

- Optional GPU acceleration with CPU fallback:
  `CF_FFMPEG_ENCODER=gpu` tries FFmpeg `h264_nvenc` before `libx264`, and
  `CF_ORT_PROVIDER=gpu|cuda|coreml|dml` tries the requested ONNX Runtime
  provider before CPU. README now documents the Ubuntu 24.04 CUDA/cuDNN
  runtime packages required for ONNX CUDA.

## [0.2.0] - 2026-05-19

This section will become **v0.2.0** when the `bench/v0.2.0` branch lands.

### Added

- **Ultraface RFB-320 face detection** (`onnxruntime@ultraface-rfb-320`)
  via `onnxruntime-node`. Replaces the v0.1.x browser-only `@mediapipe/tasks-vision`
  integration. No Node engine ceiling.
- **PFLD 68-point landmark stage** (`onnx@pfld-68`). Per-face mesh:
  jaw[17] · eyebrowL[5] · eyebrowR[5] · nose[9] · eyeL[6] · eyeR[6] ·
  mouthOuter[12] · mouthInner[8] + `mouth`/`eyeL_center`/`eyeR_center` centroid
  aliases for active-speaker compat. Sourced from `cunjian/pytorch_face_landmark`
  upstream (license caveat tracked in `docs/ROADMAP.md` v0.3.0).
- **`FaceTracker` module** — pure-logic IoU-based identity tracker. ~90 lines,
  deterministic, 8 unit tests. Replaces the v0.1.x Euclidean centroid heuristic
  in `active-speaker._matchTracks`.
- **Animated crop in `cf-ffmpeg`** via a piecewise `crop=W:H:exprX:exprY` ladder.
  Builder in `bin/lib/crop-expression-builder.mjs` (`computeCropDims`,
  `buildCropExpression`, `buildFilterArg`, `buildFilterScript`, `chooseRenderMode`,
  `escapeFilterArg`) — 20 unit tests. `cf-ffmpeg reframe-animated` subcommand
  for standalone crop testing.
- **Success-path integration test** (`tests/integration/success-path.test.mjs`)
  asserts positive evidence of face-tracked output:
    - detector === `onnxruntime@ultraface-rfb-320` (not fallback)
    - framesWithFace / framesProcessed > 0.8
    - 68 landmarks per face, mouth_y stddev > 1 px
    - tracker_flips / duration_s ≤ 1.0
    - rendered mp4 has 3 distinct frame hashes at t=1.0/2.5/4.0 (CR-2 guard)
- **`tests/fixtures/talking-head-5s.mp4`** — 188 KB CGI synth fixture used by
  the success-path test.
- **`docs/screenshots/v0.2.0-proof-t2.5s.png`** — visual proof frame.
- New diagnostic fields in `crop_path.json`: `landmark_detector`,
  `stats.trackerFlips`, `stats.samplesWithKeypoints`, `stats.totalLandmarksPerFace`,
  `stats.mouthYStddev`.

### Fixed

- **CR-1:** Browser-only MediaPipe replaced with Node-native ONNX stack
  (`onnxruntime-node` + `sharp`). The v0.1.x silent fallback path is gone.
- **CR-2:** `bin/cf-ffmpeg` now consumes the full `samples[]` timeline via the
  piecewise crop expression. v0.1.x collapsed everything to `samples[0]`.
  Original Phase 2D spec called for `ffmpeg sendcmd` — empirical test against
  `ffmpeg 6.1.1-3ubuntu5` showed the `crop` filter returns `AVERROR(ENOSYS)`
  for both `x`/`y` and generic `reinit` commands (upstream gap, not packaging).
  Pivoted to expression mode; bisected ffmpeg's nested-if ceiling at exactly
  99 levels; mitigated with stride-downsampling. See `docs/bench-v0.2.0.md`
  Phase 2D for the trace logs and bisection record.
- **CR-5:** Real-fixture success-path test prevents silent fallback regression.
  Run `npm test` before any release; the test class fails on any of: fallback
  detector, missing keypoints, static crop, or identical sample frames.

### Changed

- `package.json` deps: `@mediapipe/tasks-vision` removed; `onnxruntime-node`
  and `sharp` added. Engines: `node >=20` (no upper bound — onnxruntime
  supports 24+).
- `bin/install-models.mjs` downloads two ONNX models (~4 MB total) instead of
  the v0.1.x BlazeFace .tflite. Supports `CF_PFLD_MODEL_URL` env override.
- `bin/cf-reframe` defaults to `detector: 'onnxruntime@ultraface-rfb-320'`
  (was `mediapipe@blazeface-short`).
- Per-frame budget bumped to 1000 ms when the landmarker is active (was
  200 ms for face-only v0.1.x).

### Performance

Measured on Linux x86_64, Node 20.20, CPU only:

- Ultraface detect: **p50 9.5 ms / p95 21.8 ms** per frame
- PFLD landmarks: **p50 59 ms / p95 63 ms** per face (ORT-only)
- End-to-end per-face in pipeline: **p50 117 ms / p95 131 ms**
- Projected: **30-minute source processes in ~27 minutes** at 6 fps sampling

Speed-up tracked in `docs/ROADMAP.md` v0.3.0 — int8 quantization, worker-thread
pool, optional GPU execution provider.

### Removed

- v0.1.2 "⚠ Status" README section (MediaPipe doesn't work in Node) — the
  underlying issue is fixed. Historical note retained in this CHANGELOG.
- `bin/wasm/` directory (briefly added mid-v0.2.0 development for a MediaPipe
  vendoring attempt that was abandoned when we swapped to ONNX). `.gitignore`
  entry retained.

## [0.1.2] - 2026-05-19

### Fixed

- **CR-4:** version drift across `plugin.json`, `package.json`,
  `marketplace.json`, and git tags. New `scripts/bump-version.mjs`
  enforces single-source-of-truth bumping with working-tree-clean,
  `npm test`, `claude plugin validate .`, and CI-status guards.
- **CR-3:** dropped the fictional sha256 check in `bin/install-models.mjs`
  that printed a misleading "mismatch" warning on every install.

### Documented

- **README ⚠ Status (v0.1.2) section** discloses that face-tracked reframe
  does not function in Node — `@mediapipe/tasks-vision` is browser-only.
  Every `cf-reframe` invocation falls through to static center-crop. This
  was technically true in v0.1.0 and v0.1.1; the README + CHANGELOG misled.
- `bin/lib/face-detector.mjs` now hard-disables detector init with reason
  `mediapipe_not_supported_in_node`, surfaced in
  `crop_path.json.fallback_reason`.
- New `docs/ROADMAP.md` tracks v0.2.0 (library swap, animated crop, real
  success-path test), v0.2.x stability, v0.3.0 polish, v0.4.0 OAuth.
- `docs/REVIEW.md` self-audit (from v0.1.1) linked from README §Engineering.
- Integration tests rewritten to assert the *real* behaviour: every
  invocation lands in fallback with `mediapipe_not_supported_in_node` in
  `fallback_reason`. Reality-aligned, not aspirational.
- `CONTRIBUTING.md` documents the new release process: `npm run bump <kind>`.

### Not fixed in this patch

- **CR-1, CR-2, CR-5** require a library swap and renderer rewrite — out of
  scope for a 0.0.x patch. See `docs/ROADMAP.md` v0.2.0.

## [0.1.1] - 2026-05-20

### Added

- Code of Conduct (Contributor Covenant v2.1).
- `CONTRIBUTING.md` with setup, conventional-commits requirement, PR
  checklist, and triage policy.
- `SECURITY.md` reporting flow via GitHub Security Advisories.
- Issue forms — `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml`
  — and `.github/PULL_REQUEST_TEMPLATE.md`.

### Notes

- No code changes. Functionally identical to v0.1.0.
- Raises GitHub Community Standards score from 42 % to ≥ 90 %, unblocking
  community-marketplace submission.

## [0.1.0] - 2026-05-20

### Added — face-tracked reframe (`bin/cf-reframe` v2)

- Real MediaPipe BlazeFace short-range integration replacing the v0.1.0
  center-crop placeholder. Detection runs at 6 fps by default with all six
  BlazeFace keypoints (eyes, nose, mouth, ears) plumbed through.
- Active-speaker selection (`bin/lib/active-speaker.mjs`) — weighted score
  over four cues: audio (speaker→face mapping), mouth movement (rolling
  10-frame delta), centrality, detector confidence. Switching damper
  prevents target flips faster than 0.8 s + 24 frames.
- Speaker→face calibration: `--speaker-map auto|named|numeric` plus an
  `autoCalibrateSpeakerMap()` that takes a transcript + 5 s lead-in and
  picks the median face position per `speaker_id`.
- `bin/install-models.mjs` — idempotent BlazeFace model downloader with
  size check + sha256 warn.
- `bin/lib/frame-extractor.mjs` — async iterator over an ffmpeg rgb24 pipe
  with AbortSignal cancellation support and source-coord up-projection
  metadata.
- `bin/lib/debug-frame.mjs` — zero-dep PPM writer that overlays the chosen
  bbox + keypoints, emitted by `--debug` every 30 frames.
- New CLI flags on `cf-reframe`: positional source, `--output`, `--sample-fps`,
  `--target-aspect`, `--min-confidence`, `--weights`, `--no-active-speaker`,
  `--fallback center|topcrop`, `--speaker-map`, `--transcript`, `--debug`,
  `--json-logs`, `--help`. The v0.1.0 `--in / --out / --start-ms / --end-ms`
  surface remains valid for backwards compatibility.
- Robustness layer: detector init wrapped in try/catch with graceful
  degradation, per-frame 200 ms soft budget with skip-next cooldown,
  >50 % no-face yield → center-crop fallback, partial extraction handling
  on mid-stream ffmpeg errors. Exit code 0 in every failure mode.
- `crop_path.json` bumped to `version: 2`. New fields: `detector`, `stats`,
  `speaker_map`. The v1 sample shape (`samples[].cx/cy/scale/letterbox`)
  is preserved so `bin/cf-ffmpeg render` consumes both versions unchanged.
- Test suite (`npm test`) — 22 passing + 2 skipped: `parseSpeakerMap`
  variants, switching damper hold/release, auto-calibration median picking,
  deterministic scoring, detector idempotency, integration tests that
  generate a 5 s testsrc video and validate schema + fallback path. CI
  matrix now includes macOS in addition to Ubuntu.
- Docs: README "Reframe & active speaker" section, blueprint defaults entry,
  `tests/fixtures/README.md` for the bring-your-own-PNG fixture flow.

### Added — initial public scaffold

- Manifest, settings, README with architecture diagram.
- Entry skill `/clip-forge:start` orchestrating the full pipeline.
- Onboarding wizard `/clip-forge:onboard` writing `~/.clip-forge/profile.json`.
- Workflow skills: `import`, `transcribe`, `clip`, `reframe`, `caption`,
  `broll`, `music`, `render`, `publish`, `schedule`, `analytics`.
- Five specialist agents: `clip-director` (default), `clip-scout`,
  `caption-stylist`, `reframe-engineer`, `publisher`.
- MCP servers: Pexels (real), Deepgram (community), TikTok / YouTube /
  Instagram (stubbed pending OAuth).
- bin/ helpers: `cf-ytdlp`, `cf-ffmpeg`, `cf-reframe`, `cf-caption-burn`,
  `cf-whisper` (offline fallback), plus hook/monitor scripts.
- Hooks: SessionStart preflight, PostToolUse hints on new uploads and edit
  manifest changes.
- Monitors: `render-queue`, `publish-queue`, `new-uploads`.
- Caption templates: Beast, Submagic-Pop, Karaoke, Neon, Gradient.
- Thumbnail Remotion composition.
- CI: `claude plugin validate` + JSON / JS / sh syntax checks on every PR.
- LICENSE (MIT), placeholder demo GIF, marketplace.json snippet.

### Known limitations

- TikTok / YouTube / Instagram MCP servers return `auth_required` until
  the OAuth flows are wired (a separate engineering slice, deferred until
  API credentials are provisioned).
- `bin/cf-reframe`'s 200 ms per-frame budget is a soft limit. MediaPipe's
  `detectForVideo` is synchronous; pure-JS code cannot hard-interrupt a
  sync call without worker threads. The cooldown-skip strategy keeps slow
  frames from cascading but a single frame can still block briefly.
- No intro stingers ship by default; users provide their own.
