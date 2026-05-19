---
name: clip-forge-broll
description: Suggest and download stock B-roll cutaways for each sentence in a clip using the Pexels MCP. Writes ./clips/<slug>/<clip-id>/broll.json (timeline of cutaways with download paths). Use when the user says "add b-roll", "find cutaways", runs /clip-forge:broll, or when /clip-forge:start has auto_broll enabled.
allowed-tools: Bash, Read, Write
---

# /clip-forge:broll

## Args

`$ARGUMENTS` = `<slug> <clip-id> [--max N] [--per-sentence 1] [--orientation portrait]`

Defaults: `max=4` cutaways per clip, `per-sentence=1` (skip sentences that
fail keyword match), `orientation=portrait`.

## Inputs

- `./uploads/<slug>/transcript.json`     (slice by clip boundary)
- `./clips/<slug>/candidates.json`

## Strategy

1. For each sentence in the clip's slice, extract 1–2 search keywords:
   - Strip stopwords (`the`, `is`, `a`, `that`, …).
   - Pick the 1–2 most concrete nouns (NLP-light: longest non-stopword token,
     biased toward capitalized words).
2. Cap to `max` cutaways per clip — pick the sentences with the strongest
   keyword signal, prefer sentences with low speaker-energy (B-roll covers
   talky lulls).
3. For each chosen sentence call the **pexels** MCP `search_videos` tool:
   ```json
   { "query": "city skyline", "orientation": "portrait", "min_duration": 4 }
   ```
4. Pick the top result whose dimensions are ≥ 720×1280 portrait or
   ≥ 1280×720 landscape (will be cropped to portrait at render).
5. Download to `./clips/<slug>/<clip-id>/broll/<sentence-idx>.mp4` via curl.

## Output — `broll.json`

```json
{
  "version": 1,
  "clip_id": "c01",
  "cutaways": [
    {
      "sentence_idx": 2,
      "start_ms": 6200,
      "end_ms": 9800,
      "query": "morning coffee",
      "source": "pexels:8530484",
      "path": "./clips/podcast-ep-42/c01/broll/2.mp4",
      "credit": "Cottonbro Studio",
      "opacity": 1.0,
      "fade_ms": 200
    }
  ]
}
```

## Output

```
✅ broll c01: 4/12 sentences covered · 4 cutaways downloaded (8.3 MB)
```

## Failures

- `PEXELS_API_KEY` unset → skip cleanly with ⏭ "no PEXELS_API_KEY — skipping
  b-roll" and write an empty `broll.json`. Do **not** fail the pipeline.
- Pexels rate-limited (429) → exponential backoff (1s, 2s, 4s); after 3
  tries, ⚠ and continue with whatever was downloaded.
- All candidate clips already covered → write empty cutaways and ⏭.
