# Thumbnails

ClipForge auto-generates YouTube Shorts thumbnails by extracting a still at
`thumbnail_at_s` from the rendered clip (`bin/cf-ffmpeg` reuses ffmpeg's
`-ss` + `-vframes 1`).

For more elaborate thumbnails (text overlays, brand frames, etc.), use the
Remotion composition stub in `composition.tsx`. To render:

```bash
cd templates/thumbnails
npx remotion render composition.tsx ThumbnailMain out/thumb-c01.png \
  --props='{"title":"Nobody tells you this about quitting","clip_id":"c01","colors":{"primary":"#ff0066","accent":"#00d4ff"}}'
```

The composition expects props:

| prop          | type    | example                          |
|---------------|---------|----------------------------------|
| `title`       | string  | The clip's title                 |
| `clip_id`     | string  | `c01`                            |
| `colors`      | object  | `{primary, accent}` (hex)        |
| `still_url`   | string  | local path to a still from the clip |
