import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api } from 'teleproto';
import { filenameReference, forumDocumentTotals } from '../src/rhea/library/forum-names.mjs';
import { inputFor, mtprotoResult } from '../src/rhea/library/mtproto-contract.mjs';
import { forumReader } from './forum.mjs';
import { telegramClient } from './telegram.mjs';

const config = { actor: 'fixture-access-actor', ownerId: '123456789', key: 'x'.repeat(43),
  apiId: 12345, apiHash: 'a'.repeat(32), forum: { channelId: '1234567890', inviteHash: 'fixture-forum-invite' } };
const topicId = 30;
const examplePost = {
  className: 'Message', id: 100, peerId: { channelId: 1234567890n },
  replyTo: { replyToTopId: topicId }, groupedId: 777n,
  media: { document: { size: 4864n, attributes: [{ className: 'DocumentAttributeFilename', fileName: '[Team] Aurora [12345678].mkv' }] } },
};

test('lists 27 topics from paginated results and keeps the cursor scoped', async () => {
  const topics = Array.from({ length: 27 }, (_, n) => ({
    className: 'ForumTopic', id: n + 2, title: n === 26 ? 'Números' : String.fromCharCode(65 + n),
    topMessage: 100 + n, date: 400 + n,
  }));
  const transport = { topics: async (offset) => {
    if (offset.topic === 0) return { topics: topics.slice(0, 20), count: 27, orderByCreateDate: true };
    assert.deepEqual(offset, { topic: 21, id: 119, date: 419 });
    return { topics: topics.slice(20), count: 27, orderByCreateDate: true };
  }};
  const first = await forumReader(config, transport)('forumtopics', { cursor: null });
  assert.equal(first.forum.topics.length, 20);
  const second = await forumReader(config, transport)('forumtopics', { cursor: first.forum.next });
  assert.equal(second.forum.topics.length, 7);
  assert.equal(second.forum.next, null);
  assert.equal((await forumReader({ ...config, actor: 'other' }, transport)('forumtopics', { cursor: first.forum.next })).state,
    'forum_cursor_invalid');
});

test('reads 620 topic posts across pages without duplicates or authenticated writes', async () => {
  const history = Array.from({ length: 620 }, (_, n) => ({ ...examplePost, id: 650 - n, groupedId: BigInt(777 + Math.floor(n / 10)) }));
  const transport = {
    hasTopic: async id => id === topicId,
    posts: async (topic, offset, limit) => {
      assert.equal(topic, topicId);
      return { messages: history.filter(post => !offset || post.id < offset).slice(0, limit) };
    },
  };
  let cursor = null;
  const received = [];
  do {
    const page = await forumReader(config, transport)('forumpage', { topicId, cursor });
    assert.equal(page.state, 'forum_page');
    if (page.forum.posts.length) assert.equal(page.forum.posts[0].albumId, history[received.length].groupedId.toString());
    received.push(...page.forum.posts.map(post => post.id));
    cursor = page.forum.next;
  } while (cursor);
  assert.deepEqual(received, history.map(post => post.id));
  const first = await forumReader(config, transport)('forumpage', { topicId, cursor: null });
  assert.equal((await forumReader(config, transport)('forumpage', { topicId: 31, cursor: first.forum.next })).state,
    'forum_cursor_invalid');
});

test('projects covers, bold titles, sizes and filenames and rejects cross-topic messages', async () => {
  const cover = { ...examplePost, id: 99, groupedId: undefined,
    message: 'Aurora — Temporada 2 [1,25 GiB]',
    entities: [{ className: 'MessageEntityBold', offset: 0, length: 20 }], media: { photo: {} } };
  const transport = { protected: true, hasTopic: async () => true, posts: async () => ({ messages: [examplePost, cover] }) };
  const result = await forumReader(config, transport)('forumpage', { topicId, cursor: null });
  assert.equal(result.state, 'forum_page');
  assert.equal(result.forum.posts[1].kind, 'cover');
  assert.equal(result.forum.posts[1].heading, 'Aurora — Temporada 2');
  assert.equal(result.forum.posts[1].declaredSize, '1,25 GiB');
  assert.equal(result.forum.posts[0].filename, '[Team] Aurora [12345678].mkv');
  assert.equal(result.forum.posts[0].sizeBytes, 4864);
  assert.equal(result.forum.posts[0].protected, true);
  const injected = { ...transport, posts: async () => ({ messages: [{ ...examplePost, replyTo: { replyToTopId: 31 } }] }) };
  assert.equal((await forumReader(config, injected)('forumpage', { topicId, cursor: null })).state, 'forum_changed');
  assert.equal(inputFor('forumpage', { topicId, cursor: null, channelId: '999' }), null);
  assert.deepEqual(await mtprotoResult('forum_page', result).json(), JSON.parse(JSON.stringify(result)));
});

test('matches literal reference names and unique hexadecimal tags and rejects ambiguity', () => {
  const md = ['## Animes', '### Aurora', '#### Parte 2', '- `[Team] Aurora 03 [12345678]`',
    '- `[Team] Aurora 04 [DEAD1234]`', '- `[Other] Aurora 04 [DEAD1234]`'].join('\n');
  const ref = filenameReference(md);
  assert.equal(ref.count, 3);
  assert.deepEqual(ref.match('[Team] Aurora 03 [12345678].mkv'),
    { name: '[Team] Aurora 03 [12345678]', series: 'Aurora', section: 'Parte 2', reason: 'exact' });
  assert.equal(ref.match('alterado [12345678].mkv').reason, 'tag');
  assert.equal(ref.match('alterado [DEAD1234].mkv').reason, 'ambiguous');
  assert.equal(ref.match('alterado sem etiqueta.mkv').reason, 'unmatched');
});

test('uses read RPCs only on the configured private forum', async () => {
  const calls = [];
  const makeClient = channel => () => ({
    connect: async () => {}, destroy: async () => {}, updateManager: { stop() {} },
    async invoke(wrapper) {
      const rpc = wrapper.query;
      calls.push(rpc.className);
      if (rpc instanceof Api.users.GetUsers) return [{ id: BigInt(config.ownerId) }];
      if (rpc instanceof Api.messages.CheckChatInvite) return { className: 'ChatInviteAlready', chat: channel };
      assert.equal(rpc.peer.channelId.toString(), config.forum.channelId);
      assert.ok(rpc.getBytes().length > 0);
      if (rpc instanceof Api.messages.GetForumTopicsByID) return { topics: [{ className: 'ForumTopic', id: topicId }] };
      assert.ok(rpc instanceof Api.messages.GetReplies);
      assert.equal(rpc.msgId, topicId);
      return { messages: [examplePost] };
    },
  });
  const channel = { className: 'Channel', id: BigInt(config.forum.channelId), accessHash: 1n, megagroup: true, forum: true };
  const read = peer => telegramClient(config, makeClient(peer))(null,
    client => client.forumInventory('forumpage', { topicId, cursor: null }));
  assert.equal((await read({ ...channel, username: 'public-forum' })).state, 'forum_unavailable');
  calls.length = 0;
  assert.equal((await read(channel)).state, 'forum_page');
  assert.deepEqual(calls, ['users.GetUsers', 'messages.CheckChatInvite', 'messages.GetForumTopicsByID', 'messages.GetReplies']);
});

test('totals document bytes by exact, unambiguous Markdown section without guessing missing matches', () => {
  const reference = filenameReference([
    '### Aurora', '#### Part 1', '- `Aurora 01 [12345678].mkv`', '- `Duplicated title.mkv`',
    '#### Part 2', '- `Duplicated title.mkv`', '- `Aurora 03.mkv`',
  ].join('\n'));
  const make = (filename, size) => ({ post: { kind: 'document', filename, sizeBytes: size },
    referenceMatch: reference.match(filename) });
  assert.equal(reference.match('Duplicated title.mkv').reason, 'ambiguous');
  const result = forumDocumentTotals([
    make('Aurora 01 [12345678].mkv', 100), make('Aurora 03.mkv'), make('Duplicated title.mkv', 200),
    make('Altered [12345678].mkv', 300), { post: { kind: 'cover', sizeBytes: 400 } },
  ]);
  assert.deepEqual(result, { count: 4, sized: 3, bytes: 600n, groups: [
    { series: 'Aurora', section: 'Part 1', count: 1, sized: 1, bytes: 100n },
    { series: 'Aurora', section: 'Part 2', count: 1, sized: 0, bytes: 0n },
  ] });
});

test('reads General even when named Requests and advances past service-only pages', async () => {
  const numberedTopic = { ...examplePost, replyTo: { className: 'MessageReplyHeader', forumTopic: true, replyToMsgId: topicId },
    message: 'Other topic must not appear' };
  const direct = { ...examplePost, id: 83, replyTo: undefined, message: 'General document' };
  const reply = { ...direct, id: 82, replyTo: { className: 'MessageReplyHeader', replyToMsgId: 80 }, message: 'General reply' };
  const rootReply = { ...reply, id: 81, replyTo: { ...reply.replyTo, replyToTopId: 1 } };
  const transport = {
    topics: async () => ({ topics: [{ className: 'ForumTopic', id: 1, title: 'Requests' }], count: 1 }),
    hasTopic: () => assert.fail('General is implicit in a verified forum.'),
    async posts(topic, offset, limit) {
      assert.equal(topic, 1);
      assert.equal(limit, 60);
      const pages = new Map([[0, [{ ...direct, className: 'MessageService', id: 99 }, { className: 'MessageEmpty', id: 98 }]],
        [98, [direct, reply, rootReply]], [81, []]]);
      assert.ok(pages.has(offset));
      return { messages: pages.get(offset) };
    },
  };
  const read = forumReader(config, transport);
  assert.equal((await read('forumtopics', { cursor: null })).forum.topics[0].title, 'Requests');
  const first = await read('forumpage', { topicId: 1, cursor: null });
  assert.equal(first.state, 'forum_page');
  assert.deepEqual(first.forum.posts, []);
  assert.ok(first.forum.next);
  assert.equal((await read('forumpage', { topicId, cursor: first.forum.next })).state, 'forum_cursor_invalid');
  const second = await read('forumpage', { topicId: 1, cursor: first.forum.next });
  assert.deepEqual(second.forum.posts.map(({ id, caption }) => [id, caption]), [
    [83, 'General document'], [82, 'General reply'], [81, 'General reply'],
  ]);
  assert.equal(second.forum.posts[0].albumId, '777');
  assert.equal(second.forum.posts[0].sizeBytes, 4864);
  assert.equal((await read('forumpage', { topicId: 1, cursor: second.forum.next })).forum.next, null);
  for (const wrong of [numberedTopic, { ...numberedTopic, replyTo: { replyToTopId: 31 } },
    { ...direct, peerId: { channelId: 999n } }]) {
    const injected = forumReader(config, { posts: async () => ({ messages: [{ ...direct, id: 100 }, { ...wrong, id: 99 }] }) });
    const rejected = await injected('forumpage', { topicId: 1, cursor: null });
    assert.deepEqual(rejected, { state: 'forum_changed' });
  }
});

test('General issues a bounded read request scoped to topic 1 of the pinned supergroup', async () => {
  const calls = [];
  const client = () => ({
    connect: async () => {}, destroy: async () => {}, updateManager: { stop() {} },
    async invoke(wrapper) {
      const rpc = wrapper.query;
      calls.push(rpc.className);
      if (rpc instanceof Api.users.GetUsers) return [{ id: BigInt(config.ownerId) }];
      if (rpc instanceof Api.messages.CheckChatInvite) return { className: 'ChatInviteAlready',
        chat: { className: 'Channel', id: BigInt(config.forum.channelId), accessHash: 1n, megagroup: true, forum: true } };
      assert.ok(rpc instanceof Api.messages.GetReplies);
      assert.equal(rpc.msgId, 1);
      assert.equal(rpc.peer.channelId.toString(), config.forum.channelId);
      assert.equal(rpc.limit, 60);
      assert.ok(rpc.getBytes().length > 0);
      return { messages: [{ ...examplePost, replyTo: undefined }] };
    },
  });
  const page = await telegramClient(config, client)(null, c => c.forumInventory('forumpage', { topicId: 1, cursor: null }));
  assert.equal(page.state, 'forum_page');
  assert.deepEqual(page.forum.posts.map(post => post.id), [100]);
  assert.deepEqual(calls, ['users.GetUsers', 'messages.CheckChatInvite', 'messages.GetReplies']);
});

test('backup scope lists only topics with a distinct signed cursor and never accepts message history', async () => {
  const backupForum = { channelId: '2234567890', inviteHash: 'fixture-backup-invite' };
  const client = () => ({
    connect: async () => {}, destroy: async () => {}, updateManager: { stop() {} },
    async invoke({ query }) {
      if (query instanceof Api.users.GetUsers) return [{ id: BigInt(config.ownerId) }];
      if (query instanceof Api.messages.CheckChatInvite) {
        const scope = query.hash === config.forum.inviteHash ? config.forum : backupForum;
        return { className: 'ChatInviteAlready', chat: { className: 'Channel',
          id: BigInt(scope.channelId), accessHash: 1n, megagroup: true, forum: true } };
      }
      assert.ok(query instanceof Api.messages.GetForumTopics);
      assert.equal(query.peer.channelId.toString(), backupForum.channelId);
      return { topics: [{ className: 'ForumTopic', id: 12, title: 'Letra T', date: 95, topMessage: 80 }],
        count: 2, orderByCreateDate: true };
    },
  });
  const run = telegramClient({ ...config, backupForum }, client);
  const read = (operation, input) => run(null, c => c.forumInventory(operation, input));
  const backup = await read('forumtopics', inputFor('forumtopics', { cursor: null, scope: 'backup' }));
  assert.equal(backup.forum.channelId, backupForum.channelId);
  assert.equal(backup.forum.scope, 'backup');
  assert.equal(backup.forum.topics[0].title, 'Letra T');
  assert.equal((await mtprotoResult(backup.state, backup).json()).forum.scope, 'backup');
  assert.equal((await read('forumtopics', { cursor: backup.forum.next })).state, 'forum_cursor_invalid');
  assert.equal(inputFor('forumpage', { cursor: null, topicId: 12, scope: 'backup' }), null);
  assert.equal(inputFor('forumtopics', { cursor: null, scope: 'arbitrary' }), null);
  const disabled = await telegramClient(config, client)(null, c => c.forumInventory('forumtopics', { cursor: null, scope: 'backup' }));
  assert.equal(disabled.state, 'forum_disabled');
});
