import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api } from 'teleproto';
import { mtprotoPage } from '../functions/api/rhea/telegram-mtproto.js';
import { mtprotoControl } from './control.mjs';
import { mirrorControl } from './mirror.mjs';
import { mirrorUnits, openMirror, topicSnapshot } from './mirror-messages.mjs';
import { configuration } from './server.mjs';

const source = { channelId: '11111', inviteHash: 'fixtureSourceInvite', topicId: 10 };
const organized = { ...source, topicId: 21 };
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
function nativeVideo(id, cover = false) {
  return new Api.MessageMediaDocument({ video: true, spoiler: true, document: {
    ...document(id).document, mimeType: 'video/mp4',
    attributes: [new Api.DocumentAttributeVideo({ duration: 4, w: 720, h: 480, supportsStreaming: true })],
  }, altDocuments: [document(id + 1000).document], ...(cover && { videoCover: photo().photo, videoTimestamp: 2 }) });
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
  const settings = { ...config, file: join(cache, 'session.enc'),
    ...(options.dual && { mirror: { ...config.mirror, local: organized } }) };
  const posts = fixtures();
  const backup = [];
  const organizedPosts = [];
  const calls = [];
  function copyTo(scope, target, firstId) {
    return async (unit, randomIds, parent) => {
      calls.push({ ids: unit.map(item => item.id), randomIds, parent, ...(options.dual && { side: scope === organized ? 'local' : 'backup' }) });
      if (options.rejectBeforeSend) throw options.rejectBeforeSend;
      const album = unit.length > 1 ? BigInt(target.length + 100) : undefined;
      const ids = unit.map((item, i) => target.length + firstId + i);
      target.push(...unit.map((item, i) => ({ ...item.message, id: ids[i], groupedId: album,
        peerId: { channelId: BigInt(scope.channelId) },
        replyTo: parent === null ? { replyToMsgId: scope.topicId } :
          { replyToMsgId: parent, replyToTopId: scope.topicId } })));
      if (options.rejectAfterSend) throw options.rejectAfterSend;
      if (options.loseReceipt || (options.loseBackupReceipt && scope === destination)) {
        throw new Error('Synthetic network interruption after sending.');
      }
      return ids;
    };
  }
  const transport = {
    sourceTitle: 'Fixture origin / RHEA Mirror Test', destinationTitle: 'Fixture backup / RHEA Mirror Test',
    readSource: async () => readTopic(source, posts),
    readDestination: async () => readTopic(destination, backup),
    copy: copyTo(destination, backup, 31),
    ...(options.dual && { local: { title: 'Fixture origin / RHEA Organized Test',
      read: async () => readTopic(organized, organizedPosts), copy: copyTo(organized, organizedPosts, 40) } }),
    verifyMedia: async list => {
      assert.equal(Boolean(options.dual), false, 'Dual copies verify Telegram metadata without downloading media.');
      assert.ok(list.length >= 1 && list.length <= 10);
      return options.readable !== false;
    },
  };
  const client = { mirror: async () => transport };
  let clock = 1000;
  const start = () => mirrorControl(settings, () => clock);
  let controller = start();
  const call = (op, input = {}) => controller.handle(op, input, client);
  return { cache, settings, call, posts, backup, organizedPosts, calls, client,
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
  assert.deepEqual(await f.call('mirrorpreview'), {
    state: 'mirror_ineligible', issue: { side: 'destination', code: 'destination_not_empty' },
  });
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

  posts.splice(1, 3, ...[801, 802, 803].map((id, index) => post(source, 12 + index,
    { groupedId: 10n, media: nativeVideo(id, index === 0) })));
  const videoAlbum = (await mirror.readSource()).slice(1);
  assert.deepEqual(videoAlbum.map(item => item.contents.kind), ['video', 'video', 'video']);
  assert.ok(videoAlbum.every(item => item.contents.filename === undefined));
  assert.equal(videoAlbum[0].contents.videoCoverId, '108');
  assert.equal(videoAlbum[0].contents.videoTimestamp, 2);
  assert.deepEqual(await mirror.copy(videoAlbum, [5n, 6n, 7n], null), [31, 32, 33]);
  assert.ok(seen[3] instanceof Api.messages.SendMultiMedia);
  assert.deepEqual(seen[3].multiMedia.map(item => item.media.id.id.toString()), ['801', '802', '803']);
  assert.equal(seen[3].multiMedia[0].media.videoCover.id.toString(), '108');
  assert.equal(seen[3].multiMedia[0].media.videoTimestamp, 2);
  assert.equal(seen[3].multiMedia[0].media.spoiler, true);

  posts[3].media.document.size = BigInt(25 * 1024 ** 2 + 1);
  await assert.rejects(mirror.readSource(), { issue: { side: 'source', code: 'unsupported_post', postId: 14, detail: 'file_size' } });
  channels[0].noforwards = true;
  await assert.rejects(openMirror(config.mirror, privateChat, peerFor, invoke), {
    issue: { side: 'source', code: 'group_protected' },
  });
  channels[0].noforwards = false;
  channels[1].creator = false;
  await assert.rejects(openMirror(config.mirror, privateChat, peerFor, invoke), {
    issue: { side: 'destination', code: 'group_not_owned' },
  });
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
  const dual = { ...env, ...mirror, RHEA_TELEGRAM_MIRROR_MODE: 'synthetic-dual',
    RHEA_TELEGRAM_MIRROR_LOCAL_TOPIC_ID: String(organized.topicId) };
  assert.deepEqual(configuration(dual).mirror.local, organized);
  assert.throws(() => configuration({ ...dual, RHEA_TELEGRAM_MIRROR_LOCAL_TOPIC_ID: String(source.topicId) }),
    /Invalid MTProto mirror test configuration/);
  for (const patch of [{ RHEA_TELEGRAM_MIRROR_MODE: '' }, { RHEA_TELEGRAM_MIRROR_DESTINATION_TOPIC_ID: '1' },
    { RHEA_TELEGRAM_MIRROR_DESTINATION_ID: source.channelId }, { RHEA_TELEGRAM_MIRROR_DESTINATION_INVITE: '' }]) {
    assert.throws(() => configuration({ ...env, ...mirror, ...patch }), /Invalid MTProto mirror test configuration/);
  }
});

test('reads the unpaged messages constructor safely and accepts a pinned top-only topic reply', () => {
  const empty = new Api.messages.Messages({ messages: [], topics: [], chats: [], users: [] });
  assert.deepEqual(topicSnapshot(empty, destination.channelId, destination.topicId), []);
  const note = post(source, 11, { message: 'Fixture',
    replyTo: { className: 'MessageReplyHeader', forumTopic: true, replyToTopId: source.topicId } });
  assert.equal(topicSnapshot({ className: 'messages.Messages', messages: [note] }, source.channelId, source.topicId)[0].parent, null);
  assert.equal(topicSnapshot({ className: 'messages.Messages', messages: [note] }, source.channelId, source.topicId + 1), null);
  assert.equal(topicSnapshot({ className: 'messages.MessagesSlice', messages: [] }, destination.channelId, destination.topicId), null);
  assert.equal(topicSnapshot({ className: 'messages.ChannelMessages', count: 0, inexact: true, messages: [] },
    destination.channelId, destination.topicId), null);
});

test('preflight responds with allowlisted side and issue codes only', async t => {
  const f = await harness(t);
  const adapter = mtprotoControl(f.settings, { read: async () => 'fixture-session' }, async (_, invoke) => invoke(f.client));
  const request = () => new Request('https://adapter.example/v1/mirrorpreview', {
    method: 'POST', headers: { Authorization: 'Bearer ' + config.key, 'X-Rhea-Access-Subject': config.actor },
  });
  f.posts.length = 0;
  const response = await adapter(request());
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { state: 'mirror_ineligible', issue: { side: 'source', code: 'source_empty' } });
});

test('previews a cover and a native video album and verifies the original video identities', async t => {
  const f = await harness(t);
  f.posts.splice(1, 3, ...[801, 802, 803].map((id, index) => post(source, 12 + index,
    { groupedId: 10n, media: nativeVideo(id, index === 0) })));
  const preview = await f.approve();
  assert.deepEqual(preview.mirror.posts.map(p => p.kind), ['photo', 'video', 'video', 'video']);
  assert.equal(f.calls.length, 0);
  for (let step = 0; step < 3; step++) assert.equal((await f.call('mirrornext')).state, 'mirror_progress');
  // Alternative encodings are generated by Telegram and are not part of the primary-file comparison.
  f.backup[1].media = nativeVideo(801, true);
  f.backup[1].media.altDocuments = [];
  assert.equal((await f.call('mirrornext')).state, 'mirror_done');
  assert.deepEqual(f.calls.map(call => call.ids), [[11], [12, 13, 14]]);
  assert.deepEqual(f.backup.slice(1).map(item => item.media.document.id.toString()), ['801', '802', '803']);
});

test('dual approval verifies separate destinations and resumes from the durable checkpoint', async t => {
  const f = await harness(t, { dual: true });
  f.organizedPosts.push(post(organized, 39, { message: 'External addition' }));
  assert.deepEqual(await f.call('mirrorpreview'), {
    state: 'mirror_ineligible', issue: { side: 'local', code: 'destination_not_empty' },
  });
  f.organizedPosts.length = 0;
  const preview = await f.approve();
  assert.match(preview.mirror.localDestination, /Organized/);
  assert.equal(f.calls.length, 0);
  for (let step = 0; step < 5; step++) assert.equal((await f.call('mirrornext')).state, 'mirror_progress');
  f.restart();
  const local = await f.call('mirrornext');
  assert.equal(local.mirror.localCopies.length, 4);
  assert.equal(local.mirror.copies.length, 0);
  f.organizedPosts[0].message += ' edited';
  assert.equal((await f.call('mirrornext')).state, 'mirror_changed');
  assert.equal(f.backup.length, 0);
  f.organizedPosts[0].message = f.posts[0].message;
  for (let step = 0; step < 5; step++) assert.equal((await f.call('mirrornext')).state, 'mirror_progress');
  assert.deepEqual((await f.call('mirrornext')).mirror, {
    total: 4, localCopies: [40, 41, 42, 43].map((destinationId, i) => ({ sourceId: i + 11, destinationId })),
    copies: [31, 32, 33, 34].map((destinationId, i) => ({ sourceId: i + 11, destinationId })),
  });
  assert.equal((await f.call('mirrorstatus')).state, 'mirror_done');
  assert.deepEqual(f.calls.map(x => [x.side, x.ids, x.parent]), [
    ['local', [11], null], ['local', [12], 40], ['local', [13, 14], null],
    ['backup', [11], null], ['backup', [12], 31], ['backup', [13, 14], null],
  ]);
});

test('an unknown backup receipt stops the dual run without replaying either destination', async t => {
  const f = await harness(t, { dual: true, loseBackupReceipt: true });
  await f.approve();
  for (let step = 0; step < 6; step++) await f.call('mirrornext');
  await assert.rejects(f.call('mirrornext'), /network interruption/);
  f.restart();
  const status = await f.call('mirrornext');
  assert.equal(status.state, 'mirror_recovery');
  assert.equal(status.mirror.localCopies.length, 4);
  assert.equal(status.mirror.copies.length, 0);
  assert.equal(f.calls.length, 4);
});

test('dual transport serializes 4 GiB file references for both topics without downloading', async () => {
  const channels = [source, destination].map(scope => ({ id: BigInt(scope.channelId), accessHash: 100n,
    title: scope.channelId, creator: true, forum: true, megagroup: true }));
  const scope = { ...config.mirror, local: organized };
  const titles = new Map([[source.topicId, 'RHEA Mirror Test'], [organized.topicId, 'RHEA Organized Test'],
    [destination.topicId, 'RHEA Backup Test']]);
  const media = document(701);
  media.document.size = 4n * 1024n ** 3n;
  const attachment = post(source, 11, { media });
  const targets = [];
  const transport = await openMirror(scope,
    value => channels.find(channel => channel.id.toString() === value.channelId),
    channel => new Api.InputPeerChannel({ channelId: channel.id, accessHash: channel.accessHash }),
    async rpc => {
      if (rpc instanceof Api.messages.GetForumTopicsByID) {
        const id = rpc.topics[0];
        return { topics: [{ className: 'ForumTopic', id, title: titles.get(id) }] };
      }
      if (rpc instanceof Api.messages.GetReplies) return getReplies(source, [attachment]);
      assert.ok(rpc instanceof Api.messages.SendMedia);
      assert.ok(rpc.getBytes().length < 2048);
      assert.equal(rpc.media.id.id.toString(), '701');
      targets.push([rpc.peer.channelId.toString(), rpc.replyTo.replyToMsgId]);
      return { updates: [{ className: 'UpdateMessageID', randomId: rpc.randomId, id: 45 }] };
    }, () => assert.fail('The adapter must not download this document.'));
  const posts = await transport.readSource();
  assert.equal(posts[0].contents.size, Number(media.document.size));
  await transport.local.copy(posts, [1n], null);
  await transport.copy(posts, [2n], null);
  assert.deepEqual(targets, [[source.channelId, organized.topicId], [destination.channelId, destination.topicId]]);
  media.document.size += 1n;
  await assert.rejects(transport.readSource(), { issue: { side: 'source', code: 'unsupported_post', postId: 11, detail: 'large_file_size' } });
});

const rejection = (errorMessage, seconds) => Object.assign(new Error('Synthetic provider rejection.'), { errorMessage, ...(seconds && { seconds }) });

test('a definitive provider rejection retracts the intent so the same unit can be retried', async t => {
  for (const error of [rejection('FLOOD_WAIT_30', 30), rejection('FILE_REFERENCE_EXPIRED')]) {
    const options = { rejectBeforeSend: error };
    const f = await harness(t, options);
    await f.approve();
    await assert.rejects(f.call('mirrornext'), error);
    assert.equal((await f.call('mirrorstatus')).state, 'mirror_progress');
    f.restart();
    assert.equal((await f.call('mirrorstatus')).state, 'mirror_progress');
    assert.equal(f.backup.length, 0);
    options.rejectBeforeSend = undefined;
    assert.equal((await f.call('mirrornext')).mirror.copies.length, 0);
    assert.equal((await f.call('mirrornext')).mirror.copies.length, 1);
    assert.equal(f.calls.length, 2);
    assert.equal(f.backup.length, 1);
  }
});

test('a retracted rejection never resends when the unit had already reached Telegram', async t => {
  const f = await harness(t, { rejectAfterSend: rejection('FLOOD_WAIT_5', 5) });
  await f.approve();
  await assert.rejects(f.call('mirrornext'));
  assert.equal(f.backup.length, 1);
  assert.equal((await f.call('mirrornext')).state, 'mirror_changed');
  assert.equal(f.calls.length, 1);
});

test('an unclassified transport failure still locks the run for manual reconciliation', async t => {
  const f = await harness(t, { rejectBeforeSend: rejection('RPC_CALL_FAIL') });
  await f.approve();
  await assert.rejects(f.call('mirrornext'));
  assert.equal((await f.call('mirrorstatus')).state, 'mirror_recovery');
  assert.equal((await f.call('mirrornext')).state, 'mirror_recovery');
  assert.equal(f.calls.length, 1);
});

test('repeated rejections stop at a bounded journal instead of growing without limit', async t => {
  const options = { rejectBeforeSend: rejection('FLOOD_WAIT_1', 1) };
  const f = await harness(t, options);
  await f.approve();
  let state;
  for (let attempt = 0; attempt < 60 && state !== 'mirror_recovery'; attempt++) {
    try { state = (await f.call('mirrornext')).state; } catch { state = (await f.call('mirrorstatus')).state; }
  }
  assert.equal(state, 'mirror_recovery');
  const [name] = await readdir(f.cache);
  assert.ok((await readFile(join(f.cache, name))).length < 16384);
});

test('an organized topic stays reserved while another backup configuration is unresolved', async t => {
  const f = await harness(t, { dual: true });
  await f.approve();
  const other = mirrorControl({ ...f.settings, mirror: { ...f.settings.mirror,
    destination: { channelId: '33333', inviteHash: 'fixtureOtherInvite', topicId: 50 } } }, () => 1000);
  const reserved = { state: 'mirror_ineligible', issue: { side: 'local', code: 'destination_in_use' } };
  assert.deepEqual(await other.handle('mirrorpreview', {}, f.client), reserved);
  assert.equal((await other.handle('mirrorapprove', { approval: 'x'.repeat(43), confirm: true }, f.client)).state, 'mirror_changed');
  assert.equal((await other.handle('mirrornext', {}, f.client)).state, 'mirror_idle');
  assert.equal((await readdir(f.cache)).filter(name => name.endsWith('.jsonl')).length, 1);
  f.restart();
  assert.equal((await f.call('mirrornext')).state, 'mirror_progress');
});

test('source captions above the media keep their layout and cannot mix inside an album', async () => {
  const channels = [source, destination].map(scope => ({ id: BigInt(scope.channelId), accessHash: 100n,
    title: scope.channelId, creator: true, forum: true, megagroup: true }));
  const privateChat = async scope => channels.find(channel => channel.id.toString() === scope.channelId);
  const peerFor = channel => new Api.InputPeerChannel({ channelId: channel.id, accessHash: channel.accessHash });
  const posts = fixtures();
  posts[0].invertMedia = true;
  const seen = [];
  const invoke = async rpc => {
    if (rpc instanceof Api.messages.GetForumTopicsByID) return { topics: [{ className: 'ForumTopic', id: rpc.topics[0], title: 'RHEA Mirror Test' }] };
    if (rpc instanceof Api.messages.GetReplies) return getReplies(source, posts);
    seen.push(rpc);
    const ids = rpc.multiMedia?.map(media => media.randomId) ?? [rpc.randomId];
    return { updates: ids.map((randomId, i) => ({ className: 'UpdateMessageID', randomId, id: 31 + i })) };
  };
  const mirror = await openMirror(config.mirror, privateChat, peerFor, invoke);
  const inventory = await mirror.readSource();
  assert.equal(inventory[0].contents.invertMedia, true);
  assert.equal('invertMedia' in inventory[1].contents, false);
  await mirror.copy(inventory.slice(0, 1), [1n], null);
  await mirror.copy(inventory.slice(2), [2n, 3n], null);
  assert.equal(seen[0].invertMedia, true);
  assert.notEqual(seen[1].invertMedia, true);
  posts[3].invertMedia = true;
  assert.equal(mirrorUnits(await mirror.readSource()), null);
});

test('dual preflight refuses swapped, stale, closed, misnamed and unauthorized destinations', async () => {
  const scope = { ...config.mirror, local: organized };
  const titles = new Map([[source.topicId, 'RHEA Mirror Test'], [organized.topicId, 'RHEA Organized Test'],
    [destination.topicId, 'RHEA Backup Test']]);
  const channels = () => [source, destination].map(item => ({ id: BigInt(item.channelId), accessHash: 100n,
    title: item.channelId, creator: true, forum: true, megagroup: true }));
  const open = async ({ chats = channels(), names = titles, patch = {}, failure } = {}) => openMirror(scope,
    async value => {
      if (failure) throw failure;
      return chats.find(chat => chat.id.toString() === value.channelId);
    },
    chat => new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash }),
    async rpc => {
      if (rpc instanceof Api.messages.GetForumTopicsByID) {
        const id = rpc.topics[0];
        if (patch.missing === id) throw rejection('TOPIC_ID_INVALID');
        return { topics: [{ className: 'ForumTopic', id, title: names.get(id), ...(patch.closed === id && { closed: true }) }] };
      }
      return getReplies(source, []);
    });
  await open();
  const swapped = new Map(titles).set(organized.topicId, 'RHEA Backup Test').set(destination.topicId, 'RHEA Organized Test');
  await assert.rejects(open({ names: swapped }), { issue: { side: 'destination', code: 'dual_topic_name' } });
  const swappedSource = new Map(titles).set(source.topicId, 'RHEA Organized Test').set(organized.topicId, 'RHEA Mirror Test');
  await assert.rejects(open({ names: swappedSource }), { issue: { side: 'source', code: 'topic_name' } });
  await assert.rejects(open({ patch: { closed: destination.topicId } }), { issue: { side: 'destination', code: 'topic_closed' } });
  await assert.rejects(open({ patch: { closed: organized.topicId } }), { issue: { side: 'local', code: 'topic_closed' } });
  await assert.rejects(open({ patch: { missing: organized.topicId } }), { issue: { side: 'local', code: 'topic_missing' } });
  await assert.rejects(open({ failure: rejection('INVITE_HASH_EXPIRED') }), { issue: { side: 'source', code: 'group_unavailable' } });
  await assert.rejects(open({ chats: [] }), { issue: { side: 'source', code: 'group_unavailable' } });
  const unowned = channels();
  unowned[1].creator = false;
  await assert.rejects(open({ chats: unowned }), { issue: { side: 'destination', code: 'group_not_owned' } });
  const plain = channels();
  plain[1].forum = false;
  await assert.rejects(open({ chats: plain }), { issue: { side: 'destination', code: 'group_not_forum' } });
  const protectedDestination = channels();
  protectedDestination[1].noforwards = true;
  await assert.rejects(open({ chats: protectedDestination }), { issue: { side: 'destination', code: 'group_protected' } });
});

test('journals keep every approval, receipt and verification step without content or secrets', async t => {
  const f = await harness(t, { dual: true });
  await f.approve();
  for (let step = 0; step < 16; step++) await f.call('mirrornext');
  const [journal] = (await readdir(f.cache)).filter(name => name.endsWith('.jsonl'));
  const lines = (await readFile(join(f.cache, journal), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].type, 'approved');
  assert.deepEqual([...new Set(lines.slice(1).map(line => line.type))].sort(), ['intent', 'receipt', 'verified']);
  assert.equal((await readdir(f.cache)).filter(name => name.endsWith('.lock')).length, 1);
  assert.doesNotMatch(JSON.stringify(lines), /Aurora|secret|Fixture|Invite|token/);
});
