---
name: clip-forge-broll-ai
description: Fill broll.json gaps with AI-generated cutaway imagery via fal.ai Flux Schnell (default), Nano Banana, or Replicate. Also supports stylization (--stylize-segment with a preset). Operates ONLY on non-primary segments — refuses any segment with is_primary: true or whose time window overlaps the creator's primary face track. Cap ≤3s per cutaway. Use when the user says "fill the b-roll gaps", "AI b-roll", "stylize this cutaway", "/clip-forge:broll-ai", or when /clip-forge:start has auto_broll_ai enabled.
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# /clip-forge:broll-ai

## Args

`$ARGUMENTS` = `<slug> <clip-id> [--max-cutaways N] [--aspect 9:16|1:1|16:9] [--yolo]`

Stylize mode:

`<slug> <clip-id> --stylize-segment <segment-id> --preset cinematic|comic|anime`

| Flag | Default | Purpose |
|---|---|---|
| `--max-cutaways` | `4` | Cap on AI gap-fills per clip |
| `--aspect` | `9:16` | Target canvas aspect for generated imagery |
| `--stylize-segment` | (none) | Operate on this segment only (img2img preset) |
| `--preset` | `cinematic` | Stylization preset (stylize mode only) |
| `--yolo` | off | Silent skip at 100% budget instead of AskUserQuestion |

## Inputs

| File | Required | Notes |
|---|---|---|
| `./clips/<slug>/<clip-id>/broll.json` | yes | Output of `/clip-forge:broll` (Pexels-first). Cold-start handles missing file via empty seed. |
| `./clips/<slug>/<clip-id>/crop_path.json` | optional | Used for primary-face auto-detect. If absent, only the segment-flag refusal applies. |
| `~/.clip-forge/brand-kit.json` or per-project | optional | Brand colors fold into prompts (style hint). |

## Hard constraints (moat anchor — three-layer enforcement)

1. **Segment flag.** Any `broll.json` segment with `is_primary: true` is refused — no API call made, segment marked `refused: true` in updated `broll.json`.
2. **Auto-detect.** `crop_path.json.stats.framesWithFace / framesProcessed > 0.5` → refuse with `avatar_overlaps_primary_face`. Heuristic uses global yield — false-positive refusal is preferable to false-negative AI-over-creator.
3. **Renderer.** `bin/cf-ffmpeg render` refuses to mux any AI asset onto an `is_primary: true` slot. Defense in depth.

Per-cutaway hard cap: **3000 ms**. Longer windows truncate + flag `duration_capped: true`.

## Pipeline

1. Load `./clips/<slug>/<clip-id>/broll.json`.
2. Identify gaps: segments with `source: "ai_gap_pending"` OR `source: "pexels"` with `score < 0.5`.
3. For each gap (capped at `--max-cutaways`):
   - Run gate check (`is_primary` flag + auto-detect). Refuse → mark `refused: true`, continue.
   - Build prompt from sentence keywords + brand-kit color hint (if available).
   - Pre-charge budget (per-image cost estimate from the adapter). 80% checkpoint → emit `budget_checkpoint` event. 100% → skip, emit `budget_exhausted`.
   - Call `visual.generate({prompt, paths: [<out>], aspect, count: 1, seed: 42, brand_kit})`.
   - Update segment with `source: "ai_generated"`, `provider`, `prompt`, `cost_usd`, `path`, `is_primary: false`.
4. Save `broll.json` atomically (write-then-rename, fsync).
5. Update `./renders/<slug>/render_manifest.json.ai_costs` cumulatively.

Invocation:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-broll-ai \
  --slug <slug> \
  --clip-id <clip-id> \
  --max-cutaways ${max:-4} \
  --aspect ${aspect:-9:16} \
  ${yolo:+--yolo}
```

## Stylize mode

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-broll-ai \
  --slug <slug> \
  --clip-id <clip-id> \
  --stylize-segment <segment-id> \
  --preset cinematic
```

Presets are predefined fal.ai prompts (cinematic / comic / anime). Same `is_primary` refusal applies — stylization on the creator's primary clip body is BLOCKED, not silently smoothed over.

## Provider precedence (PLAN-v0.4.0 §3.5)

```
CF_VISUAL_PROVIDER=<name>  → explicit override
FAL_API_KEY                → fal Flux Schnell (~$0.003/img, default + cheapest)
GEMINI_API_KEY             → Nano Banana (~$0.04/img, brand-consistent)
REPLICATE_API_TOKEN        → Replicate (varies)
none                       → skill exits 0 with fallback_reason="no_visual_provider";
                             Pexels-only broll path unchanged
```

## Budget enforcement (PLAN-v0.4.0 §7 Q4)

Cumulative across the skill chain via `render_manifest.json.ai_costs`. Default cap `$10` (`CF_AI_BUDGET_USD`).

- **80%** → dispatcher emits `event: budget_checkpoint`; markdown caller fires `AskUserQuestion`:

  > **EN**: "Cost so far ${used} of ${cap}. Raise the cap to $20? (y/N)"
  > **ID**: "Biaya saat ini ${used} dari ${cap}. Naikkan cap ke $20? (y/N)"

- **100%** → dispatcher refuses further calls, emits `event: budget_exhausted`, exit 0. `--yolo` silent skip at 100%.

## Output — updated `broll.json` segments

```jsonc
{
  "id": "seg-04",
  "type":       "broll",
  "source":     "ai_generated",
  "provider":   "fal",
  "prompt":     "morning coffee cinematic photograph",
  "cost_usd":   0.003,
  "path":       "./clips/podcast-ep-42/c01/broll-ai/gap-seg-04.png",
  "start_ms":   6200,
  "end_ms":     9200,
  "duration_capped": false,
  "is_primary": false
}
```

## Failures

| Condition | Behavior |
|---|---|
| No visual keys + no mock | Skill exits 0 with `fallback_reason: no_visual_provider`. Pexels broll preserved. |
| `is_primary: true` segment | Refuse with `refusal_reason: is_primary_segment`. No API call. |
| `crop_path.json` face yield > 0.5 | Refuse with `refusal_reason: avatar_overlaps_primary_face`. |
| Provider HTTP error | `visual_fallback` event, segment marked `source: "ai_gap_failed"`, broll.json still updated. |
| 100% budget cap | Silent skip with `budget_exhausted: true` in telemetry. Exit 0. |
