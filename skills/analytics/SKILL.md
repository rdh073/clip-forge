---
name: clip-forge-analytics
description: Pull per-clip views, watch-time, retention, likes, comments, and shares from connected TikTok / Instagram / YouTube / X accounts; render an ASCII table plus a Markdown report. Use when the user says "how did my clips do", "show analytics", "which clip is winning", or runs /clip-forge:analytics.
allowed-tools: Bash, Read, Write, Agent
---

# /clip-forge:analytics

## Args

`$ARGUMENTS` = `[<slug>] [--since <iso>] [--platforms <list>] [--top N] [--md <path>]`

Defaults: all slugs, last 14 days, all connected platforms, top 20, no
markdown report.

## Inputs

Read every `./renders/<slug>/<clip-id>.posts.json` to discover post IDs.
For each `(platform, post_id)` pair, call the platform's MCP `metrics` tool:

| Platform | MCP        | Tool        |
|----------|------------|-------------|
| tiktok   | tiktok     | `metrics`   |
| reels    | instagram  | `metrics`   |
| shorts   | youtube    | `metrics`   |
| x        | —          | manual / skip |

Each returns:
```json
{
  "views": 184230,
  "likes": 12410,
  "comments": 480,
  "shares": 2240,
  "saves": 980,
  "watch_time_s": 220000,
  "avg_view_duration_s": 19.4,
  "completion_rate": 0.71,
  "fetched_at": "2026-05-20T03:14:00Z"
}
```

Cache responses for 30 minutes in `./renders/<slug>/<clip-id>.metrics.json`
to avoid hammering APIs on repeat runs.

## ASCII table

Render top N by `views`, columns:
```
#   clip                          platform  views    likes  comp%  posted
1   the moment everything…        tiktok    184K     12.4K  71%    3d ago
2   nobody tells you this…        reels     97K      8.1K   62%    2d ago
3   ...
```

Truncate clip titles to 30 chars, format counts with K/M suffixes,
relative posted-at.

## Insights

Use the **publisher** agent for narrative insights:

```
You are publisher. Given these 14d metrics, return 3 bullet insights:
  - which clip/format/platform overperformed and why
  - one concrete next-experiment recommendation
  - one thing to stop doing
Reply markdown bullets only.
```

Print them under the table.

## Markdown report

If `--md <path>` is given, write a full report with:
- Per-platform totals (views, watch-hours, follower delta if available)
- Top 10 clips table
- The publisher's 3 insights
- A "Repeat the format of clip X" section if any clip > 3× the median

## Output

```
✅ pulled metrics for 14 clips across 3 platforms (cache hit: 0/14)
   total views: 642K · total watch-hours: 184 · avg completion: 64%
```

## Failures

- Platform OAuth expired → skip that platform with ⚠ and a re-auth hint.
- No posts found for the slug → ⏭ "no published clips yet for <slug>".
