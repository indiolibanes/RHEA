import { buildCatalog } from './catalog.mjs';

const bytes = new TextEncoder();
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export async function fingerprint(value) {
  const hash = await crypto.subtle.digest('SHA-256', bytes.encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

// A copy request may contain only ascending source IDs. Never split an atomic unit.
function copyBatches(units, size, issues) {
  const batches = [];
  let batch = [];
  for (const unit of units) {
    const ids = unit.items.map(item => item.id);
    if (ids.length > size) issues.add('group_exceeds_batch_limit');
    const increasing = ids.every((id, index) => index === 0 || ids[index - 1] < id);
    if (!increasing) issues.add('group_requires_separate_transport');
    if (batch.length && (batch.length + ids.length > size || batch.at(-1) >= ids[0])) {
      batches.push(batch);
      batch = [];
    }
    if (increasing && ids.length <= size) batch.push(...ids);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function planReflow(snapshot, { strategy = 'staging', batchSize = 10 } = {}) {
  if (!['suffix', 'staging'].includes(strategy) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new TypeError('Invalid reflow options.');
  }
  const catalog = buildCatalog(snapshot);
  const originalIds = catalog.chronological.map(item => item.id);
  const targetIds = catalog.units.flatMap(unit => unit.items.map(item => item.id));
  let retained = 0;
  let retainedUnits = 0;
  if (strategy === 'suffix') {
    for (const unit of catalog.units) {
      if (!unit.items.every((item, index) => item.id === originalIds[retained + index])) break;
      retained += unit.items.length;
      retainedUnits += 1;
    }
  }
  const toCopy = catalog.units.slice(retainedUnits);
  const copyIds = targetIds.slice(retained);
  const copied = new Set(copyIds);
  const toDelete = strategy === 'suffix' ? originalIds.filter(id => copied.has(id)) : [];
  const issues = new Set(catalog.issues);
  if (snapshot.complete !== true || typeof snapshot.revision !== 'string' || !snapshot.revision) issues.add('incomplete_snapshot');
  if (catalog.chronological.some(item => copied.has(item.id) && item.copyPolicy !== 'allowed')) issues.add('copy_permission_unverified');
  const batches = copyBatches(toCopy, batchSize, issues);
  const blockers = [...issues].sort();
  const snapshotHash = await fingerprint({ sourceId: snapshot.sourceId, revision: snapshot.revision, complete: snapshot.complete,
    series: [...snapshot.series].sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id)),
    messages: [...snapshot.messages].sort((a, b) => a.id - b.id), overrides: snapshot.overrides ?? {}, options: snapshot.options ?? {} });
  const plan = { version: 1, strategy, state: 'PLANNED', dryRun: true, snapshotHash, batchSize, originalIds, targetIds,
    targetOrder: catalog.units.flatMap(unit => unit.items.map(item => ({ id: item.id, seriesId: unit.seriesId,
      season: item.season ?? null, episode: item.episode ?? null, part: item.part ?? null, kind: item.kind }))),
    retainedIds: originalIds.slice(0, retained), copyIds, originalIdsForSeparateCleanup: toDelete, batches, blockers,
    estimates: { affectedMessages: copyIds.length, copyRequests: blockers.length ? null : batches.length,
      cleanupRequestsAtSameBatchLimit: strategy === 'suffix' ? Math.ceil(toDelete.length / batchSize) : 0,
      copiedMessages: copyIds.length },
    changes: ['message_id', 'date', 'deep_link', 'album_id', 'replies', 'pins', 'reactions', 'views', 'provenance'],
    requiresIndependentMediaBackupBeforeCleanup: toDelete.length > 0,
    verification: ['source_revision', 'expected_destination_head', 'complete_ordered_id_mapping', 'captions_and_filenames',
      'media_identity_and_access', 'album_and_multipart_membership', 'independent_media_backup_before_cleanup',
      'final_channel_order_and_original_absence_if_cleanup_approved'] };
  return { ...plan, planHash: await fingerprint(plan) };
}
