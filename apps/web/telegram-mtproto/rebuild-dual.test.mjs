import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api } from 'teleproto';
import { FloodWaitError } from 'teleproto/errors';
import { mtprotoControl } from './control.mjs';
import { telegramClient } from './telegram.mjs';
import { rebuildJournalLimit } from '../src/rhea/library/organization-contract.mjs';

// Synthetic case K with two destinations: Letter K [NEW] in the titular group and Letter K in the backup group.
const base = { actor: 'test-access-subject', ownerId: '700', key: 'x'.repeat(43), rebuildEnabled: true,
  forum: { channelId: '11111', inviteHash: 'test-titular' }, backupForum: { channelId: '22222', inviteHash: 'test-backup' } };
const doc = (id, name, parent, channel = 11111n, extra = {}) => ({ className: 'Message', id, message: 'Caption ' + id, peerId: { channelId: channel },
  replyTo: { replyToMsgId: parent }, ...extra,
  media: { className: 'MessageMediaDocument', document: { className: 'Document', id: BigInt(id + 5000), accessHash: 34n,
    fileReference: Buffer.from([1]), mimeType: 'video/x-matroska', size: 1000n,
    attributes: [{ className: 'DocumentAttributeFilename', fileName: name }] } } });

async function world(t, { current = 206, selected = 37, requests = 120, backupConfigured = true, titles = {}, closed = {}, withAlbum = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rhea-dual-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { ...base, file: join(directory, 'session.enc'), ...(backupConfigured ? {} : { backupForum: undefined }) };
  const old = Array.from({ length: current }, (_, i) => doc(1000 + i, '[Fixture] Kestrel ' + String(i).padStart(3, '0') + '.mkv', 8));
  if (withAlbum) { old[100].groupedId = old[101].groupedId = 55n; }
  const intake = Array.from({ length: requests }, (_, i) => doc(2000 + i, '[Fixture] Kumo Archive - ' + String(i).padStart(3, '0') + '.mkv', 1));
  const picked = Array.from({ length: selected }, (_, i) => intake[Math.floor(i * requests / selected)].id);
  // Topic stores: 9 = [NEW] (titular), 18 = backup Letter K.
  const store = { 8: old, 1: intake, 9: [], 18: [] };
  const sends = { 9: [], 18: [] };
  const reads = { count: 0 };
  const fault = { sendFlood: 0, backupSendFlood: 0, accessRevoked: false };
  const names = { 8: 'Letter K', 9: 'Letter K [NEW]', 18: 'Letter K', ...titles };
  const provider = () => ({ connect: async () => {}, destroy: async () => {}, updateManager: { stop() {} },
    async invoke({ query }) {
      if (query instanceof Api.users.GetUsers) return [{ id: 700n }];
      if (query instanceof Api.messages.CheckChatInvite) {
        if (fault.accessRevoked && query.hash === 'test-backup') throw Object.assign(Error('private'), { errorMessage: 'CHANNEL_PRIVATE' });
        const titular = query.hash === 'test-titular';
        return { className: 'ChatInviteAlready', chat: { className: 'Channel', id: titular ? 11111n : 22222n, accessHash: 4n,
          title: titular ? 'Fixture titular' : 'Fixture backup', forum: true, megagroup: true, creator: true } };
      }
      if (query instanceof Api.messages.GetForumTopicsByID) {
        const [id] = query.topics;
        const backup = query.peer.channelId.toString() === '22222';
        const key = backup ? 18 : id;
        return { topics: [{ className: 'ForumTopic', id, closed: Boolean(closed[key]), title: backup ? names[18] : names[id] }] };
      }
      if (query instanceof Api.messages.GetReplies) {
        reads.count++;
        const backup = query.peer.channelId.toString() === '22222';
        const all = store[backup ? 18 : query.msgId];
        const sorted = [...all].reverse().filter(item => !query.offsetId || item.id < query.offsetId);
        return { className: 'messages.ChannelMessages', count: all.length, offsetIdOffset: all.length - sorted.length, messages: sorted.slice(0, query.limit) };
      }
      const backup = query.peer.channelId.toString() === '22222';
      const topic = backup ? 18 : 9;
      const flood = backup ? 'backupSendFlood' : 'sendFlood';
      if (fault[flood]) { const seconds = fault[flood]; fault[flood] = 0; throw new FloodWaitError({ capture: seconds, request: query }); }
      const items = query instanceof Api.messages.SendMultiMedia ? query.multiMedia : [query];
      const everything = [...old, ...intake];
      const updates = [];
      for (const item of items) {
        const original = everything.find(post => post.media.document.id.toString() === (item.media.id.id).toString());
        const parent = query.replyTo.replyToMsgId === topic ? null : query.replyTo.replyToMsgId;
        const id = 300 + store[topic].length + (backup ? 5000 : 0);
        store[topic].push({ ...original, id, peerId: { channelId: BigInt(query.peer.channelId) }, replyTo: { replyToMsgId: parent ?? topic },
          ...(items.length > 1 ? { groupedId: 777n + BigInt(store[topic].length > 0 ? 0 : 0) } : { groupedId: undefined }) });
        sends[topic].push(original.id);
        updates.push({ className: 'UpdateMessageID', randomId: item.randomId, id });
      }
      return { updates };
    } });
  const transport = telegramClient(config, provider);
  let clock = 1_000_000;
  const start = () => mtprotoControl(config, { read: async () => 'test' }, (_s, fn) => transport(null, fn), () => clock);
  let adapter = start();
  const call = async (operation, body) => (await adapter(new Request('https://adapter.example/v1/rebuild' + operation, { method: 'POST',
    headers: { Authorization: 'Bearer ' + config.key, 'X-Rhea-Access-Subject': config.actor }, body: JSON.stringify(body) }))).json();
  const plan = { sourceTopicId: 1, currentTopicId: 8, replacementTopicId: 9, backupTopicId: 18, beforeId: null, letter: 'K', ids: picked };
  return { plan, call, store, sends, reads, fault, names, closed, picked, restart: () => { adapter = start(); }, advance: ms => { clock += ms; },
    journal: join(directory, 'letter-rebuild-pilot.jsonl') };
}

test('case K, 243 publications: one approval and one run complete both destinations in order with zero duplicates', async t => {
  const w = await world(t);
  const preview = await w.call('preview', w.plan);
  assert.equal(preview.state, 'mirror_preview', JSON.stringify(preview.issue));
  assert.equal(preview.mirror.total, 243);
  assert.match(preview.mirror.destination, /Fixture backup \/ Letter K$/);
  assert.match(preview.mirror.localDestination, /Fixture titular \/ Letter K \[NEW\]$/);
  assert.deepEqual(w.store[9], []);
  assert.deepEqual(w.store[18], []);
  const approval = await w.call('approve', { ...w.plan, confirm: true, approval: preview.mirror.approval });
  assert.equal(approval.state, 'mirror_progress');
  assert.equal(approval.mirror.total, 243);
  const sequence = preview.mirror.posts.map(post => post.id);
  let result;
  let steps = 0;
  let restarted = false;
  do {
    result = await w.call('next', w.plan);
    steps++;
    // The tab can close at any point: a fresh adapter process continues from the durable journal.
    if (steps === 111 && !restarted) { restarted = true; w.restart(); }
  } while (result.state === 'mirror_progress' && steps < 1200);
  assert.equal(result.state, 'mirror_done', JSON.stringify(result));
  assert.deepEqual(w.sends[9], sequence);
  assert.deepEqual(w.sends[18], sequence);
  assert.equal(new Set(w.sends[9]).size, 243);
  assert.equal(w.store[9].length, 243);
  assert.equal(w.store[18].length, 243);
  assert.deepEqual(result.mirror.localCopies.map(copy => copy.sourceId), sequence);
  assert.deepEqual(result.mirror.copies.map(copy => copy.sourceId), sequence);
  assert.equal((await w.call('status', w.plan)).state, 'mirror_done');
  assert.equal((await w.call('next', w.plan)).state, 'mirror_done');
  assert.equal(w.sends[9].length + w.sends[18].length, 486);
  const { size } = await stat(w.journal);
  assert.ok(size * 1.5 < rebuildJournalLimit, size + ' bytes against ' + rebuildJournalLimit);
  console.log('# measured: ' + steps + ' next calls, ' + w.reads.count + ' topic reads (' + (w.reads.count / steps).toFixed(1) + ' per call), journal ' + size + ' bytes');
});

test('the preview verifies both destinations without writing and reports each blocker on its own side', async t => {
  const w = await world(t, { current: 20, selected: 3, requests: 20 });
  const ok = await w.call('preview', w.plan);
  assert.equal(ok.state, 'mirror_preview');
  w.store[18].push({ id: 9000 });
  assert.deepEqual((await w.call('preview', w.plan)).issue, { side: 'destination', code: 'destination_not_empty' });
  w.store[18].pop();
  w.store[9].push({ id: 9001 });
  assert.deepEqual((await w.call('preview', w.plan)).issue, { side: 'local', code: 'destination_not_empty' });
  w.store[9].pop();
  w.closed[18] = true;
  assert.deepEqual((await w.call('preview', w.plan)).issue, { side: 'destination', code: 'topic_closed' });
  w.closed[18] = false;
  w.closed[9] = true;
  assert.deepEqual((await w.call('preview', w.plan)).issue, { side: 'local', code: 'topic_closed' });
  w.closed[9] = false;
  w.names[18] = 'Letter T';
  assert.deepEqual((await w.call('preview', w.plan)).issue, { side: 'destination', code: 'topic_name' });
  w.names[18] = 'Letter K [NEW]';
  assert.deepEqual((await w.call('preview', w.plan)).issue, { side: 'destination', code: 'topic_name' });
  w.names[18] = 'Letter K';
  w.fault.accessRevoked = true;
  assert.deepEqual((await w.call('preview', w.plan)).issue, { side: 'destination', code: 'group_unavailable' });
  assert.deepEqual(w.sends, { 9: [], 18: [] });
});

test('a missing backup configuration is its own state and never starts a titular-only copy', async t => {
  const w = await world(t, { current: 5, selected: 2, requests: 10, backupConfigured: false });
  for (const operation of ['preview', 'approve', 'next', 'status']) {
    const result = await w.call(operation, operation === 'approve' ? { ...w.plan, confirm: true, approval: 'a'.repeat(43) } : w.plan);
    assert.deepEqual([result.state, result.issue], ['mirror_ineligible', { side: 'destination', code: 'backup_unconfigured' }], operation);
  }
  assert.deepEqual(w.sends, { 9: [], 18: [] });
});

test('requests without a backup keep the previous single-destination behavior', async t => {
  const w = await world(t, { current: 5, selected: 2, requests: 10 });
  const { backupTopicId, ...legacy } = w.plan;
  const preview = await w.call('preview', legacy);
  assert.equal(preview.state, 'mirror_preview');
  assert.equal(preview.mirror.localDestination, undefined);
  assert.match(preview.mirror.destination, /Letter K \[NEW\]$/);
});

test('a backup that fails after the titular copy finished keeps the titular receipts and resumes only the backup', async t => {
  const w = await world(t, { current: 12, selected: 4, requests: 20 });
  const preview = await w.call('preview', w.plan);
  await w.call('approve', { ...w.plan, confirm: true, approval: preview.mirror.approval });
  const total = preview.mirror.mirror?.total ?? preview.mirror.total;
  // Titular first: 2 calls per publication (send, verify).
  for (let i = 0; i < 2 * total; i++) assert.equal((await w.call('next', w.plan)).state, 'mirror_progress');
  assert.equal(w.store[9].length, total);
  assert.equal(w.store[18].length, 0);
  w.fault.backupSendFlood = 90;
  const paused = await w.call('next', w.plan);
  assert.equal(paused.state, 'rate_limited');
  const status = await w.call('status', w.plan);
  assert.equal(status.state, 'rate_limited');
  w.advance(91_000);
  w.restart();
  let result;
  let guard = 0;
  do { result = await w.call('next', w.plan); } while (result.state === 'mirror_progress' && ++guard < 200);
  assert.equal(result.state, 'mirror_done');
  assert.equal(w.store[9].length, total);
  assert.equal(w.store[18].length, total);
  assert.equal(new Set(w.sends[18]).size, total);
  assert.equal(result.mirror.localCopies.length, total);
});

test('an album at a unit boundary stays whole in both destinations', async t => {
  const w = await world(t, { current: 130, selected: 3, requests: 20, withAlbum: true });
  const preview = await w.call('preview', { ...w.plan, beforeId: null });
  assert.equal(preview.state, 'mirror_preview', JSON.stringify(preview.issue));
  const bad = await w.call('preview', { ...w.plan, beforeId: 1101 });
  assert.deepEqual(bad.issue, { side: 'source', code: 'insertion_splits_album', postId: 1101 });
});
