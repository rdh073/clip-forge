// budget.mjs — cumulative AI-spend tracker shared by every paid-skill chain.
//
// State lives in ./renders/<slug>/render_manifest.json under .ai_costs. The
// shape is the minimum-viable form for v0.4.0 pillar 2:
//
//   {
//     "ai_costs": {
//       "cumulative_usd": 0.42,
//       "budget_cap_usd": 10.00,
//       "breakdown":   { "elevenlabs_tts": 0.30, "groq_translate": 0.01 },
//       "skipped":     [],
//       "history":     [
//         { "ts": "...", "provider": "elevenlabs", "kind": "tts",
//           "delta_usd": 0.05, "clip_id": "c01" }
//       ]
//     }
//   }
//
// Pillar 4 (cf-edit) extends render_manifest.json with content-hash diff
// fields; that's purely additive on top of this shape.
//
// Threshold behaviour per §7 Q4:
//   - 80 % checkpoint → caller asks the user to raise the cap (AskUserQuestion)
//   - 100 % hard-stop → caller refuses further paid calls, emits skipped[]
//   - --yolo silent skip at 100 % (no prompt)
//
// This module owns ONLY the arithmetic + persistence. The interactive
// AskUserQuestion gate lives in the dub/voice-clone skill markdown.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_BUDGET_USD = 10.00;

function parseBudgetEnv() {
  const raw = process.env.CF_AI_BUDGET_USD;
  if (!raw) return DEFAULT_BUDGET_USD;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BUDGET_USD;
}

function emptyAiCosts(cap) {
  return {
    cumulative_usd: 0,
    budget_cap_usd: cap,
    breakdown:      {},
    skipped:        [],
    history:        [],
  };
}

function emptyManifest(slug, cap) {
  return {
    version:     1,
    schema:      'render_manifest.v1',
    slug:        slug || null,
    created_at:  new Date().toISOString(),
    ai_costs:    emptyAiCosts(cap),
  };
}

export function loadManifest(path, { slug, cap } = {}) {
  const budgetCap = cap != null ? cap : parseBudgetEnv();
  if (!path || !existsSync(path)) {
    return emptyManifest(slug, budgetCap);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return emptyManifest(slug, budgetCap); }
  if (!raw || typeof raw !== 'object') return emptyManifest(slug, budgetCap);
  // Normalize / migrate older manifests that don't carry ai_costs yet.
  if (!raw.ai_costs || typeof raw.ai_costs !== 'object') {
    raw.ai_costs = emptyAiCosts(budgetCap);
  } else {
    if (typeof raw.ai_costs.cumulative_usd !== 'number') raw.ai_costs.cumulative_usd = 0;
    if (typeof raw.ai_costs.budget_cap_usd !== 'number') raw.ai_costs.budget_cap_usd = budgetCap;
    if (!raw.ai_costs.breakdown || typeof raw.ai_costs.breakdown !== 'object') raw.ai_costs.breakdown = {};
    if (!Array.isArray(raw.ai_costs.skipped))                                    raw.ai_costs.skipped   = [];
    if (!Array.isArray(raw.ai_costs.history))                                    raw.ai_costs.history   = [];
  }
  if (!raw.slug && slug) raw.slug = slug;
  return raw;
}

export function saveManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return path;
}

/**
 * Compute the budget state BEFORE charging `delta_usd`.
 * Returns:
 *   { allowed: bool, would_exceed: bool, checkpoint_hit: bool,
 *     used_pct_before, used_pct_after, remaining_usd }
 *
 * `checkpoint_hit` flips true when crossing the 80 % line — caller fires
 * the AskUserQuestion gate. `allowed:false` means hard-stop.
 *
 * Pure-logic — no manifest write, no env reads beyond loadManifest's
 * initial parse.
 */
export function projectCharge(manifest, deltaUsd) {
  const cap     = manifest.ai_costs.budget_cap_usd;
  const before  = manifest.ai_costs.cumulative_usd;
  const after   = before + Math.max(0, deltaUsd);
  const usedBefore = cap > 0 ? (before / cap) * 100 : 0;
  const usedAfter  = cap > 0 ? (after  / cap) * 100 : 0;
  return {
    allowed:        after <= cap,
    would_exceed:   after > cap,
    checkpoint_hit: usedBefore < 80 && usedAfter >= 80,
    used_pct_before: +usedBefore.toFixed(2),
    used_pct_after:  +usedAfter.toFixed(2),
    remaining_usd:   +(cap - before).toFixed(4),
  };
}

/**
 * Record a successful charge. Mutates manifest.ai_costs in place; caller
 * persists with saveManifest().
 */
export function recordCharge(manifest, { provider, kind, delta_usd, clip_id, lang }) {
  const ac = manifest.ai_costs;
  ac.cumulative_usd = +(ac.cumulative_usd + Math.max(0, delta_usd)).toFixed(6);
  const breakdownKey = (provider || 'unknown') + '_' + (kind || 'misc');
  ac.breakdown[breakdownKey] = +(((ac.breakdown[breakdownKey] || 0) + Math.max(0, delta_usd))).toFixed(6);
  ac.history.push({
    ts:       new Date().toISOString(),
    provider: provider || null,
    kind:     kind || null,
    delta_usd: +Math.max(0, delta_usd).toFixed(6),
    clip_id:  clip_id || null,
    lang:     lang || null,
  });
  return manifest;
}

/**
 * Record a skipped clip due to budget exhaustion. Mutates manifest.ai_costs.
 */
export function recordSkip(manifest, { clip_id, lang, reason }) {
  manifest.ai_costs.skipped.push({
    clip_id: clip_id || null,
    lang:    lang || null,
    reason:  reason || 'budget_exhausted',
    ts:      new Date().toISOString(),
  });
  return manifest;
}

/**
 * Raise the cap mid-pipeline (the user accepted the 80 % checkpoint).
 */
export function raiseCap(manifest, newCapUsd) {
  if (Number.isFinite(newCapUsd) && newCapUsd > manifest.ai_costs.budget_cap_usd) {
    manifest.ai_costs.budget_cap_usd = +newCapUsd.toFixed(4);
  }
  return manifest;
}

export function snapshotForReport(manifest) {
  const ac = manifest.ai_costs;
  const cap = ac.budget_cap_usd;
  const pct = cap > 0 ? (ac.cumulative_usd / cap) * 100 : 0;
  return {
    total_usd:         +ac.cumulative_usd.toFixed(6),
    breakdown:         { ...ac.breakdown },
    budget_cap_usd:    cap,
    budget_used_pct:   +pct.toFixed(2),
    budget_exhausted:  ac.cumulative_usd >= cap,
    skipped_clips:     ac.skipped.slice(),
  };
}
