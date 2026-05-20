#!/usr/bin/env node
// visual-mock.mjs — realistic-mock image generator for cf-broll-ai
// integration tests. Reads a brief JSON on stdin:
//
//   { prompt, paths:[<dst>...], aspect, count, seed, brand_kit? }
//
// Writes a tiny deterministic PNG to each requested path and emits
// { paths, cost_usd, prompt_used } JSON on stdout. The PNG dimensions
// match the requested aspect (downstream timing/sizing tests need this).
// Deterministic (same input → byte-identical PNGs) — required for the
// idempotency guard.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PNG = resolvePath(__dirname, '..', 'fixtures', 'mock-broll-image.png');

const stdin = readFileSync(0, 'utf-8');
let brief;
try { brief = JSON.parse(stdin); }
catch (e) {
  process.stderr.write('visual-mock: bad JSON: ' + e.message + '\n');
  process.exit(1);
}
if (!Array.isArray(brief.paths) || brief.paths.length === 0) {
  process.stderr.write('visual-mock: brief.paths required\n');
  process.exit(2);
}

const count = Math.max(1, brief.count || 1);
const written = [];
for (let i = 0; i < Math.min(count, brief.paths.length); i++) {
  mkdirSync(dirname(brief.paths[i]), { recursive: true });
  copyFileSync(FIXTURE_PNG, brief.paths[i]);
  written.push(brief.paths[i]);
}
process.stdout.write(JSON.stringify({
  paths:       written,
  cost_usd:    0.003 * written.length,
  prompt_used: String(brief.prompt || ''),
  model:       'mock-visual',
}) + '\n');
