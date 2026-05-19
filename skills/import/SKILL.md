---
name: clip-forge-import
description: Pull a source video into ClipForge — accepts a local file path, a YouTube/Vimeo URL (via yt-dlp), or a Google Drive / Dropbox share link. Normalizes to ./uploads/<slug>/source.mp4 and emits the slug. Use when the user says "import this video", "download this YouTube link", "ingest /path/to/file.mp4", or whenever /clip-forge:start needs a source.
allowed-tools: Bash, Read, Write
---

# /clip-forge:import

## Input handling

Parse `$ARGUMENTS`:
- Looks like a URL (`^https?://`) → URL branch
- Exists as a file (`[ -f "$arg" ]`) → local branch
- Otherwise → ask the user once: "Paste a path or URL"

## Slug

Derive `SLUG` from the source:
- Local file → `basename` without extension, lowercased, non-alnum → `-`
- URL → fetch the page title via `yt-dlp --print title`, then slugify

If the slug already exists under `./uploads/`, append `-2`, `-3`, etc.

## Local branch

```bash
mkdir -p "./uploads/$SLUG"
cp "$SRC" "./uploads/$SLUG/source.mp4"
```

If the source is not already an `.mp4` container, transcode via:
```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-ffmpeg ingest "$SRC" "./uploads/$SLUG/source.mp4"
```

## URL branch (YouTube / Vimeo / generic yt-dlp)

```bash
${CLAUDE_PLUGIN_ROOT}/bin/cf-ytdlp "$URL" "./uploads/$SLUG/source.mp4"
```

`cf-ytdlp` emits one JSON line per progress tick:
```json
{"event":"progress","pct":42.1,"eta_s":34}
```
Stream those as ⏳ updates; print ✅ on `{"event":"done"}`.

## Drive / Dropbox

Drive `https://drive.google.com/file/d/<id>/view` → rewrite to
`https://drive.google.com/uc?export=download&id=<id>` then `curl -L`.

Dropbox `?dl=0` → swap to `?dl=1` then `curl -L`.

Save to `./uploads/$SLUG/source.mp4` (transcode if not mp4).

## Sidecar

Write `./uploads/$SLUG/source.json`:
```json
{
  "slug": "podcast-ep-42",
  "source_kind": "url|file|drive|dropbox",
  "source_uri": "...",
  "duration_s": 1842.3,
  "width": 1920,
  "height": 1080,
  "fps": 29.97,
  "imported_at": "2026-05-20T03:14:00Z"
}
```

Use `ffprobe` (via `bin/cf-ffmpeg probe`) to fill duration/resolution/fps.

## Output

Last line of stdout MUST be the slug — `/clip-forge:start` reads it:
```
✅ imported: ./uploads/podcast-ep-42/source.mp4 (30m 42s · 1080p · 29.97fps)
podcast-ep-42
```

## Failures

- yt-dlp non-zero → print the stderr tail, suggest `pip install -U yt-dlp`,
  exit ❌.
- Disk full → check `df` before copy; abort early with the path that's full.
- File-not-found → don't create an empty `./uploads/<slug>/` directory; clean
  up if anything was made.
