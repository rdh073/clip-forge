---
name: clip-forge-clip
description: Detect up to 15 viral clip candidates from a transcript using the clip-scout agent. Outputs ./clips/<slug>/candidates.json with virality scores, hooks, hashtags, platform fit, and reasoning. Use when the user says "find clips", "detect viral moments", runs /clip-forge:clip, or when /clip-forge:start needs candidates.
allowed-tools: Bash, Read, Write, Agent
---

# /clip-forge:clip

## Args

`$ARGUMENTS` = `<slug> [--count N] [--min-duration S] [--max-duration S]`

Defaults: `count=15`, `min=15s`, `max=90s`.

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

Profile: <embed profile.json>
Transcript: <embed transcript.json>
```

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
  ]
}
```

Sort `candidates` by `virality` descending. Assign IDs `c01`, `c02`, … in
that sorted order.

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
