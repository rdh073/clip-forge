#!/usr/bin/env node
// build-fixtures.mjs — generates the RGB fixture files used by
// bin/lib/face-detector.test.mjs AND the topic-segmented transcript fixture
// used by tests/integration/clip-prompt.test.mjs.
//
// Workflow:
//   1. Place tests/fixtures/single-face.png (any photo with a clearly visible
//      frontal face, ≥320x240) and tests/fixtures/empty-room.png (any scene
//      without a face).
//   2. Run `npm run build-fixtures`. The script extracts a 320x240 rgb24
//      frame from each PNG and writes the .rgb sibling files + a dims.json
//      that records the canonical width/height.
//   3. The same run also regenerates tests/fixtures/topic-transcript-60s.json,
//      a deterministic 60 s word-timed transcript with three topic blocks
//      (fitness 0–20s, career 20–40s, cooking 40–60s). Output is committed —
//      the build is reproducible (mulberry32 seeded) so re-running yields a
//      byte-identical file.
//
// Why not ship the .rgb files directly? They're large (~230 KB each) and
// the source PNGs are tiny in comparison. Keeping the conversion deterministic
// + scripted means the repo doesn't carry hundreds of KB of derived data.

import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const WIDTH = 320;
const HEIGHT = 240;
const ITEMS = [
  { png: resolve(DIR, 'single-face.png'), rgb: resolve(DIR, 'single-face.rgb') },
  { png: resolve(DIR, 'empty-room.png'), rgb: resolve(DIR, 'empty-room.rgb') },
];

function which(cmd) {
  try { return spawnSync('sh', ['-c', 'command -v ' + cmd]).stdout.toString().trim(); }
  catch { return ''; }
}

if (!which('ffmpeg')) {
  process.stderr.write('build-fixtures: ffmpeg is required.\n');
  process.exit(2);
}

let allOk = true;
for (const { png, rgb } of ITEMS) {
  if (!existsSync(png)) {
    process.stderr.write('  ⚠  ' + png + ' missing — see tests/fixtures/README.md\n');
    allOk = false;
    continue;
  }
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', png,
    '-vf', 'scale=' + WIDTH + ':' + HEIGHT,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    rgb,
  ]);
  if (r.status !== 0) {
    process.stderr.write('  ❌ ' + png + ' → ffmpeg failed: ' + r.stderr.toString().slice(-200) + '\n');
    allOk = false;
    continue;
  }
  process.stdout.write('  ✅ ' + rgb + ' (' + statSync(rgb).size + ' bytes)\n');
}

writeFileSync(resolve(DIR, 'dims.json'),
  JSON.stringify({ width: WIDTH, height: HEIGHT }, null, 2) + '\n');

// ----- topic-segmented transcript fixture (pillar c — prompt-based clipping) -----
//
// Three contiguous 20 s blocks, ≈ 2 words/s, sentence boundaries aligned to
// fixed mid-block beats. Determinism comes from a mulberry32 seed (matches
// the stress-plan-n50.json fixture's pattern); shuffling sentence order is
// avoided so re-runs produce byte-identical output.

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPIC_BLOCKS = [
  {
    topic: 'fitness',
    start_s: 0,
    end_s: 20,
    sentences: [
      'I hit the gym every morning and squat heavy on leg day.',
      'My protein intake is two hundred grams to support muscle growth.',
      'Cardio after lifting burns extra fat without sacrificing strength.',
      'A good fitness program tracks reps and rest between every set.',
      'You will see real progress in the gym after eight consistent weeks.',
      'Form on the squat matters more than the weight on the bar.',
    ],
  },
  {
    topic: 'career',
    start_s: 20,
    end_s: 40,
    sentences: [
      'I decided to quit my job after the third missed promotion this year.',
      'A raise of fifteen percent rarely closes a real salary gap.',
      'Negotiate your job offer before you accept the company paperwork.',
      'My career took off the day I stopped chasing the next promotion.',
      'You should know your salary band before you start the conversation.',
      'Quit the job that drains you and the right career will find you.',
    ],
  },
  {
    topic: 'cooking',
    start_s: 40,
    end_s: 60,
    sentences: [
      'I sweat the onion in the pan before adding any garlic to the recipe.',
      'A sharp knife is the single most important tool in the home cook kitchen.',
      'Toast the spices in the dry pan to wake up the sauce flavor.',
      'My favorite recipe finishes the sauce with a knob of cold butter.',
      'Cook the onion low and slow until it turns translucent and sweet.',
      'Wipe the knife on a clean cloth between every cutting board pass.',
    ],
  },
];

function buildTopicTranscript(seed) {
  const rng = mulberry32(seed);
  const words = [];
  for (const block of TOPIC_BLOCKS) {
    const blockDurMs = (block.end_s - block.start_s) * 1000;
    const sentCount = block.sentences.length;
    const slotMs = blockDurMs / sentCount;
    for (let si = 0; si < sentCount; si++) {
      const sentence = block.sentences[si];
      const sentStartMs = block.start_s * 1000 + si * slotMs;
      const tokens = sentence.split(/\s+/);
      // Reserve ≈ 90 ms gap at end of sentence for natural pause.
      const usableMs = slotMs - 90;
      const perWord = usableMs / tokens.length;
      let cursor = sentStartMs;
      for (let wi = 0; wi < tokens.length; wi++) {
        const jitter = (rng() - 0.5) * 12;
        const dur = Math.max(80, perWord + jitter);
        const startMs = Math.round(cursor);
        const endMs = Math.round(cursor + dur);
        words.push({
          w: tokens[wi],
          start_ms: startMs,
          end_ms: endMs,
          confidence: 0.95,
          speaker: 'S0',
          topic: block.topic,
        });
        cursor += dur;
      }
    }
  }
  return {
    version: 1,
    engine: 'synthetic-topic-blocks',
    language: 'en',
    duration_s: 60.0,
    source_audio: null,
    alignment_method: 'deterministic mulberry32(20260520) jitter on uniform per-word slots within fixed sentence beats',
    topic_blocks: TOPIC_BLOCKS.map((b) => ({ topic: b.topic, start_s: b.start_s, end_s: b.end_s })),
    words,
  };
}

const TOPIC_OUT = resolve(DIR, 'topic-transcript-60s.json');
const topicData = buildTopicTranscript(20260520);
writeFileSync(TOPIC_OUT, JSON.stringify(topicData, null, 2) + '\n');
process.stdout.write('  ✅ ' + TOPIC_OUT + ' (' + topicData.words.length + ' words across '
  + topicData.topic_blocks.length + ' topic blocks)\n');

// ----- vocab fixtures (pillar e — brand vocabulary) -----
//
// Four static JSON fixtures consumed by tests/integration/vocab.test.mjs:
//   * mock-transcript-clipforge-3s.json — 3 s transcript with "clipforge"
//     (lowercase) sandwiched between carrier words. Injected via
//     CF_WHISPER_TRANSCRIPT_MOCK to exercise the post-pass case-restore.
//   * mock-transcript-silent-3s.json — empty words[] + duration 3 s; the
//     hallucination-guard fixture (vocab must NOT insert spurious terms).
//   * sample-vocab.json — three real-world brand terms.
//   * large-vocab.json — 200 deterministically named terms to trip the
//     vocab_terms_truncated warning path.

const CLIPFORGE_TRANSCRIPT = {
  version: 1,
  engine: 'mock',
  language: 'en',
  duration_s: 3.0,
  speakers: [],
  words: [
    { w: 'I',         start_ms: 100,  end_ms: 200,  speaker: 0, confidence: 0.97 },
    { w: 'use',       start_ms: 200,  end_ms: 500,  speaker: 0, confidence: 0.95 },
    { w: 'clipforge', start_ms: 1000, end_ms: 1800, speaker: 0, confidence: 0.93 },
    { w: 'every',     start_ms: 1900, end_ms: 2200, speaker: 0, confidence: 0.94 },
    { w: 'day',       start_ms: 2300, end_ms: 2700, speaker: 0, confidence: 0.96 },
  ],
  sentences: [],
};

const SILENT_TRANSCRIPT = {
  version: 1,
  engine: 'mock',
  language: 'en',
  duration_s: 3.0,
  speakers: [],
  words: [],
  sentences: [],
};

const SAMPLE_VOCAB = {
  version: 1,
  terms: [
    { term: 'ClipForge', case: 'preserve', weight: 1.0 },
    { term: 'Anthropic', case: 'preserve', weight: 1.0 },
    { term: 'Sumayyah',  case: 'preserve', weight: 1.0, lang: 'en' },
  ],
  deepgram: { boost: 8.0 },
  whisper:  { initial_prompt_max_tokens: 240 },
};

function buildLargeVocab(count) {
  const terms = [];
  for (let i = 0; i < count; i++) {
    const id = String(i + 1).padStart(3, '0');
    // Highest weight first so the deepgram-cap test sees a deterministic
    // ordering of which terms make it past the 100-term cap.
    const weight = 1.0 - (i * 0.001);
    terms.push({ term: 'brand-' + id, case: 'preserve', weight });
  }
  return {
    version: 1,
    terms,
    deepgram: { boost: 8.0 },
    whisper: { initial_prompt_max_tokens: 240 },
  };
}

const VOCAB_FIXTURES = [
  { name: 'mock-transcript-clipforge-3s.json', data: CLIPFORGE_TRANSCRIPT },
  { name: 'mock-transcript-silent-3s.json',    data: SILENT_TRANSCRIPT },
  { name: 'sample-vocab.json',                 data: SAMPLE_VOCAB },
  { name: 'large-vocab.json',                  data: buildLargeVocab(200) },
];

for (const f of VOCAB_FIXTURES) {
  const out = resolve(DIR, f.name);
  writeFileSync(out, JSON.stringify(f.data, null, 2) + '\n');
  process.stdout.write('  ✅ ' + out + '\n');
}

process.exit(allOk ? 0 : 1);
