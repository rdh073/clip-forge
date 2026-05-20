// fal_lip.mjs — fal.ai LivePortrait avatar adapter (~$0.10 / clip).
//
// Cheapest OSS path; less polished than HeyGen/D-ID. Uses fal's hosted
// LivePortrait model — uploads photo+audio via fal's storage endpoint,
// submits a job to the queue API, polls until completion.

import { writeFileSync, readFileSync } from 'node:fs';

const COST_PER_CLIP_USD = 0.10;
const MODEL             = 'fal-ai/live-portrait';
const API_BASE          = 'https://queue.fal.run';
const STORAGE_BASE      = 'https://fal.run/storage/upload';
const POLL_INTERVAL_MS  = 3000;
const POLL_MAX_TRIES    = 60;

export const NAME = 'fal_lip';
export const PER_CLIP_COST_USD = COST_PER_CLIP_USD;

function apiKey() {
  return process.env.FAL_API_KEY || '';
}

export function available() {
  return apiKey().length > 0;
}

export function estimateCostUsd() {
  return COST_PER_CLIP_USD;
}

async function uploadToFal(bytes, contentType) {
  const res = await fetch(STORAGE_BASE, {
    method:  'POST',
    headers: { 'Authorization': 'Key ' + apiKey(), 'Content-Type': contentType },
    body:    bytes,
  });
  if (!res.ok) throw new Error('fal_lip: storage upload ' + res.status);
  const json = await res.json();
  if (!json.url) throw new Error('fal_lip: storage returned no url');
  return json.url;
}

export async function generate({ photo_path, audio_path, duration_ms, aspect, video_path }) {
  if (!available()) throw new Error('fal_lip: FAL_API_KEY not set');
  if (!photo_path) throw new Error('fal_lip: photo_path required');
  if (!audio_path) throw new Error('fal_lip: audio_path required');

  const photoUrl = await uploadToFal(readFileSync(photo_path), 'image/jpeg');
  const audioUrl = await uploadToFal(readFileSync(audio_path), 'audio/wav');

  const submitRes = await fetch(API_BASE + '/' + MODEL, {
    method:  'POST',
    headers: { 'Authorization': 'Key ' + apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: photoUrl,
      audio_url: audioUrl,
      driving_video_url: null,
    }),
  });
  if (!submitRes.ok) throw new Error('fal_lip: submit ' + submitRes.status);
  const submitJson = await submitRes.json();
  const requestId = submitJson.request_id;
  if (!requestId) throw new Error('fal_lip: submit returned no request_id');

  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await fetch(API_BASE + '/' + MODEL + '/requests/' + requestId, {
      headers: { 'Authorization': 'Key ' + apiKey() },
    });
    if (!statusRes.ok) continue;
    const statusJson = await statusRes.json();
    if (statusJson.status === 'COMPLETED') {
      const videoUrl = statusJson.video?.url || statusJson.output?.video?.url;
      if (!videoUrl) throw new Error('fal_lip: completed but no video url');
      const dl = await fetch(videoUrl);
      if (!dl.ok) throw new Error('fal_lip: video download ' + dl.status);
      writeFileSync(video_path, Buffer.from(await dl.arrayBuffer()));
      return { video_path, cost_usd: COST_PER_CLIP_USD, model: MODEL };
    }
    if (statusJson.status === 'FAILED') throw new Error('fal_lip: render failed');
  }
  throw new Error('fal_lip: poll timeout after ' + (POLL_MAX_TRIES * POLL_INTERVAL_MS / 1000) + 's');
}
