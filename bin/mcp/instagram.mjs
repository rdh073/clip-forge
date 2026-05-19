#!/usr/bin/env node
// Instagram Reels MCP server — stub.
// Exposes upload_reel / metrics tool schemas via Meta Graph API. Returns
// auth_required until the OAuth flow is wired.
//
// Real impl uses /me/media + /me/media_publish with `media_type=REELS`.
// Container resource expects a publicly reachable URL (or an FB CDN upload),
// which is a non-trivial deploy concern — deferred until creds are wired.

import { serve, authRequired } from './_lib.mjs';

const HAS_KEYS = !!(process.env.IG_APP_ID && process.env.IG_APP_SECRET);
const AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth?' +
  'client_id=' + encodeURIComponent(process.env.IG_APP_ID || '') +
  '&redirect_uri=http://localhost:8422/callback' +
  '&response_type=code&scope=instagram_basic,instagram_content_publish';

const tools = [
  {
    name: 'upload_reel',
    description: 'Upload an Instagram Reel via Meta Graph API.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        caption: { type: 'string' },
        hashtags: { type: 'array', items: { type: 'string' } },
        thumbnail_at_s: { type: 'number' },
        schedule_at: { type: ['string', 'null'] },
        share_to_feed: { type: 'boolean' },
      },
      required: ['file_path', 'caption'],
    },
  },
  {
    name: 'metrics',
    description: 'Fetch insights for a Reel (views, likes, comments, saves, watch-time).',
    inputSchema: {
      type: 'object',
      properties: { post_id: { type: 'string' } },
      required: ['post_id'],
    },
  },
  {
    name: 'auth_status',
    description: 'Report whether the Instagram account is connected.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const handlers = {
  async upload_reel() { return HAS_KEYS ? authRequired('instagram', AUTH_URL) : { error: 'missing_keys' }; },
  async metrics()     { return HAS_KEYS ? authRequired('instagram', AUTH_URL) : { error: 'missing_keys' }; },
  async auth_status() { return { has_keys: HAS_KEYS, connected: false }; },
};

serve({ name: 'instagram', tools, handlers });
