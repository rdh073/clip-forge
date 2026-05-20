// heygen.mjs — HeyGen API talking-head avatar adapter (v0.4.0 pillar 5).
//
// Highest quality, highest cost (~$1.00 / clip). Uploads a portrait photo
// + an audio file, returns a rendered MP4 of the photo speaking the audio.
//
// The HeyGen v2 photo-avatar API uses an async create-then-poll pattern:
//   1. POST /v2/photo_avatar/photo → photo_id
//   2. POST /v2/video/generate     → video_id (with audio_url)
//   3. GET  /v1/video_status.get   → poll until status=completed
//
// We bound polling at ~3 minutes (60 × 3s) to fail fast on stuck jobs.

import { writeFileSync, readFileSync } from 'node:fs';

const COST_PER_CLIP_USD = 1.00;
const API_BASE          = 'https://api.heygen.com';
const POLL_INTERVAL_MS  = 3000;
const POLL_MAX_TRIES    = 60;

export const NAME = 'heygen';
export const PER_CLIP_COST_USD = COST_PER_CLIP_USD;

function apiKey() {
  return process.env.HEYGEN_API_KEY || '';
}

export function available() {
  return apiKey().length > 0;
}

export function estimateCostUsd() {
  return COST_PER_CLIP_USD;
}

export async function generate({ photo_path, audio_path, duration_ms, aspect, video_path }) {
  if (!available()) throw new Error('heygen: HEYGEN_API_KEY not set');
  if (!photo_path) throw new Error('heygen: photo_path required');
  if (!audio_path) throw new Error('heygen: audio_path required');

  // Upload photo.
  const photoBytes = readFileSync(photo_path);
  const photoRes = await fetch(API_BASE + '/v1/asset/upload', {
    method:  'POST',
    headers: {
      'X-Api-Key':    apiKey(),
      'Content-Type': 'image/jpeg',
    },
    body: photoBytes,
  });
  if (!photoRes.ok) {
    throw new Error('heygen: photo upload ' + photoRes.status);
  }
  const photoJson = await photoRes.json();
  const photoId = photoJson.data?.id;
  if (!photoId) throw new Error('heygen: photo upload returned no id');

  // Upload audio.
  const audioBytes = readFileSync(audio_path);
  const audioRes = await fetch(API_BASE + '/v1/asset/upload', {
    method:  'POST',
    headers: {
      'X-Api-Key':    apiKey(),
      'Content-Type': 'audio/wav',
    },
    body: audioBytes,
  });
  if (!audioRes.ok) throw new Error('heygen: audio upload ' + audioRes.status);
  const audioJson = await audioRes.json();
  const audioUrl = audioJson.data?.url;
  if (!audioUrl) throw new Error('heygen: audio upload returned no url');

  // Generate.
  const genRes = await fetch(API_BASE + '/v2/video/generate', {
    method:  'POST',
    headers: { 'X-Api-Key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_inputs: [{
        character: { type: 'photo_avatar', photo_avatar_id: photoId },
        voice:     { type: 'audio', audio_url: audioUrl },
      }],
      aspect_ratio: mapAspect(aspect || '9:16'),
    }),
  });
  if (!genRes.ok) throw new Error('heygen: generate ' + genRes.status);
  const genJson = await genRes.json();
  const videoId = genJson.data?.video_id;
  if (!videoId) throw new Error('heygen: generate returned no video_id');

  // Poll.
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await fetch(API_BASE + '/v1/video_status.get?video_id=' + encodeURIComponent(videoId), {
      headers: { 'X-Api-Key': apiKey() },
    });
    if (!statusRes.ok) continue;
    const statusJson = await statusRes.json();
    const status = statusJson.data?.status;
    if (status === 'completed') {
      const url = statusJson.data?.video_url;
      if (!url) throw new Error('heygen: completed but no video_url');
      const dl = await fetch(url);
      if (!dl.ok) throw new Error('heygen: video download ' + dl.status);
      writeFileSync(video_path, Buffer.from(await dl.arrayBuffer()));
      return { video_path, cost_usd: COST_PER_CLIP_USD, model: 'heygen-v2' };
    }
    if (status === 'failed') throw new Error('heygen: render failed');
  }
  throw new Error('heygen: poll timeout after ' + (POLL_MAX_TRIES * POLL_INTERVAL_MS / 1000) + 's');
}

function mapAspect(a) {
  if (a === '16:9') return '16:9';
  if (a === '1:1')  return '1:1';
  return '9:16';
}
