#!/usr/bin/env node
// PostToolUse (matcher: Write) hook.
// If the user just wrote an .mp4 into ./uploads/<slug>/source.mp4, suggest
// auto-transcribing it. We do NOT auto-run /clip-forge:transcribe — that
// would be too invasive — but we surface the suggestion so the user (or
// clip-director) can fire it.
//
// Hook stdin: JSON event payload (PostToolUse schema). We only need
// `tool_input.file_path` for Write events.

import { readFileSync } from 'node:fs';

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

const raw = readStdin();
let evt;
try { evt = JSON.parse(raw); } catch { process.exit(0); }

const path = evt && evt.tool_input && evt.tool_input.file_path;
if (!path || !path.match(/\/uploads\/[^/]+\/source\.mp4$/)) {
  process.exit(0);
}

const slug = path.replace(/.*\/uploads\/([^/]+)\/source\.mp4$/, '$1');

const hint = '🎬 new upload detected: `' + slug + '`. Run `/clip-forge:transcribe ' + slug + '` to get word-timed transcripts.';

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: hint,
  },
}));
process.exit(0);
