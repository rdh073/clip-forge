// did.mjs — D-ID API avatar adapter (~$0.30 / clip). Mid-tier.
//
// D-ID's /talks endpoint accepts a source_image URL + an audio URL and
// returns a resulting video URL after polling. We pre-upload the photo
// via their /images endpoint; the audio is uploaded inline as a base64
// data URI when small, else via the /audios endpoint.

import { writeFileSync, readFileSync } from 'node:fs';

const COST_PER_CLIP_USD = 0.30;
const API_BASE          = 'https://api.d-id.com';
const POLL_INTERVAL_MS  = 3000;
const POLL_MAX_TRIES    = 60;

export const NAME = 'did';
export const PER_CLIP_COST_USD = COST_PER_CLIP_USD;

function apiKey() {
  return process.env.DID_API_KEY || '';
}

export function available() {
  return apiKey().length > 0;
}

export function estimateCostUsd() {
  return COST_PER_CLIP_USD;
}

function authHeader() {
  return 'Basic ' + Buffer.from(apiKey() + ':').toString('base64');
}

export async function generate({ photo_path, audio_path, duration_ms, aspect, video_path }) {
  if (!available()) throw new Error('did: DID_API_KEY not set');
  if (!photo_path) throw new Error('did: photo_path required');
  if (!audio_path) throw new Error('did: audio_path required');

  // Upload image.
  const imgForm = new FormData();
  const imgBytes = readFileSync(photo_path);
  imgForm.append('image', new Blob([imgBytes], { type: 'image/jpeg' }), 'photo.jpg');
  const imgRes = await fetch(API_BASE + '/images', {
    method:  'POST',
    headers: { 'Authorization': authHeader() },
    body:    imgForm,
  });
  if (!imgRes.ok) throw new Error('did: image upload ' + imgRes.status);
  const imgJson = await imgRes.json();
  const sourceUrl = imgJson.url;
  if (!sourceUrl) throw new Error('did: image upload returned no url');

  // Upload audio.
  const audForm = new FormData();
  const audBytes = readFileSync(audio_path);
  audForm.append('audio', new Blob([audBytes], { type: 'audio/wav' }), 'audio.wav');
  const audRes = await fetch(API_BASE + '/audios', {
    method:  'POST',
    headers: { 'Authorization': authHeader() },
    body:    audForm,
  });
  if (!audRes.ok) throw new Error('did: audio upload ' + audRes.status);
  const audJson = await audRes.json();
  const audioUrl = audJson.url;
  if (!audioUrl) throw new Error('did: audio upload returned no url');

  // Create talk.
  const talkRes = await fetch(API_BASE + '/talks', {
    method:  'POST',
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_url: sourceUrl,
      script:     { type: 'audio', audio_url: audioUrl },
      config:     { stitch: true, fluent: true },
    }),
  });
  if (!talkRes.ok) throw new Error('did: talks ' + talkRes.status);
  const talkJson = await talkRes.json();
  const talkId = talkJson.id;
  if (!talkId) throw new Error('did: talks returned no id');

  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await fetch(API_BASE + '/talks/' + encodeURIComponent(talkId), {
      headers: { 'Authorization': authHeader() },
    });
    if (!statusRes.ok) continue;
    const statusJson = await statusRes.json();
    if (statusJson.status === 'done') {
      const url = statusJson.result_url;
      if (!url) throw new Error('did: done but no result_url');
      const dl = await fetch(url);
      if (!dl.ok) throw new Error('did: video download ' + dl.status);
      writeFileSync(video_path, Buffer.from(await dl.arrayBuffer()));
      return { video_path, cost_usd: COST_PER_CLIP_USD, model: 'did-talks' };
    }
    if (statusJson.status === 'error') throw new Error('did: render error');
  }
  throw new Error('did: poll timeout after ' + (POLL_MAX_TRIES * POLL_INTERVAL_MS / 1000) + 's');
}
