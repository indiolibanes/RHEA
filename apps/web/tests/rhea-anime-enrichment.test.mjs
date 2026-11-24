import assert from 'node:assert/strict';
import test from 'node:test';
import { groupTopicDocuments, proposeAnimePreview } from '../src/rhea/library/anime-enrichment.mjs';
import { filenameReference } from '../src/rhea/library/forum-names.mjs';

const candidate = { titles: ['Re:Zero'], format: 'TV', year: 2026, episodes: 12, studios: ['Fixture studio'] };
const document = (id, filename, extra = {}) => ({ id, kind: 'document', filename, ...extra });

test('groups a Fansub block and previews numeric order with a unique alphabetical topic', () => {
  const exactName = '[EA]Re_Zero-S04E03 [767AB765C].mkv';
  const posts = [document(5, '[EA]Re_Zero-S04E10.mkv'), document(7, exactName), document(9, 'Re_Zero-S04E02.mkv'),
    document(12, 'Re_Zero-S03E02.mkv'), document(13, 'Saffron_Signals-S04E02.mkv')];
  const { groups, unassigned } = groupTopicDocuments(posts.reverse());
  assert.equal(unassigned, 0);
  assert.equal(groups.length, 3);
  const group = groups.find(g => g.title === 'Re Zero' && g.season === 4);
  assert.deepEqual(group.posts.map(p => p.id), [5, 7, 9]);
  const plan = proposeAnimePreview(group, candidate, [{ title: 'Letter R' }, { title: 'R', closed: true }]);
  assert.equal(plan.destination, 'Letter R');
  assert.deepEqual(plan.sorted.map(p => p.episode), [2, 3, 10]);
  assert.equal(plan.sorted[1].filename, exactName);
  assert.equal(plan.caption[1].value, 'Re:Zero · T04E03 · 2026 · Fixture studio');
});

test('flags ambiguous filenames, albums, duplicate slots and incompatible provider results', () => {
  const { groups, unassigned } = groupTopicDocuments([document(1, 'Example-S04E03.mkv', { albumId: 'x' }),
    document(2, 'Other-S04E02.mkv', { albumId: 'x' }), document(3, 'Example-S04E03.mkv'), document(4, 'E01.mkv')]);
  assert.equal(unassigned, 1);
  const group = groups.find(g => g.title === 'Example');
  assert.equal(group.duplicate, true);
  assert.equal(group.albumReview, true);
  const plan = proposeAnimePreview(group, { ...candidate, episodes: 1, format: 'SPECIAL' }, [{ title: 'R' }, { title: 'Letter R' }]);
  assert.equal(plan.destination, undefined);
  assert.equal(plan.topicAmbiguous, true);
  assert.equal(plan.editionReview, true);
  assert.equal(plan.countMismatch, true);
  assert.equal(plan.caption[0].value, '');
});

test('uses an exact Markdown name or explicit block header without inventing episode numbers', () => {
  const reference = filenameReference('### Exact name\n- `untitled.mkv`');
  const { groups, unassigned } = groupTopicDocuments([
    { id: 1, kind: 'cover', caption: 'Series: Kestrel Circuit | Compilation' },
    document(2, 'Season archive.zip'), document(3, 'untitled.mkv'),
    { id: 4, kind: 'cover', caption: 'Decorative title' }, document(5, 'Unidentified.mkv'),
  ], reference);
  assert.equal(unassigned, 1);
  assert.deepEqual(groups.map(g => [g.title, g.missingEpisode]), [['Exact name', true], ['Kestrel Circuit', true]]);
  assert.equal(groups[1].posts[0].episode, undefined);
});
