// overlay-builder.mjs — pure builders for the v0.3.0 pillar (i) overlays.
//
// Three concerns colocate here because they share the same canvas-geometry
// + ASS-escaping rules and ship together as one slice:
//
//   1. Hook overlay (ASS layer 5) — big bold text in upper third for the
//      first ≤ 2 s of the clip. Burned via libass; relies on system fallback
//      font (Liberation Sans on Linux, Helvetica on macOS) per the Q3
//      decision in docs/PLAN-v0.3.0.md §7.
//   2. Progress bar (ffmpeg drawbox filter) — bottom or top of canvas,
//      grows linearly from 0 % to 100 % over the clip duration. Composed
//      BEFORE the captions burn so captions render over the bar.
//   3. Emoji + highlight inside the caption ASS body — captions.json
//      already carries the metadata; this lib produces the burn-ready
//      ASS dialogue lines.
//
// Plus a small geometry helper:
//
//   4. chooseAspectCanvas — maps "9:16" / "1:1" / "4:5" → {w, h, name},
//      with a soft fallback (and `unknown_aspect` warning) for anything
//      else. Default (undefined / null) → 9:16 with no warning.
//
// Idempotency contract: all four functions are pure — same inputs in →
// byte-identical strings out. No Date.now(), no Math.random(), no
// process.env reads. Tested via overlay-builder.test.mjs.

const ASPECT_TABLE = {
  '9:16': { w: 1080, h: 1920 },
  '1:1':  { w: 1080, h: 1080 },
  '4:5':  { w: 1080, h: 1350 },
};

/**
 * Map a target_aspect string to canvas dimensions.
 *
 *   chooseAspectCanvas(undefined)  → {w:1080, h:1920, name:'9:16', warning:null}
 *   chooseAspectCanvas('9:16')     → {w:1080, h:1920, name:'9:16', warning:null}
 *   chooseAspectCanvas('1:1')      → {w:1080, h:1080, name:'1:1',  warning:null}
 *   chooseAspectCanvas('4:5')      → {w:1080, h:1350, name:'4:5',  warning:null}
 *   chooseAspectCanvas('5:4')      → {w:1080, h:1920, name:'9:16', warning:{code:'unknown_aspect', message:'...'}}
 *
 * @param {string|null|undefined} targetAspect
 * @returns {{w:number, h:number, name:string, warning: object|null}}
 */
export function chooseAspectCanvas(targetAspect) {
  if (targetAspect === undefined || targetAspect === null || targetAspect === '') {
    return { w: 1080, h: 1920, name: '9:16', warning: null };
  }
  const entry = ASPECT_TABLE[targetAspect];
  if (entry) {
    return { w: entry.w, h: entry.h, name: targetAspect, warning: null };
  }
  return {
    w: 1080, h: 1920, name: '9:16',
    warning: {
      code: 'unknown_aspect',
      message: 'target_aspect "' + targetAspect + '" not recognised — falling back to 9:16. Known values: 9:16, 1:1, 4:5.',
    },
  };
}

// ----- ASS helpers (shared with cf-caption-burn) -----

function msToAss(ms) {
  const m = Math.max(0, Math.floor(ms));
  const cs = Math.floor(m / 10) % 100;
  const s  = Math.floor(m / 1000) % 60;
  const min = Math.floor(m / 60000) % 60;
  const h  = Math.floor(m / 3600000);
  return h + ':' + String(min).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

function hexToAss(hex) {
  // ASS uses &HBBGGRR& byte order.
  const h = String(hex || '#ffffff').replace('#', '').padStart(6, '0').toLowerCase();
  return '&H00' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2) + '&';
}

function escapeAssText(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/\n/g, '\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

// ----- 1. Hook overlay -----

/**
 * Word-wrap a string at a max char count by inserting hard newlines on
 * space boundaries. Words longer than maxChars are left intact (no
 * mid-word break — ASS would render the break literally).
 */
function wrapAtMaxChars(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return { text: '', wrapped: false };
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line.length === 0) { line = w; continue; }
    if (line.length + 1 + w.length > maxChars) {
      lines.push(line);
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line) lines.push(line);
  return { text: lines.join('\n'), wrapped: lines.length > 1 };
}

/**
 * Build an ASS style block + dialogue line that draws the hook text on
 * layer 5 (above captions, which use layer 0).
 *
 * Position "upper-third" → alignment 8 (top center), MarginV computed
 * from canvasH so the text sits at ~y = canvasH/3. Position "center" →
 * alignment 5 (middle center), MarginV = 0.
 *
 * Returns `{ass, warnings}` where `ass` is the concatenation of a
 * "Style: Hook,…" line + "Dialogue: 5,…" line, ready to splice into a
 * captions.ass file (the caller is responsible for ensuring the Style
 * Format header is present).
 *
 * @param {object} opts
 * @param {string} opts.text                 Hook text (verbatim).
 * @param {number} opts.end_ms               Overlay disappears at this clip-relative ms.
 * @param {string} [opts.position]           'upper-third' | 'center' (default 'upper-third').
 * @param {number} [opts.fontSize]           Font size px (default 88).
 * @param {string} [opts.fillPrimary]        Hex color (default '#ffffff').
 * @param {string} [opts.strokeColor]        Hex color (default '#000000').
 * @param {number} [opts.strokePx]           Outline width px (default 6).
 * @param {number} [opts.shadow]             Shadow px (default 2).
 * @param {number} [opts.safeAreaPx]         Min distance from canvas edges (default 80).
 * @param {number} [opts.maxChars]           Wrap threshold (default 36).
 * @param {number} [opts.canvasW]            Canvas width (default 1080).
 * @param {number} [opts.canvasH]            Canvas height (default 1920).
 * @returns {{ass: string, warnings: Array<{code: string, message: string}>}}
 */
export function buildHookOverlayAss(opts) {
  const text       = String(opts.text ?? '');
  const endMs      = Math.max(0, Math.floor(opts.end_ms ?? 1800));
  const position   = opts.position === 'center' ? 'center' : 'upper-third';
  const fontSize   = opts.fontSize   ?? 88;
  const fillPrim   = opts.fillPrimary ?? '#ffffff';
  const strokeCol  = opts.strokeColor ?? '#000000';
  const strokePx   = opts.strokePx   ?? 6;
  const shadow     = opts.shadow     ?? 2;
  const safeArea   = opts.safeAreaPx ?? 80;
  const maxChars   = opts.maxChars   ?? 36;
  const canvasH    = opts.canvasH    ?? 1920;

  const warnings = [];
  if (!text) {
    return { ass: '', warnings };
  }

  const { text: wrapped, wrapped: didWrap } = wrapAtMaxChars(text, maxChars);
  if (didWrap) {
    warnings.push({
      code: 'hook_overlay_wrapped',
      message: 'hook text exceeded ' + maxChars + ' chars per line, word-wrapped.',
    });
  }

  // ASS alignment numpad: 7=topleft 8=topcenter 9=topright; 4/5/6 mid; 1/2/3 bottom.
  // For "upper-third" we put the anchor at top-center (8) with MarginV
  // = canvasH/3 - safeArea, clamped so the line sits in [safeArea, canvasH-safeArea].
  let alignment, marginV;
  if (position === 'upper-third') {
    alignment = 8;
    marginV = Math.max(safeArea, Math.floor(canvasH / 3) - safeArea);
  } else {
    alignment = 5;
    marginV = 0;
  }

  const styleLine =
    'Style: Hook,Liberation Sans,' + fontSize + ',' +
    hexToAss(fillPrim) + ',' + hexToAss(fillPrim) + ',' + hexToAss(strokeCol) + ',&H64000000&,' +
    '-1,0,0,0,100,100,0,0,1,' +
    strokePx + ',' + shadow + ',' + alignment + ',40,40,' + marginV + ',1';

  const start = msToAss(0);
  const end   = msToAss(endMs);
  const dialogue = 'Dialogue: 5,' + start + ',' + end + ',Hook,,0,0,0,,' + escapeAssText(wrapped);

  return { ass: styleLine + '\n' + dialogue + '\n', warnings };
}

// ----- 2. Progress bar (ffmpeg drawbox filter) -----

/**
 * Build the ffmpeg `drawbox` filter expression for a clip-progress bar.
 *
 *   drawbox=x=0:y=H-h:w=t*W/T:h=H_bar:color=#fff@1.0:t=fill:enable='between(t,0,T)'
 *
 * The bar's width is `t * W / T` so the fill grows linearly from 0 (t=0)
 * to W (t=T). T is the clip duration in seconds; W is the canvas width.
 *
 * Returns `{filter, warnings}`. `filter` is the empty string when
 * `enabled` is false, or when canvasW/canvasH/heightPx are non-positive.
 *
 * @param {object} opts
 * @param {boolean} [opts.enabled]      Default false.
 * @param {string}  [opts.color]        Hex (default '#ffffff').
 * @param {number}  [opts.heightPx]     Bar height px (default 8).
 * @param {string}  [opts.position]     'bottom' | 'top' (default 'bottom').
 * @param {number}  opts.canvasW        Canvas width (required).
 * @param {number}  opts.canvasH        Canvas height (required).
 * @param {number}  opts.durationMs     Clip duration ms (required, > 0).
 * @returns {{filter: string, warnings: Array}}
 */
export function buildProgressBarDrawbox(opts) {
  const enabled = !!opts.enabled;
  if (!enabled) return { filter: '', warnings: [] };

  const color    = opts.color    ?? '#ffffff';
  const heightPx = opts.heightPx ?? 8;
  const position = opts.position === 'top' ? 'top' : 'bottom';
  const canvasW  = opts.canvasW  ?? 1080;
  const canvasH  = opts.canvasH  ?? 1920;
  const durMs    = opts.durationMs;
  const warnings = [];

  if (!Number.isFinite(durMs) || durMs <= 0 || heightPx <= 0) {
    warnings.push({
      code: 'progress_bar_invalid_geometry',
      message: 'progress bar disabled — duration or height not positive (durationMs=' + durMs + ', heightPx=' + heightPx + ').',
    });
    return { filter: '', warnings };
  }

  const durS = durMs / 1000;
  const hex = String(color).startsWith('#') ? String(color) : '#' + String(color);
  const y = position === 'top' ? 0 : (canvasH - heightPx);
  // ffmpeg's drawbox filter in 6.x does NOT evaluate `w`/`h`/`x` as runtime
  // expressions despite the AVOption flag — same expression produces a
  // static box. The workaround: split the bar into N stepped drawbox calls,
  // each enabled in a contiguous time slice with the matching static
  // width. N=20 gives 20 steps over the clip (one every T/20 seconds);
  // visually the bar grows smoothly enough at 24-30 fps playback.
  const N = 20;
  const segments = [];
  for (let i = 1; i <= N; i++) {
    const sliceStart = ((i - 1) / N) * durS;
    const sliceEnd   = (i / N) * durS;
    const w = Math.max(1, Math.floor((i / N) * canvasW));
    segments.push(
      'drawbox=x=0:y=' + y + ':w=' + w + ':h=' + heightPx +
      ":color='" + hex + "@1.0':thickness=fill" +
      ":enable='between(t," + sliceStart.toFixed(3) + ',' + sliceEnd.toFixed(3) + ")'"
    );
  }
  return { filter: segments.join(','), warnings };
}

// ----- 3. Emoji + highlight inside captions.ass body -----

/**
 * Given parsed captions.json (the schema from skills/caption/SKILL.md),
 * build the ASS dialogue events that honor emoji-per-line and
 * highlight:true word colour-flip + scale.
 *
 * `templateBlock` carries the resolved style (after $brand token
 * substitution). Fields consumed: fill, highlight (the colour to swap
 * to), highlight_scale (px → 108 by default for the "pop").
 *
 * Returns `{ass, warnings}` where `ass` is one Dialogue line per
 * captions.lines[] entry, no Style block. The caller (cf-caption-burn)
 * already emits a Default style; this function reuses it.
 *
 * @param {object} captionsJson  captions.json contents
 * @param {object} templateBlock {fill: hex, highlight: hex, highlight_scale: int|null}
 * @returns {{ass: string, warnings: Array}}
 */
export function applyEmojiHighlightToAss(captionsJson, templateBlock) {
  const fill = templateBlock.fill ?? '#ffffff';
  const hi   = templateBlock.highlight ?? '#ffff00';
  const scale = templateBlock.highlight_scale ?? 108;
  const warnings = [];
  const events = [];
  const lines = (captionsJson && Array.isArray(captionsJson.lines)) ? captionsJson.lines : [];
  for (const line of lines) {
    const start = msToAss(line.start_ms ?? 0);
    const end   = msToAss(line.end_ms ?? 0);
    const parts = [];
    const words = Array.isArray(line.words) ? line.words : [];
    for (const w of words) {
      const safe = escapeAssText(w.w ?? '');
      if (w.highlight) {
        parts.push('{\\c' + hexToAss(hi) + '\\fscx' + scale + '\\fscy' + scale + '}' + safe +
                   '{\\c' + hexToAss(fill) + '\\fscx100\\fscy100}');
      } else {
        parts.push(safe);
      }
    }
    let text = parts.join(' ');
    if (line.emoji) text += ' ' + escapeAssText(line.emoji);
    events.push('Dialogue: 0,' + start + ',' + end + ',Default,,0,0,0,,' + text);
  }
  const ass = events.length === 0 ? '' : events.join('\n') + '\n';
  return { ass, warnings };
}
