import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api } from 'teleproto';
import { mtprotoControl } from './control.mjs';
import { telegramClient } from './telegram.mjs';
import { rebuildIntakeLimit, rebuildIntakeScan, rebuildJournalLimit, rebuildLimit } from '../src/rhea/library/organization-contract.mjs';

// Synthetic case K: a long current letter topic plus selected files inside a longer Requests history.
const scope = { actor: 'test-access-subject', ownerId: '700', key: 'x'.repeat(43),
  forum: { channelId: '11111', inviteHash: 'test-source' }, rebuildEnabled: true };
const post = (id, name, parent) => ({ className: 'Message', id, message: '', peerId: { channelId: 11111n }, replyTo: { replyToMsgId: parent },
  media: { className: 'MessageMediaDocument', document: { className: 'Document', id: BigInt(id + 5000), accessHash: 34n,
    fileReference: Buffer.from([1]), mimeType: 'video/x-matroska', size: 1000n,
    attributes: [{ className: 'DocumentAttributeFilename', fileName: name }] } } });

async function caseK(t, { current, selected, requests, pageGap = 0, intakeGap = 0, pickedAt, mutate }) {
  const directory = await mkdtemp(join(tmpdir(), 'rhea-k-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { ...scope, file: join(directory, 'session.enc') };
  const old = Array.from({ length: current }, (_, i) => post(1000 + i, '[Fixture] Kestrel ' + String(i).padStart(3, '0') + '.mkv', 8));
  const intake = Array.from({ length: requests }, (_, i) => post(2000 + i, '[Fixture] Kumo Archive - ' + String(i).padStart(3, '0') + '.mkv', 1));
  // Spread the selected ids through the Requests history, oldest first, like real scattered uploads.
  const picked = pickedAt ?? Array.from({ length: selected }, (_, i) => intake[Math.floor(i * requests / selected)].id);
  mutate?.({ old, intake });
  const reads = [];
  const rows = { 8: old, 1: intake, 9: [] };
  const provider = () => ({ connect: async () => {}, destroy: async () => {}, updateManager: { stop() {} },
    async invoke({ query }) {
      if (query instanceof Api.users.GetUsers) return [{ id: 700n }];
      if (query instanceof Api.messages.CheckChatInvite) return { className: 'ChatInviteAlready', chat: {
        className: 'Channel', id: 11111n, accessHash: 4n, title: 'Fixture forum', forum: true, megagroup: true, creator: true } };
      if (query instanceof Api.messages.GetForumTopicsByID) {
        const [id] = query.topics;
        return { topics: [{ className: 'ForumTopic', id, closed: id === 8, title: { 8: 'Letter K', 9: 'Letter K [NEW]' }[id] }] };
      }
      assert.ok(query instanceof Api.messages.GetReplies);
      reads.push([query.msgId, query.offsetId, query.limit]);
      const all = rows[query.msgId];
      const sorted = [...all].reverse().filter(item => !query.offsetId || item.id < query.offsetId);
      return { className: 'messages.ChannelMessages', count: all.length,
        offsetIdOffset: all.length - sorted.length + (query.msgId === 8 ? pageGap : query.msgId === 1 && query.offsetId ? intakeGap : 0), messages: sorted.slice(0, query.limit) };
    } });
  const transport = telegramClient(config, provider);
  const adapter = mtprotoControl(config, { read: async () => 'test' }, (_session, fn) => transport(null, fn));
  const preview = async () => (await adapter(new Request('https://adapter.example/v1/rebuildpreview', { method: 'POST',
    headers: { Authorization: 'Bearer ' + config.key, 'X-Rhea-Access-Subject': config.actor },
    body: JSON.stringify({ sourceTopicId: 1, currentTopicId: 8, replacementTopicId: 9, beforeId: null, letter: 'K', ids: picked }) }))).json();
  return { preview, reads, picked };
}


test('case K: 206 current + 37 selected (23 + 14) form one 243-post preview from a long, paginated Requests topic', async t => {
  const { preview, reads, picked } = await caseK(t, { current: 206, selected: 37, requests: 150 });
  const result = await preview();
  assert.equal(result.state, 'mirror_preview', JSON.stringify(result.issue));
  assert.equal(result.mirror.total, 243);
  assert.equal(result.mirror.posts.filter(item => item.id >= 2000).length, 37);
  assert.deepEqual(picked.length, 37);
  // Requests: newest-first pages until the oldest selected file plus the album margin, never the whole topic twice.
  const intakeReads = reads.filter(([topic]) => topic === 1);
  assert.deepEqual(intakeReads.map(([, offset]) => offset).slice(0, 2), [0, 2000 + 150 - 60]);
  assert.ok(intakeReads.length <= Math.ceil(150 / 60) + 1);
});

for (const [total, expected, code] of [[rebuildLimit - 1, 'mirror_preview'], [rebuildLimit, 'mirror_preview'], [rebuildLimit + 1, 'mirror_ineligible', 'history_limit']]) {
  test('combined limit boundary: ' + total + ' publications', async t => {
    const { preview } = await caseK(t, { current: total - 37, selected: 37, requests: 80 });
    const result = await preview();
    assert.equal(result.state, expected, JSON.stringify(result.issue));
    if (code) assert.equal(result.issue.code, code);
    else assert.equal(result.mirror.total, total);
  });
}

test('the selection limit is separate from the Requests history size', async t => {
  const { preview } = await caseK(t, { current: 10, selected: rebuildIntakeLimit, requests: 300 });
  assert.equal((await preview()).mirror.total, 10 + rebuildIntakeLimit);
});

test('Requests files deeper than the scan budget are refused with the history limit instead of a partial plan', async t => {
  const { preview } = await caseK(t, { current: 10, selected: 1, requests: rebuildIntakeScan + 200, pickedAt: [2000] });
  const result = await preview();
  assert.equal(result.state, 'mirror_ineligible');
  assert.deepEqual(result.issue, { side: 'source', code: 'history_limit', detail: 'scan_budget' });
});

test('an oldest-selected file reached exactly at the scan budget is still planned', async t => {
  const { preview } = await caseK(t, { current: 10, selected: 1, requests: rebuildIntakeScan - 20, pickedAt: [2000] });
  assert.equal((await preview()).state, 'mirror_preview');
});

test('an album that starts below the oldest selected file is detected across a page boundary', async t => {
  const { preview } = await caseK(t, { current: 10, selected: 1, requests: 130, pickedAt: [2070],
    mutate: ({ intake }) => { intake[69].groupedId = intake[70].groupedId = 91n; } });
  const result = await preview();
  assert.equal(result.state, 'mirror_ineligible');
  assert.equal(result.issue.code, 'album_or_reply');
});

test('page offsets that disagree with what was read are refused as unverified history', async t => {
  const { preview } = await caseK(t, { current: 10, selected: 1, requests: 150, pickedAt: [2000], intakeGap: 5 });
  const result = await preview();
  assert.equal(result.state, 'mirror_ineligible');
  assert.equal(result.issue.code, 'history_unverified');
});

test('a full dual-destination journal fits the derived journal budget with headroom', () => {
  const unit = JSON.stringify({ type: 'intent', step: 959, ids: ['9223372036854775807'] }) + '\n' +
    JSON.stringify({ type: 'receipt', step: 959, ids: [987654321] }) + '\n' + JSON.stringify({ type: 'verified', step: 959 }) + '\n';
  const header = JSON.stringify({ type: 'approved', scope: 'a'.repeat(64), evidence: 'b'.repeat(64), units: Array.from({ length: rebuildLimit }, (_, i) => [987654321 + i]), at: 1_800_000_000_000, approval: 'c'.repeat(64) });
  const bytes = header.length + 2 * rebuildLimit * unit.length;
  assert.ok(bytes * 1.5 < rebuildJournalLimit, bytes + ' bytes against ' + rebuildJournalLimit);
});
