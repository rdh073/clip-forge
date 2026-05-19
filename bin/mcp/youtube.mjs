#!/usr/bin/env node
// YouTube MCP server — stub.
// Exposes upload_short / metrics / list_uploads tool schemas. Returns
// auth_required until the OAuth flow is wired.
//
// Real impl would use https://developers.google.com/youtube/v3/docs/videos/insert
// with resumable upload + `#Shorts` in description (Shorts inference).

import { serve, authRequired } from './_lib.mjs';

const HAS_KEYS = !!(process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET);
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?' +
  'client_id=' + encodeURIComponent(process.env.YT_CLIENT_ID || '') +
  '&redirect_uri=http://localhost:8421/callback' +
  '&response_type=code&scope=https://www.googleapis.com/auth/youtube.upload';

const tools = [
  {
    name: 'upload_short',
    description: 'Upload a YouTube Short. Description automatically includes #Shorts.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        hashtags: { type: 'array', items: { type: 'string' } },
        thumbnail_at_s: { type: 'number' },
        schedule_at: { type: ['string', 'null'] },
        privacy: { type: 'string', enum: ['public', 'unlisted', 'private'] },
      },
      required: ['file_path', 'title'],
    },
  },
  {
    name: 'metrics',
    description: 'Fetch YouTube Analytics for a video (views, watch-time, retention).',
    inputSchema: {
      type: 'object',
      properties: { post_id: { type: 'string' }, since: { type: 'string' } },
      required: ['post_id'],
    },
  },
  {
    name: 'list_uploads',
    description: 'List recent uploads for the authenticated channel.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'auth_status',
    description: 'Report whether the YouTube channel is connected.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const handlers = {
  async upload_short() { return HAS_KEYS ? authRequired('youtube', AUTH_URL) : { error: 'missing_keys' }; },
  async metrics()      { return HAS_KEYS ? authRequired('youtube', AUTH_URL) : { error: 'missing_keys' }; },
  async list_uploads() { return HAS_KEYS ? authRequired('youtube', AUTH_URL) : { error: 'missing_keys' }; },
  async auth_status()  { return { has_keys: HAS_KEYS, connected: false }; },
};

serve({ name: 'youtube', tools, handlers });
