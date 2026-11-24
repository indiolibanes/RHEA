import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api } from 'teleproto';
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
        if (query.msgId === 1) return messages(source);
        return messages([...targets[query.msgId]].reverse());
      }
      assert.ok(query instanceof Api.messages.SendMedia);
      assert.ok(query.getBytes().length > 0);
      const to = query.replyTo.replyToMsgId;
      assert.ok(to === 8 || to === 9);
      assert.equal(query.peer.channelId.toString(), to === 8 ? '11111' : '22222');
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
    (_session, callback) => transport(null, callback));
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
  return { invoke, approve, source, sends, targets, restart: () => { adapter = start(); },
    loseReceipt: () => { failReceipt = true; } };
}

test('copies only the approved files from General in the selected order to both verified targets', async t => {
  const run = await setup(t);
  assert.equal((await run.invoke('next')).state, 'mirror_idle');
  await run.approve();
  assert.equal((await run.invoke('next')).state, 'mirror_progress');
  run.restart();
  let result;
  for (let i = 1; i < 12; i++) result = await run.invoke('next');
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
  const check = (operation, headers, body, data = { cloudflareAccess: { JWT: { payload: { sub: scope.actor } } } }) =>
    mtprotoPage({ request: new Request(origin + '/api/rhea/telegram-mtproto?op=organize' + operation, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
    }), data, env: { RHEA_TELEGRAM_MTPROTO_ORIGIN: 'https://adapter.example',
      RHEA_TELEGRAM_MTPROTO_KEY: scope.key, RHEA_TELEGRAM_CF_CLIENT_ID: 'test', RHEA_TELEGRAM_CF_CLIENT_SECRET: 'test',
    } }, () => { assert.fail('Rejected input must never reach the adapter.'); });
  assert.equal((await check('approve', { Origin: origin }, selection)).status, 400);
  assert.equal((await check('preview', { Origin: 'https://other.example' }, selection)).status, 403);
  assert.equal((await check('preview', { Origin: origin }, selection, {})).status, 401);
  assert.equal((await check('preview', { Origin: origin }, { ...selection, localTopicId: 1 })).status, 400);
  assert.equal((await check('preview', { Origin: origin }, { ...selection, ids: [32, 32] })).status, 400);
});

test('rebuilds a paginated letter with all unclassified posts and preserves the owner-approved insertion point', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rhea-rebuild-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { ...scope, rebuildEnabled: true, file: join(directory, 'session.enc') };
  const ids = Array.from({ length: 64 }, (_, i) => 100 + i);
  const old = ids.map(id => ({ ...rawPost(id, id), replyTo: { replyToMsgId: 8 }, message: 'Original caption ' + id }));
  const incoming = [rawPost(31, '02'), rawPost(32, '01')];
  const destination = [];
  const sends = [];
  const oldOffsets = new Set();
  const provider = () => ({
    connect: async () => {}, destroy: async () => {}, updateManager: { stop() {} },
    async invoke({ query }) {
      if (query instanceof Api.users.GetUsers) return [{ id: 700n }];
      if (query instanceof Api.messages.CheckChatInvite) return { className: 'ChatInviteAlready', chat: {
        className: 'Channel', id: 11111n, accessHash: 4n, title: 'Fixture forum', forum: true, megagroup: true, creator: true,
      } };
      if (query instanceof Api.messages.GetForumTopicsByID) {
        const [id] = query.topics;
        return { topics: [{ className: 'ForumTopic', id, title: id === 8 ? 'Letter T' : 'Letter T [NEW]' }] };
      }
      if (query instanceof Api.messages.GetReplies) {
        assert.equal(query.peer.channelId.toString(), '11111');
        if (query.msgId === 8) oldOffsets.add(query.offsetId);
        const rows = query.msgId === 8 ? old : query.msgId === 1 ? incoming : destination;
        const sorted = [...rows].reverse().filter(post => !query.offsetId || post.id < query.offsetId);
        return { className: 'messages.ChannelMessages', count: rows.length, messages: sorted.slice(0, query.limit) };
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
  const input = { sourceTopicId: 1, currentTopicId: 8, replacementTopicId: 9, beforeId: 160, letter: 'T', ids: [32, 31] };
  const invoke = async (op, body = input) => {
    const response = await adapter(new Request('https://adapter.example/v1/rebuild' + op, {
      method: 'POST', headers: { Authorization: 'Bearer ' + config.key, 'X-Rhea-Access-Subject': config.actor },
      body: JSON.stringify(body),
    }));
    return response.json();
  };
  assert.equal((await invoke('next')).state, 'mirror_idle');
  assert.equal((await invoke('preview', { ...input, beforeId: 404 })).issue.code, 'selection_changed');
  old[59].groupedId = old[60].groupedId = 77n;
  assert.equal((await invoke('preview')).issue.code, 'album_or_reply');
  delete old[59].groupedId;
  delete old[60].groupedId;
  destination.push({ id: 200 });
  assert.equal((await invoke('preview')).issue.code, 'destination_not_empty');
  destination.pop();
  const preview = await invoke('preview');
  assert.equal(preview.state, 'mirror_preview');
  assert.equal(preview.mirror.total, 66);
  const sequence = [...ids.slice(0, 60), 32, 31, ...ids.slice(60)];
  assert.deepEqual(preview.mirror.posts.map(post => post.id), sequence);
  assert.ok(oldOffsets.has(104) && oldOffsets.has(100));
  const approval = await invoke('approve', { ...input, confirm: true, approval: preview.mirror.approval });
  assert.equal(approval.state, 'mirror_progress');
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
  assert.equal(old.length, 64);
  assert.equal(incoming.length, 2);
});
