const bytes = new TextEncoder();
const decoder = new TextDecoder();
const inputLimit = 24 * 1024;
export const timestamp = () => Math.floor(Date.now() / 1000);
export const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
export const secretValue = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const base64 = raw => btoa(String.fromCharCode(...raw)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const from64 = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), x => x.charCodeAt(0));
export const digest = async value => base64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.encode(value))));
export async function proofDigest(secret, value) {
  const key = await crypto.subtle.importKey('raw', from64(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes.encode(value))));
}
const cryptKey = secret => crypto.subtle.importKey('raw', from64(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function encryptGoogle(secret, credential, actor, account, requestId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: bytes.encode(JSON.stringify([actor, account, requestId])) }, await cryptKey(secret), bytes.encode(credential));
  return requestId + '.' + base64(iv) + '.' + base64(new Uint8Array(encrypted));
}

export async function decryptGoogle(secret, value, actor, account) {
  const [requestId, iv, encrypted] = value.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(iv),
    additionalData: bytes.encode(JSON.stringify([actor, account, requestId])) }, await cryptKey(secret), from64(encrypted));
  return decoder.decode(plain);
}

export function fixedOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password ? origin : null;
  } catch { return null; }
}

function approvedRedirect(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)));
  } catch { return false; }
}

export function configuration(env) {
  const origin = fixedOrigin(env.RHEA_MCP_ORIGIN);
  const approval = fixedOrigin(env.RHEA_MCP_APPROVAL_ORIGIN);
  if (!origin || !approval || origin === approval || !env.RHEA_MCP_DB || !secretValue(env.RHEA_MCP_KEY)) return null;
  try {
    const input = JSON.parse(env.RHEA_MCP_CLIENTS);
    const entries = Object.entries(input);
    if (!entries.length || entries.length > 12) return null;
    const clients = new Map();
    for (const [id, item] of entries) {
      if (typeof id !== 'string' || !id.length || id.length > 240 || typeof item.label !== 'string' ||
          !item.label.trim() || item.label.length > 60 || !Array.isArray(item.redirects) ||
          !item.redirects.length || item.redirects.length > 6 || !item.redirects.every(approvedRedirect) ||
          (item.secretHash != null && !secretValue(item.secretHash))) return null;
      clients.set(id, { label: item.label, redirects: item.redirects, secretHash: item.secretHash,
        provider: ['gpt', 'claude', 'gemini'].includes(item.provider) ? item.provider : null,
        propose: item.propose === true, organize: item.organize === true, loopbackPort: item.loopbackPort === true });
    }
    const clientId = env.RHEA_GOOGLE_CLIENT_ID;
    const clientSecret = env.RHEA_GOOGLE_CLIENT_SECRET;
    const persistent = env.RHEA_DRIVE_PERSISTENCE === 'true';
    const google = persistent && typeof clientId === 'string' &&
      /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) &&
      typeof clientSecret === 'string' && clientSecret && !/\s/.test(clientSecret)
      ? { clientId, clientSecret } : null;
    return { origin, approval, resource: origin + '/mcp', clients, secret: env.RHEA_MCP_KEY, db: env.RHEA_MCP_DB, google, persistent };
  } catch { return null; }
}

export function acceptsRedirect(client, value) {
  if (typeof value !== 'string' || value.length > 1024 || !approvedRedirect(value)) return false;
  if (client.redirects.includes(value)) return true;
  if (!client.loopbackPort) return false;
  const target = new URL(value);
  if (target.protocol !== 'http:' || !target.port || !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)) return false;
  return client.redirects.some(value => {
    const registered = new URL(value);
    return registered.protocol === 'http:' && registered.hostname === target.hostname &&
      registered.pathname === target.pathname && registered.search === target.search;
  });
}

export function one(params, key) {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : null;
}

export async function boundedText(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request');
  const d = new TextDecoder('utf-8', { fatal: true });
  let result = '', total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return result + d.decode();
    total += value.length;
    if (total > inputLimit) {
      await reader.cancel();
      throw new Error('Body too large');
    }
    result += d.decode(value, { stream: true });
  }
}

export const safeHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
export const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...safeHeaders, ...extra } });
export const redirect = location => new Response(null, { status: 303, headers: { ...safeHeaders, Location: location } });
