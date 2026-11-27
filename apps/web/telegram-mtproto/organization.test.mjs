import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api } from 'teleproto';
import { FloodWaitError } from 'teleproto/errors';
import { mtprotoPage } from '../functions/api/rhea/telegram-mtproto.js';
import { mtprotoControl } from './control.mjs';
import { telegramClient } from './telegram.mjs';

const selection = { sourceTopicId: 1, localTopicId: 8, backupTopicId: 9, letter: 'T', ids: [32, 31, 33] };
const scope = { actor: 'test-access-subject', ownerId: '700', key: 'x'.repeat(43),
  forum: { channelId: '11111', inviteHash: 'test-source' },
  backupForum: { channelId: '22222', inviteHash: 'test-backup' }, organizationEnabled: true };
const rawPost = (id, episode, groupedId) => ({ className: 'Message', id, groupedId, message: '',
  peerId: { channelId: 11111n },
  media: { className: 'MessageMediaDocument', document: {
    className: 'Document', id: BigInt(id + 100), accessHash: 34n, fileReference: Buffer.from([1, 2, 3]),
    mimeType: 'video/x-matroska', size: BigInt(id === 32 ? 2 ** 32 : 1000),
    attributes: [{ className: 'DocumentAttributeFilename', fileName: '[Fixture] Tidal Library - ' + episode + '.mkv' }],
  } },
});

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rhea-organization-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { ...scope, file: join(directory, 'session.enc') };
  const source = [rawPost(34, '01'), rawPost(33, '03'), rawPost(32, '01'), rawPost(31, '02')];
  const targets = { 8: [], 9: [] };
  const sends = [];
  const reads = [];
  const attempts = [];
  let clock = 1000;
  let wait = 0;
  let readWait = 0;
  let failReceipt = false;
  const messages = rows => ({ className: 'messages.Messages', messages: rows });
  const provider = () => ({
    connect: async () => {}, destroy: async () => {}, updateManager: { stop() {} },
    async invoke({ query }) {
      if (query instanceof Api.users.GetUsers) return [{ id: 700n }];
      if (query instanceof Api.messages.CheckChatInvite) {
        const channelId = query.hash === scope.forum.inviteHash ? 11111n : 22222n;
        return { className: 'ChatInviteAlready', chat: {
          className: 'Channel', id: channelId, accessHash: 4n,
          title: channelId === 11111n ? 'Fixture group' : 'Fixture backup', forum: true, megagroup: true, creator: true,
        } };
      }
      if (query instanceof Api.messages.GetForumTopicsByID) {
        assert.equal(query.topics[0], query.peer.channelId.toString() === '11111' ? 8 : 9);
        return { topics: [{ className: 'ForumTopic', id: query.topics[0], title: 'Letter T' }] };
      }
      if (query instanceof Api.messages.GetReplies) {
        reads.push(query.msgId);
        if (readWait) {
          const seconds = readWait;
          readWait = 0;
          throw new FloodWaitError({ capture: seconds, request: query });
        }
        if (query.msgId === 1) return messages(source);
        return messages([...targets[query.msgId]].reverse());
      }
      assert.ok(query instanceof Api.messages.SendMedia);
      assert.ok(query.getBytes().length > 0);
      const to = query.replyTo.replyToMsgId;
      assert.ok(to === 8 || to === 9);
      assert.equal(query.peer.channelId.toString(), to === 8 ? '11111' : '22222');
      attempts.push(query.randomId);
      if (wait) {
        const seconds = wait;
        wait = 0;
        throw new FloodWaitError({ capture: seconds, request: query });
      }
      const original = source.find(item => item.media.document.id.toString() === query.media.id.id.toString());
      const id = 100 + targets[to].length;
      targets[to].push({ ...original, id, peerId: { channelId: query.peer.channelId }, replyTo: { replyToMsgId: to } });
      sends.push([to, original.id]);
      if (failReceipt) throw Error('Simulated interruption after send.');
      return { updates: [{ className: 'UpdateMessageID', randomId: query.randomId, id }] };
    },
  });
  const transport = telegramClient(config, provider);
  const start = () => mtprotoControl(config, { read: async () => 'enrolled-test-session' },
    (_session, callback) => transport(null, callback), () => clock);
  let adapter = start();
  const invoke = async (operation, input = selection) => {
    const response = await adapter(new Request('https://adapter.example/v1/organize' + operation, {
      method: 'POST', headers: { Authorization: 'Bearer ' + config.key, 'X-Rhea-Access-Subject': config.actor,
        'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }));
    return response.json();
  };
  async function approve() {
    const preview = await invoke('preview');
    assert.equal(preview.state, 'mirror_preview');
    assert.deepEqual(preview.mirror.posts.map(post => post.id), selection.ids);
    assert.equal((await invoke('approve', { ...selection, confirm: true, approval: preview.mirror.approval })).state, 'mirror_progress');
    assert.deepEqual(sends, []);
  }
  return { invoke, approve, source, sends, targets, reads, attempts, restart: () => { adapter = start(); },
    delaySend: seconds => { wait = seconds; }, advance: milliseconds => { clock += milliseconds; },
    delayRead: seconds => { readWait = seconds; },
    loseReceipt: () => { failReceipt = true; } };
}

test('journals a Telegram send rejection and retries the same IDs only after the wait, including after restart', async t => {
  const run = await setup(t);
  await run.approve();
  run.delaySend(90_000);
  const retryAt = 90_001_000;
  assert.deepEqual(await run.invoke('next'), { state: 'rate_limited', retryAt, retryAfter: 90_000 });
  assert.deepEqual(await run.invoke('next'), { state: 'rate_limited', retryAt, retryAfter: 90_000 });
  run.restart();
  run.advance(89_999_999);
  const readsBeforeRetry = run.reads.length;
  assert.deepEqual(await run.invoke('next'), { state: 'rate_limited', retryAt, retryAfter: 1 });
  assert.equal(run.reads.length, readsBeforeRetry);
  assert.equal(run.attempts.length, 1);
  assert.deepEqual(run.sends, []);
  run.advance(1);
  assert.equal((await run.invoke('next')).state, 'mirror_progress');
  assert.deepEqual(run.attempts, [run.attempts[0], run.attempts[0]]);
  assert.deepEqual(run.sends, [[8, 32]]);
});

test('preserves the original deadline when Telegram pauses a read before sending or verifying an approved batch', async t => {
  const run = await setup(t);
  await run.approve();
  for (let index = 0; index < 2; index++) {
    const retryAt = 601_000 + index * 600_000;
    run.delayRead(600);
    assert.deepEqual(await run.invoke('next'), { state: 'rate_limited', retryAt, retryAfter: 600 });
    const priorReads = run.reads.length;
    run.restart();
    run.advance(390_000);
    assert.deepEqual(await run.invoke('status'), { state: 'rate_limited', retryAt, retryAfter: 210 });
    assert.deepEqual(await run.invoke('next'), { state: 'rate_limited', retryAt, retryAfter: 210 });
    assert.equal(run.reads.length, priorReads);
    assert.equal(run.sends.length, index);
    run.advance(210_000);
    const result = await run.invoke('next');
    assert.equal(result.state, 'mirror_progress');
    assert.equal(result.mirror.localCopies.length, index);
    assert.deepEqual(run.sends, [[8, 32]]);
  }
});

test('copies only the approved files from General in the selected order to both verified targets', async t => {
  const run = await setup(t);
  assert.equal((await run.invoke('next')).state, 'mirror_idle');
  await run.approve();
  assert.equal((await run.invoke('next')).state, 'mirror_progress');
  run.restart();
  let result;
  for (let i = 1; i < 12; i++) {
    const priorReads = run.reads.length;
    result = await run.invoke('next');
    assert.deepEqual(run.reads.slice(priorReads), i === 11 ? [1, 9, 8, 9, 8, 1] : i < 6 ? [1, 8, 9] : [1, 9, 8]);
  }
  assert.equal(result.state, 'mirror_done');
  assert.deepEqual(run.sends, [[8, 32], [8, 31], [8, 33], [9, 32], [9, 31], [9, 33]]);
  assert.deepEqual(result.mirror.copies.map(copy => copy.sourceId), selection.ids);
  assert.equal(run.source.length, 4);
  assert.equal((await run.invoke('next')).state, 'mirror_done');
  assert.equal(run.sends.length, 6);
});

test('blocks destination content, partial albums, concurrent source changes and uncertain sends', async t => {
  const run = await setup(t);
  const album = 777n;
  run.source[0].groupedId = run.source[1].groupedId = album;
  assert.equal((await run.invoke('preview')).issue.code, 'album_or_reply');
  delete run.source[0].groupedId;
  delete run.source[1].groupedId;
  run.targets[9].push({ id: 101 });
  assert.equal((await run.invoke('preview')).issue.code, 'destination_not_empty');
  run.targets[9].pop();
  await run.approve();
  run.source.unshift(rawPost(42, '04'));
  assert.equal((await run.invoke('next')).state, 'mirror_changed');
  assert.deepEqual(run.sends, []);
  run.source.shift();
  run.loseReceipt();
  assert.equal((await run.invoke('next')).state, 'unavailable');
  run.restart();
  assert.equal((await run.invoke('next')).state, 'mirror_recovery');
  assert.deepEqual(run.sends, [[8, 32]]);
});

test('requires a protected same-origin approval and validates selected topics and IDs', async () => {
  const origin = 'https://workspace.example';
  const check = (operation, headers, body, data = { cloudflareAccess: { JWT: { payload: { sub: scope.actor } } } },
    fetcher = () => { assert.fail('Rejected input must never reach the adapter.'); }) =>
    mtprotoPage({ request: new Request(origin + '/api/rhea/telegram-mtproto?op=organize' + operation, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
    }), data, env: { RHEA_TELEGRAM_MTPROTO_ORIGIN: 'https://adapter.example',
      RHEA_TELEGRAM_MTPROTO_KEY: scope.key, RHEA_TELEGRAM_CF_CLIENT_ID: 'test', RHEA_TELEGRAM_CF_CLIENT_SECRET: 'test',
    } }, fetcher);
  assert.equal((await check('approve', { Origin: origin }, selection)).status, 400);
  assert.equal((await check('preview', { Origin: 'https://other.example' }, selection)).status, 403);
  assert.equal((await check('preview', { Origin: origin }, selection, {})).status, 401);
  assert.equal((await check('preview', { Origin: origin }, { ...selection, localTopicId: 1 })).status, 400);
  assert.equal((await check('preview', { Origin: origin }, { ...selection, ids: [32, 32] })).status, 400);
  const retryAt = 1_800_000_000_000;
  const response = await check('status', { Origin: origin }, selection, undefined, async () =>
    Response.json({ state: 'rate_limited', retryAfter: 210, retryAt, internal: 'discard' }, { status: 429 }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '210');
  assert.deepEqual(await response.json(), { state: 'rate_limited', retryAfter: 210, retryAt });
});

test('rebuilds a paginated letter with all unclassified posts and preserves the owner-approved insertion point', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rhea-rebuild-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { ...scope, rebuildEnabled: true, file: join(directory, 'session.enc') };
  const ids = Array.from({ length: 64 }, (_, i) => 100 + i);
  const old = ids.map(id => ({ ...rawPost(id, id), replyTo: { replyToMsgId: 8 }, message: 'Original caption ' + id }));
  const incoming = [rawPost(31, '02'), rawPost(32, '01')];
  const destination = [];
  const nextDestination = [];
  const nextLetter = [{ ...rawPost(164, '01'), replyTo: { replyToMsgId: 18 } }];
  const sends = [];
  const oldOffsets = new Set();
  let oldPageGap = 0;
  const provider = () => ({
    connect: async () => {}, destroy: async () => {}, updateManager: { stop() {} },
    async invoke({ query }) {
      if (query instanceof Api.users.GetUsers) return [{ id: 700n }];
      if (query instanceof Api.messages.CheckChatInvite) return { className: 'ChatInviteAlready', chat: {
        className: 'Channel', id: 11111n, accessHash: 4n, title: 'Fixture forum', forum: true, megagroup: true, creator: true,
      } };
      if (query instanceof Api.messages.GetForumTopicsByID) {
        const [id] = query.topics;
        return { topics: [{ className: 'ForumTopic', id, closed: id === 8,
          title: { 8: 'Letter – “K”', 9: 'Letter K [NEW]', 18: 'Letter T', 19: 'Letter T [NEW]' }[id] }] };
      }
      if (query instanceof Api.messages.GetReplies) {
        assert.equal(query.peer.channelId.toString(), '11111');
        if (query.msgId === 8) oldOffsets.add(query.offsetId);
        const rows = { 8: old, 1: incoming, 9: destination, 18: nextLetter, 19: nextDestination }[query.msgId];
        const sorted = [...rows].reverse().filter(post => !query.offsetId || post.id < query.offsetId);
        const offsetIdOffset = rows.length - sorted.length + (query.msgId === 8 ? oldPageGap : 0);
        return { className: 'messages.ChannelMessages', count: rows.length, offsetIdOffset, messages: sorted.slice(0, query.limit) };
      }
      assert.ok(query instanceof Api.messages.SendMedia);
      assert.equal(query.peer.channelId.toString(), '11111');
      assert.equal(query.replyTo.replyToMsgId, 9);
      const original = [...old, ...incoming].find(post => post.media.document.id.toString() === query.media.id.id.toString());
      const id = 200 + destination.length;
      assert.equal(query.message, original.message);
      destination.push({ ...original, id, replyTo: { replyToMsgId: 9 } });
      sends.push(original.id);
      return { updates: [{ className: 'UpdateMessageID', randomId: query.randomId, id }] };
    },
  });
  const transport = telegramClient(config, provider);
  const start = () => mtprotoControl(config, { read: async () => 'test' }, (_session, fn) => transport(null, fn));
  let adapter = start();
  let input = { sourceTopicId: 1, currentTopicId: 8, replacementTopicId: 9, beforeId: 160, letter: 'K', ids: [32, 31] };
  const nextInput = { sourceTopicId: 1, currentTopicId: 18, replacementTopicId: 19, beforeId: null, letter: 'T', ids: [32] };
  const invoke = async (op, body = input) => {
    const response = await adapter(new Request('https://adapter.example/v1/rebuild' + op, {
      method: 'POST', headers: { Authorization: 'Bearer ' + config.key, 'X-Rhea-Access-Subject': config.actor },
      body: JSON.stringify(body),
    }));
    return response.json();
  };
  assert.equal((await invoke('next')).state, 'mirror_idle');
  oldPageGap = 2;
  assert.equal((await invoke('preview')).issue.code, 'history_unverified');
  oldPageGap = 0;
  assert.equal((await invoke('preview', { ...input, beforeId: 404 })).issue.code, 'selection_changed');
  old[59].groupedId = old[60].groupedId = 77n;
  assert.deepEqual((await invoke('preview')).issue, { side: 'source', code: 'insertion_splits_album', postId: 160 });
  delete old[59].groupedId;
  delete old[60].groupedId;
  destination.push({ id: 200 });
  assert.equal((await invoke('preview')).issue.code, 'destination_not_empty');
  destination.pop();
  assert.equal((await invoke('preview')).state, 'mirror_preview'); // Single-anchor clients remain compatible.
  input = { ...input, beforeId: null, insertions: [{ beforeId: 160, ids: [32] }, { beforeId: 162, ids: [31] }] };
  assert.equal((await invoke('preview', { ...input, insertions: [{ beforeId: 162, ids: [32] }, { beforeId: 160, ids: [31] }] })).issue.code,
    'selection_changed');
  assert.equal((await invoke('preview', { ...input, insertions: [{ beforeId: 160, ids: [31] }, { beforeId: 162, ids: [32] }] })).state,
    'invalid_request');
  const preview = await invoke('preview');
  assert.equal(preview.state, 'mirror_preview');
  assert.equal(preview.mirror.total, 66);
  const sequence = [...ids.slice(0, 60), 32, ...ids.slice(60, 62), 31, ...ids.slice(62)];
  assert.deepEqual(preview.mirror.posts.map(post => post.id), sequence);
  // The second page is short, so it is the last one: no extra empty page is requested.
  assert.ok(oldOffsets.has(104) && !oldOffsets.has(100));
  const approval = await invoke('approve', { ...input, confirm: true, approval: preview.mirror.approval });
  assert.equal(approval.state, 'mirror_progress');
  assert.equal((await invoke('preview', nextInput)).state, 'mirror_recovery');
  assert.deepEqual(sends, []);
  old.at(-1).message = 'Concurrent edit';
  assert.equal((await invoke('next')).state, 'mirror_changed');
  old.at(-1).message = 'Original caption 163';
  assert.equal((await invoke('next')).state, 'mirror_progress');
  adapter = start();
  assert.equal((await invoke('next')).mirror.copies.length, 1);
  assert.deepEqual(sends, [100]);
  let result;
  for (let step = 2; step < 2 * sequence.length; step++) result = await invoke('next');
  assert.equal(result.state, 'mirror_done');
  assert.deepEqual(sends, sequence);
  assert.deepEqual(result.mirror.copies.map(receipt => receipt.sourceId), sequence);
  assert.equal((await invoke('next')).state, 'mirror_done');
  const nextPreview = await invoke('preview', nextInput);
  assert.equal(nextPreview.state, 'mirror_preview');
  assert.deepEqual(nextPreview.mirror.posts.map(post => post.id), [164, 32]);
  assert.equal((await invoke('approve', { ...nextInput, confirm: true, approval: nextPreview.mirror.approval })).state, 'mirror_progress');
  adapter = start();
  assert.equal((await invoke('status', input)).state, 'mirror_done');
  assert.equal((await invoke('status', nextInput)).state, 'mirror_progress');
  assert.equal(old.length, 64);
  assert.equal(incoming.length, 2);
});
