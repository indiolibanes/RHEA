import { DriveError } from '../drive-files.mjs';
import { driveLinks, durableId } from './drive-link.mjs';
import { organizationTools, organizeTool } from './organize.mjs';
import { proposals, writeTools } from './proposals.mjs';
import { acceptsRedirect, boundedText, configuration, decryptGoogle, digest, json, one, redirect, safeHeaders } from './security.mjs';
import { storage } from './storage.mjs';
import { readTool, readTools, validate } from './tools.mjs';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const codeVerifier = /^[A-Za-z0-9._~-]{43,128}$/;
const challengeFormat = /^[A-Za-z0-9_-]{43}$/;
const allowedOrigins = new Set(['https://chatgpt.com', 'https://claude.ai', 'https://claude.com']);
const jsonType = /^(application\/json)(?:\s*;.*)?$/i;
const formType = /^(application\/x-www-form-urlencoded)(?:\s*;.*)?$/i;
const oauthError = (error, status = 400) => json({ error }, status, { Pragma: 'no-cache' });
const rpc = (id, result) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status);
const safeId = id => typeof id === 'string' && id.length <= 160 || Number.isSafeInteger(id);
const scopes = cfg => ['rhea:read', 'rhea:propose', ...(cfg.google ? ['rhea:organize'] : [])];
function normalizeScope(scope, client, cfg) {
  if (scope == null) return 'rhea:read';
  const requested = new Set(scope.split(/\s+/).filter(Boolean));
  if (!requested.has('rhea:read')) return null;
  if (requested.size === 1) return 'rhea:read';
  if (requested.size !== 2) return null;
  if (client?.propose && requested.has('rhea:propose')) return 'rhea:read rhea:propose';
  if (cfg.google && client?.organize && requested.has('rhea:organize')) return 'rhea:read rhea:organize';
  return null;
}

function resourceMetadata(cfg) {
  return { resource: cfg.resource, authorization_servers: [cfg.origin], scopes_supported: scopes(cfg),
    bearer_methods_supported: ['header'], resource_name: 'RHEA' };
}

function serverMetadata(cfg) {
  return { issuer: cfg.origin, authorization_endpoint: cfg.origin + '/authorize',
    token_endpoint: cfg.origin + '/token', revocation_endpoint: cfg.origin + '/revoke',
    response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    client_id_metadata_document_supported: true, scopes_supported: scopes(cfg),
    authorization_response_iss_parameter_supported: true };
}

async function authorize(request, url, cfg, db) {
  if (url.href.length > 4096 || !await db.rate('authorize:' + (request.headers.get('CF-Connecting-IP') ?? 'local'), 30)) {
    return oauthError('temporarily_unavailable', 429);
  }
  const p = url.searchParams;
  const clientId = one(p, 'client_id'), client = cfg.clients.get(clientId);
  const callback = one(p, 'redirect_uri'), state = one(p, 'state'), challenge = one(p, 'code_challenge');
  const resource = one(p, 'resource');
  const scope = normalizeScope(one(p, 'scope'), client, cfg);
  if (!client && clientId?.endsWith('.apps.googleusercontent.com')) {
    return json({ error: 'invalid_request', error_description: 'Use a registered RHEA OAuth client. RHEA handles Google Drive OAuth.' }, 400);
  }
  if (!client || !acceptsRedirect(client, callback) || one(p, 'response_type') !== 'code' ||
      (resource !== null && resource !== cfg.resource) || p.getAll('resource').length > 1 || p.getAll('scope').length > 1 ||
      !state || state.length > 512 || !challengeFormat.test(challenge ?? '') ||
      one(p, 'code_challenge_method') !== 'S256' || !scope) return oauthError('invalid_request');
  const id = await db.request(clientId, callback, state, challenge, scope);
  return redirect(cfg.approval + '/rhea?' + new URLSearchParams({ mcp_request: id }) + '#mcp-review');
}

async function credentials(request, cfg, db, action) {
  if (!await db.rate(action + ':' + (request.headers.get('CF-Connecting-IP') ?? 'local'), 60)) {
    return oauthError('temporarily_unavailable', 429);
  }
  if (!formType.test(request.headers.get('Content-Type') ?? '')) return oauthError('invalid_request');
  let p;
  try { p = new URLSearchParams(await boundedText(request)); }
  catch { return oauthError('invalid_request'); }
  const clientId = one(p, 'client_id');
  const client = cfg.clients.get(clientId);
  const secret = one(p, 'client_secret');
  if (!client || p.getAll('client_secret').length > 1 || (client.secretHash && (!secret || secret.length > 512 ||
      await digest(secret) !== client.secretHash)) || (!client.secretHash && secret !== null)) {
    return oauthError('invalid_client', 401);
  }
  if (action === 'revoke') {
    await db.revokeToken(one(p, 'token'), clientId);
    return new Response(null, { status: 200, headers: safeHeaders });
  }
  const resource = one(p, 'resource');
  if (p.getAll('resource').length > 1 || (resource !== null && resource !== cfg.resource) ||
      p.has('scope') && !normalizeScope(one(p, 'scope'), client, cfg)) return oauthError('invalid_target');
  const flow = one(p, 'grant_type');
  let token;
  if (flow === 'authorization_code') {
    const callback = one(p, 'redirect_uri'), verifier = one(p, 'code_verifier');
    if (!acceptsRedirect(client, callback) || !codeVerifier.test(verifier ?? '')) return oauthError('invalid_grant');
    token = await db.authorizationCode(one(p, 'code'), clientId, callback, await digest(verifier));
  } else if (flow === 'refresh_token') {
    token = await db.renew(one(p, 'refresh_token'), clientId, p.has('scope') ? normalizeScope(one(p, 'scope'), client, cfg) : null);
  } else {
    return oauthError('unsupported_grant_type');
  }
  return token ? json(token, 200, { Pragma: 'no-cache' }) : oauthError('invalid_grant');
}

async function mcp(request, cfg, db, fetcher) {
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins.has(origin) && origin !== cfg.origin) return new Response(null, { status: 403, headers: safeHeaders });
  const auth = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.get('Authorization') ?? '');
  const grant = await db.access(auth?.[1]);
  const authHeader = 'Bearer resource_metadata="' + cfg.origin + '/.well-known/oauth-protected-resource/mcp", scope="rhea:read"';
  if (!grant) return json({ error: 'invalid_token' }, 401, { 'WWW-Authenticate': authHeader });
  if (!await db.rate('mcp:' + grant.actor + ':' + grant.client, 45)) {
    return json({ error: 'rate_limit' }, 429, { 'Retry-After': '60' });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...safeHeaders, Allow: 'POST' } });
  const version = request.headers.get('MCP-Protocol-Version');
  if (version && !versions.includes(version)) return rpcError(null, -32600, 'Unsupported MCP protocol version', 400);
  if (!jsonType.test(request.headers.get('Content-Type') ?? '')) return rpcError(null, -32600, 'Expected application/json', 415);
  let call;
  try { call = JSON.parse(await boundedText(request)); }
  catch { return rpcError(null, -32700, 'Invalid JSON', 400); }
  if (!call || Array.isArray(call) || call.jsonrpc !== '2.0' || typeof call.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  if (!Object.hasOwn(call, 'id') && call.method.startsWith('notifications/')) {
    return new Response(null, { status: 202, headers: safeHeaders });
  }
  if (!safeId(call.id)) return rpcError(null, -32600, 'Invalid Request', 400);
  if (call.method === 'initialize') {
    const requested = call.params?.protocolVersion;
    if (typeof requested !== 'string') return rpcError(call.id, -32602, 'Invalid initialization');
    return rpc(call.id, { protocolVersion: versions.includes(requested) ? requested : versions[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'rhea', title: 'RHEA', version: '0.9.2' } });
  }
  if (call.method === 'ping') return rpc(call.id, {});
  if (!grant.scope?.split(' ').includes('rhea:read')) return json({ error: 'insufficient_scope' }, 403, { 'WWW-Authenticate': authHeader });
  const canPropose = cfg.clients.get(grant.client)?.propose && grant.scope.split(' ').includes('rhea:propose');
  const linkId = durableId(grant.google);
  const canOrganize = Boolean(linkId && cfg.google && cfg.clients.get(grant.client)?.organize && grant.scope.split(' ').includes('rhea:organize'));
  const tools = canOrganize ? [...readTools, ...organizationTools] : canPropose ? [...readTools, ...writeTools] : readTools;
  if (call.method === 'tools/list') return rpc(call.id, { tools });
  if (call.method !== 'tools/call') return rpcError(call.id, -32601, 'Method not found');
  const tool = tools.find(tool => tool.name === call.params?.name);
  const args = call.params?.arguments ?? {};
  if (!tool || !validate(tool, args)) return rpcError(call.id, -32602, 'Unknown tool or invalid arguments');
  const audit = { actor: await digest(cfg.secret + ':audit:' + grant.actor), client: grant.client, action: tool.name };
  await db.audit({ ...audit, result: 'started' });
  try {
    const token = linkId ? (await driveLinks(cfg, fetcher)?.session(grant.actor, grant.account, linkId))?.session?.token :
      await decryptGoogle(cfg.secret, grant.google, grant.actor, grant.account);
    if (!token) throw new DriveError(401, 'Reconnect the Google Drive account.');
    const permit = async () => {
      const active = await db.access(auth[1]);
      if (!active?.scope.split(' ').includes('rhea:organize')) throw new DriveError(403, 'The grant was revoked.');
    };
    const output = tool.annotations.readOnlyHint ? await readTool(tool.name, args, token, fetcher) : canOrganize ?
      await organizeTool(tool.name, args, token, fetcher, permit) : await proposals(cfg).create(grant, tool.name, args, token, fetcher);
    if (canOrganize && tool.name === 'rhea_connection_status') output.permissions.push('organize');
    const serialized = JSON.stringify(output);
    if (new TextEncoder().encode(serialized).length > 48 * 1024) throw new Error('Response too large');
    await db.audit({ ...audit, result: output.state === 'PARTIAL' ? 'partially_completed' : 'succeeded' });
    return rpc(call.id, { structuredContent: output, content: [{ type: 'text', text: serialized }] });
  } catch (error) {
    const status = error?.status;
    const publicError = status === 401 ? 'Check the Google Drive connection in RHEA and reauthorize if requested.' :
      error?.code === 'drive_refresh_pending' || error?.code === 'drive_refresh_unavailable' ?
        'Google Drive renewal is temporarily unavailable. Retry this request shortly.' :
      status === 403 || status === 404 ? 'The resource is unavailable in the authorized Drive root.' :
      status === 409 ? 'Check for an ambiguous folder or conflicting name in the authorized Drive tree.' : 'RHEA could not complete the operation.';
    await db.audit({ ...audit, result: 'refused_or_failed' });
    return rpc(call.id, { isError: true, content: [{ type: 'text', text: publicError }] });
  }
}

export async function fetchGateway(request, env, fetcher = fetch) {
  const cfg = configuration(env);
  if (!cfg) return json({ error: 'service_unavailable' }, 503);
  const url = new URL(request.url);
  if (url.origin !== cfg.origin) return json({ error: 'not_found' }, 404);
  const db = storage(cfg);
  try {
    if (request.method === 'GET') {
      if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
        return json(resourceMetadata(cfg));
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') return json(serverMetadata(cfg));
      if (url.pathname === '/authorize') return await authorize(request, url, cfg, db);
    }
    if (request.method === 'POST' && ['/token', '/revoke'].includes(url.pathname)) {
      return await credentials(request, cfg, db, url.pathname.slice(1));
    }
    if (url.pathname === '/mcp') return await mcp(request, cfg, db, fetcher);
    return json({ error: 'not_found' }, 404);
  } catch {
    return json({ error: 'service_unavailable' }, 503);
  }
}

export default {
  fetch(request, env) { return fetchGateway(request, env); },
  async scheduled(_event, env) { const cfg = configuration(env); if (cfg) await Promise.all([storage(cfg).cleanup(), proposals(cfg).cleanup()]); },
};
