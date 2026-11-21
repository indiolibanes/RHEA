#!/usr/bin/env node
// Local stdio MCP server for allowlisted RHEA documentation only.
// No network calls, Drive access, GitHub writes, credentials or private files.
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';

const VERSION = '0.1.0';
const PROTOCOL = '2025-06-18';
const DOCS = new Set([
  'README.md', 'GEMINI.md', 'docs/google-drive-oauth.md',
  'docs/gemini-mcp-integration.md',
]);

const tools = Object.freeze([
  {
    name: 'rhea_project_status',
    description: 'Read-only overview of the RHEA architecture, deployment boundaries and safe next actions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'rhea_read_document',
    description: 'Read one explicitly allowlisted, non-sensitive RHEA project document.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', enum: [...DOCS] } },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
]);

const message = text => ({ content: [{ type: 'text', text }], isError: false });
const error = (id, code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
const success = (id, result) => ({ jsonrpc: '2.0', id, result });

async function callTool(name, args) {
  if (name === 'rhea_project_status') {
    return message([
      'RHEA / read-only local MCP context',
      'The project includes a web workspace, a remote Drive gateway and an Android prototype.',
      'This MCP server has NO access to user files, Google Drive, secrets, GitHub or deployments.',
      'Use the official GitHub MCP server separately for repository actions.',
      'Never merge automatically, bypass Cloudflare Access, or treat demo files as real.',
      'Gemini web custom MCP app eligibility is region/account dependent.',
      'See docs/gemini-mcp-integration.md for the remote MCP setup.',
    ].join('\n'));
  }
  if (name === 'rhea_read_document') {
    const path = args?.path;
    if (typeof path !== 'string' || !DOCS.has(path) ||
        Object.keys(args).some(key => key !== 'path')) {
      return { content: [{ type: 'text', text: 'Document not allowed.' }], isError: true };
    }
    const content = await readFile(new URL('../../' + path, import.meta.url), 'utf8');
    return message(content.length > 16_000 ? content.slice(0, 16_000) + '\n[Truncated]' : content);
  }
  return { content: [{ type: 'text', text: 'Unknown RHEA context tool.' }], isError: true };
}

async function dispatch(payload) {
  const id = payload?.id;
  if (!payload || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
    return error(id ?? null, -32600, 'Invalid JSON-RPC request.');
  }
  // Notifications MUST NOT receive a response.
  if (id === undefined || id === null) return null;
  try {
    if (payload.method === 'initialize') {
      return success(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'rhea-readonly', title: 'RHEA · Local project context', version: VERSION },
        instructions: 'Only documentation and safe project context. Use GitHub MCP separately for live repository data.',
      });
    }
    if (payload.method === 'ping') return success(id, {});
    if (payload.method === 'tools/list') return success(id, { tools });
    if (payload.method === 'tools/call') {
      const p = payload.params;
      if (!p || typeof p.name !== 'string' || (p.arguments != null &&
          (typeof p.arguments !== 'object' || Array.isArray(p.arguments)))) {
        return error(id, -32602, 'Invalid tool arguments.');
      }
      return success(id, await callTool(p.name, p.arguments ?? {}));
    }
    return error(id, -32601, 'Method not found.');
  } catch {
    // Do not log paths, contents or exception details to stdout.
    return error(id, -32603, 'The RHEA context operation failed.');
  }
}

const io = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of io) {
  if (!line.trim()) continue;
  if (line.length > 64 * 1024) {
    process.stdout.write(JSON.stringify(error(null, -32600, 'Request exceeds limit.')) + '\n');
    continue;
  }
  let answer;
  try { answer = await dispatch(JSON.parse(line)); }
  catch { answer = error(null, -32700, 'Invalid JSON.'); }
  if (answer) process.stdout.write(JSON.stringify(answer) + '\n');
}
