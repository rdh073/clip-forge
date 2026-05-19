---
name: clip-forge-schedule
description: Queue a rendered clip for later posting across the user's platforms. Appends to ~/.clip-forge/queue.json; the publish-queue monitor drains it at the scheduled time. Use when the user says "schedule this", "post it Tuesday at 6pm", "queue for later", or runs /clip-forge:schedule.
allowed-tools: Bash, Read, Write, Agent
---

# /clip-forge:schedule

## Args

`$ARGUMENTS` = `<slug> <clip-id> [--at <iso>] [--platforms <list>] [--spread N]`

- `--at <iso>` — single fire time (`2026-05-21T18:00:00+07:00`).
- `--spread N` — spread N posts across the next N best windows per platform.
- If neither, ask **publisher** for optimal posting times based on `profile.platform`
  and timezone (`date +%z`).

## Queue file

`~/.clip-forge/queue.json` — append-only list:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "q-2026-05-21-001",
      "slug": "podcast-ep-42",
      "clip_id": "c01",
      "platforms": ["tiktok", "reels", "shorts"],
      "scheduled_at": "2026-05-21T18:00:00+07:00",
      "render_path": "./renders/podcast-ep-42/c01.mp4",
      "caption_overrides": null,
      "status": "pending",
      "attempts": 0,
      "created_at": "2026-05-20T03:14:00Z"
    }
  ]
}
```

Generate `id` as `q-<YYYY-MM-DD>-<3-digit counter>`.

## Optimal-windows mode

When `--at` is unset, call **publisher** agent:

```
You are publisher. Given platform <list> and timezone <tz>, return up to N
upcoming posting windows ranked by expected reach. Use platform-specific
best-time-to-post heuristics. Reply STRICT JSON: [{"platform":"tiktok",
"at":"2026-05-21T18:00:00+07:00","reason":"…"}].
```

Honor `--spread` by picking the top N windows that don't collide on the
same platform within 24 h.

## Confirmation

Print the schedule before writing:

```
📅 about to schedule c01:
   2026-05-21 18:00 +07:00  → tiktok, reels, shorts
   2026-05-22 12:30 +07:00  → x
   continue? (y/N)
```

Under `--yolo` in the parent flow, skip the prompt.

## Output

```
✅ queued c01 (q-2026-05-21-001): 2 windows · 4 platform-posts total
   the publish-queue monitor will fire them automatically
```

## Failures

- `--at` in the past → ❌ "scheduled_at is in the past".
- Queue file corrupted → backup to `queue.json.bak.$(date +%s)`, start a
  fresh queue with this entry, ⚠ note the backup.
