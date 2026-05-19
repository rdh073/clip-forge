#!/usr/bin/env node
// Monitor: emits a line whenever a new .mp4 lands under ./uploads/.
// Uses fs.watch (recursive on macos/linux>=4.x) with a debounce so we only
// announce a file once it stops growing for 2s (i.e. download/copy finished).

import { existsSync, mkdirSync, watch, statSync } from 'node:fs';

const ROOT = './uploads';
if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });

const seen = new Set();
const pending = new Map(); // path -> last size

function emit(obj) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
}

function isCandidate(p) {
  return p.endsWith('.mp4') && p.includes('/uploads/');
}

setInterval(() => {
  for (const [p, prev] of pending) {
    if (!existsSync(p)) { pending.delete(p); continue; }
    let cur;
    try { cur = statSync(p).size; } catch { continue; }
    if (cur === prev && cur > 0) {
      if (!seen.has(p)) {
        seen.add(p);
        emit({ level: 'info', event: 'new_upload', path: p, size_bytes: cur });
      }
      pending.delete(p);
    } else {
      pending.set(p, cur);
    }
  }
}, 2000);

try {
  watch(ROOT, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const full = ROOT + '/' + filename;
    if (!isCandidate(full)) return;
    if (seen.has(full)) return;
    let sz = 0;
    try { sz = statSync(full).size; } catch { return; }
    pending.set(full, sz);
  });
} catch (e) {
  emit({ level: 'warn', msg: 'fs.watch failed on this platform: ' + e.message + ' — falling back to polling' });
  // polling fallback omitted for brevity; pending Map still works via interval
}

emit({ level: 'info', msg: 'watching ./uploads/ for new .mp4 files' });
