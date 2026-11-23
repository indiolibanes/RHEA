import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api } from 'teleproto';
import { mtprotoPage } from '../functions/api/rhea/telegram-mtproto.js';
import { catalogSnapshot } from '../src/rhea/library/live-catalog.mjs';
import { planReflow } from '../src/rhea/library/planner.mjs';
import { mtprotoControl } from './control.mjs';
import { readInventory } from './inventory.mjs';
import { configuration } from './server.mjs';
import { sessionStore } from './session-store.mjs';
import { telegramClient } from './telegram.mjs';

const testConfig = { actor: 'test-actor', key: 'a'.repeat(43), ownerId: '100001',
  channelId: '9876543210', inviteHash: 'fixture-invite-abc', apiId: 12345,
  apiHash: 'a'.repeat(32), phone: '+12345678901' };
const auth = { className: 'auth.Authorization', user: { id: testConfig.ownerId } };
const codeDelivery = { className: 'auth.SentCode', type: { className: 'auth.SentCodeTypeApp' }, phoneCodeHash: 'fixture-private-hash' };
const revision = 'a'.repeat(64);
const request = (operation, input, extra = {}) => new Request('https://mtproto.example.test/v1/' + operation, {
  method: operation === 'status' ? 'GET' : 'POST',
  headers: { Authorization: 'Bearer ' + testConfig.key, 'X-Rhea-Access-Subject': testConfig.actor },
  ...(input ? { body: JSON.stringify(input) } : {}), ...extra,
});
const browserRequest = (operation, input, extra = {}) => new Request('https://rhea.example.test/api/rhea/telegram-mtproto?op=' + operation, {
  method: operation === 'status' ? 'GET' : 'POST', headers: { Authorization: 'forged', 'X-Rhea-Access-Subject': 'forged' },
  ...(input ? { body: JSON.stringify(input) } : {}), ...extra,
});
const rpcError = errorMessage => Object.assign(new Error('private raw provider error'), { errorMessage });
const state = async (response, expected) => assert.deepEqual(await (await response).json(), { state: expected });

function setup(clientChanges = {}) {
  let session = null;
  let time = 1;
  const calls = [];
  const store = { read: async () => session, write: async value => { session = value; }, clear: async () => { session = null; } };
  const client = {
    async sendCode() { calls.push('code'); return codeDelivery; },
    async signIn(entered, hash) {
      assert.equal(hash, codeDelivery.phoneCodeHash);
      if (entered === '00000') throw rpcError('PHONE_CODE_INVALID');
      if (entered === '11111') throw rpcError('SESSION_PASSWORD_NEEDED');
      return auth;
    },
    async checkPassword(entered) {
      if (entered !== 'mock password') throw rpcError('PASSWORD_HASH_INVALID');
      return auth;
    },
    save: () => 'synthetic session',
    async logout() { calls.push('logout'); },
    async inventory() { return { state: 'inventory', inventory: { channelId: testConfig.channelId, messages: [],
      revision, complete: true }, session: 'must not be returned' }; },
    ...clientChanges,
  };
  const handle = mtprotoControl(testConfig, store, async (saved, run) => run(client), () => time);
  return { handle, store, calls, advance: ms => { time += ms; } };
}

test('adapter supports app-code and 2FA, saves only the authenticated owner, and revokes on disconnect', async () => {
  const { handle, store, calls } = setup();
  await state(handle(request('status')), 'disconnected');
  await state(handle(request('start')), 'code');
  await state(handle(request('start')), 'code');
  assert.equal(await store.read(), null);
  await state(handle(request('code', { code: '00000' })), 'invalid_code');
  await state(handle(request('code', { code: '11111' })), 'password');
  await state(handle(request('password', { password: 'wrong' })), 'invalid_password');
  await state(handle(request('password', { password: 'mock password' })), 'connected');
  assert.equal(await store.read(), 'synthetic session');
  const answer = await handle(request('inventory'));
  assert.equal(answer.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await answer.json(), { state: 'inventory', inventory: {
    channelId: testConfig.channelId, messages: [], revision, complete: true,
  } });
  await state(handle(request('disconnect')), 'disconnected');
  assert.equal(await store.read(), null);
  assert.deepEqual(calls, ['code', 'logout']);
});

test('adapter refuses other accounts, expired challenges, writes, and wrong service identity', async () => {
  const mismatch = setup({ async signIn() { return { ...auth, user: { id: '100002' } }; } });
  await state(mismatch.handle(request('start')), 'code');
  await state(mismatch.handle(request('code', { code: '12345' })), 'account_mismatch');
  assert.equal(await mismatch.store.read(), null);
  assert.deepEqual(mismatch.calls, ['code', 'logout']);
  const { handle, advance } = setup();
  for (const operation of ['copy', 'delete', 'publish']) await state(handle(request(operation)), 'invalid_request');
  await state(handle(request('inventory', null, { headers: { Authorization: 'Bearer forged' } })), 'not_allowed');
  await state(handle(request('start')), 'code');
  advance(301_000);
  await state(handle(request('code', { code: '12345' })), 'expired');
});

test('adapter respects provider flood wait and expires incomplete enrollment', async () => {
  let requests = 0;
  const { handle, advance } = setup({ async sendCode() { requests++; throw rpcError('FLOOD_WAIT_80'); } });
  const a = await handle(request('start'));
  assert.equal(a.status, 429);
  assert.equal(a.headers.get('Retry-After'), '80');
  advance(61_000);
  assert.equal((await handle(request('start'))).status, 429);
  assert.equal(requests, 1);
  advance(20_000);
  assert.equal((await handle(request('start'))).status, 429);
  assert.equal(requests, 2);
});

test('Pages uses only verified identity, a fixed service origin, redacted state, and strict request shapes', async () => {
  const data = { cloudflareAccess: { JWT: { payload: { sub: testConfig.actor } } } };
  const env = { RHEA_TELEGRAM_MTPROTO_ORIGIN: 'https://mtproto.example.test', RHEA_TELEGRAM_MTPROTO_KEY: testConfig.key,
    RHEA_TELEGRAM_CF_CLIENT_ID: 'service-id', RHEA_TELEGRAM_CF_CLIENT_SECRET: 'service-secret' };
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, env.RHEA_TELEGRAM_MTPROTO_ORIGIN + '/v1/code');
    assert.equal(options.headers['X-Rhea-Access-Subject'], testConfig.actor);
    assert.equal(options.headers.Authorization, 'Bearer ' + testConfig.key);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { code: '12345' });
    return Response.json({ state: 'connected', password: 'never forward', session: 'private' });
  };
  await state(mtprotoPage({ request: browserRequest('code', { code: '12345' }), data: {}, env }, fetcher), 'access_required');
  await state(mtprotoPage({ request: browserRequest('publish'), data, env }, fetcher), 'invalid_request');
  await state(mtprotoPage({ request: browserRequest('code', { code: '12345', channel: 'another-peer' }), data, env }, fetcher), 'invalid_request');
  await state(mtprotoPage({ request: browserRequest('code', { code: '12345' }), data, env: {} }, fetcher), 'unconfigured');
  await state(mtprotoPage({ request: browserRequest('code', { code: '12345' }), data, env }, fetcher), 'connected');
  assert.equal(calls, 1);
});

test('session envelope is encrypted, private on disk, and pinned to its configured identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rhea-session-test-'));
  try {
    const file = join(directory, 'sealed');
    const key = randomBytes(32);
    const store = sessionStore(file, key, [testConfig.actor, testConfig.channelId]);
    await store.write('a pretend auth key');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file)).includes('a pretend auth key'), false);
    assert.equal(await store.read(), 'a pretend auth key');
    await assert.rejects(sessionStore(file, key, [testConfig.actor, 'other']).read());
    await assert.rejects(sessionStore(file, randomBytes(32), [testConfig.actor, testConfig.channelId]).read());
    await store.clear();
    assert.equal(await store.read(), null);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('teleproto invokes only read operations on the exact enrolled private channel', async () => {
  const calls = [];
  let stopCount = 0;
  let destroyCount = 0;
  const channel = { className: 'Channel', id: BigInt(testConfig.channelId), broadcast: true, accessHash: 555n };
  function provider(peer) {
    return () => ({
      connect: async () => {},
      updateManager: { stop() { stopCount++; } },
      destroy: async () => { destroyCount++; },
      async invoke(request) {
        assert.ok(request instanceof Api.InvokeWithoutUpdates);
        const rpc = request.query;
        calls.push(rpc.className);
        if (rpc instanceof Api.users.GetUsers) return [{ id: BigInt(testConfig.ownerId) }];
        if (rpc instanceof Api.messages.CheckChatInvite) return { className: 'ChatInviteAlready', chat: peer };
        assert.ok(rpc instanceof Api.messages.GetHistory);
        assert.equal(rpc.peer.channelId.toString(), testConfig.channelId);
        assert.ok(rpc.getBytes().length > 0);
        if (rpc.offsetId) return { pts: 40, messages: [] };
        const posts = [{ id: 3, message: 'Series: Solar Talon | S01E01' }, { id: 1, message: 'Series: Kestrel Flight | S01E01' }];
        return { pts: 40, messages: posts.slice(0, rpc.limit) };
      },
    });
  }
  const read = (factory) => telegramClient(testConfig, factory)(null, client => client.inventory());
  const result = await read(provider(channel));
  assert.equal(result.state, 'inventory');
  const snapshot = catalogSnapshot(result.inventory);
  assert.deepEqual(snapshot.messages.map(item => item.id), [1, 3]);
  assert.equal(snapshot.messages[0].link, 'https://t.me/c/' + testConfig.channelId + '/1');
  const plan = await planReflow(snapshot);
  assert.deepEqual(plan.targetIds, [1, 3]);
  assert.ok(plan.blockers.includes('copy_permission_unverified'));
  assert.deepEqual(calls.slice(0, 2), ['users.GetUsers', 'messages.CheckChatInvite']);
  calls.length = 0;
  await assert.deepEqual(await read(provider({ ...channel, username: 'public' })), { state: 'channel_unavailable' });
  assert.deepEqual(calls, ['users.GetUsers', 'messages.CheckChatInvite']);
  assert.equal(stopCount, 2);
  assert.equal(destroyCount, 2);
});

test('inventory rejects inconsistent pagination and exposes capped coverage without trusted copy rights', async () => {
  const channelId = testConfig.channelId;
  const page = async (offset, limit) => ({ pts: 42, messages: [5, 3, 1].filter(id => !offset || id < offset)
    .slice(0, limit).map(id => ({ id, noforwards: true })) });
  const partial = await readInventory({ channelId, page, max: 2 });
  assert.equal(partial.inventory.complete, false);
  assert.deepEqual(partial.inventory.messages.map(m => [m.id, m.copyPolicy]), [[3, 'protected'], [5, 'protected']]);
  const stale = await readInventory({ channelId, page: async () => ({ pts: 42, messages: [{ id: 3 }, { id: 4 }] }) });
  assert.equal(stale.state, 'stale_inventory');
});

test('Node runtime refuses missing or reused secrets and accepts isolated configuration', () => {
  const env = { RHEA_TELEGRAM_MTPROTO_MODE: 'sandbox', RHEA_TELEGRAM_API_ID: String(testConfig.apiId),
    RHEA_TELEGRAM_API_HASH: testConfig.apiHash, RHEA_TELEGRAM_CHANNEL_ID: testConfig.channelId,
    RHEA_TELEGRAM_CHANNEL_INVITE: 'https://t.me/+' + testConfig.inviteHash, RHEA_TELEGRAM_OWNER_ID: testConfig.ownerId,
    RHEA_TELEGRAM_ACCESS_SUB: testConfig.actor, RHEA_TELEGRAM_PHONE: testConfig.phone, RHEA_TELEGRAM_MTPROTO_KEY: testConfig.key,
    RHEA_TELEGRAM_SESSION_FILE: '/isolated/telegram/session', RHEA_TELEGRAM_SESSION_KEY: randomBytes(32).toString('base64url') };
  assert.equal(configuration(env).encryptionKey.length, 32);
  assert.equal(configuration(env).bindHost, '127.0.0.1');
  assert.equal(configuration({ ...env, RHEA_TELEGRAM_BIND_HOST: '0.0.0.0' }).bindHost, '0.0.0.0');
  assert.throws(() => configuration({ ...env, RHEA_TELEGRAM_BIND_HOST: '1.2.3.4' }), /Invalid/);
  assert.throws(() => configuration({ ...env, RHEA_TELEGRAM_API_HASH: '' }), /Invalid/);
  assert.throws(() => configuration({ ...env, RHEA_TELEGRAM_SESSION_KEY: testConfig.key }), /Invalid/);
});
