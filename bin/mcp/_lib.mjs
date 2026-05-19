// Minimal MCP stdio server plumbing for ClipForge.
// Each MCP server in this directory imports `serve` and passes its tool
// definitions + handlers. We speak JSON-RPC 2.0 over stdio per the MCP spec
// at https://modelcontextprotocol.io/specification (2025-06 revision).
//
// This is a from-scratch implementation — no @modelcontextprotocol/sdk
// dependency — chosen to keep the plugin install-free.

import { createInterface } from 'node:readline';

export function serve({ name, version = '0.1.0', tools, handlers }) {
  const rl = createInterface({ input: process.stdin, terminal: false });

  const log = (...args) => process.stderr.write('[mcp:' + name + '] ' + args.join(' ') + '\n');

  const respond = (id, result, error) => {
    if (id === undefined || id === null) return;
    const msg = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };
    process.stdout.write(JSON.stringify(msg) + '\n');
  };

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      log('parse error:', e.message);
      return;
    }

    try {
      switch (msg.method) {
        case 'initialize':
          respond(msg.id, {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name, version },
          });
          return;

        case 'notifications/initialized':
        case 'initialized':
          return;

        case 'tools/list':
          respond(msg.id, { tools });
          return;

        case 'tools/call': {
          const tool = (msg.params || {}).name;
          const args = (msg.params || {}).arguments || {};
          const fn = handlers[tool];
          if (!fn) {
            respond(msg.id, null, { code: -32601, message: 'unknown tool: ' + tool });
            return;
          }
          const out = await fn(args);
          respond(msg.id, {
            content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }],
            isError: out && out.error ? true : false,
          });
          return;
        }

        case 'ping':
          respond(msg.id, {});
          return;

        default:
          respond(msg.id, null, { code: -32601, message: 'method not found: ' + msg.method });
      }
    } catch (e) {
      log('handler error:', e.stack || e.message);
      respond(msg.id, null, { code: -32603, message: e.message });
    }
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// Pretty-print an auth_required response in the shape ClipForge skills expect.
export function authRequired(platform, authUrl) {
  return {
    error: 'auth_required',
    platform,
    auth_url: authUrl,
    next: 'Run /clip-forge:publish --reauth ' + platform + ' to start the OAuth flow.',
  };
}
