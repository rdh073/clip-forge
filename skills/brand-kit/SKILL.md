---
name: clip-forge-brand-kit
description: Register and manage brand assets (logo, endcard, lower-third overlay) that the renderer burns into every clip. Wizard-driven add / list / set-default / remove for ~/.clip-forge/brand-kit.json (global) or ./uploads/<slug>/brand-kit.json (per-project, wins). Required for creators who want a consistent visual identity across exports — logo bottom-right, lower-third intro banner, branded endcard. Use when the user says "add my logo", "set up brand kit", "register endcard", "lower-third for podcast intro", "pasang logo", "kelola brand assets", or runs /clip-forge:brand-kit.
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# /clip-forge:brand-kit

## Args

`$ARGUMENTS` = `<subcommand> [options]`

| Subcommand | Purpose |
|---|---|
| `add` | Interactive wizard to register one asset (logo / endcard / lower-third) |
| `list` | Print the active brand-kit.json — global or per-project |
| `set-default` | Rename the active kit (single kit per file; renames the `name` field) |
| `remove` | Delete an asset from the active kit |

| Flag | Default | Purpose |
|---|---|---|
| `--asset` | (required for add/remove) | `logo` \| `endcard` \| `lower_third` |
| `--path` | (required for add) | Absolute path to PNG/SVG/MP4 |
| `--position` | `bottom-right` (logo), `bottom-left` (lower-third) | One of `bottom-right`, `bottom-left`, `top-right`, `top-left`, `center` |
| `--opacity` | `0.7` (logo), `0.9` (lower-third) | 0.0–1.0 |
| `--scale-px` | `96` | Logo target width in pixels, 8..1024 |
| `--duration-ms` | `3000` (mp4 endcard), `2000` (png endcard) | Endcard duration, 100..5000 ms |
| `--show-from-ms` / `--show-until-ms` | `1500` / `4000` | Lower-third visibility window |
| `--slug` | (none) | Per-project — writes `./uploads/<slug>/brand-kit.json` |
| `--global` | off | Force `~/.clip-forge/brand-kit.json` (default when no `--slug`) |

## Storage layout

```
~/.clip-forge/brand-kit.json           # global default
./uploads/<slug>/brand-kit.json        # per-project (wins entirely; no merge)
```

Per-project precedence mirrors `voices.json` from pillar 2: if both exist,
the project file wins outright — no field-level merge.

## Schema (v1) — `schemas/brand-kit.v1.json`

```jsonc
{
  "version": 1,
  "name":    "default",
  "assets": {
    "logo": {
      "path":     "/abs/logo.png",
      "position": "bottom-right",
      "opacity":  0.7,
      "scale_px": 96
    },
    "endcard": {
      "path":        "/abs/endcard.mp4",
      "duration_ms": 3000
    },
    "lower_third": {
      "path":          "/abs/lt.png",
      "position":      "bottom-left",
      "opacity":       0.9,
      "show_from_ms":  1500,
      "show_until_ms": 4000
    }
  }
}
```

## File-size limits (enforced at LOAD time, not render time)

| Asset | Format | Cap |
|---|---|---|
| logo | PNG / SVG | 2 MB |
| endcard | PNG | 2 MB |
| endcard | MP4 (≤ 3 s) | 3 MB |
| lower_third | PNG with alpha | 2 MB |

Oversized assets are SKIPPED with a soft `brand_kit_asset_oversize` warning
before the filter graph is built. The render still produces output — just
without that asset. Missing-path assets emit `brand_asset_missing:<key>`
with the same skip-and-continue behaviour (invariant B3).

## Wizard pipeline (`add` subcommand)

1. Ask `AskUserQuestion` which asset type — logo / endcard / lower-third.
2. Prompt for the absolute path. Validate exists + within size cap.
3. Prompt for position (logo / lower-third) with the five-option list.
4. Prompt for opacity (default per type) and scale_px (logo only).
5. Show summary and ask one final confirmation.
6. Invoke dispatcher:

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/bin/cf-brand-kit add \
     --asset <type> \
     --path  <abs> \
     [--position <p>] [--opacity <0..1>] [--scale-px <N>] \
     [--duration-ms <N>] [--show-from-ms <N>] [--show-until-ms <N>] \
     [--slug <slug> | --global]
   ```

7. Read `event: "done"` NDJSON. Surface the path + the asset entry.

## Render-time integration (already wired in `cf-ffmpeg render`)

`edit.json` supports three shapes for declaring the brand kit, in
precedence order:

```jsonc
// 1. Inline (highest precedence) — full kit object
{ "brand_kit": { "version": 1, "name": "...", "assets": { ... } } }

// 2. Reference — pointer to a brand-kit.json
{ "watermark": { "brand_kit_ref": "/abs/path/brand-kit.json" } }

// 3. Legacy (backward compat) — string path
{ "watermark": "/abs/logo.png" }
```

When none of the above are set, the renderer falls back to the per-project
or global brand-kit.json automatically.

The renderer composes:
- **Logo** — `filter_complex` overlay at the requested position with
  opacity + scale_px. Honours the chosen `target_aspect` canvas
  (1080×1920 / 1080×1080 / 1080×1350 / 1920×1080) via
  `chooseAspectCanvas` from pillar (i) — no hardcoded dims.
- **Lower-third** — same overlay primitive plus time-gated
  `enable='between(t, show_from, show_until)'`. Visible only in window.
- **Endcard** — appended via the concat demuxer with an 8 ms audio
  crossfade (`JUNCTION_XFADE_S` from `bin/lib/tighten-splice.mjs`).
  PNG endcards are still-rendered at the requested duration_ms; MP4
  endcards play through their own duration (capped at 5 s).

## SVG support (best-effort, graceful degrade)

SVG logos / lower-thirds need librsvg compiled into ffmpeg. The renderer
probes once per invocation:

```text
ffmpeg -v error -f lavfi -i nullsrc -frames:v 1 -f null - 2>/dev/null
```

If librsvg is unavailable, SVG assets are SKIPPED with a
`librsvg_not_available` warning. PNG assets in the same kit still render
normally — no crash.

## Telemetry — `render_report.json.brand_kit`

```jsonc
"brand_kit": {
  "applied":       true,
  "source":        "global" | "project" | "inline" | "ref" | "legacy" | null,
  "assets_burned": ["logo", "endcard", "lower_third"],
  "warnings":      [
    { "code": "brand_asset_missing", "asset": "endcard", "message": "..." },
    { "code": "librsvg_not_available", "message": "..." }
  ]
}
```

## Caption template tokens (hook for v0.5.0)

`agents/caption-stylist.md` can return `$brand.logo` in caption templates;
the renderer substitutes the filename at burn time. **Only `$brand.logo`
is wired in v0.4.0 pillar 3.** Colour tokens (`$brand.colors.primary`,
`$brand.colors.accent`) are reserved for v0.5.0 — documented in
`docs/PLAN-v0.4.0.md` §10 decision log.

## Graceful degrade matrix

| Condition | Behaviour |
|---|---|
| Missing brand-kit.json everywhere | Render proceeds with no brand assets; no warning (B1) |
| Malformed brand-kit.json | Soft warning `brand_kit_unreadable`; render succeeds (B2) |
| Asset path missing | Soft warning `brand_asset_missing:<key>`; that asset skipped, others continue (B3) |
| Asset oversize | Soft warning `brand_kit_asset_oversize`; that asset skipped, others continue |
| SVG + no librsvg | Soft warning `librsvg_not_available`; SVG skipped, PNGs continue |
| Legacy string watermark | Auto-mapped to `{assets.logo}` with default position bottom-right + opacity 0.7 (B5 backward-compat) |

## Failure modes

- Wrong subcommand → `cf-brand-kit: subcommand required — try: add | list | set-default | remove`. Exit 1.
- `add` without `--path` → exit 1 with message.
- Asset path missing → exit 1 with absolute-path message.
- Asset oversized at write time → exit 1 with byte-count + cap.

All other failures exit 0 with `{event: "done", ok: false, fallback_used: true}` NDJSON.
