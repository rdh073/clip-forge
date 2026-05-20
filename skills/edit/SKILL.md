---
name: clip-forge-edit
description: Content-hash diff + partial re-render driven by render_manifest.json, with optional LLM prompt-driven JSON-patch edits to edit.json. Use when the user says "re-render only changed clips", "edit my hook to say X", "make the progress bar red", "switch aspect to 16:9", "rerun pipeline without redoing all clips", "patch this edit.json with a prompt", "edit ulang clip yang sudah berubah saja", or runs /clip-forge:edit. Diff mode runs without API keys; prompt mode requires GROQ_API_KEY (default) or ANTHROPIC_API_KEY (fallback, override via CF_LLM_PROVIDER=anthropic).
allowed-tools: Bash, Read, AskUserQuestion
---

# /clip-forge:edit

## Args

`$ARGUMENTS` parses into the flags below. Default mode is `diff` — pass
`--prompt "<text>"` to switch into LLM patch mode.

| Flag | Default | Purpose |
|---|---|---|
| `--slug <slug>` | auto-detect if single project under `./clips/` | Project slug |
| `--force` | off | Re-render every selected clip regardless of staleness |
| `--dry-run` | off | Print the diff, perform no work |
| `--only c01,c03` | all clips | Restrict to subset |
| `--prompt "<text>"` | (none) | Invoke LLM patch mode |
| `--auto-apply` | off | Skip the LLM patch preview gate |
| `--yolo` | off | Implies `--auto-apply` |
| `--provider <name>` | precedence | Force `groq` or `anthropic` LLM |
| `--no-json-logs` | off | Suppress NDJSON event lines |

## Diff mode (default)

Content-hash diff against `./renders/<slug>/render_manifest.json`. Hashes
six inputs per clip:

```
edit.json   crop_path   captions.ass   cuts_plan   audio_source   brand_kit
```

A clip is stale when any hash mismatches the manifest OR no manifest entry
exists (cold-start). Stale clips re-render via `cf-ffmpeg render`; fresh
clips skip entirely. The manifest is updated atomically (write-then-rename
with fsync) after each successful render.

### Invariants

- **E1.** `cf-edit --dry-run` prints exactly the set of clips whose inputs
  changed. Empty diff → empty stale array, exit 0.
- **E2.** After a non-dry run, every re-rendered clip's stored
  `input_hashes` match the current on-disk inputs.
- **E3.** `cf-edit --force` re-renders all selected clips + writes the
  manifest, even when hashes match.
- **E4.** Idempotent — `cf-edit` twice with no changes → second run
  re-renders zero clips.
- **E5.** Missing manifest → cold-start renders ALL selected clips and
  writes a fresh manifest.
- **E6.** Manifest writes are atomic — kill -9 mid-write leaves either the
  previous manifest intact OR no manifest. Never partial JSON.
- **E7.** Pillar 2 `ai_costs` block is preserved byte-for-byte modulo
  additive breakdown keys (`groq_llm`, `anthropic_llm`,
  `anthropic_translate`).

## Prompt mode

`--prompt "<text>"` invokes the LLM patch path:

1. Slim `edit.json` to its editable fields + the user prompt → send to LLM.
2. LLM returns RFC 6902 patch JSON (`schemas/edit-patch.v1.json`).
3. Three-layer validation:
   - **Schema** — every op shape-valid (`op`, `path`, optional `value`).
   - **Whitelist** — `path` must match an editable JSON Pointer (below);
     forbidden paths (`/crop_path`, `/audio_source`, `/clip_id`, `/source`,
     `/output`, `/version`) reject immediately.
   - **Preview** — dispatcher emits `patch_preview` NDJSON; this skill
     surfaces the patch summary via `AskUserQuestion`. `--auto-apply` /
     `--yolo` skips the gate.
4. Patch applied atomically to `edit.json`, diff mode kicks in to
   re-render the changed clip.

### Editable JSON Pointer whitelist

```
/cuts                       — replace the path string
/hook_overlay/text          — change hook overlay text
/hook_overlay/end_ms        — change hook overlay duration cap
/hook_overlay/position      — "upper-third" | "center"
/progress_bar/enabled       — bool
/progress_bar/color         — hex string "#rrggbb"
/progress_bar/height_px     — int 4..16
/progress_bar/position      — "bottom" | "top"
/target_aspect              — "9:16" | "1:1" | "4:5" | "16:9"
/brand_kit                  — whole-object replacement
/watermark                  — legacy string OR brand_kit_ref object
```

### NEVER editable

`/crop_path` · `/audio_source` · `/clip_id` · `/source` · `/output` ·
`/version`. The LLM is told to refuse with
`{patch: [], warning: {code: "scope_exceeds_whitelist", message: "..."}}`.
The dispatcher's whitelist enforcement is the second backstop — even if
the LLM forgets, the patch is rejected with `rejected_reason: off_whitelist`.

### Retry policy

First validation failure → re-prompt the LLM with the validation error as
context. Second failure → exit 1 with `rejected_reason` in the NDJSON
event; the caller decides whether to re-run with a clearer prompt or edit
the file manually. Never silently apply malformed patches.

### LLM provider precedence (PLAN-v0.4.0 §7 Q6)

```
CF_LLM_PROVIDER=<name>      → explicit override (groq | anthropic)
GROQ_API_KEY      set       → groq llama-3.3-70b-versatile (~$0.001/edit)
ANTHROPIC_API_KEY set       → claude-haiku-4-5-20251001    (~$0.02/edit)
neither set                 → diff mode still works; prompt mode exits
                              with {fallback_reason: "no_llm_provider"}
```

Mock injection for tests: `CF_LLM_MOCK=<path>` runs the script with the
brief on stdin and reads `{text, cost_usd, ...}` on stdout. Mock responses
MUST validate against `schemas/edit-patch.v1.json`.

## Pipeline

1. Parse flags, resolve slug (auto-detect single project under
   `./clips/<slug>/` when omitted).
2. Diff mode: load manifest, compute `input_hashes` for every clip, build
   stale set.
3. Prompt mode: read first clip's `edit.json`, build LLM brief, call LLM
   via `bin/lib/llm.mjs`, validate response, surface preview via
   `AskUserQuestion`, apply patch atomically.
4. Re-render each stale clip via `cf-ffmpeg render --manifest <path>`.
5. Update `render_manifest.json.clips.<id>.input_hashes` + `rendered_sha256`
   atomically after each successful render.
6. Emit `event: "done"` NDJSON with the final stale set.

## Failure modes

- Missing `--slug` and no single project under `./clips/` → exit 1 with
  "--slug required" message.
- No clips in the project → exit 0 with `reason: "no_clips_found"`.
- LLM mid-flight failure → exit 1; manifest untouched; partial spend
  recorded in `ai_costs.history` for audit.
- Render failure on a stale clip → exit 1 immediately; the failed clip is
  NOT recorded in the manifest (preserves diff-mode invariant E2).
- Budget cap reached → exit 1 with `event: "budget_exhausted"`. Raise via
  `CF_AI_BUDGET_USD=N` or re-run with `--yolo` for silent skip.

## Telemetry — `render_report.json` extensions

The renderer (`cf-ffmpeg render`) consumes the patched `edit.json` and
emits its usual `render_report.json`. The cf-edit dispatcher's NDJSON
trail is the authoritative record of which clips re-rendered and why:

```json
{ "event": "diff", "stale": ["c02"], "reasons": {"c02": {"reason": "input_changed:edit_json,captions_ass"}} }
{ "event": "patch_preview", "clip_id": "c01", "summary": "  ~ REPLACE /hook_overlay/text = ..." }
{ "event": "patch_applied", "clip_id": "c01", "cost_usd": 0.0008, "provider_used": "groq" }
{ "event": "render_done", "clip_id": "c01", "output": "/abs/path/c01.mp4" }
{ "event": "done", "ok": true, "stale": ["c01"] }
```

## Graceful degrade matrix

| Condition | Behaviour |
|---|---|
| No manifest | Cold-start: render all selected clips, write fresh manifest (E5) |
| Hash unchanged | Skip clip entirely; manifest untouched (E4) |
| `--force` | Re-render every selected clip regardless (E3) |
| `--dry-run` | Print stale set, no work, no manifest mutation (E1) |
| `--prompt` + no LLM keys | Exit 0 with `fallback_reason: "no_llm_provider"`; diff mode still works |
| LLM returns invalid JSON | One retry with validation error in context, then exit 1 |
| LLM returns off-whitelist patch | Reject with `rejected_reason: "off_whitelist"`, retry, then exit 1 |
| Patch apply error | Exit 1; edit.json untouched (atomic rename safety) |
| Budget cap reached | Exit 1 with `event: "budget_exhausted"` |
