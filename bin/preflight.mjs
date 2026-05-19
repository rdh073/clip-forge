#!/usr/bin/env node
// SessionStart hook — checks system binaries and API keys, prints a one-shot
// readiness banner. Never fails the session (always exit 0); just informs.
//
// Reads the hook input JSON from stdin (the SessionStart event payload), but
// we don't actually need any of it for this check.

import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../..');

function which(cmd) {
  try {
    const path = execSync('command -v ' + cmd + ' 2>/dev/null', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    return path || null;
  } catch {
    return null;
  }
}

function checkBin(name, suggestInstall) {
  const found = which(name);
  return { name, ok: !!found, path: found, hint: found ? null : suggestInstall };
}

const bins = [
  checkBin('ffmpeg',  'install via your package manager (apt install ffmpeg / brew install ffmpeg)'),
  checkBin('yt-dlp',  'pip install -U yt-dlp  (or pipx install yt-dlp)'),
  checkBin('node',    'install Node 20+'),
];

const keys = [
  { name: 'DEEPGRAM_API_KEY', ok: !!process.env.DEEPGRAM_API_KEY, optional: true,  fallback: 'whisper.cpp (offline)' },
  { name: 'PEXELS_API_KEY',   ok: !!process.env.PEXELS_API_KEY,   optional: true,  fallback: 'b-roll skipped'        },
  { name: 'TIKTOK_CLIENT_KEY',ok: !!process.env.TIKTOK_CLIENT_KEY,optional: true,  fallback: 'publish to TikTok off' },
  { name: 'YT_CLIENT_ID',     ok: !!process.env.YT_CLIENT_ID,     optional: true,  fallback: 'publish to Shorts off' },
  { name: 'IG_APP_ID',        ok: !!process.env.IG_APP_ID,        optional: true,  fallback: 'publish to Reels off'  },
];

const modelPath = resolve(PLUGIN_ROOT, 'bin/models/face_detector.onnx');
const modelOk = existsSync(modelPath) && (() => {
  try { return statSync(modelPath).size > 500_000; } catch { return false; }
})();

const lines = [];
lines.push('🎬 ClipForge preflight');
for (const b of bins) {
  lines.push(b.ok ? '  ✅ ' + b.name + '  → ' + b.path
                  : '  ❌ ' + b.name + '  → ' + b.hint);
}
lines.push(modelOk
  ? '  ✅ face_detector.onnx present (Ultraface RFB-320)'
  : '  ⚠  face_detector.onnx missing  (run `node bin/install-models.mjs` for face-tracked reframe; otherwise center-crop fallback is used)');
for (const k of keys) {
  lines.push(k.ok ? '  ✅ ' + k.name
                  : '  ⚠  ' + k.name + ' unset  (fallback: ' + k.fallback + ')');
}
lines.push('  Run /clip-forge:start to begin.');

// SessionStart hooks add to additional context via hookSpecificOutput.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: lines.join('\n'),
  },
}));
process.exit(0);
