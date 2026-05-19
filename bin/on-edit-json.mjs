#!/usr/bin/env node
// PostToolUse (matcher: Write|Edit) hook.
// If the user just modified ./clips/<slug>/<clip-id>/edit.json, suggest
// re-rendering that clip. We don't auto-render — same reasoning as
// on-upload.mjs — but we hint clearly.

import { readFileSync } from 'node:fs';

function readStdin() {
  try { return readFileSync(0, 'utf-8'); } catch { return ''; }
}

const raw = readStdin();
let evt;
try { evt = JSON.parse(raw); } catch { process.exit(0); }

const path = evt && evt.tool_input && evt.tool_input.file_path;
if (!path) process.exit(0);

const m = path.match(/\/clips\/([^/]+)\/([^/]+)\/edit\.json$/);
if (!m) process.exit(0);

const [, slug, clipId] = m;
const hint = '✂️  edit.json changed for ' + slug + '/' + clipId +
  '. Re-render with `/clip-forge:render ' + slug + ' ' + clipId + '`.';

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: hint,
  },
}));
process.exit(0);
