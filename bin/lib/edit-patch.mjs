// edit-patch.mjs — RFC 6902 JSON-patch validator + applier for cf-edit
// prompt mode (v0.4.0 pillar 4).
//
// Three-layer validation per PLAN-v0.4.0 §7 Q5:
//   1. JSON Schema (schemas/edit-patch.v1.json) — structural shape.
//   2. WHITELIST — only the editable JSON Pointer paths listed below.
//   3. Auto dry-run preview (handled in skills/edit/SKILL.md via
//      AskUserQuestion before the dispatcher applies the patch).
//
// SCHEMA-PATH alignment note (brief CRITICAL section): the editable
// paths reflect the ACTUAL edit.json shape — `/hook_overlay/...`,
// `/target_aspect`, etc. — NOT the brief's first-draft paths. See
// docs/PLAN-v0.4.0.md §10 decision log for the rationale on dropping
// `/captions/style` from the whitelist (captions style lives in
// captions.json, a sibling file — out of scope for v0.4.0 pillar 4).

const WHITELIST_EXACT = new Set([
  '/cuts',
  '/hook_overlay/text',
  '/hook_overlay/end_ms',
  '/hook_overlay/position',
  '/progress_bar/enabled',
  '/progress_bar/color',
  '/progress_bar/height_px',
  '/progress_bar/position',
  '/target_aspect',
  '/brand_kit',
  '/watermark',
]);

const WHITELIST_PREFIX = [
  '/brand_kit/',
  '/progress_bar/',
];

const FORBIDDEN_EXACT = new Set([
  '/crop_path',
  '/audio_source',
  '/clip_id',
  '/source',
  '/output',
  '/version',
]);

export const WHITELIST = {
  exact:     [...WHITELIST_EXACT].sort(),
  prefix:    [...WHITELIST_PREFIX].sort(),
  forbidden: [...FORBIDDEN_EXACT].sort(),
};

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Layer 1 — structural validation. Pure-logic; no I/O. Returns
 * {ok, errors:[{path, reason}]}. Mirrors the subset of draft-07
 * needed for schemas/edit-patch.v1.json.
 */
export function validatePatchShape(payload) {
  const errors = [];
  if (!isObject(payload)) {
    errors.push({ path: '$', reason: 'payload is not an object' });
    return { ok: false, errors };
  }
  if (!Array.isArray(payload.patch)) {
    errors.push({ path: '$.patch', reason: 'patch must be an array' });
    return { ok: false, errors };
  }
  for (let i = 0; i < payload.patch.length; i++) {
    const op = payload.patch[i];
    const where = '$.patch[' + i + ']';
    if (!isObject(op)) {
      errors.push({ path: where, reason: 'op must be an object' });
      continue;
    }
    if (!['add', 'replace', 'remove'].includes(op.op)) {
      errors.push({ path: where + '.op', reason: 'op must be one of add/replace/remove' });
    }
    if (typeof op.path !== 'string' || !op.path.startsWith('/')) {
      errors.push({ path: where + '.path', reason: 'path must be a JSON Pointer starting with /' });
    }
    // No additional properties beyond op/path/value.
    for (const k of Object.keys(op)) {
      if (!['op', 'path', 'value'].includes(k)) {
        errors.push({ path: where + '.' + k, reason: 'unknown key (only op/path/value allowed)' });
      }
    }
  }
  if (payload.warning != null) {
    if (!isObject(payload.warning)) {
      errors.push({ path: '$.warning', reason: 'warning must be an object or null' });
    } else {
      if (typeof payload.warning.code    !== 'string') errors.push({ path: '$.warning.code',    reason: 'code must be string' });
      if (typeof payload.warning.message !== 'string') errors.push({ path: '$.warning.message', reason: 'message must be string' });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Layer 2 — whitelist enforcement. Each op.path must match either an
 * exact whitelisted path OR sit under a whitelisted prefix. Forbidden
 * paths short-circuit immediately.
 */
export function enforceWhitelist(payload) {
  const rejected = [];
  if (!payload || !Array.isArray(payload.patch)) {
    return { ok: false, rejected: [{ path: '$.patch', reason: 'not an array' }] };
  }
  for (let i = 0; i < payload.patch.length; i++) {
    const op = payload.patch[i];
    const p = String(op.path || '');
    if (FORBIDDEN_EXACT.has(p)) {
      rejected.push({ index: i, path: p, reason: 'forbidden_path' });
      continue;
    }
    for (const f of FORBIDDEN_EXACT) {
      if (p.startsWith(f + '/')) {
        rejected.push({ index: i, path: p, reason: 'forbidden_path_prefix' });
      }
    }
    if (WHITELIST_EXACT.has(p)) continue;
    if (WHITELIST_PREFIX.some((pre) => p.startsWith(pre))) continue;
    if (!rejected.find((r) => r.index === i)) {
      rejected.push({ index: i, path: p, reason: 'off_whitelist' });
    }
  }
  return { ok: rejected.length === 0, rejected };
}

/**
 * Layer 1 + 2 combined. Returns:
 *   { ok: true,  patch, warning }
 *   { ok: false, rejected_reason: 'schema_fail' | 'off_whitelist' | 'both',
 *     shape_errors, whitelist_rejected }
 *
 * Mirrors the brutal-review #4 contract — the rejection code MUST surface
 * back to the report for forensic traceability.
 */
export function validatePatchPayload(payload) {
  const shape = validatePatchShape(payload);
  if (!shape.ok) {
    return {
      ok:              false,
      rejected_reason: 'schema_fail',
      shape_errors:    shape.errors,
      whitelist_rejected: [],
    };
  }
  const wl = enforceWhitelist(payload);
  if (!wl.ok) {
    return {
      ok:              false,
      rejected_reason: 'off_whitelist',
      shape_errors:    [],
      whitelist_rejected: wl.rejected,
    };
  }
  return { ok: true, patch: payload.patch, warning: payload.warning || null };
}

/**
 * Apply an RFC 6902 patch to a JSON document. Pure-logic, no I/O.
 * Tiny RFC 6902 implementation — sufficient for the whitelisted paths.
 *
 * Returns { ok: true, doc } on success or
 *         { ok: false, error: '<reason>' } on apply error.
 */
export function applyPatch(doc, patchOps) {
  let out;
  try { out = JSON.parse(JSON.stringify(doc)); }
  catch (e) { return { ok: false, error: 'doc_clone_failed: ' + e.message }; }
  if (!Array.isArray(patchOps)) return { ok: false, error: 'patch_not_array' };
  for (let i = 0; i < patchOps.length; i++) {
    const op = patchOps[i];
    const segs = parsePointer(op.path);
    if (segs === null) return { ok: false, error: 'invalid_pointer: ' + op.path };
    try {
      if (op.op === 'remove') {
        removeAt(out, segs);
      } else if (op.op === 'add' || op.op === 'replace') {
        setAt(out, segs, op.value);
      } else {
        return { ok: false, error: 'unsupported_op: ' + op.op };
      }
    } catch (e) {
      return { ok: false, error: 'apply_failed at ' + op.path + ': ' + e.message };
    }
  }
  return { ok: true, doc: out };
}

function parsePointer(p) {
  if (typeof p !== 'string') return null;
  if (p === '') return [];
  if (p[0] !== '/') return null;
  return p.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function setAt(doc, segs, value) {
  if (segs.length === 0) {
    // Replacing the whole document — unusual; reject for safety.
    throw new Error('root_replace_not_supported');
  }
  let parent = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (parent[k] == null || typeof parent[k] !== 'object') {
      parent[k] = {};
    }
    parent = parent[k];
  }
  parent[segs[segs.length - 1]] = value;
}

function removeAt(doc, segs) {
  if (segs.length === 0) throw new Error('root_remove_not_supported');
  let parent = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (parent == null || typeof parent !== 'object') {
      throw new Error('parent_missing_at_' + k);
    }
    parent = parent[k];
  }
  if (parent == null || typeof parent !== 'object') return;
  delete parent[segs[segs.length - 1]];
}

/**
 * Render a unified-diff-ish summary of a patch for the AskUserQuestion
 * preview. No external lib — JSON ops are short enough that an op-by-op
 * print is readable.
 */
export function summarisePatch(patchOps) {
  if (!Array.isArray(patchOps)) return '(invalid patch — not an array)';
  if (patchOps.length === 0) return '(no changes)';
  const lines = [];
  for (const op of patchOps) {
    const v = 'value' in op ? JSON.stringify(op.value) : '';
    if (op.op === 'remove') {
      lines.push('  - REMOVE ' + op.path);
    } else if (op.op === 'add') {
      lines.push('  + ADD     ' + op.path + ' = ' + v);
    } else if (op.op === 'replace') {
      lines.push('  ~ REPLACE ' + op.path + ' = ' + v);
    } else {
      lines.push('  ? ' + JSON.stringify(op));
    }
  }
  return lines.join('\n');
}
