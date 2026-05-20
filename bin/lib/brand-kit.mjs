// brand-kit.mjs — pure-logic loader/saver for ~/.clip-forge/brand-kit.json
// and ./uploads/<slug>/brand-kit.json.
//
// Two-tier scope (PLAN-v0.4.0 §3.3 mirror of pillar 2 voices.json):
//
//   1. ./uploads/<slug>/brand-kit.json — per-project (wins entirely; no merge)
//   2. ~/.clip-forge/brand-kit.json     — user-global default
//
// File-size limits (PLAN §3.3 + brief): enforced at LOAD time, before the
// filter graph is built. Oversized assets are SKIPPED with a soft warning
// brand_kit_asset_oversize — the render still proceeds with the remaining
// assets. This is the design intent: keep ffmpeg memory bounded.
//
//   logo        ≤ 2 MB (PNG / SVG)
//   endcard     ≤ 2 MB (PNG) or ≤ 3 MB (MP4)
//   lower_third ≤ 2 MB (PNG with alpha)
//
// SoC: this module only owns persistence + lookup + size enforcement.
// Filter-graph construction lives in bin/lib/brand-overlay-builder.mjs;
// ffmpeg invocation lives in bin/cf-ffmpeg.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname } from 'node:path';

const SCHEMA_VERSION = 1;

const LIMITS = {
  logo_bytes:        2 * 1024 * 1024,
  endcard_png_bytes: 2 * 1024 * 1024,
  endcard_mp4_bytes: 3 * 1024 * 1024,
  lower_third_bytes: 2 * 1024 * 1024,
};

const POSITIONS = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center']);

function emptyKit(name = 'default') {
  return { version: SCHEMA_VERSION, name, assets: {} };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clampOpacity(v, def = 0.7) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clampScalePx(v, def = 96) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.max(8, Math.min(1024, Math.floor(v)));
}

function normalisePosition(v, def = 'bottom-right') {
  return POSITIONS.has(v) ? v : def;
}

function fileBytes(p) {
  try { return statSync(p).size; }
  catch { return null; }
}

function isMp4Path(p) {
  return /\.mp4$/i.test(String(p));
}

function isSvgPath(p) {
  return /\.svg$/i.test(String(p));
}

function normaliseKit(raw, warnings) {
  if (!isObject(raw)) {
    warnings.push({ code: 'brand_kit_unreadable', message: 'brand-kit.json root is not an object' });
    return emptyKit();
  }
  const out = emptyKit(typeof raw.name === 'string' ? raw.name : 'default');
  if (!isObject(raw.assets)) return out;

  // Logo.
  if (isObject(raw.assets.logo)) {
    const a = raw.assets.logo;
    if (typeof a.path !== 'string' || !a.path) {
      warnings.push({ code: 'brand_kit_logo_path_missing', message: 'assets.logo.path required' });
    } else {
      out.assets.logo = {
        path:     a.path,
        position: normalisePosition(a.position, 'bottom-right'),
        opacity:  clampOpacity(a.opacity, 0.7),
        scale_px: clampScalePx(a.scale_px, 96),
      };
    }
  }
  // Endcard.
  if (isObject(raw.assets.endcard)) {
    const a = raw.assets.endcard;
    if (typeof a.path !== 'string' || !a.path) {
      warnings.push({ code: 'brand_kit_endcard_path_missing', message: 'assets.endcard.path required' });
    } else {
      const def = isMp4Path(a.path) ? 3000 : 2000;
      const dur = (typeof a.duration_ms === 'number' && a.duration_ms > 0)
        ? Math.max(100, Math.min(5000, Math.floor(a.duration_ms))) : def;
      out.assets.endcard = { path: a.path, duration_ms: dur };
    }
  }
  // Lower third.
  if (isObject(raw.assets.lower_third)) {
    const a = raw.assets.lower_third;
    if (typeof a.path !== 'string' || !a.path) {
      warnings.push({ code: 'brand_kit_lower_third_path_missing', message: 'assets.lower_third.path required' });
    } else {
      out.assets.lower_third = {
        path:          a.path,
        position:      normalisePosition(a.position, 'bottom-left'),
        opacity:       clampOpacity(a.opacity, 0.9),
        show_from_ms:  Math.max(0, Math.floor(typeof a.show_from_ms === 'number' ? a.show_from_ms : 1500)),
        show_until_ms: Math.max(0, Math.floor(typeof a.show_until_ms === 'number' ? a.show_until_ms : 4000)),
      };
    }
  }
  return out;
}

/**
 * Enforce file-size limits + path-exists on a normalised kit. Mutates `kit`
 * by deleting oversized / missing assets, appending warnings.
 *
 *   missing  → brand_asset_missing:<key>
 *   oversize → brand_kit_asset_oversize:<key>
 *
 * Returns the mutated kit (same reference).
 */
export function enforceAssetLimits(kit, warnings) {
  if (!isObject(kit) || !isObject(kit.assets)) return kit;
  const assets = kit.assets;

  if (assets.logo) {
    const size = fileBytes(assets.logo.path);
    if (size === null) {
      warnings.push({ code: 'brand_asset_missing', asset: 'logo', message: 'logo path missing: ' + assets.logo.path });
      delete assets.logo;
    } else if (size > LIMITS.logo_bytes) {
      warnings.push({ code: 'brand_kit_asset_oversize', asset: 'logo',
        message: 'logo ' + assets.logo.path + ' is ' + size + ' bytes, over 2 MB limit; skipped' });
      delete assets.logo;
    }
  }
  if (assets.endcard) {
    const size = fileBytes(assets.endcard.path);
    if (size === null) {
      warnings.push({ code: 'brand_asset_missing', asset: 'endcard', message: 'endcard path missing: ' + assets.endcard.path });
      delete assets.endcard;
    } else {
      const cap = isMp4Path(assets.endcard.path) ? LIMITS.endcard_mp4_bytes : LIMITS.endcard_png_bytes;
      if (size > cap) {
        warnings.push({ code: 'brand_kit_asset_oversize', asset: 'endcard',
          message: 'endcard ' + assets.endcard.path + ' is ' + size + ' bytes, over cap ' + cap + '; skipped' });
        delete assets.endcard;
      }
    }
  }
  if (assets.lower_third) {
    const size = fileBytes(assets.lower_third.path);
    if (size === null) {
      warnings.push({ code: 'brand_asset_missing', asset: 'lower_third', message: 'lower_third path missing: ' + assets.lower_third.path });
      delete assets.lower_third;
    } else if (size > LIMITS.lower_third_bytes) {
      warnings.push({ code: 'brand_kit_asset_oversize', asset: 'lower_third',
        message: 'lower_third ' + assets.lower_third.path + ' is ' + size + ' bytes, over 2 MB limit; skipped' });
      delete assets.lower_third;
    }
  }
  return kit;
}

export function loadKitFile(path, { enforce = true } = {}) {
  if (!path || !existsSync(path)) {
    return { ok: false, kit: emptyKit(), warning: 'brand_kit_file_missing', path, warnings: [] };
  }
  const warnings = [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    return {
      ok: false, kit: emptyKit(),
      warning: 'brand_kit_unreadable',
      warnings: [{ code: 'brand_kit_unreadable', message: 'brand-kit.json parse error: ' + e.message }],
      path,
    };
  }
  const kit = normaliseKit(raw, warnings);
  if (enforce) enforceAssetLimits(kit, warnings);
  const hadAssetWarning = warnings.some((w) => w.code === 'brand_kit_unreadable');
  return { ok: !hadAssetWarning, kit, warning: null, warnings, path };
}

/**
 * Load with per-project precedence — project file wins entirely.
 *
 *   loadKit({globalPath, projectPath}) → {kit, source, path, warnings}
 *
 * source ∈ 'project' | 'global' | null.
 * warnings always present (possibly empty).
 */
export function loadKit({ globalPath, projectPath } = {}) {
  if (projectPath && existsSync(projectPath)) {
    const r = loadKitFile(projectPath);
    if (r.ok) {
      return { kit: r.kit, source: 'project', path: projectPath, warnings: r.warnings };
    }
    if (globalPath && existsSync(globalPath)) {
      const g = loadKitFile(globalPath);
      const w = [...g.warnings, { code: 'brand_kit_unreadable', message: 'project brand-kit.json unreadable; fell back to global' }];
      return { kit: g.kit, source: 'global', path: globalPath, warnings: w };
    }
    return { kit: emptyKit(), source: null, path: null, warnings: r.warnings };
  }
  if (globalPath && existsSync(globalPath)) {
    const g = loadKitFile(globalPath);
    return { kit: g.kit, source: 'global', path: globalPath, warnings: g.warnings };
  }
  return { kit: emptyKit(), source: null, path: null, warnings: [] };
}

/**
 * Resolve which brand-kit object to apply for a given render, considering
 * edit.json precedence (PLAN brief §3):
 *
 *   inline brand_kit object   wins
 *   brand_kit_ref: {path: …}  next
 *   legacy watermark string   maps to a logo-only kit
 *   per-project / global file fallback (when none of the above)
 *
 * Returns:
 *   { kit, source, warnings, applied }
 *
 *   source ∈ 'inline' | 'ref' | 'legacy' | 'project' | 'global' | null
 *   applied = true iff kit.assets is non-empty AND something will burn.
 *
 *   `editJson.brand_kit`        — inline shape (full kit object)
 *   `editJson.watermark.brand_kit_ref` — { path: <abs> }
 *   `editJson.watermark`        — legacy string path (logo PNG/MP4)
 */
export function resolveKitForEdit(editJson, { globalPath, projectPath } = {}) {
  const warnings = [];
  // Inline.
  if (isObject(editJson.brand_kit)) {
    const kit = normaliseKit(editJson.brand_kit, warnings);
    enforceAssetLimits(kit, warnings);
    return { kit, source: 'inline', warnings, applied: hasAnyAsset(kit) };
  }
  // Ref via watermark object.
  if (isObject(editJson.watermark) && typeof editJson.watermark.brand_kit_ref === 'string') {
    const refPath = editJson.watermark.brand_kit_ref;
    if (existsSync(refPath)) {
      const r = loadKitFile(refPath);
      warnings.push(...r.warnings);
      return { kit: r.kit, source: 'ref', warnings, applied: hasAnyAsset(r.kit) };
    }
    warnings.push({ code: 'brand_kit_ref_missing', message: 'brand_kit_ref path missing: ' + refPath });
    // Fall through to project/global.
  }
  // Legacy single-string watermark.
  if (typeof editJson.watermark === 'string' && editJson.watermark) {
    const path = editJson.watermark;
    const size = fileBytes(path);
    if (size === null) {
      warnings.push({ code: 'brand_asset_missing', asset: 'logo', message: 'legacy watermark path missing: ' + path });
      return { kit: emptyKit(), source: null, warnings, applied: false };
    }
    // Legacy semantics: bottom-right, 70 % opacity (matches existing
    // bin/cf-ffmpeg watermark subcommand). MP4 → endcard. PNG/SVG → logo.
    const kit = emptyKit('legacy-watermark');
    if (isMp4Path(path)) {
      kit.assets.endcard = { path, duration_ms: 3000 };
    } else {
      kit.assets.logo = { path, position: 'bottom-right', opacity: 0.7, scale_px: 96 };
    }
    enforceAssetLimits(kit, warnings);
    return { kit, source: 'legacy', warnings, applied: hasAnyAsset(kit) };
  }
  // Per-project / global fallback (only if edit.json says nothing).
  const loaded = loadKit({ globalPath, projectPath });
  warnings.push(...loaded.warnings);
  return { kit: loaded.kit, source: loaded.source, warnings, applied: hasAnyAsset(loaded.kit) };
}

function hasAnyAsset(kit) {
  return isObject(kit) && isObject(kit.assets) &&
         (kit.assets.logo || kit.assets.endcard || kit.assets.lower_third) ? true : false;
}

/**
 * Mutating helpers used by /clip-forge:brand-kit (cf-brand-kit dispatcher).
 */
export function upsertAsset(kit, key, entry) {
  if (!isObject(kit) || !isObject(kit.assets)) {
    kit = emptyKit(kit?.name ?? 'default');
  }
  const next = { version: SCHEMA_VERSION, name: kit.name ?? 'default', assets: { ...(kit.assets || {}) } };
  next.assets[key] = entry;
  return next;
}

export function removeAsset(kit, key) {
  if (!isObject(kit) || !isObject(kit.assets)) return emptyKit();
  const next = { version: SCHEMA_VERSION, name: kit.name ?? 'default', assets: { ...kit.assets } };
  delete next.assets[key];
  return next;
}

export function saveKitFile(path, kit) {
  mkdirSync(dirname(path), { recursive: true });
  const body = {
    version: SCHEMA_VERSION,
    name:    kit.name ?? 'default',
    assets:  kit.assets ?? {},
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  return path;
}

export { SCHEMA_VERSION, LIMITS };
