// anthropic.mjs — Anthropic Claude Haiku 4.5 LLM adapter for cf-edit
// prompt-mode patches and translate fallback. BYO key (ANTHROPIC_API_KEY).
//
// Default model: claude-haiku-4-5-20251001. JSON-mode is enforced by
// instructing the system prompt to return JSON only; the SDK does not need
// a separate response_format flag. Pricing approximated at $1.00/M tokens
// (mid-band Haiku 4.5 rate).

const COST_PER_M_TOKENS_USD = 1.00;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const API_BASE = 'https://api.anthropic.com/v1';

export const NAME = 'anthropic';

function apiKey() { return process.env.ANTHROPIC_API_KEY || ''; }

export function available() { return apiKey().length > 0; }

export async function complete({ system, user, max_tokens, model }) {
  if (!available()) {
    return { fallback_used: true, fallback_reason: 'anthropic_key_missing', cost_usd: 0 };
  }
  const body = {
    model: model || DEFAULT_MODEL,
    system: String(system || ''),
    messages: [{ role: 'user', content: String(user || '') }],
    max_tokens: max_tokens || 2048,
    temperature: 0,
  };
  let r;
  try {
    r = await fetch(API_BASE + '/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey(),
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { fallback_used: true, fallback_reason: 'anthropic_network_error', detail: e.message, cost_usd: 0 };
  }
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 240);
    return { fallback_used: true, fallback_reason: 'anthropic_http_' + r.status, detail, cost_usd: 0 };
  }
  let payload;
  try { payload = await r.json(); }
  catch (e) {
    return { fallback_used: true, fallback_reason: 'anthropic_invalid_json', detail: e.message, cost_usd: 0 };
  }
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
  if (!text) {
    return { fallback_used: true, fallback_reason: 'anthropic_empty_response', cost_usd: 0 };
  }
  const usage = payload.usage || {};
  const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  const cost = (tokens / 1_000_000) * COST_PER_M_TOKENS_USD;
  return { text, cost_usd: Number(cost.toFixed(6)),
           usage: { prompt: usage.input_tokens || 0, completion: usage.output_tokens || 0 } };
}
