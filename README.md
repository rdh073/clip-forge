# 🎬 ClipForge

> Turn long videos into 10+ viral shorts — AI clip detection, auto-reframe, viral captions, render, schedule, publish. **All from your terminal.**

ClipForge is a [Claude Code](https://code.claude.com) plugin that gives video creators
the Opus Clip / Klap / Vizard / Submagic workflow without a browser. `cd` into a
folder, run `/clip-forge:start`, and a fleet of specialist agents takes a podcast,
sermon, lecture, or stream and ships you ten platform-ready 9:16 clips with burned-in
captions, B-roll, and a music bed — ready to publish to TikTok, Reels, Shorts, and X.

![hero](docs/screenshots/hero.gif)

---

## Install

```bash
/plugin marketplace add xtrzy/clip-forge
/plugin install clip-forge
```

Or run directly from a checkout:

```bash
git clone https://github.com/xtrzy/clip-forge
claude --plugin-dir ./clip-forge
```

## Required env vars

Copy `.env.example` to `.env` and fill in the keys you have. ClipForge degrades
gracefully — if a key is missing, the related step falls back to a local
alternative (e.g. Whisper instead of Deepgram) or is skipped with a warning.

| Variable | Purpose | Required for |
|---|---|---|
| `DEEPGRAM_API_KEY` | Cloud transcription | `/clip-forge:transcribe` (falls back to local Whisper) |
| `ANTHROPIC_API_KEY` | Already set by Claude Code | clip-scout, caption-stylist |
| `PEXELS_API_KEY` | Stock B-roll | `/clip-forge:broll` |
| `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET` | TikTok upload | `/clip-forge:publish tiktok` |
| `YT_CLIENT_ID` + `YT_CLIENT_SECRET` | YouTube Shorts upload | `/clip-forge:publish youtube` |
| `IG_APP_ID` + `IG_APP_SECRET` | Instagram Reels upload | `/clip-forge:publish instagram` |

System binaries: `ffmpeg`, `yt-dlp`, `node>=20`. The SessionStart hook checks
these on every boot and warns if missing.

## Quickstart

```bash
cd ~/Videos/podcast-ep-42
claude
> /clip-forge:start
```

First run walks you through the onboarding wizard (platform, niche, brand kit,
caption style). Subsequent runs jump straight to import → clip → render.

Pass `--yolo` to skip every approval gate and ship 10 clips unattended:

```text
/clip-forge:start --yolo
```

---

## Skills

| Slash command | What it does |
|---|---|
| `/clip-forge:start`        | Orchestrates the whole pipeline; the only command you need |
| `/clip-forge:onboard`      | 4-step wizard: platform, niche, brand kit, caption style |
| `/clip-forge:import`       | Pull source from local file, YouTube/Vimeo, or Drive/Dropbox |
| `/clip-forge:transcribe`   | Word-timed transcript via Deepgram (or local Whisper) |
| `/clip-forge:clip`         | Calls clip-scout agent to pick up to 15 viral moments |
| `/clip-forge:reframe`      | Face-tracked 16:9 → 9:16 crop path with Kalman smoothing |
| `/clip-forge:caption`      | Word-timed captions in your default style → `.ass` file |
| `/clip-forge:broll`        | Pexels stock cutaways matched to each sentence |
| `/clip-forge:music`        | Royalty-free music bed with auto-ducking under speech |
| `/clip-forge:render`       | Final 9:16 1080×1920 MP4 per clip (ffmpeg presets) |
| `/clip-forge:publish`      | Post to TikTok, Reels, Shorts, X |
| `/clip-forge:schedule`     | Queue posts for later; monitor drains the queue |
| `/clip-forge:analytics`    | Per-clip views, watch-time, retention report |

## Agents

- **clip-director** — lead producer; default agent set via `settings.json`
- **clip-scout** — viral-pattern recognition (hook, peak, completeness)
- **caption-stylist** — picks caption style per niche/platform/sentiment
- **reframe-engineer** — face-track vs object-track, pan-speed limits
- **publisher** — knows each platform's caption length, hashtag rules, posting times

## Architecture

```
    ┌────────────────────┐
    │   user terminal    │
    └──────────┬─────────┘
               │  /clip-forge:start
               ▼
    ┌────────────────────┐         ┌─────────────────────────┐
    │  clip-director     │◄────────┤ ~/.clip-forge/profile   │
    │     (agent)        │         └─────────────────────────┘
    └──┬───┬───┬───┬───┬─┘
       │   │   │   │   │
       ▼   ▼   ▼   ▼   ▼
   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
   │import│ │trans-│ │ clip │ │refrm │ │capt. │  …skills
   └──┬───┘ │cribe │ │scout │ │engr. │ │stylst│
      │     └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘
      ▼        ▼        ▼        ▼        ▼
   ┌─────────────────────────────────────────────┐
   │   .mcp.json: deepgram · pexels · tiktok ·   │
   │              youtube · instagram            │
   └─────────────────────────────────────────────┘
      │
      ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐
   │bin/cf-   │    │bin/cf-   │    │bin/cf-   │
   │ ytdlp    │    │ ffmpeg   │    │ reframe  │
   └──────────┘    └──────────┘    └──────────┘
      │
      ▼
   ┌──────────────────────────┐
   │ ./renders/<slug>/*.mp4   │
   └──────────────────────────┘
      │
      ▼  monitors/publish-queue drains on schedule
   ┌──────────────────────────┐
   │ TikTok · Reels · Shorts  │
   └──────────────────────────┘
```

## File layout in your project

```
your-project/
├── uploads/<slug>/source.mp4        # raw imports
├── uploads/<slug>/transcript.json   # word-timed
├── clips/<slug>/candidates.json     # clip-scout output
├── clips/<slug>/<clip-id>/
│   ├── crop_path.json               # reframe-engineer output
│   ├── captions.json + .ass         # caption-stylist output
│   ├── broll.json                   # cutaway timeline
│   └── edit.json                    # render manifest (triggers hook)
└── renders/<slug>/<clip-id>.mp4     # final 9:16 export
```

## License

MIT © 2026 xtrzy
