// tighten-splice.mjs — invariant validation + ffmpeg filter_complex graph
// construction for the tighten-render integration.
//
// Two responsibilities:
//
//   1. assertPlanInvariants(plan)
//      Throws Error with message "render: invariant violation I<n> — <msg>"
//      on the first violation, per the SKILL.md "Plan invariants" contract.
//      Used by cf-ffmpeg render() on plan load.
//
//   2. buildSpliceGraph({ plan, cropFilterArg, captionsPath, hasAudio })
//      Returns { filterComplex, mapVideo, mapAudio, padDurS, junctionCount }
//      describing the splice graph for a multi-segment plan. Shape:
//        - Video: [0:v] crop+scale → split=N → N × trim+setpts → concat → (optional) ass overlay → [vout]
//        - Audio: [0:a] asplit=N → N × atrim+asetpts → N-1 chained acrossfades → apad → [aout]
//      For N=1 kept segment, returns a degenerate graph (no splice) — the
//      renderer will instead use the single-chain path.
//
// JUNCTION_XFADE_S is the single source of truth for audio crossfade
// duration. Bumping it to 0.012 if the spectral-flatness assertion fails
// on the fixture is a one-line edit.

// 0.008 s validated by Phase A R4b on real Indonesian speech (Mata Najwa
// supercut, hand-crafted 3-cut plan). Junction-quality measurements:
//   J0 (speech-tail "Pak?" → speech-onset "Rokok,"):
//        sample-jump fade=16 vs hard=656 int16  → 41× attenuation
//   J1 (speech-tail "bisa." → silence):
//        sample-jump fade=1760 vs hard=1632 int16 → ratio 1.08 (no real
//        click to kill; xfade-jump ≈ natural speech tail amplitude)
//   J2 (silence → silence):
//        sample-jump fade=111 vs hard=2593 int16 → 23× attenuation
//   Spectral flatness at all three junctions: 0.0000 (well under 0.5).
// Do NOT bump without re-running tests/integration/tighten-junction-quality
// (Phase B) on a real speech fixture and confirming both authoritative gates
// (G1 sample-jump ratio + G2 spectral flatness) still pass on J0 and J2.
// G1 may legitimately exceed 0.5 at speech-to-silence junctions; see the
// SKILL.md "junction_below_click_floor" exclusion and the J1 finding above.
// 20 ms is the absolute ceiling — past 20 ms the crossfade smears /t/ /k/
// /p/ attacks audibly.
export const JUNCTION_XFADE_S = 0.008;

const INVARIANT_PREFIX = 'render: invariant violation';

export function assertPlanInvariants(plan) {
  const dur = plan.source_duration_ms;
  const basis = plan.basis_start_ms;
  const cuts = plan.cuts || [];
  const kept = plan.kept_segments || [];

  if (typeof dur !== 'number' || dur < 0) {
    throw new Error(`${INVARIANT_PREFIX} I1 — source_duration_ms invalid: ${dur}`);
  }

  // I1 — range bounds for every cut and every kept segment.
  for (const arr of [{ list: cuts, name: 'cut' }, { list: kept, name: 'kept_segment' }]) {
    for (let i = 0; i < arr.list.length; i++) {
      const it = arr.list[i];
      if (!(it.start_ms >= 0 && it.start_ms <= it.end_ms && it.end_ms <= dur)) {
        throw new Error(
          `${INVARIANT_PREFIX} I1 — ${arr.name}[${i}] out of range: ` +
          `start=${it.start_ms} end=${it.end_ms} source_duration=${dur}`
        );
      }
    }
  }

  // I2 — cuts sorted ascending by start_ms, non-overlapping.
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i - 1].end_ms > cuts[i].start_ms) {
      throw new Error(
        `${INVARIANT_PREFIX} I2 — cuts overlap or unsorted at index ${i}: ` +
        `prev.end=${cuts[i - 1].end_ms} > next.start=${cuts[i].start_ms}`
      );
    }
  }

  // I3 — kept == complement(cuts) over [0, source_duration_ms].
  const expectedKept = complementOf(cuts, dur);
  if (kept.length !== expectedKept.length) {
    throw new Error(
      `${INVARIANT_PREFIX} I3 — kept_segments count mismatch: got ${kept.length}, ` +
      `complement(cuts) yields ${expectedKept.length}`
    );
  }
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].start_ms !== expectedKept[i].start_ms || kept[i].end_ms !== expectedKept[i].end_ms) {
      throw new Error(
        `${INVARIANT_PREFIX} I3 — kept_segments[${i}] does not complement cuts: ` +
        `got [${kept[i].start_ms}, ${kept[i].end_ms}], expected ` +
        `[${expectedKept[i].start_ms}, ${expectedKept[i].end_ms}]`
      );
    }
  }

  // I4 — duration consistency.
  const sumCuts = cuts.reduce((a, c) => a + (c.end_ms - c.start_ms), 0);
  if (plan.saved_ms !== sumCuts) {
    throw new Error(
      `${INVARIANT_PREFIX} I4 — saved_ms mismatch: plan.saved_ms=${plan.saved_ms}, Σ(cuts)=${sumCuts}`
    );
  }
  const sumKept = kept.reduce((a, k) => a + (k.end_ms - k.start_ms), 0);
  if (plan.output_duration_ms !== sumKept) {
    throw new Error(
      `${INVARIANT_PREFIX} I4 — output_duration_ms mismatch: plan.output_duration_ms=${plan.output_duration_ms}, Σ(kept)=${sumKept}`
    );
  }
  if (plan.output_duration_ms !== dur - sumCuts) {
    throw new Error(
      `${INVARIANT_PREFIX} I4 — output_duration_ms != source - saved: ` +
      `${plan.output_duration_ms} != ${dur} - ${sumCuts}`
    );
  }

  // I5 — coordinate parity. Skip silently for legacy plans (v0.3.0-pre)
  // that lack source_*_ms fields; renderer can still operate on clip-relative.
  // For plans that DO carry the fields, assert parity.
  for (const arr of [{ list: cuts, name: 'cut' }, { list: kept, name: 'kept_segment' }]) {
    for (let i = 0; i < arr.list.length; i++) {
      const it = arr.list[i];
      if (typeof it.source_start_ms !== 'number' && typeof it.source_end_ms !== 'number') continue;
      const expS = basis + it.start_ms;
      const expE = basis + it.end_ms;
      if (it.source_start_ms !== expS || it.source_end_ms !== expE) {
        throw new Error(
          `${INVARIANT_PREFIX} I5 — ${arr.name}[${i}] source/clip-relative parity: ` +
          `got source=[${it.source_start_ms}, ${it.source_end_ms}], ` +
          `expected basis+rel=[${expS}, ${expE}]`
        );
      }
    }
  }

  return { ok: true };
}

function complementOf(cuts, dur) {
  if (cuts.length === 0) return [{ start_ms: 0, end_ms: dur }];
  const kept = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start_ms > cursor) kept.push({ start_ms: cursor, end_ms: c.start_ms });
    cursor = Math.max(cursor, c.end_ms);
  }
  if (cursor < dur) kept.push({ start_ms: cursor, end_ms: dur });
  return kept;
}

// ----- splice graph -----

/**
 * Build the splice graphs (video and audio) for a tighten plan. Returns
 * the chains split so the renderer can invoke them as two separate
 * ffmpeg passes — see the videoGraph / audioGraph fields. The combined
 * filterComplex is also returned (single-pass), but cf-ffmpeg's render
 * uses two-pass to work around an ffmpeg bug where the AAC encoder drops
 * trailing audio frames when both streams are encoded in one invocation
 * and video EOFs slightly before audio. Two-pass: encode audio to temp
 * .m4a, then encode video + mux with -c:a copy.
 *
 * @param {object} args
 * @param {object} args.plan          parsed tighten_plan.json
 * @param {string} args.cropFilterArg crop+scale filter chain e.g. 'crop=360:640:140:0,scale=1080:1920'
 * @param {string|null} args.captionsPath path to .ass captions, or null
 * @param {boolean} args.hasAudio     whether the source has an audio stream
 * @returns {{filterComplex:string, videoGraph:string, audioGraph:string|null, mapVideo:string, mapAudio:string|null, padDurS:number, junctionCount:number, keptCount:number}}
 */
export function buildSpliceGraph({ plan, cropFilterArg, captionsPath, hasAudio }) {
  const kept = plan.kept_segments || [];
  const N = kept.length;
  if (N === 0) {
    throw new Error('buildSpliceGraph: plan has zero kept_segments — nothing to render');
  }

  // ----- video chain -----
  const videoParts = [];
  videoParts.push(`[0:v]${cropFilterArg}[vc]`);
  if (N === 1) {
    const s = secStr(kept[0].start_ms);
    const e = secStr(kept[0].end_ms);
    videoParts.push(`[vc]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[vconcat]`);
  } else {
    videoParts.push(`[vc]split=${N}${rangeLabels('vc', N, '_')}`);
    for (let i = 0; i < N; i++) {
      const s = secStr(kept[i].start_ms);
      const e = secStr(kept[i].end_ms);
      videoParts.push(`[vc_${i}]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    }
    videoParts.push(`${rangeLabels('v', N)}concat=n=${N}:v=1:a=0[vconcat]`);
  }
  if (captionsPath) {
    const ascii = escapeAssPath(captionsPath);
    videoParts.push(`[vconcat]ass='${ascii}'[vout]`);
  } else {
    videoParts.push(`[vconcat]null[vout]`);
  }
  const mapVideo = '[vout]';
  const videoGraph = videoParts.join(';');

  // ----- audio chain -----
  let mapAudio = null;
  let padDurS = 0;
  let audioGraph = null;
  const junctionCount = Math.max(0, N - 1);

  if (hasAudio) {
    const audioParts = [];
    if (N === 1) {
      const s = secStr(kept[0].start_ms);
      const e = secStr(kept[0].end_ms);
      audioParts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[aout]`);
    } else {
      audioParts.push(`[0:a]asplit=${N}${rangeLabels('ac', N, '_')}`);
      for (let i = 0; i < N; i++) {
        const s = secStr(kept[i].start_ms);
        const e = secStr(kept[i].end_ms);
        audioParts.push(`[ac_${i}]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
      }
      // Chain N-1 acrossfades left-to-right. Each acrossfade overlaps the
      // pair by JUNCTION_XFADE_S, so total audio length is
      //   Σ kept - (N-1) × JUNCTION_XFADE_S
      // We compensate with apad below (Option A — silence pad is invisible).
      let prev = '[a0]';
      for (let i = 1; i < N; i++) {
        const next = i === N - 1 ? '[amix]' : `[afx${i}]`;
        audioParts.push(`${prev}[a${i}]acrossfade=d=${JUNCTION_XFADE_S}${next}`);
        prev = next;
      }
      // TODO(v0.3.0 caption integration) — apad shifts the audio tail by
      // (N-1) * JUNCTION_XFADE_S seconds. Caption .ass files generated by
      // the caption-stylist against the tightened timeline assume zero
      // audio-tail drift; if caption sync ends up off by ≈ N*8ms on long
      // clips with many junctions, this is the cause. Mirrored in
      // docs/PLAN-v0.3.0.md → "Cross-cutting concerns".
      padDurS = junctionCount * JUNCTION_XFADE_S;
      audioParts.push(`[amix]apad=pad_dur=${padDurS.toFixed(3)}[aout]`);
    }
    mapAudio = '[aout]';
    audioGraph = audioParts.join(';');
  }

  const filterComplex = (audioGraph ? videoGraph + ';' + audioGraph : videoGraph);
  return { filterComplex, videoGraph, audioGraph, mapVideo, mapAudio, padDurS, junctionCount, keptCount: N };
}

function secStr(ms) {
  return (ms / 1000).toFixed(3);
}

function rangeLabels(prefix, n, infix = '') {
  let out = '';
  for (let i = 0; i < n; i++) out += `[${prefix}${infix}${i}]`;
  return out;
}

function escapeAssPath(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
