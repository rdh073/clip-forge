// groq.mjs — Groq Llama 3.3 70B LLM adapter for cf-edit prompt-mode patches.
//
// BYO key (GROQ_API_KEY). Default model: llama-3.3-70b-versatile, JSON-object
// response format. Pricing rounded to ~$0.59 / M tokens (in + out treated
// uniformly for cost-estimate purposes).

const COST_PER_M_TOKENS_USD = 0.59;
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const API_BASE = 'https://api.groq.com/openai/v1';

export const NAME = 'groq';

function apiKey() { return process.env.GROQ_API_KEY || ''; }

export function available() { return apiKey().length > 0; }

export async function complete({ system, user, max_tokens, model }) {
  if (!available()) {
    return { fallback_used: true, fallback_reason: 'groq_key_missing', cost_usd: 0 };
  }
  const body = {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: String(system || '') },
      { role: 'user',   content: String(user   || '') },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: max_tokens || 2048,
  };
  let r;
  try {
    r = await fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + apiKey(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { fallback_used: true, fallback_reason: 'groq_network_error', detail: e.message, cost_usd: 0 };
  }
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 240);
    return { fallback_used: true, fallback_reason: 'groq_http_' + r.status, detail, cost_usd: 0 };
  }
  let payload;
  try { payload = await r.json(); }
  catch (e) {
    return { fallback_used: true, fallback_reason: 'groq_invalid_json', detail: e.message, cost_usd: 0 };
  }
  const text = String(payload.choices?.[0]?.message?.content || '').trim();
  if (!text) {
    return { fallback_used: true, fallback_reason: 'groq_empty_response', cost_usd: 0 };
  }
  const usage = payload.usage || {};
  const tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  const cost = (tokens / 1_000_000) * COST_PER_M_TOKENS_USD;
  return { text, cost_usd: Number(cost.toFixed(6)),
           usage: { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0 } };
}
