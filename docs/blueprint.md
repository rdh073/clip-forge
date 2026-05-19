# 🎬 `clip-forge` — Claude Code Plugin Blueprint

## Defaults

- Face detection: MediaPipe BlazeFace short-range, ~6 fps sampling.
- Active-speaker scoring weights: audio 0.3 · mouth 0.5 · central 0.1 · confidence 0.1.
- Switching damper: ≤1 target flip per 0.8 s + 24-frame lock.
- Target aspect: 9:16 (1080×1920). Override with `--target-aspect W:H`.
- Pan velocity clamp: 80 source-px/s.

## Konsep

Karena Claude Code adalah **terminal-based agent**, plugin ini bukan mengganti UI web Opus Clip, tapi memberi creator **workflow CLI yang lebih cepat**:
- `cd ~/Videos/podcast-ep-42`
- `claude` → `/clip-forge:start`
- Onboarding (sekali) → upload/import → AI generates 10 klip → edit → render → publish.

Komponen yang dipakai dari spec plugin:
| Komponen plugin | Untuk apa di `clip-forge` |
|---|---|
| **Skills** (`/clip-forge:xxx`) | Setiap langkah workflow (onboard, import, clip, caption, render, publish) |
| **Agents** | Sub-agen spesialis (clip-scout, caption-stylist, reframe-engineer, publisher) |
| **Hooks** | Auto-jalan ffmpeg setelah file diedit, auto-transcribe saat upload selesai |
| **MCP servers** | Bridge ke Deepgram, Anthropic, Pexels, TikTok/IG/YT APIs |
| **LSP** | (skip — bukan kebutuhan video) |
| **Monitors** | Watch folder upload, watch render queue, watch publish status |
| **`bin/`** | Shipping `ffmpeg-helper`, `yt-dlp`, `caption-burn` scripts |
| **`settings.json`** | Aktifkan default agent "clip-director" |

---

## Struktur direktori

```
clip-forge/
├── .claude-plugin/
│   └── plugin.json
├── README.md
├── settings.json
├── bin/
│   ├── cf-ffmpeg                 # wrapper FFmpeg dengan preset
│   ├── cf-ytdlp                  # wrapper yt-dlp
│   ├── cf-reframe                # MediaPipe face-tracker → crop JSON
│   └── cf-caption-burn           # render captions via Remotion CLI
├── skills/
│   ├── start/SKILL.md            # entry point / onboarding wizard
│   ├── onboard/SKILL.md          # brand kit, platform, niche
│   ├── import/SKILL.md           # upload, YouTube URL, Drive
│   ├── transcribe/SKILL.md       # Deepgram / Whisper
│   ├── clip/SKILL.md             # AI clip detection
│   ├── reframe/SKILL.md          # 16:9 → 9:16 auto-crop
│   ├── caption/SKILL.md          # viral caption styles
│   ├── broll/SKILL.md            # Pexels suggestion
│   ├── music/SKILL.md            # music bed + ducking
│   ├── render/SKILL.md           # final MP4 export
│   ├── publish/SKILL.md          # TikTok/IG/YT/X
│   ├── schedule/SKILL.md         # queue posts
│   └── analytics/SKILL.md        # post-publish metrics
├── agents/
│   ├── clip-director.md          # main orchestrator (set as default)
│   ├── clip-scout.md             # finds viral moments
│   ├── caption-stylist.md        # caption design choices
│   ├── reframe-engineer.md       # cropping decisions
│   └── publisher.md              # platform-specific publishing
├── hooks/
│   └── hooks.json                # auto-transcribe on upload, auto-render on edit
├── monitors/
│   └── monitors.json             # watch ./uploads, ./renders, publish queue
├── .mcp.json                     # Deepgram, Anthropic-extra, Pexels, TikTok, etc.
└── templates/
    ├── captions/                 # Beast, Submagic-pop, karaoke, neon, gradient
    ├── intros/
    └── thumbnails/
```
