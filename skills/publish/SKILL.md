---
name: clip-forge-publish
description: Upload a rendered clip to TikTok, Instagram Reels, YouTube Shorts, or X. Handles OAuth, caption length per platform, hashtag rules, and thumbnail requirements via the publisher agent. Use when the user says "publish", "upload to TikTok", "post this", runs /clip-forge:publish, or when /clip-forge:start chose the publish branch.
allowed-tools: Bash, Read, Write, Agent
---

# /clip-forge:publish

## Args

`$ARGUMENTS` = `<slug> <clip-id> [--platforms tiktok,reels,shorts,x] [--now|--at <iso>]`

If `--platforms` omitted, use `profile.platform` (`all` → tiktok+reels+shorts+x).
If `--at` is supplied, defer to `/clip-forge:schedule` instead.

## Inputs

- `./renders/<slug>/<clip-id>.mp4`
- `./clips/<slug>/candidates.json` (for title, hook, hashtags)
- `~/.clip-forge/profile.json`

## Delegate caption + hashtag per platform to publisher

Call the **publisher** agent with the clip's title/hook and target platforms.
It returns per-platform payloads:

```json
{
  "tiktok": {
    "caption": "Nobody tells you this about quitting your job 🎯 #fyp #career",
    "hashtags": ["#fyp","#career","#quityourjob","#startup"],
    "thumbnail_at_s": 1.2
  },
  "reels": {
    "caption": "Nobody tells you this about quitting your job\n.\n.\n#career #reels",
    "hashtags": ["#career","#reels","#viral"],
    "thumbnail_at_s": 1.2
  }
}
```

publisher enforces: TikTok ≤ 2200 chars, IG ≤ 2200 chars + 30 hashtag cap,
YT title ≤ 100 chars + description ≤ 5000, X ≤ 280.

## Upload

For each platform in `--platforms`:

| Platform | MCP server | Tool          |
|----------|------------|---------------|
| tiktok   | tiktok     | `upload`      |
| reels    | instagram  | `upload_reel` |
| shorts   | youtube    | `upload_short`|
| x        | (TODO)     | manual prompt with twurl command |

Call e.g.:
```json
{
  "file_path": "./renders/<slug>/<clip-id>.mp4",
  "caption":   "<from publisher>",
  "hashtags":  ["#fyp", "#career"],
  "thumbnail_at_s": 1.2,
  "schedule_at": null
}
```

Each MCP returns `{"post_id": "...", "url": "..."}`. Record results in
`./renders/<slug>/<clip-id>.posts.json`:

```json
{
  "posts": [
    {
      "platform": "tiktok",
      "post_id": "7345698712345678901",
      "url": "https://tiktok.com/@you/video/7345...",
      "posted_at": "2026-05-20T03:14:00Z",
      "caption": "..."
    }
  ]
}
```

## Output

```
✅ published c01:
   tiktok  → https://tiktok.com/@you/video/7345…  (id 7345698712345678901)
   reels   → https://instagram.com/reel/XYZ
   shorts  → https://youtu.be/abc123
```

## Failures

- OAuth expired → MCP returns `auth_required`; print the platform's auth URL
  and ❌ "run `/clip-forge:publish --reauth <platform>`".
- Rate limited → backoff per platform's hint; ⚠ and continue with the others.
- Per-platform failure → ❌ that platform, ✅ the rest, exit 0 if at least
  one succeeded.
