// render-manifest.mjs — render manifest I/O for cf-edit (v0.4.0 pillar 4).
//
// SHARED FILE with pillar 2 (budget.mjs). Pillar 2 owns the `ai_costs`
// block, pillar 4 owns the `clips` block. cf-edit's atomic rewrite MUST
// preserve any existing `ai_costs` byte-for-byte modulo additive breakdown
// keys — composition gate verifies this.
//
// Atomic write: writeFile to <path>.tmp, fsync, rename. Crash mid-write
// leaves either the previous manifest intact OR no manifest (both valid;
// cf-edit treats absent manifest as cold-start).
//
// Hash semantics: input_hashes carry "sha256:<hex>" strings. A missing
// input file maps to null (NOT to "sha256:nullhash"). This lets the diff
// detect "input was added since last render" without false positives.

import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, statSync,
  openSync, fsyncSync, closeSync, renameSync, unlinkSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';

export const MANIFEST_SCHEMA_VERSION = 1;

const SHA_PREFIX = 'sha256:';

/**
 * Compute sha256 of a file. Returns null when the file is missing or
 * unreadable. NEVER throws — callers want a stable null on missing input.
 */
export function hashFileSha256(path) {
  if (!path || typeof path !== 'string') return null;
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const buf = readFileSync(path);
    const hex = createHash('sha256').update(buf).digest('hex');
    return SHA_PREFIX + hex;
  } catch {
    return null;
  }
}

/**
 * Compute sha256 of a string buffer (used for edit.json — we may hash the
 * canonical-on-disk bytes OR a synthesized patched JSON).
 */
export function hashStringSha256(s) {
  return SHA_PREFIX + createHash('sha256').update(String(s == null ? '' : s)).digest('hex');
}

/**
 * Compute the input_hashes record for a single clip from its edit.json
 * descriptor. The keys mirror the in-brief contract: edit_json, crop_path,
 * captions_ass, cuts_plan, audio_source, brand_kit.
 *
 * brand_kit hash policy:
 *   - inline edit.json.brand_kit → hash JSON.stringify(brand_kit) (canonicalised)
 *   - edit.json.watermark.brand_kit_ref → hash the referenced file
 *   - legacy edit.json.watermark string → hash the file
 *   - none / missing path → null
 */
export function computeInputHashes(editJsonPath) {
  const out = {
    edit_json:    null,
    crop_path:    null,
    captions_ass: null,
    cuts_plan:    null,
    audio_source: null,
    brand_kit:    null,
  };
  if (!editJsonPath || !existsSync(editJsonPath)) return out;
  out.edit_json = hashFileSha256(editJsonPath);
  let edit;
  try { edit = JSON.parse(readFileSync(editJsonPath, 'utf-8')); }
  catch { return out; }
  if (edit.crop_path)    out.crop_path    = hashFileSha256(edit.crop_path);
  if (edit.captions)     out.captions_ass = hashFileSha256(edit.captions);
  if (edit.cuts)         out.cuts_plan    = hashFileSha256(edit.cuts);
  if (edit.audio_source) out.audio_source = hashFileSha256(edit.audio_source);
  if (edit.brand_kit && typeof edit.brand_kit === 'object') {
    const canonical = JSON.stringify(edit.brand_kit, Object.keys(edit.brand_kit).sort());
    out.brand_kit = hashStringSha256(canonical);
  } else if (edit.watermark && typeof edit.watermark === 'object' && edit.watermark.brand_kit_ref) {
    out.brand_kit = hashFileSha256(edit.watermark.brand_kit_ref);
  } else if (typeof edit.watermark === 'string') {
    out.brand_kit = hashFileSha256(edit.watermark);
  }
  return out;
}

/**
 * Load a manifest file, normalising shape. Missing file → empty shell with
 * the slug pre-filled. Unreadable JSON → empty shell (caller treats it as
 * cold-start; no exception bubbles up). NEVER throws.
 */
export function loadManifestFile(path, { slug, clipforgeVersion } = {}) {
  if (!path || !existsSync(path)) {
    return emptyManifest(slug, clipforgeVersion);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return emptyManifest(slug, clipforgeVersion); }
  if (!raw || typeof raw !== 'object') return emptyManifest(slug, clipforgeVersion);
  // Normalise; preserve unknown fields (additive forward-compat).
  if (typeof raw.version !== 'number') raw.version = MANIFEST_SCHEMA_VERSION;
  if (typeof raw.schema  !== 'string') raw.schema  = 'render_manifest.v1';
  if (!raw.slug && slug) raw.slug = slug;
  if (!raw.clips || typeof raw.clips !== 'object') raw.clips = {};
  if (!raw.ai_costs || typeof raw.ai_costs !== 'object') {
    // Do NOT clobber an existing ai_costs structure — only seed when absent.
    raw.ai_costs = undefined;
  }
  return raw;
}

function emptyManifest(slug, clipforgeVersion) {
  return {
    version: MANIFEST_SCHEMA_VERSION,
    schema:  'render_manifest.v1',
    slug:    slug || null,
    created_at: new Date().toISOString(),
    clipforge_version: clipforgeVersion || null,
    clips:   {},
  };
}

/**
 * Atomic write — writeFile to <path>.tmp, fsync, rename. Crash mid-write
 * leaves either the previous file intact OR no file. Brutal-review check
 * #2 verifies this with a kill -9 simulation.
 */
export function saveManifestAtomic(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp.' + process.pid + '.' + Date.now();
  const body = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(tmp, body);
  // Force fsync so the rename targets fully-written bytes.
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  return path;
}

/**
 * Diff a set of clip descriptors against the manifest. Returns the list
 * of clip_ids whose inputs no longer match. Cold-start (no manifest entry)
 * is ALWAYS considered stale.
 *
 * @param {Array<{clip_id, edit_json_path}>} clips
 * @param {object} manifest  output of loadManifestFile
 * @returns {{stale: string[], reasons: Object<string, {reason, stale_keys}>}}
 */
export function diffClips(clips, manifest) {
  const stale = [];
  const reasons = {};
  const clipsBlock = (manifest && manifest.clips) || {};
  for (const c of clips) {
    const id = c.clip_id;
    if (!id) continue;
    const prev = clipsBlock[id];
    const current = computeInputHashes(c.edit_json_path);
    if (!prev || !prev.input_hashes) {
      stale.push(id);
      reasons[id] = { reason: 'cold_start', stale_keys: Object.keys(current) };
      continue;
    }
    const changed = [];
    for (const k of Object.keys(current)) {
      if (prev.input_hashes[k] !== current[k]) changed.push(k);
    }
    // Also catch keys that existed previously but have been dropped — treat
    // those as a change so we re-render after a removal.
    for (const k of Object.keys(prev.input_hashes)) {
      if (!(k in current) && prev.input_hashes[k]) changed.push(k);
    }
    if (changed.length > 0) {
      stale.push(id);
      reasons[id] = { reason: 'input_changed:' + changed.join(','), stale_keys: changed };
    }
  }
  return { stale, reasons };
}

/**
 * Upsert one clip entry into the manifest. Returns the mutated manifest
 * (also mutates in-place — manifests are small + always written before the
 * function returns to its caller).
 */
export function recordClipRender(manifest, { clip_id, output, input_hashes, rendered_sha256, rerender_reason }) {
  if (!manifest.clips) manifest.clips = {};
  manifest.clips[clip_id] = {
    output,
    rendered_at:     new Date().toISOString(),
    rendered_sha256: rendered_sha256 || null,
    rerender_reason: rerender_reason || null,
    input_hashes:    { ...input_hashes },
  };
  manifest.rendered_at = manifest.clips[clip_id].rendered_at;
  return manifest;
}

/**
 * Default manifest path for a slug — ./renders/<slug>/render_manifest.json.
 */
export function manifestPathForSlug(slug, { rendersRoot } = {}) {
  return join(rendersRoot || './renders', slug, 'render_manifest.json');
}

export { SHA_PREFIX };
