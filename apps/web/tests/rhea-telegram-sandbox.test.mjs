import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../functions/api/rhea/telegram.js';
import { telegramSandbox } from '../telegram-worker/index.mjs';

const actor = 'access-actor-test';
const env = {
  RHEA_TELEGRAM_MODE: 'sandbox',
  RHEA_TELEGRAM_ACCESS_SUB: actor,
  RHEA_TELEGRAM_BOT_TOKEN: '12:' + 'x'.repeat(40),
  RHEA_TELEGRAM_CHANNEL_ID: '-1001234567',
  RHEA_TELEGRAM_OWNER_ID: '1234',
};
const channel = Number(env.RHEA_TELEGRAM_CHANNEL_ID);
const owner = Number(env.RHEA_TELEGRAM_OWNER_ID);
const bot = { id: 12, is_bot: true };
const membership = { status: 'administrator', user: bot, can_be_edited: true, can_manage_chat: true,
  can_post_messages: false, can_edit_messages: false, can_delete_messages: false };
const channelInfo = { id: channel, type: 'channel', title: 'Synthetic channel title', pinned_message: { text: 'Synthetic private post' } };
const ownerInfo = { user: { id: owner, is_bot: false }, status: 'creator' };
const data = { cloudflareAccess: { JWT: { payload: { sub: actor } } } };
const workerRequest = (path, method = 'GET', subject = actor) => new Request('https://rhea-telegram.internal' + path, {
  method, headers: { 'X-Rhea-Access-Subject': subject },
});
const browserRequest = (method = 'GET', options) => new Request('https://rhea.example.test/api/rhea/telegram', {
  method, headers: { 'X-Rhea-Access-Subject': 'untrusted', Cookie: 'private=browser-cookie' }, ...options,
});

function telegramMock(overrides = {}) {
  const calls = [];
  const fetcher = async (url, settings) => {
    const upstream = new URL(url);
    assert.equal(upstream.origin, 'https://api.telegram.org');
    assert.equal(settings.redirect, 'error');
    assert.equal(settings.method, 'POST');
    const method = upstream.pathname.split('/').at(-1);
    assert.equal(upstream.pathname, '/bot' + env.RHEA_TELEGRAM_BOT_TOKEN + '/' + method);
    const payload = JSON.parse(settings.body);
    calls.push({ method, payload });
    const key = method === 'getChatMember' && payload.user_id === owner ? 'owner' : method;
    if (Object.hasOwn(overrides, key)) return overrides[key];
    const result = { getMe: bot, getChat: channelInfo, getChatMember: membership, owner: ownerInfo }[key];
    assert.ok(result, 'Unexpected outbound method.');
    return Response.json({ ok: true, result });
  };
  return { fetcher, calls };
}

async function expectState(response, status, state) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await response.json(), { state });
}

test('Pages requires the verified Access subject, sends only that subject, and strips provider data', async () => {
  const seen = [];
  const binding = { fetch: async request => {
    seen.push(request);
    return Response.json({ state: request.method === 'GET' ? 'ready' : 'verified', token: 'private', chatId: channel });
  } };
  const sandbox = { RHEA_TELEGRAM_SANDBOX: binding };
  await expectState(await onRequest({ request: browserRequest(), data: {}, env: sandbox }), 401, 'access_required');
  await expectState(await onRequest({ request: browserRequest(), data, env: {} }), 200, 'unconfigured');
  await expectState(await onRequest({ request: browserRequest('DELETE'), data, env: sandbox }), 405, 'method_not_allowed');
  await expectState(await onRequest({ request: browserRequest('POST', { body: '{}' }), data, env: sandbox }), 405, 'method_not_allowed');
  await expectState(await onRequest({ request: browserRequest(), data, env: sandbox }), 200, 'ready');
  await expectState(await onRequest({ request: browserRequest('POST'), data, env: sandbox }), 200, 'verified');
  assert.deepEqual(seen.map(request => [request.method, new URL(request.url).pathname, [...request.headers]]), [
    ['GET', '/status', [['x-rhea-access-subject', actor]]],
    ['POST', '/check', [['x-rhea-access-subject', actor]]],
  ]);
});

test('Pages rejects inconsistent states, network errors, and oversized service responses', async () => {
  for (const fetch of [
    () => Response.json({ state: 'verified' }),
    () => Response.json({ state: 'rate_limited' }),
    () => new Response('a'.repeat(1025)),
    () => { throw new Error('Internal private detail'); },
  ]) {
    await expectState(await onRequest({ request: browserRequest(), data, env: { RHEA_TELEGRAM_SANDBOX: { fetch } } }), 503, 'unavailable');
  }
});

test('Worker status and rejected actor or routes never reach Telegram', async () => {
  const { fetcher, calls } = telegramMock();
  await expectState(await telegramSandbox(workerRequest('/status'), {}, fetcher), 200, 'unconfigured');
  await expectState(await telegramSandbox(workerRequest('/status'), { ...env, RHEA_TELEGRAM_BOT_TOKEN: 'invalid' }, fetcher), 200, 'unconfigured');
  await expectState(await telegramSandbox(workerRequest('/check', 'POST', 'different actor'), env, fetcher), 403, 'not_allowed');
  await expectState(await telegramSandbox(workerRequest('/sendMessage', 'POST'), env, fetcher), 405, 'method_not_allowed');
  await expectState(await telegramSandbox(new Request('https://unexpected.example.test/status',
    { headers: { 'X-Rhea-Access-Subject': actor } }), env, fetcher), 405, 'method_not_allowed');
  await expectState(await telegramSandbox(workerRequest('/status'), env, fetcher), 200, 'ready');
  assert.deepEqual(calls, []);
});

test('bound Pages check verifies only the pinned private channel, minimum bot rights, and numeric owner', async () => {
  const { fetcher, calls } = telegramMock();
  const binding = { fetch: request => telegramSandbox(request, env, fetcher) };
  await expectState(await onRequest({ request: browserRequest('POST'), data,
    env: { RHEA_TELEGRAM_SANDBOX: binding } }), 200, 'verified');
  assert.deepEqual(calls, [
    { method: 'getMe', payload: {} },
    { method: 'getChat', payload: { chat_id: channel } },
    { method: 'getChatMember', payload: { chat_id: channel, user_id: bot.id } },
    { method: 'getChatMember', payload: { chat_id: channel, user_id: owner } },
  ]);
});

test('Worker fails closed for a public channel, a bot with extra privileges, or a non-owner', async () => {
  for (const [overrides, expected, total] of [
    [{ getChat: { ...channelInfo, username: 'public-example' } }, 'review_channel', 2],
    [{ getChat: { ...channelInfo, type: 'supergroup' } }, 'review_channel', 2],
    [{ getChat: { ...channelInfo, id: channel - 1 } }, 'review_channel', 2],
    [{ getChatMember: { ...membership, can_post_messages: true } }, 'review_bot_permissions', 3],
    [{ getChatMember: { ...membership, can_delete_messages: true } }, 'review_bot_permissions', 3],
    [{ getChatMember: { ...membership, can_change_info: true } }, 'review_bot_permissions', 3],
    [{ owner: { ...ownerInfo, status: 'administrator' } }, 'review_owner', 4],
    [{ owner: { ...ownerInfo, user: { id: owner + 1, is_bot: false } } }, 'review_owner', 4],
  ]) {
    const replies = Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, Response.json({ ok: true, result: value })]));
    const { fetcher, calls } = telegramMock(replies);
    await expectState(await telegramSandbox(workerRequest('/check', 'POST'), env, fetcher), 409, expected);
    assert.equal(calls.length, total);
  }
});

test('check exposes only fixed failures and a bounded retry deadline, without retrying Telegram', async () => {
  const rejected = telegramMock({ getMe: Response.json({ ok: false, description: 'Private upstream details' }, { status: 401 }) });
  await expectState(await telegramSandbox(workerRequest('/check', 'POST'), env, rejected.fetcher), 409, 'telegram_rejected');
  assert.equal(rejected.calls.length, 1);
  const limited = telegramMock({ getMe: Response.json({ ok: false, parameters: { retry_after: 18 }, description: 'Private' }, { status: 429 }) });
  const result = await onRequest({ request: browserRequest('POST'), data, env: {
    RHEA_TELEGRAM_SANDBOX: { fetch: request => telegramSandbox(request, env, limited.fetcher) },
  } });
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('Retry-After'), '18');
  assert.deepEqual(await result.json(), { state: 'rate_limited', retryAfter: 18 });
  assert.equal(limited.calls.length, 1);
});
