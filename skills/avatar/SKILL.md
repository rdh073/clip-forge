---
name: clip-forge-avatar
description: Generate a ≤5-second talking-head avatar stinger (hook or outro) from a portrait photo + an audio clip via HeyGen (default), D-ID, or fal LivePortrait. ENFORCES a two-gate consent system, refuses to operate on primary footage, and refuses windows that overlap the creator's primary face track (auto-detected from crop_path.json). Use when the user says "make an intro stinger", "avatar outro", "talking head from this photo", "/clip-forge:avatar". Pass --no-avatar to skip without prompts.
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# /clip-forge:avatar

## Args

`$ARGUMENTS` = `<slug> <clip-id> --photo <p> --audio <a> [--segment-type hook|outro] [--duration-ms N] [--aspect 9:16|1:1|16:9] [--no-avatar] [--yolo]`

| Flag | Default | Purpose |
|---|---|---|
| `--photo <p>` | (required unless `--no-avatar`) | Portrait JPEG/PNG of the subject |
| `--audio <p>` | (required unless `--no-avatar`) | WAV/MP3 of the spoken content (≤5s) |
| `--segment-type` | `hook` | `hook` or `outro` |
| `--segment-id` | (optional) | Use this segment id from broll.json for primary-face gating |
| `--duration-ms` | `3000` | Stinger duration (HARD CAP `5000`) |
| `--aspect` | `9:16` | Output canvas aspect |
| `--no-avatar` | off | Skip every gate; exit 0 immediately. No generation. |
| `--yolo` | off | Silent skip at 100% budget instead of AskUserQuestion |

## Hard constraints (moat anchor — same as broll-ai)

- Duration > 5000 ms → refused, no API call, exit 0.
- Target segment with `is_primary: true` → refused.
- `crop_path.json` face yield > 0.5 → refused with `avatar_overlaps_primary_face` (auto-detect).
- `--no-avatar` overrides every gate (run-time escape hatch).

## Consent system (PLAN-v0.4.0 §7 Q3, BILINGUAL EN+ID)

**Gate 1 — one-time per machine.** First-ever `/clip-forge:avatar` invocation triggers an `AskUserQuestion`:

> **EN**: "Avatar generation requires explicit consent. I confirm I only use photos of people with their permission."
> **ID**: "Generasi avatar memerlukan persetujuan eksplisit. Saya konfirmasi bahwa saya hanya menggunakan foto orang yang telah memberikan izin."

- YES → `~/.clip-forge/.consent-log` written with `machine_id_hash` (sha256). Subsequent runs skip the prompt.
- NO → skill exits 0, no log mutation. Re-run after deciding to consent.

Skip the prompt: set `CF_AVATAR_CONSENT=1` (CI / headless friendly). The log gets written on first non-prompt run for audit-trail consistency.

**Gate 2 — per-photo sha256 cache.** Each new portrait triggers:

> **EN**: "First time using this photo. Subject has given permission? (y/N)"
> **ID**: "Foto ini pertama kali digunakan. Subjek telah memberi izin? (y/T)"

- YES → photo hash written to `~/.clip-forge/.consent-log.photos[<hash>]` with `consented_at`, `last_used_at`, `use_count: 1`. Future runs of the SAME photo skip the prompt and bump `use_count`.
- NO → skill exits 0 with `skip_reason: consent_denied_gate_2`. No log mutation.

CI override: `CF_CONSENT_MOCK=auto-yes` (or `auto-no`) decides both gates without prompting. Used by the integration tests.

## Pipeline

1. Parse args. `--no-avatar` → exit 0 immediately (no prompts, no API call).
2. Duration cap check (`> 5000` → refuse).
3. Lookup target segment (from `broll.json` if `--segment-id` given, else synthesize hook/outro shell).
4. Run primary-face gate: segment.is_primary + crop_path.json face-yield. Refuse → exit 0.
5. Consent gate 1 — load `~/.clip-forge/.consent-log`, check, prompt or env-bypass.
6. Consent gate 2 — sha256 the photo, lookup in log, prompt or cache hit.
7. Budget pre-flight — `projectCharge` against `render_manifest.json.ai_costs`. 80% checkpoint event, 100% hard-stop.
8. Call `avatar.generate({photo_path, audio_path, duration_ms, aspect, video_path})` via the resolved provider.
9. Update `render_manifest.json.ai_costs` cumulatively + per-provider breakdown key.

Invocation:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-avatar \
  --slug <slug> \
  --clip-id <clip-id> \
  --photo ${photo_path} \
  --audio ${audio_path} \
  --segment-type ${segment_type:-hook} \
  --duration-ms ${duration_ms:-3000} \
  ${yolo:+--yolo}
```

## Provider precedence

```
CF_AVATAR_PROVIDER=<name>  → explicit override (heygen | did | fal_lip)
HEYGEN_API_KEY             → HeyGen (best quality, ~$1.00/clip)
DID_API_KEY                → D-ID (~$0.30/clip)
FAL_API_KEY                → fal LivePortrait (~$0.10/clip, OSS)
none                       → skill exits 0 with no_avatar_provider
```

## Budget enforcement

Same Q4 contract as every paid skill. Cumulative across the chain via `render_manifest.json.ai_costs.cumulative_usd`. Default `$10` cap (`CF_AI_BUDGET_USD`).

## Output

`./clips/<slug>/<clip-id>/avatar-<segment-type>.mp4` — concat-prepended or appended at render via edit.json `prepend_video` / `append_video` (renderer wires this up when the avatar.mp4 is present).

## Failures

| Condition | Behavior |
|---|---|
| `--no-avatar` | Exit 0 immediately. No consent prompt. No generation. |
| `duration_ms > 5000` | Refuse with `avatar_duration_capped`. No API call. |
| `is_primary: true` segment | Refuse with `is_primary_segment`. No API call. |
| `crop_path` face yield > 0.5 | Refuse with `avatar_overlaps_primary_face`. No API call. |
| Photo missing | Refuse with `photo_missing`. |
| Gate 1 denied | Exit 0 with `skip_reason: consent_denied_gate_1`. No log mutation. |
| Gate 2 denied | Exit 0 with `skip_reason: consent_denied_gate_2`. No log mutation. |
| 100% budget | Silent skip with `budget_exhausted: true`. Exit 0. |
| Provider HTTP error | Surface `avatar_fallback` event, exit 0. Manifest still updated. |

## Consent log security model

Lives at `~/.clip-forge/.consent-log` — single file, global scope (avatar consent is a human contract, not a per-project setting). Stored fields:

- `version`, `consented_at`, `machine_id_hash` (sha256 of hostname + username)
- `photos[<sha256>]` with `consented_at`, `last_used_at`, `use_count`

NOT stored: raw photos, photo paths, subject contact info, plaintext machine identifiers.

To revoke consent for a single photo: edit the log and remove its `photos[<hash>]` entry. To revoke ALL consent: delete the file — next `/clip-forge:avatar` invocation re-prompts gate 1.
