# PLAN — ClipForge v0.4.0 (BYO-key external AI + repurposing depth)

**Status:** REVIEWED & LOCKED — open questions resolved 2026-05-21. Ready
to scaffold; pillar (1) 16:9 aspect ships first as half-day momentum work.
**Author:** clip-forge core (2026-05-21).
**Predecessor:** [docs/PLAN-v0.3.0.md](PLAN-v0.3.0.md) (shipped: pillars
a/b/c/e/i), [docs/ROADMAP.md](ROADMAP.md) (v0.4.0 deferred slate),
competitive analysis of Agent Opus (2026-05-21 chat — not committed;
see §10 decision log).
**Scope:** Repurposing-depth features that close OpusClip + Agent Opus
parity WITHOUT abandoning the moat. Default execution remains CPU-local;
every new external AI integration follows the existing `DEEPGRAM_API_KEY`
/ `PEXELS_API_KEY` opt-in BYO-key pattern.

> **Constraint shift from v0.3.0.** v0.3.0 rejected voice cloning,
> visual styles, AI avatars, prompt-driven editing, and multi-language
> dub as anti-moat. v0.4.0 RE-OPENS those rejections under a stricter
> BYO-key contract: external APIs are allowed when keyed by the user;
> missing keys degrade gracefully to local-only behavior (Piper TTS
> as the offline TTS fallback); ClipForge hosts no server, holds no
> tokens, brokers no traffic.

---

## 0. The five re-classified features

| Feature | v0.3.0 verdict | v0.4.0 verdict | Providers (BYO) | Cost / 30s clip | Moat preservation |
|---|---|---|---|---|---|
| Voice cloning + TTS ✅ shipped | REJECT | **ACCEPT** | ElevenLabs · Cartesia · Groq PlayAI · **Piper TTS (local fallback)** | $0.025–0.15 (or $0 with Piper) | Key absent → Piper local TTS or original audio retained; never fail render. |
| Multi-language dub ✅ shipped | implicit REJECT | **ACCEPT** | Whisper translate (local) + above TTS providers | $0.025–0.15 + translate | Key absent → translation written; dub skipped with warning. |
| Visual styles | REJECT | **CONDITIONAL ACCEPT** — scope to B-roll + intro stingers only, NOT primary clip body | fal.ai Flux Schnell · Nano Banana · Replicate fallback | $0.10–2.50 | Stylization operates on FETCHED footage (Pexels) or generated stingers — never the creator's primary clip. |
| AI Avatars | REJECT | **CONDITIONAL ACCEPT** — limited to ≤5s intro/outro stingers, never clip body | HeyGen · D-ID · Hedra | $0.30–1.50 / sec × ≤5s | Avatar is a stinger asset only. Two-gate consent (§7 Q3). |
| Prompt-driven re-edit | REJECT | **ACCEPT** (bundled into cf-edit) | Groq Llama 3.3 70B (default) · Anthropic Claude Haiku 4.5 (fallback) | $0.001–0.02 / instruction | LLM emits RFC 6902 JSON patch against existing edit.json; 3-layer validation (schema + whitelist + dry-run preview). |

---

## 1. Why the BYO-key shift preserves the moat

Five rules (unchanged from v0.3.0):

1. **Default CPU-local.** Every new env var (`GROQ_API_KEY`, `ELEVENLABS_API_KEY`, `FAL_API_KEY`, `HEYGEN_API_KEY`, etc.) is OPTIONAL. The default install never touches paid features. Piper TTS is the offline fallback for the TTS-dependent slice.
2. **Graceful degrade.** Mirrors the existing `DEEPGRAM_API_KEY` → Whisper fallback. Missing key never crashes a render; the dependent skill prints `⚠ <feature> skipped — set <KEY> to enable` and proceeds.
3. **No ClipForge server.** All API calls go user → provider directly. ClipForge ships no proxy, holds no creator tokens, has no infrastructure liability.
4. **Terminal-native.** Slash commands + `skills/<name>/SKILL.md` only. No web UI added.
5. **Repurposing-first.** Every BYO-key feature operates on the user's existing long-form source.

**Wedge-violation guard:** a new skill is moat-safe ONLY IF its primary input is the user's source video. Every v0.4.0 pillar passes that test.

---

## 2. v0.4.0 milestone — 6 picks (ship order)

Scoring: `score = impact × (1 / effort) × moat_safety`. Impact 1–5, effort
1=L / 2=M / 3=S, moat_safety 1–5. **Ship order** intentionally diverges
from pure score where revenue-stream momentum matters (#5 AI B-roll
precedes #6 Speaker-aware despite lower score — validating the new
BYO-key tier early gives feedback signal on pricing/UX before locking
the rest of the BYO surface).

| # (ship order) | Pick | Impact | 1/Effort | Moat | Score | LOC |
|---|---|:-:|:-:|:-:|:-:|---|
| 1 | **16:9 aspect profile** ✅ | 5 | 3 (S) | 5 | **75** | ~30 |
| 2 | **Multi-language dub + voice clone** ✅ | 5 | 2 (M) | 4 | **40** | ~600 |
| 3 | **Brand kit / custom assets** ✅ | 4 | 2 (M) | 5 | **40** | ~400 |
| 4 | **cf-edit + prompt-driven re-edit** | 4 | 2 (M) | 4 | **32** | ~500 |
| 5 | **AI B-roll: stylization + avatar stingers** | 3 | 2 (M) | 3 | 18 | ~700 |
| 6 | **Speaker-aware reframe / split-screen** | 3 | 2 (M) | 5 | 30 | ~650 |

**Total LOC:** ~2880. **Realistic shipping window:** ~4–5 weeks.

### Explicitly deferred to v0.5.0

| Pick | Reason |
|---|---|
| (d) Manual reframe pin override | Power-user only; deferred again. |
| (g) XML / FCPXML export | Niche editor handoff; partial support worse than none. Ship `.edl` first when slot opens. |
| (j) Real OAuth publish | Gates on TikTok/YT/IG developer-program approval; ships per-platform as approvals arrive, NOT blocked by v0.4.0. |

---

## 3. Per-pillar specs

### 3.1 — 16:9 aspect profile (S, ~30 LOC)

Extend `bin/lib/overlay-builder.mjs::chooseAspectCanvas()` to accept `"16:9"` → 1920×1080. Renderer already aspect-aware (pillar i). No new skill.

**Invariants.** I1: `target_aspect: "16:9"` → 1920×1080 output. I2: crop_path samples unchanged (same-crop-smaller-canvas rule from v0.3.0 Q5). I3: overlay/progress-bar positioning respects wider canvas.

**Tests.** Append to `tests/integration/overlay.test.mjs`:
- `test('aspect: target_aspect "16:9" → rendered MP4 is 1920×1080')`
- `test('aspect 16:9: hook overlay positioning math survives wider canvas')`

**Effort:** Ship same day.

---

### 3.2 — Multi-language dub + voice clone (M, ~600 LOC)

**Skills.**
- `/clip-forge:voice-clone` — wizard, captures ≥30s sample from source, uploads to provider, stores `voice_id`.
- `/clip-forge:dub` — translates transcript → synthesizes target-language audio aligned to source timeline → patches `edit.json.audio_source`.

**TTS provider precedence (locked Q1):**
```
ELEVENLABS_API_KEY set     → ElevenLabs (best quality, voice clone gold)
CARTESIA_API_KEY  set      → Cartesia (real-time, low latency)
GROQ_API_KEY      set      → Groq PlayAI (fast & cheap, batch dub)
none of the above          → Piper TTS local (warn: voice clone DISABLED, generic TTS only)
CF_TTS_PROVIDER=<name>     → user-forced override
```
Piper TTS is the local fallback — no voice clone, generic voice models from `~/.clip-forge/piper/voices/<lang>-<name>.onnx` (fetched lazily by `bin/install-models.mjs --piper` when first needed).

**voices.json scope (locked Q2): per-project wins, global default optional.**

Resolution order:
1. `./uploads/<slug>/voices.json` — per-project (wins)
2. `~/.clip-forge/voices.json` — user default

**Schema (both files share):**
```jsonc
{
  "version": 1,
  "default": "creator-main",
  "voices": {
    "creator-main": {
      "provider":     "elevenlabs",
      "voice_id":     "abc123",
      "sample_path":  "/abs/path/sample.wav",
      "created_at":   "2026-05-21T...",
      "uses":         ["hook", "outro", "dub-id", "dub-en"]
    }
  }
}
```

The `uses` field lets the skill match a voice to a role (e.g. `/clip-forge:dub --lang id` looks for a voice with `uses: ["dub-id"]` first).

**Pipeline:**
1. Read transcript.json + clip boundaries.
2. Translate (Whisper local `--task translate`, or Groq translate API).
3. Per-sentence TTS call → temp WAV.
4. Concat aligned to original sentence start_ms (silence-padding).
5. Write `./uploads/<slug>/dubbed-<lang>.wav` + `dub_report.json`.
6. Patch `edit.json.audio_source` + new `dub` block.

**Schema delta (`edit.json`):**
```jsonc
{
  "audio_source": "./uploads/<slug>/dubbed-id.wav",
  "dub": {
    "source_lang": "en",
    "target_lang": "id",
    "voice_id":    "creator-main",
    "provider":    "elevenlabs",
    "report":      "./uploads/<slug>/dub_report.json"
  }
}
```

**Invariants:**
- D1: No TTS provider keys AND Piper not installed → `/clip-forge:dub` exits 0, `fallback_reason: "no_tts_provider"`.
- D2: Target language unsupported by chosen provider → fallback down the precedence list; if all fail → `target_lang_unsupported_all_providers`.
- D3: Dubbed WAV duration matches source ±200ms; pad silence if shorter; warning `dub_audio_longer_than_source` if longer.
- D4: Idempotent — same transcript + same voice_id + same provider + same seed → byte-identical `dubbed.wav`. Provider nondeterminism → warning `tts_nondeterministic`.
- D5: Cost cap via `CF_AI_BUDGET_USD` (Q4 behavior — 80% checkpoint, 100% hard-stop).

**Telemetry — `dub_report.json`:**
```jsonc
{
  "version": 1,
  "source_lang": "en", "target_lang": "id",
  "provider": "elevenlabs", "voice_id": "creator-main",
  "duration_source_ms": 46000, "duration_dubbed_ms": 45820,
  "drift_ms": -180,
  "cost_usd_estimate": 0.087,
  "tts_calls": 12,
  "fallback_used": false, "fallback_reason": null,
  "warnings": []
}
```

**Tests — `tests/integration/dub.test.mjs`:**
- Mock TTS hook `CF_TTS_MOCK=<path>` reads brief, emits pre-baked WAV.
- Mock translate hook `CF_TRANSLATE_MOCK=<path>` returns translated transcript JSON.
- **Realistic-mock requirement:** mock-emitted WAV duration must match the expected dubbed duration (within ±50ms) so downstream timing assertions stay valid.
- Assert: dubbed.wav exists, duration ≈ source ±200ms, edit.json patched, report schema-valid, idempotency (two runs byte-identical).
- Hallucination guard: empty transcript → empty dubbed.wav (silence), warning emitted.
- Piper fallback path: no API keys, Piper voice model present → produces a valid (generic-voice) dubbed.wav.

---

### 3.3 — Brand kit / custom assets (M, ~400 LOC)

Extend `edit.json.watermark` from a single path to an optional typed brand-kit object. New per-user `~/.clip-forge/brand-kit.json` (sister to `~/.clip-forge/vocab.json` from pillar e). Caption templates + overlay-builder gain token substitution `$brand.logo`, `$brand.endcard`, `$brand.lower_third`.

**New skill:** `/clip-forge:brand-kit` — wizard to configure assets.

**Schema — `~/.clip-forge/brand-kit.json`:**
```jsonc
{
  "version": 1,
  "assets": {
    "logo":        { "path": "/abs/logo.png", "position": "bottom-right",
                     "opacity": 0.7, "scale_px": 96 },
    "endcard":     { "path": "/abs/endcard.mp4", "duration_ms": 3000 },
    "lower_third": { "path": "/abs/lt.png", "position": "bottom",
                     "opacity": 0.9, "show_from_ms": 1500, "show_until_ms": 4000 }
  }
}
```

**Invariants:**
- B1: Missing brand-kit.json → no rendering change, no warning.
- B2: Malformed brand-kit.json → fallback to no-brand, soft warning `brand_kit_unreadable`. Exit 0.
- B3: Brand asset path missing → soft warning `brand_asset_missing:<key>`, asset skipped, render continues.
- B4: Caption template `$brand.logo` token substitution idempotent.
- B5: Backward-compat — `edit.json.watermark: "<path>"` (string) still works as logo-only kit.

**Tests — `tests/integration/brand-kit.test.mjs`:**
- Logo at bottom-right → luminance band visible at frame t=2s in that region
- Endcard appended → MP4 duration = clip_duration + endcard.duration_ms
- Lower-third visible only in show_from_ms..show_until_ms window
- Missing brand-kit → no warning, no change (B1)
- Malformed brand-kit → warning + render succeeds (B2)

---

### 3.4 — cf-edit + prompt-driven re-edit (M, ~500 LOC)

**New skill:** `/clip-forge:edit` with two modes.

**Mode 1 — Diff mode (default).** Pure-logic content-hash diff against `./renders/<slug>/render_manifest.json`. Re-renders only stale clips. NO LLM needed.

**Mode 2 — Prompt mode.** LLM emits RFC 6902 JSON patch against current edit.json → 3-layer validation (Q5) → auto dry-run preview → user approves → patch applied → diff-mode re-render kicks in.

**LLM provider precedence (locked Q6):**
```
GROQ_API_KEY        set → groq llama-3.3-70b-versatile (default, ~$0.59/M tokens, ~$0.001/edit)
ANTHROPIC_API_KEY   set → claude-haiku-4-5-20251001 (~$0.02/edit; reserved for complex)
both absent              → prompt mode disabled; diff mode still works
CF_LLM_PROVIDER=anthropic → force Claude even when Groq set
```

Reasoning: Groq Llama is plenty smart for JSON-patch synthesis at 1/20 the cost. Claude reserved for skills with complex reasoning (clip-scout virality scoring, caption-stylist style choice).

**3-layer validation (locked Q5):**
1. **JSON Schema** against `schemas/edit.json.patch.v1.json` — every patch op shape-valid.
2. **Whitelist** of editable JSON Pointer paths — only these may be patched:
   - `/cuts/*/start_ms`, `/cuts/*/end_ms` (tighten plan)
   - `/captions/style`, `/captions/font`, `/captions/emoji_density`
   - `/hook_overlay/text`, `/hook_overlay/end_ms`, `/hook_overlay/position`
   - `/progress_bar/*`
   - `/target_aspect`
   - NOT editable: `/crop_path`, `/audio_source`, `/clip_id`, `/source`, `/output`
3. **Auto dry-run preview** — print the diff to stdout; AskUserQuestion gate before apply. `--auto-apply` skips preview (implied by `--yolo`).

**Retry policy on validation fail:** First failure → re-prompt LLM with the validation error message. Second failure → ask user "LLM patch invalid, edit manually?" with the offending patch as starter context. Never silently apply malformed patches.

**LLM system prompt (versioned at `config/llm-prompts/cf-edit-v1.md`):**
```
You are clip-edit-assistant. Given a clip's edit.json + transcript slice,
return STRICT JSON only — an RFC 6902 patch describing the changes the
user requested. Whitelisted paths:
  /cuts/*/start_ms, /cuts/*/end_ms
  /captions/style, /captions/font, /captions/emoji_density
  /hook_overlay/text, /hook_overlay/end_ms, /hook_overlay/position
  /progress_bar/*
  /target_aspect
NOT editable: /crop_path, /audio_source, /clip_id, /source, /output.
If the request cannot be safely interpreted, return:
  {"patch": [], "warning": {"code": "ambiguous_prompt", "message": "..."}}
```

**New artifact — `./renders/<slug>/render_manifest.json`** (cf-edit lockfile):
```jsonc
{
  "version": 1, "slug": "podcast-ep-42",
  "rendered_at": "2026-05-21T12:34:56Z",
  "clips": {
    "c01": {
      "output": "./renders/podcast-ep-42/c01.mp4",
      "input_hashes": {
        "edit_json":    "sha256:...",
        "crop_path":    "sha256:...",
        "captions_ass": "sha256:...",
        "cuts_plan":    "sha256:...",
        "audio_source": "sha256:..."
      },
      "rendered_sha256": "sha256:..."
    }
  }
}
```

**Invariants:**
- E1: `cf-edit --dry-run` prints exactly the clips whose input hash differs. Empty diff → empty print.
- E2: After non-dry run, new manifest hashes match current inputs for re-rendered clips.
- E3: `cf-edit --force` re-renders all + updates manifest.
- E4: Idempotent — two runs with no input changes → second re-renders zero clips.
- E5: Missing manifest → cold-start re-renders ALL clips and writes manifest.
- E6: Prompt-mode patches validated against schema + whitelist BEFORE apply; invalid → reject + warning, no apply.
- E7: Prompt-mode patches user-approved via dry-run preview unless `--yolo` / `--auto-apply`.

**Tests — `tests/integration/edit.test.mjs`:**
- Cold start, no-op, partial, force scenarios
- Prompt-mode mock `CF_LLM_MOCK=<path>`: patch applied, diff-mode follows
- Prompt-mode invalid patch (whitelisted-path violation): rejected + retry triggered
- Prompt-mode without keys: diff-mode still works; prompt mode exits 0 with `no_llm_provider`

---

### 3.5 — AI B-roll: stylization + avatar stingers (M, ~700 LOC)

The narrowest, most-aggressive net-new dependency. Scoped tightly. **Shipped before pillar (6)** to validate the BYO-key tier UX/pricing/consent flow early.

**Stylized B-roll** — extends `skills/broll/SKILL.md` with `--style <name>`:
- Pipeline: Pexels frame → fal.ai Flux Schnell (frame stylization) → AnimateDiff via fal (tween) → composite back as B-roll cutaway
- Catalog of 8 styles in `templates/styles/<name>.json`: Claymation, Watercolor, Pen & Ink, Halftone, Schematic, Blue Vox, Marcinelle, Vox
- Provider: fal.ai (primary) → Replicate (fallback) → Nano Banana (still-frame alternative)

**Avatar stingers** — new `/clip-forge:stinger`:
- `--intro` / `--outro` generates ≤5s talking-head
- Provider: HeyGen (premium photorealistic), D-ID (mid), Hedra (cheap lip-sync)
- Output: `templates/intros/<slug>-<clip-id>.mp4` — concat-prepended/appended at render

**New env vars:**
- `FAL_API_KEY`, `REPLICATE_API_TOKEN`, `NANO_BANANA_API_KEY` — stylization
- `HEYGEN_API_KEY`, `DID_API_KEY`, `HEDRA_API_KEY` — avatars
- `CF_AI_BUDGET_USD` — per-skill-chain cost ceiling (default 10.00)
- `CF_AVATAR_CONSENT=1` — first-use consent gate

**Avatar consent — two-gate system (locked Q3):**

**Gate 1 (one-time, env var):**
- `CF_AVATAR_CONSENT=1` required before ANY avatar generation
- Confirms: "Saya hanya pakai foto orang dengan izin / I only use photos with subject consent"
- README documents the requirement; first-use error message links to it
- Approval written to `~/.clip-forge/.consent-log` with timestamp

**Gate 2 (per-photo, sha256 cache):**
- SHA256 hash of each input photo logged in `~/.clip-forge/.consent-log`
- Re-using same photo → no re-prompt
- New photo → AskUserQuestion: "Foto ini punya izin subject? (y/N)"
- 'N' → skip avatar generation, fall back to static-text stinger
- `--no-avatar` flag → run-time override; never generates avatar regardless of consent state

**Cost-cap-breach behavior — checkpoint + hard-stop (locked Q4):**

`CF_AI_BUDGET_USD` defaults to `10.00`. Tracked cumulatively across all paid skills in the same `/clip-forge:start` invocation chain via `render_manifest.json.ai_costs.cumulative_usd`.

- **80% threshold** ($8 of $10) → AskUserQuestion: "Cost $8.00 / $10.00. Raise to $20? (y/N)"
  - 'y' → cap raised to $20, continue
  - 'N' → graceful finish current skill, skip remaining paid steps in the chain
- **100% threshold** ($10/$10) → HARD STOP, no further paid calls
  - Render finishes with whatever is already done
  - render_report carries `budget_exhausted: true` and lists `skipped_clips: [...]`
  - Exit code 0 (user opted into the cap)
- **`--yolo` mode** → silent skip at 100% (no AskUserQuestion); same telemetry

**Invariants:**
- A1: `--style <name>` without any stylization provider key → exit 0, fallback to unstyled Pexels, `fallback_reason: no_stylize_provider`.
- A2: Stylization budget breach → graceful skip (Q4 behavior), unstyled cutaways instead.
- A3: Avatar stinger ≤5s hard cap. Longer requests truncate + warn `avatar_duration_capped`.
- A4: Seed pinned across cutaways in same clip → visual consistency.
- A5: Avatar consent two-gate enforced (Q3). Missing `CF_AVATAR_CONSENT=1` → refuse with link to README.

**Tests — `tests/integration/ai-broll.test.mjs`:**
- Mock fal provider `CF_FAL_MOCK=<path>` → pre-baked stylized JPEG
- Mock avatar hook `CF_AVATAR_MOCK=<path>` → pre-baked 3s MP4
- Style applied: B-roll cutaway is mock JPEG (sha256 match)
- Avatar appended: MP4 duration = clip_duration + stinger_duration
- Cost cap 80% checkpoint: AskUserQuestion fires under non-yolo
- Cost cap 100% hard-stop: render finishes, skipped_clips populated
- No-key path: existing v0.3.0 Pexels behavior preserved (regression guard)
- Consent gate 1 missing: avatar refused, fallback to static-text stinger
- Consent gate 2: new photo prompts AskUserQuestion; same photo re-used → no prompt

---

### 3.6 — Speaker-aware reframe / split-screen (M, ~650 LOC)

From v0.3.0 deferred slate. Local-only, no new APIs.

Reframe consumes per-word `speaker` field from `transcript.json` (Deepgram diarizes; Whisper diarize patchy → opt-in `--diarize sherpa` for sherpa-onnx VAD). When ≥2 speakers active in 1.5s window, render split-screen letterbox (vstack for 9:16, hstack for 16:9 / 1:1).

**New flag on `cf-reframe`:** `--speaker-route auto|none` (default `auto` when ≥2 speakers).

**Schema delta (`crop_path.json` v3):**
```jsonc
{
  "version": 3,
  "samples": [
    { "t_ms": 0, "cx": 940, "cy": 540, "scale": 1.78, "letterbox": false },
    { "t_ms": 4500, "split_screen": {
        "speakers": [
          { "speaker_id": 0, "cx": 480, "cy": 540, "scale": 1.4 },
          { "speaker_id": 1, "cx": 1440, "cy": 540, "scale": 1.4 }
        ]
      }
    }
  ]
}
```

**Invariants:**
- S1: Single-speaker transcript → no split_screen samples; v0.2.0 behavior preserved.
- S2: Split-screen window ≥1.5s; brief overlap → keep dominant.
- S3: Crop expression handles split_screen via `hstack`/`vstack`.
- S4: render_report carries `split_screen_segments_count`.

**Tests — `tests/integration/split-screen.test.mjs`:**
- Two-speaker fixture → ≥1 split_screen sample
- Rendered MP4 at split-screen timestamp has two distinguishable face regions
- Single-speaker fixture → zero split_screen samples (regression guard)

---

## 4. Test contract — positive-evidence integration tests

Every new `bin/cf-*` script + every new skill mirrors graceful-degradation
contract from cf-tighten / cf-enhance / cf-reframe / cf-clip / cf-whisper.
Every new test asserts EFFECT, not exit code.

**Mock injection points (complete list):**

| Env var | Skill | Returns |
|---|---|---|
| `CF_TTS_MOCK=<path>` | dub, voice-clone | pre-baked WAV |
| `CF_TRANSLATE_MOCK=<path>` | dub | translated transcript JSON |
| `CF_LLM_MOCK=<path>` | cf-edit prompt mode | RFC 6902 patch |
| `CF_FAL_MOCK=<path>` | AI B-roll stylization | pre-baked JPEG |
| `CF_AVATAR_MOCK=<path>` | avatar stinger | pre-baked MP4 |
| `CF_WHISPER_TRANSCRIPT_MOCK=<path>` | transcribe (v0.3.0, existing) | transcript JSON |
| `CF_CLIP_SCOUT_MOCK=<path>` | clip-prompt (v0.3.0, existing) | candidates JSON |

**Realistic-mock requirement (CRITICAL):** every mock must emit a response whose **timing** matches what the real provider would produce. Mock TTS WAVs must have duration matching the input text length (±50ms tolerance). Mock translation transcripts must preserve `start_ms`/`end_ms` from the source. Mock LLM patches must reference real edit.json paths. Mocks that emit "easy" placeholders break downstream timing/sync assertions and produce false greens.

**Regression guarantees** (MUST still pass at v0.4.0 ship):
- All v0.3.0 tests: tighten, enhance, clip-prompt, vocab, overlay (with composition)
- All v0.2.0 tests: success-path, fallback-path
- Phase C stress, tail-duration suites

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Runaway cost from AI APIs | `CF_AI_BUDGET_USD` cumulative across skill chain (Q4 80%/100% behavior); dry-run prints estimated cost before any spend; `--cost-confirm` for one-shot bypass; per-skill cost breakdown in render_report `ai_costs` block. |
| BYO key proliferation (8+ env vars) | Consolidated discovery via `/clip-forge:onboard` wizard; `.env.example` lists all keys; `~/.clip-forge/providers.json` per-user override of precedence. |
| Provider lockin via voice_id | `voices.json` carries `provider` + `voice_id`; switching providers requires re-clone but doesn't break stored records; per-project + global scopes (Q2). |
| **Determinism on TTS-affected paths** | **4-mode `CF_RENDER_DETERMINISTIC`:**<br>`strict` — fail if any TTS in pipeline (legacy v0.3.0 behavior)<br>`audio` — byte-identical audio, ±200ms video tolerance<br>`visual` — byte-identical video, audio float<br>`relaxed` — ±200ms tolerance both (new default for TTS-affected renders)<br>`unset` — production mode, no determinism enforcement |
| Dub timeline drift vs source | D3 invariant: ±200ms tolerance + warns; per-sentence silence padding aligns to source `start_ms`. |
| Style consistency across B-roll | Pin fal.ai seed across cutaways in same clip; assert seed equality in render_report. |
| API key leak via .env commit | `.env` gitignored; CI lint check confirms `.env` not tracked. |
| LLM hallucinated patch breaks render | Q5 3-layer validation: schema + whitelist + dry-run preview; 2 retries then manual fallback. |
| Avatar consent / misuse | Q3 two-gate: env var + per-photo sha256 cache; new photo prompts AskUserQuestion. |
| Multi-language dub voice misattribution | voice_id stored per language via `uses: ["dub-id", "dub-en"]` (§3.2 schema); no cross-language reuse without explicit re-clone. |

---

## 6. LOC budget (ship order)

| # | Pick | New | Modified | Tests | Subtotal |
|---|---|---|---|---|---|
| 1 | 16:9 aspect | 10 | 10 | 30 | ~50 |
| 2 | Dub + voice clone | 350 | 80 | 170 | ~600 |
| 3 | Brand kit | 220 | 80 | 100 | ~400 |
| 4 | cf-edit + prompt | 280 | 90 | 130 | ~500 |
| 5 | AI B-roll + avatar | 420 | 110 | 170 | ~700 |
| 6 | Speaker-aware reframe | 380 | 100 | 170 | ~650 |
| **Total** | | **1660** | **470** | **770** | **~2900 LOC** |

---

## 7. Locked decisions (closed 2026-05-21)

The six open questions are resolved as follows. Implementation MUST follow these defaults unless a future revision re-opens them.

**Q1 — TTS provider precedence.** ElevenLabs → Cartesia → Groq PlayAI → Piper TTS local. User override via `CF_TTS_PROVIDER=<name>`. See §3.2.

**Q2 — voices.json scope.** Per-project (`./uploads/<slug>/voices.json`) wins, with optional global default (`~/.clip-forge/voices.json`). Schema includes `default` + `uses: [...]` fields. See §3.2.

**Q3 — Avatar consent UX.** Two-gate: (1) `CF_AVATAR_CONSENT=1` env var one-time gate written to `~/.clip-forge/.consent-log`; (2) per-photo sha256 cached in same log — new photo → AskUserQuestion; same photo re-used → no prompt; `--no-avatar` flag overrides at run-time. See §3.5.

**Q4 — Cost-cap-breach behavior.** Checkpoint + hard-stop: 80% threshold AskUserQuestion to raise; 100% hard-stop with `budget_exhausted: true` telemetry; `--yolo` silent skip at 100%. Cumulative tracking in `render_manifest.json.ai_costs`. See §3.5.

**Q5 — LLM JSON patch validation.** 3-layer: JSON Schema (`schemas/edit.json.patch.v1.json`) + whitelisted JSON Pointer paths + auto dry-run preview via AskUserQuestion. Two retries on failure then manual fallback. Never silent apply. See §3.4.

**Q6 — Prompt re-edit LLM default.** Groq Llama 3.3 70B (default, ~$0.001/edit). Anthropic Claude Haiku 4.5 fallback when GROQ_API_KEY absent. `CF_LLM_PROVIDER=anthropic` forces Claude. See §3.4.

---

## 8. Cross-cutting concerns

- **providers.json schema.** Centralized loader at `bin/lib/providers.mjs`. Lazy-loads only providers a given skill needs. User-edit-friendly.
- **Cost telemetry on render_report.** New `ai_costs` block on `render_report.v2`:
  ```jsonc
  "ai_costs": {
    "total_usd": 0.42,
    "breakdown": {
      "elevenlabs_tts": 0.30,
      "groq_llm":       0.01,
      "fal_image_gen":  0.11
    },
    "budget_cap_usd":   10.00,
    "budget_used_pct":  4.2,
    "budget_exhausted": false,
    "skipped_clips":    []
  }
  ```
  Creator audit-ability is critical for BYO-key trust.
- **render_report v1 → v2 bump.** v0.4.0 adds enough top-level fields (`cost_usd_estimate`, `brand_kit`, `dub`, `split_screen_segments_count`, `stylization`, `avatar`, `ai_costs`) to justify a schema version bump. v1 stays accepted (additive readers); v2 is the new canonical.
- **LLM prompt versioning.** Anthropic + Groq system prompts checked into `config/llm-prompts/<skill>-v1.md`, version-pinned. Drift between provider responses tracked in tests.
- **TTS abstraction layer.** `bin/lib/tts.mjs` shared by dub + voice-clone + future skills. Provider adapters: `tts/elevenlabs.mjs`, `tts/cartesia.mjs`, `tts/groq.mjs`, `tts/piper.mjs`.
- **Avatar abstraction layer.** `bin/lib/avatar.mjs` shared by stinger + future avatar skills. Provider adapters per service.
- **Cost-cap arbitration.** `CF_AI_BUDGET_USD` honored across ALL paid skills in a single invocation chain (dub + stylize + avatar in one `/clip-forge:start --yolo` run shares the cap via `render_manifest.json.ai_costs.cumulative_usd`).
- **README BYO-key disclosure (REQUIRED).** Before any v0.4.0 ship, README gains a "🔑 BYO API Keys (Optional Tier 2 Features)" section ABOVE the install instructions:
  ```markdown
  ## 🔑 BYO API Keys (Optional Tier 2 Features)

  ClipForge ships local-first. Tier 2 features require your own API
  keys and bill directly from those providers (ClipForge takes nothing):

  | Feature                  | Provider              | ~Cost per clip |
  |--------------------------|-----------------------|----------------|
  | Voice clone hook/outro   | ElevenLabs            | ~$0.05         |
  | Multi-lang dub (5 langs) | ElevenLabs + Groq     | ~$0.30         |
  | AI B-roll fallback       | fal.ai                | ~$0.20         |
  | Avatar stinger           | HeyGen                | ~$1.00         |
  | Prompt-driven re-edit    | Groq (or Claude)      | ~$0.001        |

  Set `CF_AI_BUDGET_USD=N` to cap total per pipeline (default `$10`).
  Local fallback: Piper TTS (offline, no voice clone, generic voice).
  ```
- **Carry-forward from v0.3.0 §8** — caption re-timeline after apad, skill-ordering enforcement, deterministic-render env var, vocab.json + tighten interaction — all still apply unchanged.

---

## 9. EXIT CRITERIA — v0.4.0 ship gates

v0.4.0 is NOT shippable unless ALL of the following are true:

1. **All 6 picks shipped on master.** Each with one feat commit + one doc-fill commit (matching the v0.3.0 ship pattern).
2. **100% mock-path test coverage** for paid features. Every BYO-key skill has a `CF_*_MOCK=<path>` injection point with a positive-evidence integration test that runs green in CI without any API keys set.
3. **All v0.3.0 + v0.2.0 regression tests still passing.** No regressions in tighten / enhance / clip-prompt / vocab / overlay (incl. composition) / success-path / fallback-path / Phase C stress / tail-duration.
4. **README updated with BYO-key section** (per §8 disclosure block) ABOVE install instructions.
5. **At least 1 end-to-end multi-lang dub demo** committed to `examples/dub-demo/` showing: 30s source clip + transcript + voice-clone + dubbed output in 2 target languages + render_report with ai_costs telemetry.
6. **`claude plugin validate .` reports 0 errors / 0 warnings** on tip-of-master.
7. **CI lint check** confirms `.env` is not tracked in git.
8. **render_report v2 schema** committed at `schemas/render_report.v2.json` with backward-compat assertion for v1 readers.

If any gate fails, v0.4.0 stays unmerged.

---

## 10. Decision log

- 2026-05-21 — first draft of this plan. Triggered by competitive analysis of Agent Opus features under a new constraint: external AI APIs allowed via opt-in BYO-key pattern (mirrors existing DEEPGRAM/PEXELS pattern). Five v0.3.0 rejections re-classified: voice clone + multi-lang dub + prompt-driven re-edit accepted; visual styles + AI avatars conditionally accepted (scoped to non-primary footage). v0.4.0 picks ordered by `impact × (1/effort) × moat_safety` with ship-order tweak: AI B-roll precedes Speaker-aware to validate the new BYO-key tier early.
- 2026-05-21 — maintainer review locked 6 open questions:
  - Q1 TTS precedence: ElevenLabs → Cartesia → Groq → Piper local (added Piper as offline fallback).
  - Q2 voices.json: per-project wins, global default optional; schema gains `default` + `uses` fields.
  - Q3 avatar consent: two-gate (env var + per-photo sha256 cache).
  - Q4 cost-cap: 80% AskUserQuestion checkpoint + 100% hard-stop; `--yolo` silent skip.
  - Q5 LLM patch validation: 3-layer (schema + whitelist + dry-run preview); 2 retries then manual.
  - Q6 LLM provider default: Groq Llama 3.3 70B; Claude Haiku 4.5 fallback.
- 2026-05-21 — pillar 3 (brand kit / custom assets) shipped at SHA `set after rebase`. Schema `schemas/brand-kit.v1.json` v1 finalised: `{version, name, assets: {logo, endcard, lower_third}}`. Per-project (`./uploads/<slug>/brand-kit.json`) wins entirely over global (`~/.clip-forge/brand-kit.json`); same precedence rule as voices.json from pillar 2. File-size limits enforced at LOAD time (logo / lower-third PNG ≤ 2 MB, endcard PNG ≤ 2 MB / MP4 ≤ 3 MB) — oversized assets are skipped with `brand_kit_asset_oversize` before the filter graph is built, keeping ffmpeg memory bounded. `edit.json.brand_kit` (inline) > `watermark.brand_kit_ref` (file pointer) > legacy `watermark: "<path>"` (string) > project/global file. SVG support is best-effort: `librsvg_not_available` warning + skip when ffmpeg lacks librsvg; PNG assets in same kit still render. Color tokens `$brand.colors.primary` / `$brand.colors.accent` documented as a DESIGN HOOK only — token expansion deferred to v0.5.0; `$brand.logo` is the only substitution wired this round (see `agents/caption-stylist.md`). New `bin/cf-brand-kit` dispatcher with `add | list | set-default | remove` subcommands; new `/clip-forge:brand-kit` skill. Backward-compat regression test confirms legacy `"watermark": "<path>"` still produces a bottom-right logo overlay.
- 2026-05-21 — maintainer review additions:
  - Added `CF_TRANSLATE_MOCK` to mock injection list.
  - Added realistic-mock-response requirement (timing parity with real providers).
  - Added 4-mode `CF_RENDER_DETERMINISTIC` (strict / audio / visual / relaxed) for TTS-affected paths.
  - Added `ai_costs` block to render_report v2 telemetry.
  - Added README BYO-key disclosure section as ship requirement.
  - Added §9 EXIT CRITERIA section codifying ship gates.
  - Swapped pillar (5) ↔ (6) ship order: AI B-roll precedes Speaker-aware to validate BYO-key tier UX/pricing/consent flow before locking the rest of the BYO surface.
