#!/usr/bin/env node
// TikTok MCP server — stub.
// Exposes upload / metrics / list_posts tool schemas. Returns auth_required
// until the OAuth flow is wired (separate engineering slice).
//
// Real implementation would use https://developers.tiktok.com/doc/login-kit-web
// + /post/publish/inbox/video/init/ — that's a 200-line OAuth + chunked upload
// project, deferred until API credentials are provisioned.

import { serve, authRequired } from './_lib.mjs';

const HAS_KEYS = !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
const TOKEN_FILE = (process.env.HOME || process.env.USERPROFILE) + '/.clip-forge/tokens/tiktok.json';

const tools = [
  {
    name: 'upload',
    description: 'Upload a video to TikTok. Returns post_id and url on success.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        caption: { type: 'string' },
        hashtags: { type: 'array', items: { type: 'string' } },
        thumbnail_at_s: { type: 'number' },
        schedule_at: { type: ['string', 'null'], description: 'ISO 8601' },
        disable_duet: { type: 'boolean' },
        disable_stitch: { type: 'boolean' },
      },
      required: ['file_path', 'caption'],
    },
  },
  {
    name: 'metrics',
    description: 'Fetch performance metrics for a TikTok post.',
    inputSchema: {
      type: 'object',
      properties: { post_id: { type: 'string' } },
      required: ['post_id'],
    },
  },
  {
    name: 'list_posts',
    description: 'List recent TikTok posts for the authenticated account.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string' }, limit: { type: 'number' } },
    },
  },
  {
    name: 'auth_status',
    description: 'Report whether the TikTok account is connected.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/?client_key=' +
  encodeURIComponent(process.env.TIKTOK_CLIENT_KEY || '') +
  '&scope=user.info.basic,video.upload,video.publish&response_type=code';

const handlers = {
  async upload(args) {
    if (!HAS_KEYS) return { error: 'missing_keys', hint: 'set TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET' };
    return authRequired('tiktok', AUTH_URL);
  },
  async metrics(args) {
    if (!HAS_KEYS) return { error: 'missing_keys' };
    return authRequired('tiktok', AUTH_URL);
  },
  async list_posts(args) {
    if (!HAS_KEYS) return { error: 'missing_keys' };
    return authRequired('tiktok', AUTH_URL);
  },
  async auth_status() {
    return { has_keys: HAS_KEYS, token_file: TOKEN_FILE, connected: false };
  },
};

serve({ name: 'tiktok', tools, handlers });
