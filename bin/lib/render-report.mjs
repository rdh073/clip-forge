// render-report.mjs — builds render_report.json, validates it against the
// committed JSON Schema (schemas/render_report.v1.json), and writes it to
// disk. Used by bin/cf-ffmpeg render.
//
// Why a hand-rolled validator instead of ajv: zero new runtime deps, and
// the subset of JSON Schema we use is small (type/const/enum/required/
// additionalProperties/properties/items/minimum/maximum). The committed
// schema file is still the canonical contract and validates externally
// with any draft-07-compliant validator (npx ajv-cli for review).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const PLUGIN_ROOT = resolvePath(__dirname, '..', '..');
const SCHEMA_PATH = join(PLUGIN_ROOT, 'schemas', 'render_report.v1.json');

let _cachedSchema = null;
function loadSchema() {
  if (!_cachedSchema) _cachedSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  return _cachedSchema;
}

/**
 * Validate a value against a JSON Schema (draft-07 subset).
 * Returns { ok: true } or throws Error with message
 *   "render: report schema violation — <path>: <reason>"
 * matching the SKILL.md spec.
 */
export function validateAgainstSchema(value, schema, path = '$') {
  const errs = [];
  validate(value, schema, path, errs);
  if (errs.length > 0) {
    const first = errs[0];
    const err = new Error('render: report schema violation — ' + first.path + ': ' + first.reason);
    err.violations = errs;
    throw err;
  }
  return { ok: true };
}

function validate(value, schema, path, errs) {
  // const
  if ('const' in schema) {
    if (value !== schema.const) {
      errs.push({ path, reason: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
      return;
    }
  }
  // enum
  if ('enum' in schema) {
    if (!schema.enum.includes(value)) {
      errs.push({ path, reason: `expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}` });
      return;
    }
  }
  // type
  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.some((t) => typeMatches(value, t, actual))) {
      errs.push({ path, reason: `expected type ${JSON.stringify(types)}, got ${actual}` });
      return;
    }
  }
  // minimum / maximum
  if (typeof value === 'number') {
    if ('minimum' in schema && value < schema.minimum) {
      errs.push({ path, reason: `value ${value} below minimum ${schema.minimum}` });
    }
    if ('maximum' in schema && value > schema.maximum) {
      errs.push({ path, reason: `value ${value} above maximum ${schema.maximum}` });
    }
  }
  // object
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) {
          errs.push({ path, reason: `missing required key '${key}'` });
        }
      }
    }
    if (schema.properties) {
      for (const key of Object.keys(value)) {
        if (key in schema.properties) {
          validate(value[key], schema.properties[key], path + '.' + key, errs);
        } else if (schema.additionalProperties === false) {
          errs.push({ path, reason: `additional property '${key}' not allowed` });
        }
      }
    }
  }
  // array
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      validate(value[i], schema.items, path + '[' + i + ']', errs);
    }
  }
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function typeMatches(value, declared, actual) {
  if (declared === 'integer') return Number.isInteger(value);
  if (declared === actual) return true;
  if (declared === 'number' && actual === 'number') return true;
  return false;
}

/**
 * Build the render_report.json object from raw inputs. Caller is
 * responsible for ensuring all numbers are finite + integer fields are
 * integers; the validator will catch any miss.
 *
 * @param {object} input
 * @returns {object} render report v1
 */
export function buildRenderReport(input) {
  const {
    clipId, renderMode, inputDurationMs, outputDurationMs, audioDurationMs,
    encoder, deterministic, passes, filterComplexBytes, junctionXfadeS,
    tighten, junctions, warnings,
    targetAspect, overlays, sidecars,
    aiCosts, ttsProviderUsed, ttsNondeterministic, dubLanguages,
    brandKit, rerender, llm,
    stingers, brollAi, splitScreen,
  } = input;

  // Sign convention: av_drift_ms = video − audio (output is video post-concat;
  // concat doesn't lose duration). Mode-aware interpretation lives in SKILL.md
  // and the caller emits warnings accordingly.
  const avDriftMs = +(outputDurationMs - audioDurationMs).toFixed(3);

  return {
    schema: 'render_report.v1',
    version: 1,
    render_mode: renderMode,
    clip_id: clipId ?? null,
    input_duration_ms: round3(inputDurationMs),
    output_duration_ms: round3(outputDurationMs),
    audio_duration_ms: round3(audioDurationMs),
    av_drift_ms: avDriftMs,
    encoder: String(encoder),
    deterministic: !!deterministic,
    passes: (passes || []).map((p) => ({
      name: String(p.name),
      wall_ms: Math.round(p.wall_ms),
    })),
    filter_complex_bytes: filterComplexBytes | 0,
    junction_xfade_s: junctionXfadeS,
    tighten: tighten || null,
    junctions: junctions || [],
    warnings: warnings || [],
    target_aspect: targetAspect ?? null,
    overlays: overlays ?? null,
    sidecars: sidecars ?? null,
    ai_costs: aiCosts ?? null,
    tts_provider_used: ttsProviderUsed ?? null,
    tts_nondeterministic: !!ttsNondeterministic,
    dub_languages: Array.isArray(dubLanguages) ? dubLanguages.slice() : [],
    brand_kit: brandKit ?? null,
    rerender: rerender ?? null,
    llm: llm ?? null,
    stingers: stingers ?? null,
    broll_ai: brollAi ?? null,
    split_screen: splitScreen ?? null,
  };
}

function round3(n) { return Math.round((n + Number.EPSILON) * 1000) / 1000; }

/**
 * Validate report against schema, then write to disk.
 * Throws on validation failure (caller catches → exit non-zero).
 */
export function writeRenderReport(report, path) {
  validateAgainstSchema(report, loadSchema());
  mkdirSync(dirname(resolvePath(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}

export { loadSchema, SCHEMA_PATH };
