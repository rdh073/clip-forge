#!/usr/bin/env node
// Monitor command, invoked as either:
//   queue-watch.mjs render   — watches ./renders/ for new .mp4 files and announces them
//   queue-watch.mjs publish  — drains ~/.clip-forge/queue.json at each entry's scheduled_at
//
// Monitors are long-running: emit one stdout line per event. Claude Code's
// monitor surface streams them as conversation context.

import { existsSync, readFileSync, writeFileSync, watch, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const mode = process.argv[2];
const HOME = homedir();
const QUEUE_PATH = join(HOME, '.clip-forge', 'queue.json');
const RENDERS_DIR = './renders';

function emit(obj) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
}

if (mode === 'render') {
  if (!existsSync(RENDERS_DIR)) {
    emit({ level: 'info', msg: 'no ./renders directory yet — waiting for first render' });
  }
  const seen = new Set();
  function scan() {
    if (!existsSync(RENDERS_DIR)) return;
    for (const slug of readdirSync(RENDERS_DIR)) {
      const slugDir = join(RENDERS_DIR, slug);
      let stat;
      try { stat = statSync(slugDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const file of readdirSync(slugDir)) {
        if (!file.endsWith('.mp4')) continue;
        const full = join(slugDir, file);
        if (seen.has(full)) continue;
        seen.add(full);
        const sz = statSync(full).size;
        emit({ level: 'info', event: 'render_complete', slug, clip: file.replace('.mp4',''),
               path: full, size_bytes: sz });
      }
    }
  }
  scan();
  setInterval(scan, 2000);

} else if (mode === 'publish') {
  function loadQueue() {
    if (!existsSync(QUEUE_PATH)) return { version: 1, entries: [] };
    try { return JSON.parse(readFileSync(QUEUE_PATH, 'utf-8')); }
    catch { return { version: 1, entries: [] }; }
  }
  function saveQueue(q) {
    writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2));
  }
  function tick() {
    const q = loadQueue();
    const now = Date.now();
    let dirty = false;
    for (const e of q.entries) {
      if (e.status !== 'pending') continue;
      const dueAt = Date.parse(e.scheduled_at);
      if (Number.isNaN(dueAt) || dueAt > now) continue;
      e.status = 'firing';
      dirty = true;
      emit({ level: 'info', event: 'publish_due', id: e.id, slug: e.slug, clip: e.clip_id,
             platforms: e.platforms, action: 'invoke /clip-forge:publish ' + e.slug + ' ' + e.clip_id + ' --platforms ' + e.platforms.join(',') });
    }
    if (dirty) saveQueue(q);
  }
  tick();
  setInterval(tick, 30_000);

} else {
  process.stderr.write('usage: queue-watch.mjs render|publish\n');
  process.exit(2);
}
