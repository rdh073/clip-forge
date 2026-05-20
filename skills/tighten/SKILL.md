---
name: clip-forge-tighten
description: Tighten a clip by removing filler words ("um", "uh", "you know", "I mean", "anu", "apa namanya" — locale-aware English + Indonesian defaults) and silent gaps (default threshold -30 dB, min 400 ms). Writes ./clips/<slug>/<clip-id>/tighten_plan.json — a list of clip-relative time ranges the renderer will splice out with 8 ms audio crossfades. Use when the user says "tighten this", "remove fillers", "cut the ums", "trim dead air", "remove silences", runs /clip-forge:tighten, or when /clip-forge:start enters the tighten step.
allowed-tools: Bash, Read, Write
---

# /clip-forge:tighten

## Args

`$ARGUMENTS` = `<slug> <clip-id> [--locale en|id|en,id] [--aggressive] [--no-silence] [--no-fillers] [--keep-pause-ms N] [--silence-threshold-db DB] [--min-silence-ms N] [--min-confidence F] [--max-cut-ms N] [--fillers <path>] [--dry-run]`

Defaults — chosen to be CONSERVATIVE so the first invocation never produces
audible click artifacts or accidentally drops semantic content:

| Flag                       | Default          | Purpose                                                                          |
|----------------------------|------------------|----------------------------------------------------------------------------------|
| `--locale`                 | `en`             | Which built-in filler dict(s) to load. Comma-separated for multi-locale.         |
| `--aggressive`             | off              | Also cut single-repeat false starts, context-marker fillers, and raise confidence floor to 0.90. See "Aggressive mode rules" below. |
| `--no-silence`             | off              | Skip silence detection (filler-words only).                                      |
| `--no-fillers`             | off              | Skip filler-word detection (silence only).                                       |
| `--keep-pause-ms`          | `120`            | Leave this much padding on each side of a silence cut so the next word breathes. |
| `--silence-threshold-db`   | `-30`            | RMS level below which audio is considered silent.                                |
| `--min-silence-ms`         | `400`            | Minimum gap to count as silence (under this is just natural punctuation).        |
| `--min-confidence`         | `0.85`           | ASR confidence gate (raised to `0.90` automatically under `--aggressive`).       |
| `--max-cut-ms`             | `600`            | Never cut a span longer than this (avoids excising emphatic emotional beats).    |
| `--fillers`                | (built-in dict)  | Path to a custom filler dict JSON (overrides `--locale`).                        |
| `--dry-run`                | off              | Print summary (cut count, saved_ms, breakdown by reason) to stdout; do NOT write `tighten_plan.json`. |

## Inputs

| File                                                | Required | Notes                                |
|-----------------------------------------------------|----------|--------------------------------------|
| `./uploads/<slug>/transcript.json`                  | yes      | word-timed, ideally with confidence  |
| `./uploads/<slug>/source.mp4`                       | yes      | needed for silencedetect             |
| `./clips/<slug>/candidates.json`                    | yes      | resolves `<clip-id>` → start/end ms  |
| `${CLAUDE_PLUGIN_ROOT}/config/fillers/<locale>.json`| yes      | shipped defaults; user can extend    |

Validate all four exist; ❌ otherwise.

## Pipeline

1. Resolve clip `start_ms` / `end_ms` from `candidates.json`.
2. Load filler dict(s) — comma-separated locale list, merged left-to-right
   (later wins on duplicates). User `--fillers <path>` replaces, doesn't
   merge. Dicts may carry both a `fillers` list (always-cut) and a
   `context_fillers` list (only cut with `--aggressive`).
3. Call `bin/cf-tighten`:

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/bin/cf-tighten \
     --transcript ./uploads/<slug>/transcript.json \
     --source     ./uploads/<slug>/source.mp4 \
     --output     ./clips/<slug>/<clip-id>/tighten_plan.json \
     --start-ms   $START_MS \
     --end-ms     $END_MS \
     --clip-id    <clip-id> \
     --locale     ${locale:-en} \
     --keep-pause-ms ${keep_pause_ms:-120} \
     --silence-threshold-db ${silence_threshold_db:--30} \
     --min-silence-ms ${min_silence_ms:-400} \
     --min-confidence ${min_confidence:-0.85} \
     --max-cut-ms ${max_cut_ms:-600} \
     ${aggressive:+--aggressive} \
     ${no_silence:+--no-silence} \
     ${no_fillers:+--no-fillers} \
     ${dry_run:+--dry-run}
   ```

4. Patch `./clips/<slug>/<clip-id>/edit.json` so it references the new
   plan. If `edit.json` doesn't exist yet, the render skill will write it.
   This skill only adds the field — it does NOT trigger a render:

   ```jsonc
   {
     "cuts": "./clips/<slug>/<clip-id>/tighten_plan.json"
   }
   ```

   Skip this step under `--dry-run`.

## Coordinate basis — dual

Every cut and every kept segment carries BOTH coordinate systems:

- **Clip-relative** (`start_ms` / `end_ms`) — zero at `basis_start_ms`. The
  renderer uses these for splicing. This is the authoritative basis.
- **Source-absolute** (`source_start_ms` / `source_end_ms`) — original media
  timestamps. Used for debug, cross-reference against the source transcript,
  and for diffing two plans cut from the same source.

Invariant: `source_start_ms == basis_start_ms + start_ms` (same for end).
Renderer ignores `source_*` fields; debug tooling ignores `start_ms/end_ms`.

## Output schema — `tighten_plan.json`

```json
{
  "version": 1,
  "clip_id": "c01",
  "basis_start_ms": 252000,
  "basis_end_ms": 298000,
  "source_duration_ms": 46000,
  "output_duration_ms": 39200,
  "saved_ms": 6800,
  "cuts": [
    { "start_ms": 4280, "end_ms": 4620,
      "source_start_ms": 256280, "source_end_ms": 256620,
      "reason": "filler_word", "word": "um",
      "confidence_min": 0.94, "duration_ms": 340 },
    { "start_ms": 8900, "end_ms": 9540,
      "source_start_ms": 260900, "source_end_ms": 261540,
      "reason": "silence", "rms_db": -52, "duration_ms": 640 },
    { "start_ms": 22150, "end_ms": 22450,
      "source_start_ms": 274150, "source_end_ms": 274450,
      "reason": "false_start", "word": "I", "duration_ms": 300 }
  ],
  "kept_segments": [
    { "start_ms": 0,     "end_ms": 4280,  "source_start_ms": 252000, "source_end_ms": 256280 },
    { "start_ms": 4620,  "end_ms": 8900,  "source_start_ms": 256620, "source_end_ms": 260900 },
    { "start_ms": 9540,  "end_ms": 22150, "source_start_ms": 261540, "source_end_ms": 274150 },
    { "start_ms": 22450, "end_ms": 46000, "source_start_ms": 274450, "source_end_ms": 298000 }
  ],
  "settings": {
    "locale": "en",
    "keep_pause_ms": 120,
    "silence_threshold_db": -30,
    "min_silence_ms": 400,
    "min_confidence": 0.85,
    "max_cut_ms": 600,
    "aggressive": false,
    "no_silence": false,
    "no_fillers": false
  },
  "filler_dict_version": "en-v1",
  "fallback_used": false,
  "fallback_reason": null,
  "warnings": []
}
```

`kept_segments` is the complement of `cuts` over `[0, source_duration_ms]`.
The renderer uses `kept_segments` directly — `cuts` is for human review.

### `warnings: []` — structured soft-issue log

Every soft issue that does NOT promote `fallback_used` to true still
appends one object: `{ "code": "...", "message": "..." }`. Examples:

- `{ "code": "no_confidence", "message": "transcript has no per-word confidence; gating by duration only" }`
- `{ "code": "locale_fallback", "message": "locale 'fr' not built-in; fell back to en-v1" }`
- `{ "code": "speaker_id_missing_multiword", "message": "phrase 'you know' spans words with no speaker tag — accepted" }`
- `{ "code": "context_filler_skipped_conservative", "message": "context-marker 'gini' skipped — pass --aggressive to cut" }`

Renderer logs every warning on load (one line each, prefixed
`tighten: warning code=... msg=...`) but does NOT exit non-zero on them.

## Plan invariants (enforced by renderer on load)

The renderer asserts these five invariants when it loads
`tighten_plan.json`. Any violation aborts the render with a non-zero exit
naming the violated invariant.

1. **I1 — range bounds.** Every `cut` and every `kept_segment` satisfies
   `0 <= start_ms <= end_ms <= source_duration_ms`.
2. **I2 — sorted, non-overlapping cuts.** `cuts[i].end_ms <= cuts[i+1].start_ms`
   for all `i`; `cuts` sorted ascending by `start_ms`.
3. **I3 — kept = complement(cuts).** Concatenating `kept_segments` in order
   reconstructs `[0, source_duration_ms]` minus exactly the union of `cuts`.
4. **I4 — duration consistency.** `output_duration_ms == source_duration_ms - saved_ms`
   and `saved_ms == Σ (cut.end_ms - cut.start_ms)` and
   `output_duration_ms == Σ (kept.end_ms - kept.start_ms)`.
5. **I5 — coordinate parity.** For every cut and every kept segment,
   `source_start_ms == basis_start_ms + start_ms` AND
   `source_end_ms   == basis_start_ms + end_ms`.

Renderer message format on violation:
`tighten: invariant violation I3 — kept_segments do not complement cuts; refusing to render`.

## Aggressive mode rules (`--aggressive`)

`--aggressive` activates the following changes — all conservative by
default, all auditable in the plan via `reason` and `confidence_min`:

- **Confidence floor raised** from `0.85` to `0.90`. Lower-confidence
  hits — including filler-word hits — are skipped.
- **False-start detection enabled.** A false start is defined as: the same
  normalized word token repeated with `< 150 ms` end-to-start gap, **single
  repeat only** (sequence length exactly 2). The FIRST occurrence is cut;
  the second (kept) reading is the speaker's intended take.
- **Triple-or-more repeats are NEVER cut.** Sequences of length ≥ 3 of the
  same token (e.g. "no no no", "jangan jangan jangan") are treated as
  intentional emphasis. Aggressive mode skips them and emits warning
  `{ "code": "triple_repeat_kept", "message": "kept 3× repetition of '<word>' — intentional emphasis" }`.
- **Context fillers become cuttable.** Tokens in the dict's
  `context_fillers` list (e.g. id: `eh, anu, gini, gitu, apa ya`) are
  treated as cuttable. Without `--aggressive` they are skipped with a
  `context_filler_skipped_conservative` warning.

## Punctuation-aware filler skip

If a filler-word match is **immediately followed** by `?` or `!` in the
transcript word text (e.g. `"eh?"`, `"like?"`, `"really!"`), the cut is
NOT taken — this is a speech act (interrogative / exclamatory), not a
filler. The match emits a warning
`{ "code": "filler_punct_speech_act", "message": "skipped '<word>' followed by ?/! — likely speech act, not filler" }`
and the word is kept.

Punctuation detection looks at the raw `w` field of the transcript word
(post-ASR), not just the normalized token, because most ASR engines glue
the trailing punctuation onto the word (`"like?"`, `"really!"`).

## Crossfade & junction quality

The renderer applies an 8 ms audio crossfade at every cut junction
(`JUNCTION_XFADE_S = 0.008` in `bin/lib/tighten-splice.mjs` — the single
source of truth). The integration test
(`tests/integration/tighten-junction-quality.test.mjs`) asserts junction
quality using **three metrics, two authoritative and one informational**.

### G1 (authoritative) — Sample-jump ratio

Compute max `|sample[i] - sample[i-1]|` in a ±2.5 ms window. Two values:
- `jump_with_xfade` — measured in the rendered output's PCM
- `jump_no_xfade`  — measured in a synthesized 5 ms window built from
  source K[i] tail + K[i+1] head joined at the cut boundary (no extra
  render pass needed)

Ratio = `jump_with_xfade / jump_no_xfade`.

G1 ratio gate evaluation requires BOTH preconditions true:

- **(a)** `jump_no_xfade >= 200` int16
     — there is an audible-level discontinuity to measure
- **(b)** **excess kurtosis** of the diff signal `s[i] - s[i-1]` over
  the no-xfade ±2.5 ms window (reported as `kurtosis_no_xfade_narrow`)
  `>= 3.0`
     — the discontinuity has outlier character (= click-like)

**Pass:** preconditions (a) and (b) both hold, AND ratio ≤ `0.5`.

**Failure modes — skip G1 with a warning + set `ratio: null`:**

- (a) fails → status `"skipped_below_floor"`,
  warning code `junction_below_click_floor`
- (a) passes but (b) fails → status `"skipped_smooth_no_click"`,
  warning code `junction_smooth_no_click`

`jump_with_xfade` and `jump_no_xfade` remain populated even when status
is skipped — they aid diagnosis.

**Rationale:** a click is a single-sample outlier in the diff signal.
Excess kurtosis directly measures outlier presence: `0` for Gaussian,
`~1–2` for smooth speech harmonics, `10–100+` for click-containing
windows. The `3.0` threshold is the standard "obvious outlier presence"
level in statistical practice — **not empirically tuned**. The metric
is amplitude-invariant (normalized by variance), so the threshold
survives `cf-enhance` denoising and content/speaker variation. An
earlier version of this gate used spectral flatness; on 5 ms windows
that proved spectrally tonal regardless of click presence and was
unable to separate test cases (replaced 2026-05-20).

### G2 (authoritative) — Spectral flatness

80 ms Hann-windowed FFT (4096-point, zero-padded) centered on the
junction. Flatness = geometric mean / arithmetic mean of the power
spectrum (DC and Nyquist excluded). A click is broadband noise
(flatness → 1.0); speech is tonal (flatness → 0.1–0.3).

Two values, both reported:

- `flatness_with_xfade_wide` — measured in the rendered output's PCM
- `flatness_no_xfade_wide`   — measured in the synthesized 80 ms window
  from source K[i] tail + K[i+1] head joined at the cut boundary

**Pass:** `flatness_with_xfade_wide < 0.5`.

`flatness_no_xfade_wide` is reported for diagnostic value (proves
whether the source itself had a broadband transient at the cut point).

### G3 (informational only — does NOT fail the render)

RMS spike: peak RMS in any sliding 40 ms window within ±100 ms of the
junction, vs RMS of the full 200 ms baseline. Report the delta in dB. Log
an `rms_intrinsic_amplitude_difference` warning when delta > 6 dB, but
**do not fail the test on this metric alone**.

### Why RMS is informational

A 6 dB RMS gate fails on real-speech junctions where the two spliced
segments have intrinsic amplitude differences (e.g., quiet question
decay → loud answer onset). The 27 dB amplitude jump from "Pak?" to
"Rokok," in Phase A R4b real-speech testing was the forcing function.
Sample-jump is amplitude-invariant and detects only discontinuities,
which is what "click" actually is.

### Bump procedure

If G1 or G2 fails on a representative real-speech fixture, bump
`JUNCTION_XFADE_S` from `0.008` to **`0.012`** (single-constant edit in
`bin/lib/tighten-splice.mjs`). Re-run the junction-quality test. **20 ms
is the absolute ceiling** — past that the crossfade smears /t/ /k/ /p/
consonant attacks audibly.

## Render report

Every `cf-ffmpeg render` writes a JSON telemetry report next to the
rendered MP4: `<output_dir>/render_report.json`. The `done` NDJSON event
on stdout includes `{"event":"done","path":"...","report_path":"..."}`
so downstream tools can locate it without path inference.

The report MUST validate against the committed JSON Schema at
`schemas/render_report.v1.json`. Validation runs on every emit; failure
exits non-zero with
`render: report schema violation — <field>: <reason>`.

The top-level `schema` field (`"render_report.v1"`) is the report's
identity; future tooling discriminates report types via this field.
`version` (`1`) is the schema's internal revision.

### Schema (v1)

```jsonc
{
  "schema":  "render_report.v1",
  "version": 1,
  "render_mode": "splice",    // "splice" | "passthrough"
  "clip_id": "c01",
  "input_duration_ms": 5000,
  "output_duration_ms": 4430,
  "audio_duration_ms": 4430,
  "av_drift_ms": 3,           // see "A/V drift sign convention" below
  "encoder": "libx264",
  "deterministic": false,
  "passes": [
    { "name": "audio_splice", "wall_ms": 412 },
    { "name": "video_mux",    "wall_ms": 887 }
  ],
  "filter_complex_bytes": 612,
  "junction_xfade_s": 0.008,  // forensic trail of the xfade value used
  "tighten": {
    "plan_path": "./clips/.../tighten_plan.json",
    "kept_segments_count": 3,
    "cuts_count": 2,
    "saved_ms": 570,
    "warnings_from_plan": [{"code":"...","message":"..."}]
  },
  "junctions": [
    {
      "index": 0,
      "time_ms": 446,
      "g1": {
        "ratio": 0.02,
        "jump_with_xfade": 16,
        "jump_no_xfade": 656,
        "kurtosis_no_xfade_narrow": 28.5,
        "status": "pass"
      },
      "g2": {
        "flatness_with_xfade_wide": 0.0000,
        "flatness_no_xfade_wide":  0.8500,
        "status": "pass"
      },
      "g3": {
        "rms_delta_db": 6.90,
        "status": "informational_warning"
      },
      "warnings": ["rms_intrinsic_amplitude_difference"]
    }
  ],
  "warnings": []
}
```

### Status enums

- `g1.status`: `"pass"` | `"fail"` | `"skipped_below_floor"` | `"skipped_smooth_no_click"`
  - When status is `skipped_*`, `ratio` is `null` but jump fields stay populated.
  - **Note on `skipped_smooth_no_click`:** currently exercised only by analyzer
    unit tests. Natural occurrence is rare on real speech — it requires
    `jump_no_xfade >= 200` AND `kurtosis < 3.0`, an unusual combination
    where amplitude is meaningful but no diff-signal outlier exists.
    Real-content fixture deferred until natural example surfaces in
    production renders.
- `g2.status`: `"pass"` | `"fail"`
- `g3.status`: `"pass"` | `"informational_warning"` — never fails the render.

### A/V drift sign convention (mode-aware)

```
av_drift_ms = video_duration_ms - audio_duration_ms
```

**`render_mode: "splice"`** — negative is the **baseline**. Audio splice
is sample-exact at 48 kHz; video is frame-quantized at the source fps
grid. Audio is always slightly longer than video by 0–33 ms at 30 fps.

Warning conditions:
- `av_drift_ms < -50` → `av_drift_audio_overhang_excessive`
   (suggests splice math is emitting tail silence beyond expected duration)
- `av_drift_ms > +50` → `av_drift_video_longer_in_splice`
   (suggests AAC encoder dropped audio frames — investigate buffer flush;
   this is the regression class the two-pass fix solved in 2026-05-20)

Baseline negative drift (`-50 ms < drift <= 0 ms`) is **silent — expected**.

**`render_mode: "passthrough"`** — both streams should match within muxer
tolerance.

Warning condition:
- `abs(av_drift_ms) > 10` → `av_drift_unexpected_passthrough`
   (possible muxer issue or input stream sync defect)

### `passes[].wall_ms`

Wall-clock from ffmpeg `spawn()` to the process `exit` event, **exclusive
of pre/post I/O**. Measured with `Date.now()` deltas. Captures pure
encode/transcode cost; PCM extraction and report assembly are excluded.

### Warnings vs failures

The renderer exits non-zero **only** on:
- Plan-invariant violations (I1–I5)
- Skill ordering violations (`cuts` + `broll`/`transitions`/`music`)
- Any ffmpeg pass exit code ≠ 0
- Zero-byte output
- Report schema validation failure

G1 `"fail"` and G2 `"fail"` are recorded in the report but do **not**
exit non-zero — the integration test reads the report and asserts.
G3 never fails.

### Junction-array contents

For non-splice renders (no `cuts` in `edit.json`), `junctions` is `[]`.
For splice renders: one entry per cut junction in output-time order.
`time_ms` is the junction center in **output coords** (post-acrossfade);
use the dual-coords basis in `tighten_plan.json` to map back to source.

### Warning codes

**Per-junction `warnings[]`** (array of strings, codes only — meanings
fixed below):

- `rms_intrinsic_amplitude_difference` — G3 informational, real-speech
  prosody difference across the cut (not a splice defect)
- `junction_below_click_floor` — G1 skipped, no audible discontinuity to
  measure
- `junction_smooth_no_click` — G1 skipped, diff signal has no outlier
  character — natural speech variation, not a click (G2 alone is sufficient)

**Top-level `warnings[]`** (array of `{code, message}` objects):

- `filter_graph_length_near_limit` — graph > 8192 bytes, near ffmpeg's
  ~10 KB default
- `aac_priming_overhead` — output audio length differs from expected by
  more than one AAC frame (reserved for future regression detection)
- `junction_too_short_for_xfade` — kept segment shorter than
  `JUNCTION_XFADE_S`, hard-cut fallback applied at that junction
- `av_drift_audio_overhang_excessive` — splice render, audio > 50 ms longer
  than video (see "A/V drift sign convention")
- `av_drift_video_longer_in_splice` — splice render, video > 50 ms longer
  than audio (AAC tail-truncation regression)
- `av_drift_unexpected_passthrough` — passthrough render, |drift| > 10 ms

### `tighten.warnings_from_plan` — passthrough

Verbatim copy of `tighten_plan.warnings`. The renderer does NOT filter
or rename fields; if a future tighten plan adds keys, the renderer
preserves them. Shape: `{code, message}` per entry (additional fields
allowed and copied).

## Testing

Filler dictionary matching is tested at the `cf-tighten` unit level
(synthetic word arrays). The integration test for tighten + render
(`tests/integration/tighten-junction-quality.test.mjs` and siblings)
uses **word-cut semantics** rather than filler-cut: cut arbitrary words
from a real public-domain speech sample (`tests/fixtures/jfk-speech-10s.mp4`),
then verify the renderer + Whisper re-ASR round-trip. This avoids
dependency on filler-quality TTS synthesis and gives a deterministic,
reproducible fixture. Both layers together validate the full
filler-removal pipeline.

R4c (Whisper re-ASR) skips cleanly when `CF_WHISPER_URL` is unset or the
endpoint is unreachable, so `npm test` on a fresh checkout without local
ASR infrastructure stays green.

## Idempotency contract

Same inputs → byte-identical `tighten_plan.json`. Specifically:

- `cf-tighten` writes the plan with stable key ordering (object keys
  serialized in fixed insertion order), 2-space indentation, and a single
  trailing newline.
- All floats are quantized to 3 decimal places before serialization.
- Warning ordering matches event ordering inside the pipeline (deterministic
  given fixed inputs).
- No timestamps, PIDs, hostnames, or environment values appear in the plan.

The integration test runs `cf-tighten` twice on the same fixture with the
same flags and asserts `sha256(plan_a) == sha256(plan_b)`.

## `--dry-run`

When passed, `cf-tighten`:

- Runs the full pipeline (transcript load, filler match, silencedetect).
- Prints to **stdout** a one-line JSON summary:
  `{"event":"dry_run","cuts":N,"saved_ms":M,"by_reason":{"filler_word":a,"silence":b,...},"warnings":W}`
- Does NOT write `tighten_plan.json` to disk.
- Does NOT touch `edit.json`.
- Exits 0.

Useful for the user to preview the cost of a flag change without
clobbering the on-disk plan.

## Display

```
✅ tightened c01: 14 cuts · saved 6.8s · 46.0s → 39.2s (-15%)
   fillers: 9 (um×3, uh×2, you know×2, like×1, I mean×1)
   silence: 5 gaps · longest 1.2s
   confidence gate: 0.85 · max cut: 600ms · locale: en
```

If `--aggressive`:
```
   repetitions: 3 (false starts: "I", "the", "and")
   confidence gate raised to 0.90 (aggressive)
```

If `--dry-run`:
```
🔍 dry-run c01: would cut 14 · would save 6.8s (no file written)
```

## Stderr progress

If `--start-ms > 0` AND the accurate-seek phase of silencedetect takes
more than 5 seconds wall-clock, `cf-tighten` emits human-readable
progress to **stderr**:

```
cf-tighten: seeking to 00:04:12.000...
cf-tighten: done in 7.3s
```

Short seeks (< 5 s) stay silent to avoid spam on small fixtures. NDJSON
progress is still available via `--json-logs` on stdout.

## Graceful degradation

| Condition                                       | Behavior                                                                |
|-------------------------------------------------|-------------------------------------------------------------------------|
| Missing transcript.json                         | ⚠ silence-only mode; `fallback_used: true`, reason `transcript_missing` |
| Missing source.mp4                              | ⚠ filler-only mode; `fallback_used: true`, reason `source_missing`      |
| Filler dict path bad                            | ⚠ fall back to built-in `en-v1`, reason `filler_dict_unreadable`        |
| `ffmpeg silencedetect` exits non-zero           | ⚠ proceed with filler cuts only, reason `silencedetect_failed`          |
| Transcript words have no `confidence` field     | ⚠ confidence gate skipped, warning `no_confidence` — duration gate still applies |
| Zero candidates → zero cuts                     | ✅ exit 0, write valid empty plan, `cuts: []`, `saved_ms: 0`            |

In every case `cf-tighten` exits 0 and writes a valid `tighten_plan.json`
so `bin/cf-ffmpeg render` never breaks.

## Failures (hard errors only)

- Missing `<slug>` / `<clip-id>` args → ❌
- `candidates.json` doesn't contain `<clip-id>` → ❌ list the available IDs
- `bin/cf-tighten` exits non-zero (it shouldn't, per contract above) → ❌
  surface stderr tail

## Examples

```bash
# Default conservative pass
/clip-forge:tighten podcast-ep-42 c01

# Multi-locale (creator code-switches EN↔ID)
/clip-forge:tighten podcast-ep-42 c01 --locale en,id

# Aggressive: also strip context fillers, single-repeat false starts; conf floor 0.90
/clip-forge:tighten podcast-ep-42 c01 --aggressive

# Silence-only (e.g. clean read with no fillers, just dead-air to trim)
/clip-forge:tighten podcast-ep-42 c01 --no-fillers --min-silence-ms 250

# Preview the cost of --aggressive without writing the plan
/clip-forge:tighten podcast-ep-42 c01 --aggressive --dry-run

# Custom user dictionary
/clip-forge:tighten podcast-ep-42 c01 --fillers ~/my-vocab/no-go-words.json
```

## Interaction with other skills

- **Runs AFTER `transcribe`** — needs word timing.
- **Runs BEFORE `caption`** — captions are generated against the *tightened*
  word list so karaoke timing stays accurate after splicing. The caption
  skill reads `tighten_plan.json` and skips words inside cut ranges.
- **Runs BEFORE `render`** — the renderer's concat-demuxer step honors
  `kept_segments` with 8 ms audio crossfades at each junction (12 ms if
  the 8 ms default fails the junction-quality assertion on the fixture).

## Skill ordering

**Tighten MUST run before broll, transitions, and music.** The renderer's
video concat is a hard cut at each kept-segment boundary; cutting across
already-baked B-roll, transitions, or music produces visible jump cuts and
audible audio discontinuities respectively.

The renderer enforces this. If `edit.json` carries a `cuts` reference AND
any of `broll`, `transitions`, or `music`, the renderer exits with:

```
render: skill ordering violation — tighten plan present after broll/transitions bake. Re-run tighten before broll/transitions.
```

Run order:

```
transcribe → tighten → reframe → caption → broll → transitions → music → render
```
