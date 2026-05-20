---
name: clip-forge-clip
description: Detect up to 15 viral clip candidates from a transcript using the clip-scout agent. Outputs ./clips/<slug>/candidates.json with virality scores, hooks, hashtags, platform fit, and reasoning. Use when the user says "find clips", "detect viral moments", runs /clip-forge:clip, or when /clip-forge:start needs candidates.
allowed-tools: Bash, Read, Write, Agent
---

# /clip-forge:clip

## Args

`$ARGUMENTS` = `<slug> [--count N] [--min-duration S] [--max-duration S] [--prompt "<topic>"]`

Defaults: `count=15`, `min=15s`, `max=90s`. `--prompt` is unset by default
(no topical filter; scout picks by virality alone).

## Inputs

Read:
- `./uploads/<slug>/transcript.json`
- `~/.clip-forge/profile.json` (for `platform`, `niche`)

Validate both exist; ❌ otherwise.

## Delegate to clip-scout

Spawn the **clip-scout** agent with this brief (use the Agent tool):

```
You are clip-scout. Given the transcript below and the profile, return STRICT
JSON only — no prose, no markdown — matching the schema in the system message.

Hard rules:
- Pick at most $COUNT candidates.
- Each clip must be a contiguous span from the transcript.
- Duration: $MIN_DURATION ≤ end_ms - start_ms ≤ $MAX_DURATION.
- Score on five axes (0-100 each), virality = weighted mean:
    hook_strength    (0-3s of the clip)        weight 0.30
    emotional_peak                              weight 0.25
    narrative_complete                          weight 0.20
    platform_fit  (vs profile.platform)         weight 0.15
    quotability   (one-line takeaway)           weight 0.10
- Reject clips that start or end mid-sentence; align to sentence boundaries.

Prompt: $PROMPT_OR_OMIT
Profile: <embed profile.json>
Transcript: <embed transcript.json>
```

If `$ARGUMENTS` carries `--prompt "<topic>"`, embed the `Prompt: <topic>`
line above `Profile:`. If not, OMIT the line entirely — do NOT pass an
empty value. The agent treats the absence of `Prompt:` as "no topical
filter, pick by virality alone".

## Prompt-based clipping

`--prompt "<topic>"` activates a two-pass selection inside clip-scout:
filter to candidates whose transcript text is on-topic, then re-rank the
filtered set by virality desc (see `agents/clip-scout.md` →
"Prompt-based filtering"). The trade documented in
`docs/PLAN-v0.3.0.md` §5 risk row 1 is: broad prompts may produce zero
matches even when the source has clip-worthy moments. The contract is
**honest empty** — zero matches do NOT silently fall back to a
virality-sorted top-N. The caller (this skill, `/clip-forge:start`, or
the user) decides whether to re-run without `--prompt` or broaden the
topic.

## Dispatch path

`bin/cf-clip` is the auditable dispatcher. It accepts the same arg
grammar as the slash skill, loads transcript + profile, builds the
brief, and routes:

- **Test / mock path.** When `CF_CLIP_SCOUT_MOCK=<path>` is set,
  `cf-clip` execs that script with the brief on stdin and reads STRICT
  JSON back on stdout. Used by `tests/integration/clip-prompt.test.mjs`
  to exercise the contract without spending an `ANTHROPIC_API_KEY`.
- **Real path.** When no env var is set, `cf-clip --emit-brief` prints
  the brief to stdout and exits 0; the slash-skill (the one with the
  `Agent` tool allowance) then dispatches the real clip-scout agent and
  writes `candidates.json` with the agent's JSON.
- **Fallback path.** When `cf-clip` is invoked WITHOUT either of the
  above, it writes `candidates: []` + `fallback_used: true` +
  `warning.code: "no_scout_backend"` so downstream skills never crash on
  a missing artifact.

## Output schema — `./clips/<slug>/candidates.json`

```json
{
  "version": 1,
  "slug": "podcast-ep-42",
  "generated_at": "2026-05-20T03:14:00Z",
  "candidates": [
    {
      "id": "c01",
      "start_ms": 252000,
      "end_ms": 298000,
      "duration_s": 46.0,
      "title": "the moment everything changed",
      "hook": "Nobody tells you this about quitting your job —",
      "virality": 92,
      "scores": {
        "hook_strength": 95,
        "emotional_peak": 90,
        "narrative_complete": 88,
        "platform_fit": 95,
        "quotability": 85
      },
      "reasoning": "Opens with pattern-interrupt question, lands a clear pivot at 0:32, closes on a quotable line.",
      "hashtags": ["#career", "#quityourjob", "#startup", "#fyp"],
      "platform_fit": {"tiktok": 95, "reels": 88, "shorts": 80, "x": 65},
      "transcript_excerpt": "Nobody tells you this about quitting your job. The first week feels like vacation. The second week..."
    }
  ],
  "fallback_used": false,
  "fallback_reason": null,
  "warning": null
}
```

Sort `candidates` by `virality` descending. Assign IDs `c01`, `c02`, … in
that sorted order.

### v0.3.0 schema additions (additive, ignored by v0.2.0 readers)

- `warning` — optional top-level block `{ "code": "...", "message": "..." }`
  for soft contract issues. Currently emitted codes:
  - `"no_match"` — `--prompt` filtered all candidates out
  - `"no_scout_backend"` — dispatcher invoked with neither env mock nor
    `--emit-brief` (test-only path leaking into prod)
- `fallback_used` (boolean) + `fallback_reason` (string|null) — promoted
  on HARD failures (mock binary missing, transcript unreadable, scout
  JSON unparseable). On the soft `no_match` path, `fallback_used`
  STAYS `false` — a zero-result filter is a successful contract
  outcome, not a degradation.

## Display

Render a compact ASCII table for the user (top 10 only):

```
#    start    end      virality  title
c01  04:12    04:58    92        the moment everything changed
c02  11:01    11:47    88        nobody tells you this about X
…
```

## Failures

- clip-scout returned invalid JSON → re-prompt **once** with "Your previous
  response was not valid JSON. Reply with JSON only."
- Still bad → ❌ print the raw output's first 500 chars and abort.
- Fewer than 3 candidates → ⚠ note quality may be low; don't abort.

### Soft failures — empty candidates

A zero-length `candidates[]` is a VALID artifact. The render skill MUST
NOT crash on it; instead it prints `no candidates to render` and exits
0. `/clip-forge:start` reads the top-level `warning` block (if present),
surfaces the message verbatim, and asks whether to re-run with different
settings.

The two soft-failure cases handled at this layer:

| Case                            | `candidates` | `warning.code`     | `fallback_used` |
|---------------------------------|--------------|--------------------|-----------------|
| `--prompt` filtered everything  | `[]`         | `no_match`         | `false`         |
| Dispatch path misconfigured     | `[]`         | `no_scout_backend` | `true`          |
| Transcript / scout I/O failure  | `[]`         | various            | `true`          |

## Testing

`bin/cf-clip` honors `CF_CLIP_SCOUT_MOCK=<path>` for integration tests.
When set, the dispatcher routes the brief through that script instead of
the real Agent tool. The reference mock lives at
`tests/mocks/clip-scout-mock.mjs` and the contract suite at
`tests/integration/clip-prompt.test.mjs` exercises the four documented
paths (no-prompt baseline, on-topic filter, zero-match honest empty,
re-rank invariant). The mock is deterministic — same brief → byte-
identical JSON, so the test stays idempotent.
