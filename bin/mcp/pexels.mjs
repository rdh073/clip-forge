#!/usr/bin/env node
// Pexels MCP server — real implementation, no SDK dependency.
// Exposes:
//   search_videos(query, orientation?, min_duration?, per_page?)
//   search_photos(query, orientation?, per_page?)  // (unused by ClipForge but useful for thumbnails later)
//
// Requires env PEXELS_API_KEY. https://www.pexels.com/api/

import { serve } from './_lib.mjs';

const API_KEY = process.env.PEXELS_API_KEY || '';
const BASE = 'https://api.pexels.com';

function ensureKey() {
  if (!API_KEY) {
    return { error: 'missing_api_key', hint: 'set PEXELS_API_KEY in .env' };
  }
  return null;
}

async function pexelsGet(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('pexels ' + res.status + ': ' + body.slice(0, 200));
  }
  return res.json();
}

function pickBestVideoFile(videoFiles, orientation) {
  // Prefer portrait if requested, else landscape; pick highest resolution.
  const wantPortrait = orientation === 'portrait';
  const filtered = videoFiles.filter((f) => {
    if (!f.width || !f.height) return false;
    return wantPortrait ? f.height >= f.width : f.width >= f.height;
  });
  const pool = filtered.length ? filtered : videoFiles;
  return pool.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
}

const tools = [
  {
    name: 'search_videos',
    description: 'Search Pexels for stock video clips. Returns up to per_page results with downloadable URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword search' },
        orientation: { type: 'string', enum: ['portrait', 'landscape', 'square'], description: 'Default landscape' },
        min_duration: { type: 'number', description: 'Minimum clip duration in seconds' },
        per_page: { type: 'number', description: '1-80, default 10' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_photos',
    description: 'Search Pexels for stock photos (useful for thumbnails).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        orientation: { type: 'string', enum: ['portrait', 'landscape', 'square'] },
        per_page: { type: 'number' },
      },
      required: ['query'],
    },
  },
];

const handlers = {
  async search_videos({ query, orientation = 'landscape', min_duration = 0, per_page = 10 }) {
    const fail = ensureKey();
    if (fail) return fail;
    const data = await pexelsGet('/videos/search', { query, orientation, per_page });
    const results = (data.videos || [])
      .filter((v) => v.duration >= min_duration)
      .map((v) => {
        const file = pickBestVideoFile(v.video_files || [], orientation);
        return file ? {
          id: v.id,
          duration_s: v.duration,
          width: file.width,
          height: file.height,
          url: file.link,
          preview: v.image,
          credit: v.user && v.user.name,
          source: 'pexels:' + v.id,
        } : null;
      })
      .filter(Boolean);
    return { videos: results, total: data.total_results || 0 };
  },

  async search_photos({ query, orientation = 'portrait', per_page = 10 }) {
    const fail = ensureKey();
    if (fail) return fail;
    const data = await pexelsGet('/v1/search', { query, orientation, per_page });
    const results = (data.photos || []).map((p) => ({
      id: p.id,
      width: p.width,
      height: p.height,
      url: p.src && (p.src.original || p.src.large),
      credit: p.photographer,
      source: 'pexels:' + p.id,
    }));
    return { photos: results, total: data.total_results || 0 };
  },
};

serve({ name: 'pexels', tools, handlers });
