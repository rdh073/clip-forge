# Intro stingers

Drop short 9:16 (1080×1920) mp4 files here — these are the optional intro
clips concatenated to the front of a rendered short.

ClipForge ships **no default intro stingers** to keep the install lean and
because every creator wants their own brand stinger. Generate one with
Remotion (`templates/thumbnails/` has a Remotion entry as a starting point)
or drop in any pre-made 1080×1920 mp4 ≤ 3 seconds long.

Naming convention:

```
templates/intros/<name>.mp4
```

To use a specific intro for a clip, edit that clip's `edit.json`:

```json
{ "intro": "${CLAUDE_PLUGIN_ROOT}/templates/intros/podcast-1.mp4" }
```

The renderer concatenates it ahead of the body with a 200 ms crossfade.
