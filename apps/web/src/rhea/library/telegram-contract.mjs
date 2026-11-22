const statuses = {
  unconfigured: 200,
  ready: 200,
  verified: 200,
  access_required: 401,
  not_allowed: 403,
  method_not_allowed: 405,
  review_channel: 409,
  review_bot_permissions: 409,
  review_owner: 409,
  telegram_rejected: 409,
  rate_limited: 429,
  unavailable: 503,
};

export function telegramResult(state, retryAfter) {
  const wait = Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 86_400 ? retryAfter : undefined;
  return Response.json({ state, ...(state === 'rate_limited' && wait ? { retryAfter: wait } : {}) }, {
    status: statuses[state],
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(state === 'rate_limited' && wait ? { 'Retry-After': String(wait) } : {}),
    },
  });
}

export async function boundedTelegramJson(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected a response body.');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Response too large.');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function relayTelegramResult(response, payload, pathname) {
  const state = payload?.state;
  const unexpectedState = pathname === '/status' ? state === 'verified' : state === 'ready';
  if (!Object.hasOwn(statuses, state) || statuses[state] !== response.status || unexpectedState) {
    return telegramResult('unavailable');
  }
  return telegramResult(state, payload.retryAfter);
}
