// junction-analyzer.mjs — pure functions for computing the G1/G2/G3
// junction-quality telemetry that lands in render_report.json's
// `junctions[]` array. See skills/tighten/SKILL.md → "Crossfade & junction
// quality" for the gate definitions and schemas/render_report.v1.json for
// the field schema.
//
// Inputs:
//   - The rendered output's PCM (Int16Array, mono 48 kHz LE)
//   - The source PCM (Int16Array, mono 48 kHz LE), with cuts NOT applied
//   - The tighten plan's kept_segments (clip-relative ms) and basis_start_ms
//   - JUNCTION_XFADE_S
//
// Output: array of junction objects matching the JSON schema.
//
// G1 (sample-jump ratio, authoritative):
//   Compute jump_with_xfade: max |sample[i] - sample[i-1]| in ±2.5 ms
//     window around junction center in OUTPUT coords.
//   Compute jump_no_xfade: same scan over a synthesized 5 ms window —
//     2.5 ms of source K[i] tail followed by 2.5 ms of source K[i+1] head,
//     joined at the cut boundary.
//   kurtosis_no_xfade_narrow: excess kurtosis of the diff signal
//     s[i] - s[i-1] over that 5 ms window. Used by split-condition (b).
//     A click is a single-sample outlier in the diff signal → high
//     kurtosis. Speech harmonics produce smooth diffs → low kurtosis.
//     Amplitude-invariant (normalized by variance).
//   Status:
//     - jump_no_xfade < 200 int16          → "skipped_below_floor"
//     - else if kurtosis_narrow < 3.0      → "skipped_smooth_no_click"
//     - else ratio = jump_with_xfade / jump_no_xfade
//         ratio ≤ 0.5  → "pass"
//         ratio  > 0.5 → "fail"
//   ratio is null when status is skipped_*.
//
// G2 (spectral flatness, authoritative):
//   flatness_with_xfade_wide: 80 ms Hann-windowed 4096-pt FFT centered on
//     junction in OUTPUT coords.
//   flatness_no_xfade_wide: same but on synthesized 80 ms window from
//     source K[i] tail + K[i+1] head.
//   Status: "pass" if flatness_with_xfade_wide < 0.5, else "fail".
//
// G3 (RMS spike, informational):
//   Peak RMS in any sliding 40 ms window inside ±100 ms of junction in
//   OUTPUT vs RMS of full 200 ms baseline. Delta in dB.
//   Status: "pass" if rms_delta_db ≤ 6.0, else "informational_warning".
//   Adds "rms_intrinsic_amplitude_difference" to junction warnings on
//   informational_warning.

export const SR = 48000;
export const G1_HALF_MS = 2.5;          // ±2.5 ms = 5 ms total
export const G2_WINDOW_MS = 80;
export const G3_PEAK_MS = 40;
export const G3_BASELINE_MS = 200;
export const FFT_N = 4096;
export const G1_JUMP_FLOOR = 200;       // int16, ≈ -45 dB FS
export const G1_KURTOSIS_FLOOR = 3.0;   // excess kurtosis; standard "obvious outlier" level
export const G2_FLATNESS_GATE = 0.5;
export const G3_RMS_GATE_DB = 6.0;

// ----- FFT (in-place radix-2 Cooley-Tukey) -----

export function fft(real, imag) {
  const n = real.length;
  if (n & (n - 1)) throw new Error('FFT length must be power of 2');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = -2 * Math.PI / len;
    const wr0 = Math.cos(ang);
    const wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = real[i + k];
        const ai = imag[i + k];
        const br = real[i + k + half];
        const bi = imag[i + k + half];
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        real[i + k] = ar + tr;
        imag[i + k] = ai + ti;
        real[i + k + half] = ar - tr;
        imag[i + k + half] = ai - ti;
        const nr = cr * wr0 - ci * wi0;
        ci = cr * wi0 + ci * wr0;
        cr = nr;
      }
    }
  }
}

export function hann(n, total) {
  return 0.5 * (1 - Math.cos(2 * Math.PI * n / (total - 1)));
}

// Spectral flatness of a normalized window (samples in [-1, 1]).
// fftN must be ≥ samples.length. Power spectrum uses bins [1, fftN/2-1].
export function spectralFlatness(samples, fftN) {
  if (samples.length > fftN) throw new Error('samples longer than FFT');
  const real = new Float64Array(fftN);
  const imag = new Float64Array(fftN);
  const L = samples.length;
  for (let i = 0; i < L; i++) real[i] = samples[i] * hann(i, L);
  fft(real, imag);
  let logSum = 0, arithSum = 0, count = 0;
  for (let k = 1; k < fftN / 2; k++) {
    const p = real[k] * real[k] + imag[k] * imag[k] + 1e-20;
    logSum += Math.log(p);
    arithSum += p;
    count++;
  }
  return Math.exp(logSum / count) / (arithSum / count);
}

// ----- sample-level helpers (Int16Array PCM, mono) -----

export function rmsSamples(pcm, fromIdx, toIdx) {
  let s = 0, n = 0;
  const lo = Math.max(0, fromIdx | 0);
  const hi = Math.min(pcm.length, toIdx | 0);
  for (let i = lo; i < hi; i++) {
    const v = pcm[i] / 32768;
    s += v * v; n++;
  }
  return n === 0 ? 0 : Math.sqrt(s / n);
}

export function maxJump(pcm, fromIdx, toIdx) {
  let m = 0;
  const lo = Math.max(1, fromIdx | 0);
  const hi = Math.min(pcm.length, toIdx | 0);
  for (let i = lo; i < hi; i++) {
    const d = Math.abs(pcm[i] - pcm[i - 1]);
    if (d > m) m = d;
  }
  return m;
}

// Excess kurtosis of the diff signal s[i] - s[i-1] across a sample window.
// Used as G1 condition (b): a click is a single-sample outlier in diff
// space → high kurtosis. Smooth speech harmonics → low kurtosis.
// Normalized by variance → amplitude-invariant (survives denoising,
// speaker variation).
//
// Edge case: silent / near-constant window has variance ≈ 0 → return 0
// (no outliers possible). Such cases should already be skipped by the
// jump_no_xfade < 200 floor.
//
// Formula: excess_kurtosis = m4 / m2^2 - 3
//   where m2 = mean of (d - mean(d))^2 and m4 = mean of (d - mean(d))^4
//   d = diff signal. Excess kurtosis = 0 for Gaussian. Above ~3 is
//   commonly the "obvious outlier" threshold in statistical practice.
export function kurtosisOfDiff(samples) {
  if (samples.length < 3) return 0;
  // Build diff signal in Float64 for numerical accuracy across int16 jumps.
  const n = samples.length - 1;
  const d = new Float64Array(n);
  let dMean = 0;
  for (let i = 0; i < n; i++) {
    d[i] = samples[i + 1] - samples[i];
    dMean += d[i];
  }
  dMean /= n;

  let m2 = 0, m4 = 0;
  for (let i = 0; i < n; i++) {
    const x = d[i] - dMean;
    const x2 = x * x;
    m2 += x2;
    m4 += x2 * x2;
  }
  m2 /= n;
  m4 /= n;

  if (m2 < 1e-10) return 0;
  return m4 / (m2 * m2) - 3;
}

// Extract a normalized Float64 window from int16 PCM into a Float64Array.
function copyNormalized(pcm, fromIdx, toIdx) {
  const lo = Math.max(0, fromIdx | 0);
  const hi = Math.min(pcm.length, toIdx | 0);
  const out = new Float64Array(hi - lo);
  for (let i = lo; i < hi; i++) out[i - lo] = pcm[i] / 32768;
  return out;
}

// ----- synthesized no-xfade window -----

// Build a synthesized "no-xfade" window around a cut: half of the window
// drawn from the END of one source segment, half from the START of the
// next, joined at the boundary. The cut samples themselves are NOT in
// the window — they're removed.
//
// kTailEndSample: source PCM index ONE PAST the last sample of the kept
//                 segment ending at this junction (= cut-start sample).
// kHeadStartSample: source PCM index of the first sample of the next
//                   kept segment (= cut-end sample).
// halfSamples: half-window size.
//
// Returns Int16Array of length 2*halfSamples with the join at index halfSamples.
function buildNoXfadeWindow(sourcePcm, kTailEndSample, kHeadStartSample, halfSamples) {
  const out = new Int16Array(halfSamples * 2);
  // First half: samples [kTailEndSample - halfSamples, kTailEndSample)
  for (let i = 0; i < halfSamples; i++) {
    const idx = kTailEndSample - halfSamples + i;
    out[i] = (idx >= 0 && idx < sourcePcm.length) ? sourcePcm[idx] : 0;
  }
  // Second half: samples [kHeadStartSample, kHeadStartSample + halfSamples)
  for (let i = 0; i < halfSamples; i++) {
    const idx = kHeadStartSample + i;
    out[halfSamples + i] = (idx >= 0 && idx < sourcePcm.length) ? sourcePcm[idx] : 0;
  }
  return out;
}

// ----- main entry -----

/**
 * @param {object} args
 * @param {Int16Array} args.outputPcm    rendered output's mono 48kHz PCM
 * @param {Int16Array} args.sourcePcm    source mono 48kHz PCM (pre-cut, with -ss applied)
 * @param {number}     args.basisStartMs (= tighten_plan.basis_start_ms)
 * @param {Array}      args.keptSegments tighten_plan.kept_segments (clip-relative ms)
 * @param {number}     args.xfadeS       JUNCTION_XFADE_S
 * @returns {Array<object>}              junction telemetry per schema
 */
export function computeJunctionMetrics({ outputPcm, sourcePcm, basisStartMs, keptSegments, xfadeS }) {
  const D = xfadeS;
  const halfNarrow = Math.round(G1_HALF_MS / 1000 * SR);     // 120 samples @ 48k
  const halfWide   = Math.round(G2_WINDOW_MS / 2 / 1000 * SR); // 1920 samples
  const halfPeak   = Math.round(G3_PEAK_MS / 2 / 1000 * SR);   // 960 samples
  const halfBase   = Math.round(G3_BASELINE_MS / 2 / 1000 * SR); // 4800 samples

  const N = keptSegments.length;
  const junctions = [];

  // Running sum of kept durations to compute junction centers in output coords:
  //   junction_i_center_out_ms = Σ K[0..i].duration - (i + 0.5) * D * 1000
  let cumOutMs = 0;
  for (let i = 0; i < N - 1; i++) {
    const Ki = keptSegments[i];
    cumOutMs += (Ki.end_ms - Ki.start_ms);
    const junctionCenterOutMs = cumOutMs - (i + 0.5) * D * 1000;
    const junctionCenterOutSample = Math.round(junctionCenterOutMs / 1000 * SR);

    // Source PCM indices at the cut boundary. Source PCM is decoded from the
    // source's audio stream after the renderer's -ss seek, so source-PCM
    // index 0 corresponds to basis_start_ms. Clip-relative ms maps directly.
    const kTailEndSample = Math.round(Ki.end_ms / 1000 * SR);
    const kHeadStartSample = Math.round(keptSegments[i + 1].start_ms / 1000 * SR);

    // ----- G1 -----
    const jumpWith = maxJump(outputPcm,
                              junctionCenterOutSample - halfNarrow,
                              junctionCenterOutSample + halfNarrow);
    const noXfadeNarrow = buildNoXfadeWindow(sourcePcm, kTailEndSample, kHeadStartSample, halfNarrow);
    const jumpNo = maxJump(noXfadeNarrow, 0, noXfadeNarrow.length);
    const kurtosisNarrow = kurtosisOfDiff(noXfadeNarrow);

    let g1Status, g1Ratio;
    if (jumpNo < G1_JUMP_FLOOR) {
      g1Status = 'skipped_below_floor';
      g1Ratio = null;
    } else if (kurtosisNarrow < G1_KURTOSIS_FLOOR) {
      g1Status = 'skipped_smooth_no_click';
      g1Ratio = null;
    } else {
      g1Ratio = jumpWith / jumpNo;
      g1Status = (g1Ratio <= 0.5) ? 'pass' : 'fail';
    }

    // ----- G2 -----
    const wideOut = copyNormalized(outputPcm,
                                    junctionCenterOutSample - halfWide,
                                    junctionCenterOutSample + halfWide);
    const flatnessWide = spectralFlatness(wideOut, FFT_N);

    const noXfadeWide = buildNoXfadeWindow(sourcePcm, kTailEndSample, kHeadStartSample, halfWide);
    const noXfadeWideNorm = new Float64Array(noXfadeWide.length);
    for (let j = 0; j < noXfadeWide.length; j++) noXfadeWideNorm[j] = noXfadeWide[j] / 32768;
    const flatnessNoXfadeWide = spectralFlatness(noXfadeWideNorm, FFT_N);

    const g2Status = (flatnessWide < G2_FLATNESS_GATE) ? 'pass' : 'fail';

    // ----- G3 (informational) -----
    const baselineRms = rmsSamples(outputPcm,
                                    junctionCenterOutSample - halfBase,
                                    junctionCenterOutSample + halfBase);
    let peakRms = 0;
    const slideStep = Math.round(SR * 0.001); // 1 ms step
    for (let s = junctionCenterOutSample - halfBase; s + 2 * halfPeak <= junctionCenterOutSample + halfBase; s += slideStep) {
      const r = rmsSamples(outputPcm, s, s + 2 * halfPeak);
      if (r > peakRms) peakRms = r;
    }
    const g3Db = 20 * Math.log10(peakRms / (baselineRms + 1e-12));
    const g3Status = (g3Db <= G3_RMS_GATE_DB) ? 'pass' : 'informational_warning';

    // ----- warnings codes -----
    const jWarnings = [];
    if (g3Status === 'informational_warning')  jWarnings.push('rms_intrinsic_amplitude_difference');
    if (g1Status === 'skipped_below_floor')    jWarnings.push('junction_below_click_floor');
    if (g1Status === 'skipped_smooth_no_click') jWarnings.push('junction_smooth_no_click');

    junctions.push({
      index: i,
      time_ms: +junctionCenterOutMs.toFixed(3),
      g1: {
        ratio: g1Ratio == null ? null : +g1Ratio.toFixed(4),
        jump_with_xfade: jumpWith,
        jump_no_xfade: jumpNo,
        kurtosis_no_xfade_narrow: +kurtosisNarrow.toFixed(3),
        status: g1Status,
      },
      g2: {
        flatness_with_xfade_wide: +flatnessWide.toFixed(4),
        flatness_no_xfade_wide:   +flatnessNoXfadeWide.toFixed(4),
        status: g2Status,
      },
      g3: {
        rms_delta_db: +g3Db.toFixed(2),
        status: g3Status,
      },
      warnings: jWarnings,
    });
  }

  return junctions;
}
