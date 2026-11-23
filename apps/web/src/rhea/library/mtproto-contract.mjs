export const overviewLimit = 2 * 1024 * 1024;
export const inventoryLimit = 500;
const routes = { status: 'GET', start: 'POST', code: 'POST', password: 'POST', cancel: 'POST', inventory: 'POST', disconnect: 'POST' };
const statusCodes = {
  unconfigured: 200, disconnected: 200, code: 200, password: 200, connected: 200, inventory: 200,
  access_required: 401, not_allowed: 403, invalid_request: 400, invalid_code: 409, invalid_password: 409,
  expired: 409, channel_unavailable: 409, account_mismatch: 409, unsupported_delivery: 409,
  revoke_in_telegram: 409, stale_inventory: 409, busy: 409, rate_limited: 429, unavailable: 503,
};

export function operationAllowed(operation, method) {
  return typeof operation === 'string' && Object.hasOwn(routes, operation) && routes[operation] === method;
}

export function inputFor(operation, value) {
  const expected = operation === 'code' ? 'code' : operation === 'password' ? 'password' : null;
  if (!expected) return value === undefined ? {} : null;
  if (!value || Object.keys(value).length !== 1 || typeof value[expected] !== 'string') return null;
  const input = value[expected];
  if (expected === 'code' ? !/^[0-9]{4,8}$/.test(input) : !input.length || input.length > 256) return null;
  return { [expected]: input };
}

const preciseId = (value, length = 19) => typeof value === 'string' &&
  /^[1-9][0-9]+$/.test(value) && value.length <= length;
const optionalText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;
const messageId = id => Number.isInteger(id) && id > 0 && id <= 2_147_483_647;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function overview(value) {
  if (!value || !preciseId(value.channelId) || !/^[0-9a-f]{64}$/.test(value.revision ?? '') ||
    typeof value.complete !== 'boolean' || !Array.isArray(value.messages) || value.messages.length > inventoryLimit) return null;
  const seen = new Set();
  const messages = [];
  for (const post of value.messages) {
    if (!post || !messageId(post.id) || seen.has(post.id)) return null;
    seen.add(post.id);
    messages.push({
      id: post.id, date: nonnegative(post.date), editedAt: nonnegative(post.editedAt),
      caption: optionalText(post.caption, 448), filename: optionalText(post.filename, 192),
      albumId: optionalText(post.albumId, 22), providerMediaId: optionalText(post.providerMediaId, 32),
      sizeBytes: nonnegative(post.sizeBytes),
      copyPolicy: post.copyPolicy === 'protected' ? 'protected' : 'unknown',
    });
  }
  return { channelId: value.channelId, revision: value.revision, complete: value.complete, messages };
}

export function mtprotoResult(state, extra = {}) {
  const status = Object.hasOwn(statusCodes, state) ? statusCodes[state] : null;
  if (!status) return mtprotoResult('unavailable');
  const body = { state };
  if (state === 'inventory') {
    const safe = overview(extra.inventory);
    if (!safe) return mtprotoResult('unavailable');
    body.inventory = safe;
  }
  if (state === 'rate_limited' && Number.isInteger(extra.retryAfter) && extra.retryAfter > 0 && extra.retryAfter <= 86_400) {
    body.retryAfter = extra.retryAfter;
  }
  return Response.json(body, { status, headers: {
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    ...(body.retryAfter ? { 'Retry-After': String(body.retryAfter) } : {}),
  } });
}
