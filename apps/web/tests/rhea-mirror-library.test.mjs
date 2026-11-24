import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEpisodeLabel } from '../src/rhea/library/catalog.mjs';
import { mirrorIssue, mirrorResponse } from '../src/rhea/library/mirror-contract.mjs';

test('episode parsing keeps the sample filename and ignores release tags that look like sub-episodes', () => {
  assert.deepEqual(parseEpisodeLabel('[Demo]Sample-Series-S04E03 [12345678].mkv'), { season: 4, episode: 3 });
  assert.deepEqual(parseEpisodeLabel('Sample.Series.S04E03.1080.mkv'), { season: 4, episode: 3 });
  assert.deepEqual(parseEpisodeLabel('Sample Series S04E03.5 [12345678].mkv'), { season: 4, episode: 3.5 });
  assert.deepEqual(parseEpisodeLabel('Sample Series S04E03-E04.mkv'), {});
});

test('mirror issues reserve the in-use code for the organized topic only', () => {
  assert.deepEqual(mirrorIssue({ side: 'local', code: 'destination_in_use' }), { side: 'local', code: 'destination_in_use' });
  assert.equal(mirrorIssue({ side: 'destination', code: 'destination_in_use' }), undefined);
  assert.equal(mirrorIssue({ side: 'source', code: 'destination_in_use' }), undefined);
});

test('mirror responses keep organized and backup receipts distinct and reject mismatched lists', () => {
  const copy = (sourceId, destinationId) => ({ sourceId, destinationId });
  const done = mirrorResponse('mirror_done', { total: 2, localCopies: [copy(11, 41), copy(12, 42)], copies: [copy(11, 31), copy(12, 32)] });
  assert.deepEqual(done.localCopies.map(item => item.destinationId), [41, 42]);
  assert.deepEqual(done.copies.map(item => item.destinationId), [31, 32]);
  assert.equal(mirrorResponse('mirror_progress', { total: 2, localCopies: [copy(11, 41)], copies: [copy(11, 31)] }), null);
  assert.equal(mirrorResponse('mirror_progress', { total: 2, localCopies: [copy(11, 41), copy(12, 42)], copies: [copy(12, 31)] }), null);
  assert.deepEqual(mirrorResponse('mirror_progress', { total: 2, copies: [copy(11, 31)] }), { total: 2, copies: [copy(11, 31)] });
});
