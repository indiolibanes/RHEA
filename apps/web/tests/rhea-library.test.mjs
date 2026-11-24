import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { demoBotReply } from '../src/rhea/library/bot-preview.mjs';
import { buildCatalog, duplicateCandidates, findSeries, parseEpisodeLabel, privateMessageLink, titleKey } from '../src/rhea/library/catalog.mjs';
import { syntheticSnapshot } from '../src/rhea/library/fixtures.mjs';
import { planReflow } from '../src/rhea/library/planner.mjs';
import { rehearse } from '../src/rhea/library/rehearsal.mjs';

const fixture = (messages, options) => ({
  sourceId: 'sandbox', revision: 'revision-1', complete: true, options,
  series: [{ id: 'k', title: 'O Kairō' }, { id: 's', title: 'Silk Station' }],
  messages: messages.map((row, index) => ({ id: index + 1, copyPolicy: 'allowed', ...row })),
});

test('normalization preserves explicit options and parses only unambiguous episode markers', () => {
  assert.equal(titleKey('  O Kairō   10 ', { ignoreArticles: true }), 'kairo 10');
  assert.equal(titleKey('O Kairō 10', { foldCase: false, foldDiacritics: false }), 'O Kairō 10');
  assert.deepEqual(parseEpisodeLabel('Kairō.S02E10.5v2.Parte-2.mkv'), { season: 2, episode: 10.5, part: 2 });
  assert.deepEqual(parseEpisodeLabel('[Demo]Sample-Series-S04E03 [12345678].mkv'), { season: 4, episode: 3 });
  assert.deepEqual(parseEpisodeLabel('Sample.Series.S04E03.1080.mkv'), { season: 4, episode: 3 });
  assert.deepEqual(parseEpisodeLabel('Sample Series S04E03.5 [12345678].mkv'), { season: 4, episode: 3.5 });
  assert.deepEqual(parseEpisodeLabel('Kairō.S02E10-E11.mkv'), {});
  assert.deepEqual(parseEpisodeLabel('Kairō 1080 x 1920.mkv'), {});
  assert.equal(titleKey('霧の駅'), '霧の駅');
  assert.notEqual(titleKey('ガ'), titleKey('カ'));
  assert.equal(privateMessageLink('1234567890', 42), 'https://t.me/c/1234567890/42');
  assert.throws(() => privateMessageLink('42/..', 1), /Invalid/);
});

test('catalog groups episode numbers, special editions and unknown slots deterministically', () => {
  const snapshot = fixture([
    { seriesId: 's' }, { seriesId: 'k', season: 1, episode: 10 }, { seriesId: 'k', season: 1, episode: 2 },
    { seriesId: 'k', season: 1, kind: 'ova' }, { seriesId: 'k', season: 1 },
    { seriesId: 'k', filename: 'k.S01E03.mkv', caption: 'Original caption', label: 'Local display label' },
    { seriesId: 'k', season: 1, episode: 2 },
  ], { ignoreArticles: true });
  const catalog = buildCatalog(snapshot);
  assert.deepEqual(catalog.units.flatMap(unit => unit.items.map(row => row.id)), [3, 7, 6, 2, 5, 4, 1]);
  assert.equal(catalog.chronological[5].episode, 3);
  assert.equal(catalog.chronological[5].filename, 'k.S01E03.mkv');
  const corrected = buildCatalog({ ...snapshot, overrides: { 6: { episode: null, label: 'Manual' } } }).chronological[5];
  assert.equal(corrected.episode, null);
  assert.equal(corrected.caption, 'Original caption');
  assert.equal(corrected.label, 'Manual');
  assert.throws(() => buildCatalog({ ...snapshot, overrides: { 6: { filename: 'rewrite.mkv' } } }), /correction/);
  assert.throws(() => buildCatalog(fixture([{ id: 4 }, { id: 4 }])), /unique/);
});

test('conflicting translated aliases remain separate, and duplicate evidence never removes items', () => {
  const snapshot = syntheticSnapshot();
  const catalog = buildCatalog(snapshot);
  assert.equal(catalog.chronological.length, 355);
  assert.deepEqual(findSeries(catalog, 'kIRo TODAI').map(row => row.id), ['kiro']);
  assert.deepEqual(findSeries(catalog, '霧の駅').map(row => row.id), ['silk', 'star']);
  assert.deepEqual(findSeries(catalog, 'cloud terminal').map(row => row.id), ['kumo', 'star']);
  const candidates = duplicateCandidates(catalog);
  assert.deepEqual(candidates.map(row => row.basis), ['exact_metadata', 'telegram_media_identity']);
  assert.ok(candidates.every(row => row.ids.length === 2));
  const hash = 'a'.repeat(64);
  snapshot.messages[0].sha256 = hash;
  snapshot.messages[1].sha256 = hash.toUpperCase();
  assert.deepEqual(duplicateCandidates(buildCatalog(snapshot)).find(row => row.basis === 'verified_sha256').ids, [100, 101]);
});

test('plan selects the minimum contiguous suffix and preserves the full target for staging', async () => {
  const snapshot = syntheticSnapshot();
  const inPlace = await planReflow(snapshot, { strategy: 'suffix' });
  const staging = await planReflow(snapshot);
  assert.deepEqual(inPlace.retainedIds, [100, 101, 102, 103, 104, 105, 106, 107]);
  assert.equal(inPlace.copyIds.length, 347);
  assert.equal(inPlace.originalIdsForSeparateCleanup.length, 347);
  assert.equal(inPlace.requiresIndependentMediaBackupBeforeCleanup, true);
  assert.equal(staging.copyIds.length, 355);
  assert.deepEqual(staging.originalIdsForSeparateCleanup, []);
  assert.deepEqual(inPlace.batches.flat(), inPlace.copyIds);
  assert.ok(inPlace.batches.every(batch => batch.every((id, ix) => ix === 0 || batch[ix - 1] < id)));
  for (const key of ['albumId', 'multipartId']) {
    const ids = snapshot.messages.filter(row => row[key]).map(row => row.id);
    assert.ok(inPlace.batches.some(batch => ids.every(id => batch.includes(id))));
  }
  assert.deepEqual(staging.blockers, []);
  assert.equal(staging.planHash, (await planReflow({ ...snapshot, messages: [...snapshot.messages].reverse() })).planHash);
  assert.notEqual(staging.planHash, (await planReflow({ ...snapshot, revision: 'edition-2' })).planHash);
  assert.notEqual(staging.planHash, (await planReflow({ ...snapshot, overrides: { 100: { label: 'Changed' } } })).planHash);
  assert.notEqual(staging.planHash, (await planReflow(snapshot, { batchSize: 12 })).planHash);
});

test('suffix boundary retreats to whole album and transport failures block qualification', async () => {
  const snapshot = fixture([{ seriesId: 'k', episode: 1, albumId: 'A' }, { seriesId: 'k', episode: 1, albumId: 'A' },
    { seriesId: 's', episode: 1 }, { seriesId: 'k', episode: 2 }]);
  const plan = await planReflow(snapshot, { strategy: 'suffix' });
  assert.deepEqual(plan.retainedIds, [1, 2]);
  assert.deepEqual(plan.targetIds, [1, 2, 4, 3]);
  const blocked = await planReflow({ ...snapshot, complete: false,
    messages: snapshot.messages.map((row, index) => index === 1 ? { ...row, copyPolicy: 'protected' } : row) }, { batchSize: 1 });
  assert.deepEqual(blocked.blockers, ['copy_permission_unverified', 'group_exceeds_batch_limit', 'incomplete_snapshot']);
  assert.equal(blocked.estimates.copyRequests, null);
});

test('conflicting series, overlapping episode groups, and underspecified multipart IDs fail closed', async () => {
  const snapshot = fixture([
    { seriesId: 'k', episode: 1, albumId: 'A' }, { seriesId: 'k', episode: 3, albumId: 'A' }, { seriesId: 'k', episode: 2 },
    { seriesId: 's', albumId: 'B' }, { seriesId: 'k', albumId: 'B' },
    { seriesId: 's', episode: 4, multipartId: 'parts' }, { seriesId: 's', episode: 4, multipartId: 'parts', part: 2 },
  ]);
  const plan = await planReflow(snapshot);
  assert.deepEqual(plan.blockers, ['atomic_group_order_conflict', 'conflicting_group_identity', 'group_requires_separate_transport', 'multipart_metadata_conflict']);
  assert.equal(plan.targetIds.length, snapshot.messages.length);
  assert.equal(new Set(plan.targetIds).size, snapshot.messages.length);
});

test('already ordered snapshot yields a no-op suffix plan', async () => {
  const plan = await planReflow(fixture([{ seriesId: 'k' }, { seriesId: 's' }]), { strategy: 'suffix' });
  assert.deepEqual(plan.retainedIds, [1, 2]);
  assert.deepEqual(plan.batches, []);
  assert.equal(plan.estimates.affectedMessages, 0);
});

async function rehearsalFixture() {
  const plan = await planReflow(fixture([{ seriesId: 's' }, { seriesId: 'k' }]), { strategy: 'suffix', batchSize: 1 });
  const apply = (state, event) => rehearse(state, event, plan);
  const initial = { phase: 'SCANNED', planHash: plan.planHash };
  const planned = apply(initial, { type: 'plan' });
  const approval = { type: 'approve-copy', scope: 'copy', planHash: plan.planHash, snapshotHash: plan.snapshotHash, destinationHead: 2 };
  const copying = apply(apply(planned, approval), { type: 'start' });
  const receipts = plan.batches.map((ids, i) => ({ type: 'receipt', batchIndex: i, snapshotHash: plan.snapshotHash,
    previousHead: i + 2, sourceIds: ids, destinationIds: [i + 3] }));
  return { plan, apply, planned, approval, copying, receipts };
}

test('rehearsal persists checkpoint, rejects early retry, reconciles interrupted and ambiguous writes', async () => {
  const { plan, apply, planned, approval, copying, receipts } = await rehearsalFixture();
  assert.throws(() => apply(planned, { ...approval, scope: 'cleanup' }), /approval/);
  const partial = apply(copying, receipts[0]);
  assert.equal(apply(partial, receipts[0]), partial);
  const saved = JSON.parse(JSON.stringify(apply(partial, { type: 'pause', resumeAfter: 60 })));
  assert.throws(() => apply(saved, { type: 'resume', now: 59 }), /deadline/);
  assert.equal(apply(saved, { type: 'resume', now: 60, snapshotHash: plan.snapshotHash, destinationHead: 99 }).phase, 'RECOVERY_REQUIRED');
  assert.equal(apply(partial, { ...receipts[1], destinationIds: [] }).phase, 'RECOVERY_REQUIRED');
  assert.equal(apply(partial, { type: 'uncertain', reason: 'timeout_after_send' }).phase, 'RECOVERY_REQUIRED');
  let resumed = apply(saved, { type: 'resume', now: 60, snapshotHash: plan.snapshotHash, destinationHead: 3 });
  resumed = apply(resumed, receipts[1]);
  assert.deepEqual(resumed.receipts.map(receipt => receipt.destinationIds[0]), [3, 4]);
  assert.equal(apply(copying, { type: 'fail', reason: 'no_post_permission' }).phase, 'FAILED');
  assert.equal(apply(partial, { type: 'fail', reason: 'lost_post_permission' }).phase, 'RECOVERY_REQUIRED');
});

test('rehearsal requires independently verified replacement, media backup and separate cleanup approval', async () => {
  const { plan, apply, copying, receipts } = await rehearsalFixture();
  const copied = receipts.reduce(apply, copying);
  const verify = { type: 'verify', snapshotHash: plan.snapshotHash, mediaAccessible: true, metadataVerified: true,
    groupsVerified: true, independentOrder: [3, 4] };
  assert.equal(apply(copied, { ...verify, independentOrder: [4, 3] }).phase, 'RECOVERY_REQUIRED');
  const verified = apply(copied, verify);
  assert.throws(() => apply(verified, { type: 'finish-staging' }), /separate/);
  assert.throws(() => apply(verified, { type: 'request-cleanup', backupEvidenceHash: 'manifest-only' }), /media-complete/);
  const waiting = apply(verified, { type: 'request-cleanup', backupEvidenceHash: 'media-backed', independentMediaVerified: true });
  const cleanup = { type: 'observe-cleanup', scope: 'cleanup', planHash: plan.planHash, irreversibilityAcknowledged: true,
    backupEvidenceHash: 'media-backed', preCleanupSnapshotHash: plan.snapshotHash, originalsAbsent: true, finalOrderVerified: true };
  assert.throws(() => apply(waiting, { ...cleanup, originalsAbsent: false }), /verification/);
  assert.throws(() => apply(waiting, { ...cleanup, irreversibilityAcknowledged: false }), /approval/);
  assert.equal(apply(waiting, cleanup).phase, 'FINALIZED');
});

test('migration applies after current D1 schema and constrains active runs, approvals, and receipts', () => {
  const db = new DatabaseSync(':memory:');
  for (const migration of ['0001_gateway', '0002_proposals', '0003_drive_links', '0004_library']) {
    db.exec(readFileSync(new URL('../mcp-gateway/' + migration + '.sql', import.meta.url), 'utf8'));
  }
  db.prepare('INSERT INTO rhea_library_sources VALUES (?,?,?,?,?,NULL,?)').run('source', 'actor', 'hash', 'sealed', 'Demo', 1);
  const hash = 'a'.repeat(64);
  db.prepare('INSERT INTO rhea_library_snapshots VALUES (?,?,?,?,?,?,?)').run('source', 'snapshot', 'revision', 2, 1, hash, 1);
  const insertRun = db.prepare('INSERT INTO rhea_library_runs(id,source_id,snapshot_id,plan_hash,plan_json,strategy,state,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  insertRun.run('a', 'source', 'snapshot', hash, '{}', 'suffix', 'COPYING', 1);
  assert.equal(db.prepare('SELECT dry_run FROM rhea_library_runs').get().dry_run, 1);
  assert.throws(() => insertRun.run('b', 'source', 'snapshot', hash, '{}', 'staging', 'PAUSED', 1), /UNIQUE/);
  insertRun.run('c', 'source', 'snapshot', hash, '{}', 'staging', 'PLANNED', 1);
  const approve = db.prepare('INSERT INTO rhea_library_approvals VALUES(?,?,?,?,?,?,?,NULL)');
  approve.run('a', 'copy', 'actor-hash', hash, 0, 1, 100);
  assert.throws(() => approve.run('a', 'cleanup', 'actor-hash', hash, 0, 1, 100), /CHECK/);
  approve.run('a', 'cleanup', 'actor-hash', hash, 1, 1, 100);
  db.prepare('INSERT INTO rhea_library_receipts VALUES(?,?,?,?,?,?,?)').run('a', 0, 'operation', 'CONFIRMED', 2, 3, 1);
  const map = db.prepare('INSERT INTO rhea_library_message_map VALUES(?,?,?,?)');
  map.run('a', 0, 1, 3);
  assert.throws(() => map.run('a', 0, 2, 3), /UNIQUE/);
  assert.throws(() => map.run('a', 1, 2, 4), /FOREIGN KEY/);
  db.close();
});

test('bot preview requires the pinned numeric owner, current ownership, and private chat', async () => {
  const snapshot = syntheticSnapshot();
  const options = { ownerId: 123, ownsTestChannel: async id => id === 123, workspaceOrigin: 'https://rhea.example.test', snapshot };
  const message = { from: { id: 123, is_bot: false, username: 'any' }, chat: { id: 123, type: 'private' }, text: '/preview K' };
  const result = await demoBotReply({ message }, options);
  assert.match(result.text, /347/);
  assert.equal(result.reply_markup.inline_keyboard[1][0].url, 'https://rhea.example.test/rhea/library#K');
  assert.equal(await demoBotReply({ message: { ...message, from: { ...message.from, id: 999 } } }, options), null);
  assert.equal(await demoBotReply({ message: { ...message, chat: { id: 123, type: 'channel' } } }, options), null);
  assert.equal(await demoBotReply({ message }, { ...options, ownsTestChannel: async () => false }), null);
  const admin = await demoBotReply({ message: { ...message, text: '/approve cleanup' } }, options);
  assert.match(admin.text, /demonstração/);
});
