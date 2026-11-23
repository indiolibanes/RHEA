import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api } from 'teleproto';
import { mtprotoPage } from '../functions/api/rhea/telegram-mtproto.js';
import { mtprotoControl } from './control.mjs';
import { mirrorControl } from './mirror.mjs';
import { openMirror, topicSnapshot } from './mirror-messages.mjs';
import { configuration } from './server.mjs';

const source = { channelId: '11111', inviteHash: 'fixtureSourceInvite', topicId: 10 };
const destination = { channelId: '22222', inviteHash: 'fixtureTargetInvite', topicId: 20 };
const config = { actor: 'fixture-owner', ownerId: '777', key: 'x'.repeat(43), mirror: { source, destination } };
const entity = new Api.MessageEntityBold({ offset: 0, length: 6 });
const spoiler = new Api.MessageEntitySpoiler({ offset: 0, length: 6 });
const ref = Buffer.from([1, 2, 3]);
const root = scope => ({ className: 'MessageService', id: scope.topicId, peerId: { channelId: BigInt(scope.channelId) } });
function photo() {
  return { className: 'MessageMediaPhoto', spoiler: true,
    photo: { className: 'Photo', id: 108n, accessHash: 33n, fileReference: ref } };
}
function document(id) {
  return { className: 'MessageMediaDocument', document: {
    className: 'Document', id: BigInt(id), accessHash: 34n, fileReference: ref, size: 28672n,
    mimeType: 'video/x-matroska', attributes: [{ className: 'DocumentAttributeFilename', fileName: '[Team] Ação ' + id + '.mkv' }],
  } };
}
function post(scope, id, extra) {
  return { className: 'Message', id, peerId: { channelId: BigInt(scope.channelId) },
    replyTo: { replyToMsgId: scope.topicId }, message: '', ...extra };
}
function fixtures() {
  return [
    post(source, 11, { message: 'Aurora [56 KiB]', entities: [entity], media: photo() }),
    post(source, 12, { message: 'secret', entities: [spoiler], replyTo: { replyToMsgId: 11, replyToTopId: 10 } }),
    post(source, 13, { groupedId: 9n, media: document(701) }),
    post(source, 14, { groupedId: 9n, media: document(702) }),
  ];
}
const getReplies = (scope, posts) => ({ count: posts.length, messages: [...posts].reverse().concat(root(scope)) });
const readTopic = (scope, posts) => topicSnapshot(getReplies(scope, posts), scope.channelId, scope.topicId);

async function harness(t, options = {}) {
  const cache = await mkdtemp(join(tmpdir(), 'rhea-mirror-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const settings = { ...config, file: join(cache, 'session.enc') };
  const posts = fixtures();
  const backup = [];
  const calls = [];
  const transport = {
    sourceTitle: 'Fixture origin / RHEA Mirror Test', destinationTitle: 'Fixture backup / RHEA Mirror Test',
    readSource: async () => readTopic(source, posts),
    readDestination: async () => readTopic(destination, backup),
    async copy(unit, randomIds, parent) {
      calls.push({ ids: unit.map(item => item.id), randomIds, parent });
      const album = unit.length > 1 ? BigInt(backup.length + 100) : undefined;
      const ids = unit.map((item, i) => backup.length + 31 + i);
      backup.push(...unit.map((item, i) => ({ ...item.message, id: ids[i], groupedId: album,
        peerId: { channelId: BigInt(destination.channelId) },
        replyTo: parent === null ? { replyToMsgId: destination.topicId } :
          { replyToMsgId: parent, replyToTopId: destination.topicId } })));
      if (options.loseReceipt) throw new Error('Synthetic network interruption after sending.');
      return ids;
    },
    verifyMedia: async list => {
      assert.ok(list.length >= 1 && list.length <= 10);
      return options.readable !== false;
    },
  };
  const client = { mirror: async () => transport };
  let clock = 1000;
  const start = () => mirrorControl(settings, () => clock);
  let controller = start();
  const call = (op, input = {}) => controller.handle(op, input, client);
  return { cache, settings, call, posts, backup, calls, client,
    restart: () => { controller = start(); }, expire: () => { clock += 300001; },
    async approve() {
      const preview = await call('mirrorpreview');
      assert.equal(preview.state, 'mirror_preview');
      assert.equal((await call('mirrorapprove', { approval: preview.mirror.approval, confirm: true })).state, 'mirror_progress');
      return preview;
    } };
}

test('copies a cover, a spoiler reply and a document album with durable verified mappings', async t => {
  const f = await harness(t);
  assert.equal((await f.call('mirrornext')).state, 'mirror_idle');
  const preview = await f.approve();
  assert.deepEqual(preview.mirror.posts.map(p => p.id), [11, 12, 13, 14]);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call('mirrornext')).mirror.copies.length, 0);
  f.restart();
  const verifiedAfterRestart = await f.call('mirrornext');
  assert.deepEqual(verifiedAfterRestart.mirror.copies, [{ sourceId: 11, destinationId: 31 }]);
  for (let step = 0; step < 3; step++) assert.equal((await f.call('mirrornext')).state, 'mirror_progress');
  const completed = await f.call('mirrornext');
  assert.equal(completed.state, 'mirror_done');
  assert.equal(completed.mirror.copies.length, 4);
  assert.deepEqual(f.calls.map(call => [call.ids, call.parent]), [[[11], null], [[12], 31], [[13, 14], null]]);
  assert.deepEqual(f.backup[2].media.document.attributes, f.posts[2].media.document.attributes);
  assert.equal((await f.call('mirrornext')).state, 'mirror_done');
  assert.deepEqual(completed, await f.call('mirrorstatus'));
  const [name] = await readdir(f.cache);
  const log = await readFile(join(f.cache, name), 'utf8');
  assert.doesNotMatch(log, /Aurora|secret|Fixture|Invite|Ação|token/);
});

test('denies edited previews, expired approval, external posts and protected content', async t => {
  const f = await harness(t);
  const preview = await f.call('mirrorpreview');
  f.expire();
  assert.equal((await f.call('mirrorapprove', { approval: preview.mirror.approval, confirm: true })).state, 'mirror_changed');
  const fresh = await f.call('mirrorpreview');
  f.posts[0].message += ' edited';
  assert.equal((await f.call('mirrorapprove', { approval: fresh.mirror.approval, confirm: true })).state, 'mirror_changed');
  f.posts[1].noforwards = true;
  assert.equal((await f.call('mirrorpreview')).state, 'mirror_ineligible');
  f.posts[1].noforwards = false;
  f.backup.push(post(destination, 30, { message: 'External addition' }));
  assert.equal((await f.call('mirrorpreview')).state, 'mirror_ineligible');
  f.backup.length = 0;
  await f.approve();
  f.backup.push(post(destination, 30, { message: 'External addition' }));
  assert.equal((await f.call('mirrornext')).state, 'mirror_changed');
  assert.equal(f.calls.length, 0);
});

test('a write with a lost receipt is never automatically resent after restart', async t => {
  const f = await harness(t, { loseReceipt: true });
  await f.approve();
  await assert.rejects(f.call('mirrornext'), /network interruption/);
  f.restart();
  assert.equal((await f.call('mirrorstatus')).state, 'mirror_recovery');
  assert.equal((await f.call('mirrornext')).state, 'mirror_recovery');
  assert.equal(f.calls.length, 1);
});

test('a known receipt can be verified later without resending the unit', async t => {
  const options = { readable: false };
  const f = await harness(t, options);
  await f.approve();
  await f.call('mirrornext');
  assert.equal((await f.call('mirrornext')).state, 'mirror_changed');
  options.readable = true;
  f.restart();
  assert.equal((await f.call('mirrornext')).mirror.copies.length, 1);
  assert.equal(f.calls.length, 1);
});

test('rejects partial topics, out-of-topic messages and noncontiguous albums', async t => {
  const f = await harness(t);
  const result = getReplies(source, f.posts);
  assert.equal(topicSnapshot({ ...result, count: 25 }, source.channelId, source.topicId), null);
  f.posts[2].replyTo = { replyToMsgId: 42 };
  assert.equal((await f.call('mirrorpreview')).state, 'mirror_ineligible');
  f.posts[2].replyTo = { replyToMsgId: 10 };
  f.posts.splice(3, 0, post(source, 14, { message: 'Separator' }));
  f.posts[4].id++;
  assert.equal((await f.call('mirrorpreview')).state, 'mirror_ineligible');
});

test('Teleproto RPCs target the pinned forum topic and reuse native files', async () => {
  const channels = [source, destination].map(scope => ({ id: BigInt(scope.channelId), accessHash: 100n,
    title: scope.channelId, creator: true, forum: true, megagroup: true }));
  const privateChat = async scope => channels.find(channel => channel.id.toString() === scope.channelId);
  const peerFor = channel => new Api.InputPeerChannel({ channelId: channel.id, accessHash: channel.accessHash });
  const posts = fixtures();
  const seen = [];
  const invoke = async (rpc, options) => {
    assert.ok(rpc.getBytes().length > 0);
    if (rpc instanceof Api.messages.GetForumTopicsByID) {
      const expected = rpc.peer.channelId.toString() === source.channelId ? source.topicId : destination.topicId;
      assert.deepEqual(rpc.topics, [expected]);
      return { topics: [{ className: 'ForumTopic', id: expected, title: 'RHEA Mirror Test' }] };
    }
    if (rpc instanceof Api.messages.GetReplies) {
      assert.equal(rpc.msgId, source.topicId);
      return getReplies(source, posts);
    }
    assert.equal(options.maxRetryCount, 1);
    assert.equal(rpc.peer.channelId.toString(), destination.channelId);
    seen.push(rpc);
    const ids = rpc.multiMedia?.map(media => media.randomId) ?? [rpc.randomId];
    return { updates: ids.map((randomId, i) => ({ className: 'UpdateMessageID', randomId, id: 31 + i })) };
  };
  const mirror = await openMirror(config.mirror, privateChat, peerFor, invoke, async function* () { yield Buffer.from('file'); });
  const inventory = await mirror.readSource();
  assert.deepEqual(await mirror.copy(inventory.slice(0, 1), [1n], null), [31]);
  assert.deepEqual(await mirror.copy(inventory.slice(1, 2), [2n], 31), [31]);
  assert.deepEqual(await mirror.copy(inventory.slice(2), [3n, 4n], null), [31, 32]);
  assert.ok(seen[0] instanceof Api.messages.SendMedia);
  assert.equal(seen[0].media.spoiler, true);
  assert.equal(seen[0].replyTo.replyToMsgId, destination.topicId);
  assert.ok(seen[1] instanceof Api.messages.SendMessage);
  assert.equal(seen[1].replyTo.replyToMsgId, 31);
  assert.equal(seen[1].replyTo.topMsgId, destination.topicId);
  assert.deepEqual(seen[1].entities, [spoiler]);
  assert.ok(seen[2] instanceof Api.messages.SendMultiMedia);
  assert.deepEqual(seen[2].multiMedia.map(item => item.media.id.id.toString()), ['701', '702']);
  assert.equal(await mirror.verifyMedia(inventory), true);
  channels[0].noforwards = true;
  assert.equal(await openMirror(config.mirror, privateChat, peerFor, invoke), null);
});

test('new operations enforce Access identity, same origin, and explicit approval input', async t => {
  const f = await harness(t);
  const env = { RHEA_TELEGRAM_MTPROTO_ORIGIN: 'https://adapter.example',
    RHEA_TELEGRAM_MTPROTO_KEY: config.key, RHEA_TELEGRAM_CF_CLIENT_ID: 'test', RHEA_TELEGRAM_CF_CLIENT_SECRET: 'test' };
  const data = { cloudflareAccess: { JWT: { payload: { sub: config.actor } } } };
  const adapter = mtprotoControl(f.settings, { read: async () => 'synthetic-encrypted-session' },
    async (saved, invoke) => invoke(f.client));
  function request(op, options = {}) {
    const { origin = 'https://workspace.example', body, actor = config.actor } = options;
    return mtprotoPage({
      env, data: actor === config.actor ? data : { cloudflareAccess: { JWT: { payload: { sub: actor } } } },
      request: new Request('https://workspace.example/api/rhea/telegram-mtproto?op=' + op, {
        method: 'POST', headers: { Origin: origin, ...(body && { 'Content-Type': 'application/json' }) },
        ...(body && { body: JSON.stringify(body) }),
      }),
    }, (url, init) => adapter(new Request(url, init)));
  }
  assert.equal((await request('mirrorpreview', { origin: 'https://other.example' })).status, 403);
  assert.equal((await request('mirrorpreview', { actor: 'another-operator' })).status, 403);
  const preview = await (await request('mirrorpreview')).json();
  assert.equal(preview.state, 'mirror_preview');
  assert.equal((await request('mirrorapprove', { body: { approval: preview.mirror.approval, confirm: false } })).status, 400);
  assert.equal((await request('mirrorapprove', { body: { approval: preview.mirror.approval, confirm: true, channelId: '11111' } })).status, 400);
  assert.equal((await request('mirrorapprove', { body: { approval: preview.mirror.approval, confirm: true } })).status, 200);
  assert.equal(f.calls.length, 0);
});

test('mirror runtime refuses incomplete settings, shared targets and the General topic', () => {
  const env = { RHEA_TELEGRAM_MTPROTO_MODE: 'sandbox', RHEA_TELEGRAM_API_ID: '77', RHEA_TELEGRAM_API_HASH: 'a'.repeat(32),
    RHEA_TELEGRAM_CHANNEL_ID: '33333', RHEA_TELEGRAM_OWNER_ID: config.ownerId, RHEA_TELEGRAM_PHONE: '+15550001111',
    RHEA_TELEGRAM_CHANNEL_INVITE: 'https://t.me/+fixtureChannelInvite', RHEA_TELEGRAM_ACCESS_SUB: config.actor,
    RHEA_TELEGRAM_MTPROTO_KEY: config.key, RHEA_TELEGRAM_SESSION_KEY: 'y'.repeat(43),
    RHEA_TELEGRAM_SESSION_FILE: '/tmp/fixture-session.enc' };
  const mirror = { RHEA_TELEGRAM_MIRROR_MODE: 'synthetic',
    RHEA_TELEGRAM_MIRROR_SOURCE_ID: source.channelId, RHEA_TELEGRAM_MIRROR_SOURCE_INVITE: 'https://t.me/+' + source.inviteHash,
    RHEA_TELEGRAM_MIRROR_SOURCE_TOPIC_ID: String(source.topicId),
    RHEA_TELEGRAM_MIRROR_DESTINATION_ID: destination.channelId,
    RHEA_TELEGRAM_MIRROR_DESTINATION_INVITE: 'https://t.me/+' + destination.inviteHash,
    RHEA_TELEGRAM_MIRROR_DESTINATION_TOPIC_ID: String(destination.topicId) };
  assert.equal(configuration(env).mirror, undefined);
  assert.deepEqual(configuration({ ...env, ...mirror }).mirror, config.mirror);
  for (const patch of [{ RHEA_TELEGRAM_MIRROR_MODE: '' }, { RHEA_TELEGRAM_MIRROR_DESTINATION_TOPIC_ID: '1' },
    { RHEA_TELEGRAM_MIRROR_DESTINATION_ID: source.channelId }, { RHEA_TELEGRAM_MIRROR_DESTINATION_INVITE: '' }]) {
    assert.throws(() => configuration({ ...env, ...mirror, ...patch }), /Invalid MTProto mirror test configuration/);
  }
});
