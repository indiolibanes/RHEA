import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mirrorIssue } from '../src/rhea/library/mirror-contract.mjs';
import { organizationInput, rebuildIntakeLimit, rebuildIntakeScan, rebuildJournalLimit, rebuildLimit } from '../src/rhea/library/organization-contract.mjs';

const plan = { currentTopicId: 8, sourceTopicId: 1, replacementTopicId: 9, beforeId: null, letter: 'K', ids: [31, 32] };

test('derives every reconstruction bound from one set of constants', () => {
  assert.ok(rebuildLimit >= 243, 'the K case must fit in a single plan');
  assert.ok(rebuildIntakeLimit <= rebuildIntakeScan && rebuildIntakeScan % 60 === 0);
  assert.ok(rebuildJournalLimit >= rebuildLimit * 2 * 136 * 2);
});

test('accepts an optional backup topic and keeps the previous shape valid', () => {
  assert.deepEqual(organizationInput('rebuildpreview', plan), plan);
  assert.deepEqual(organizationInput('rebuildpreview', { ...plan, backupTopicId: 18 }), { ...plan, backupTopicId: 18 });
  const approval = { ...plan, backupTopicId: 18, approval: 'a'.repeat(43), confirm: true };
  assert.deepEqual(organizationInput('rebuildapprove', approval), approval);
  assert.equal(organizationInput('rebuildpreview', { ...plan, backupTopicId: 1 }), null);
  assert.equal(organizationInput('rebuildpreview', { ...plan, backupTopicId: 'x' }), null);
  assert.equal(organizationInput('rebuildpreview', { ...plan, backupTopicId: 18, extra: true }), null);
});

test('exposes the backup configuration and scan budget issues without leaking detail', () => {
  assert.deepEqual(mirrorIssue({ side: 'destination', code: 'backup_unconfigured' }), { side: 'destination', code: 'backup_unconfigured' });
  assert.equal(mirrorIssue({ side: 'source', code: 'backup_unconfigured' }), undefined);
  assert.deepEqual(mirrorIssue({ side: 'source', code: 'history_limit', detail: 'scan_budget' }), { side: 'source', code: 'history_limit', detail: 'scan_budget' });
  assert.deepEqual(mirrorIssue({ side: 'source', code: 'history_limit', detail: 'other' }), { side: 'source', code: 'history_limit' });
});
