import assert from 'node:assert/strict';
import test from 'node:test';
import { alphabeticDestination, groupTopicDocuments, proposeAnimePreview } from '../src/rhea/library/anime-enrichment.mjs';
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
  const plan = proposeAnimePreview(group, candidate, [{ id: 35, title: 'Letter R' }, { id: 36, title: 'R', closed: true }]);
  assert.equal(plan.destination, 'Letter R');
  assert.equal(plan.destinationTopicId, 35);
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
  const plan = proposeAnimePreview(group, { ...candidate, episodes: 1, format: 'SPECIAL' }, [{ id: 8, title: 'R' }, { id: 190, title: 'Letter R' }]);
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

test('excludes the fansub prefix and accepts Portuguese season markers without changing filenames', () => {
  const portuguese = '[Zeta Sub][WEB] nome_anime t04e03 [767AB765C].mkv';
  const { groups, unassigned } = groupTopicDocuments([
    document(41, portuguese), document(42, '[Alpha] nome_anime-S04E02.mkv'),
    document(43, '[Zeta Sub] nome_anime-T04E04-E05.mkv'),
  ]);
  assert.equal(unassigned, 1);
  assert.deepEqual(groups.map(g => [g.title, g.season]), [['nome anime', 4]]);
  const [group] = groups;
  const metadata = { ...candidate, titles: ['Nome Anime'] };
  const plan = proposeAnimePreview(group, metadata, [
    { id: 1, title: 'N' }, { id: 73, title: 'Letra N' }, { id: 14, title: 'Z' },
  ]);
  assert.equal(plan.letter, 'N');
  assert.equal(plan.destinationTopicId, 73);
  assert.deepEqual(plan.sorted.map(p => p.episode), [2, 3]);
  assert.equal(plan.sorted[1].filename, portuguese);
});

test('an unidentified topic never becomes a routing destination', () => {
  const { groups } = groupTopicDocuments([document(21, '[Team] Re_Zero T04E03.mkv')]);
  const plan = proposeAnimePreview(groups[0], candidate, [{ id: 1, title: 'R' }, { title: 'Letter R' }]);
  assert.equal(plan.letter, 'R');
  assert.equal(plan.destinationTopicId, undefined);
});

test('orders fansub episodes without season tags and totals known document sizes', () => {
  const name = episode => '[Fixture]_TARI_TARI_' + episode + '_[1280x720][A1B2C3D4].mkv';
  const { groups, unassigned } = groupTopicDocuments([
    document(9, name('10'), { sizeBytes: 4_294_967_296 }),
    document(8, name('02')),
    document(7, name('01v2'), { sizeBytes: 100 }),
    document(6, '[Fixture]_TARI_TARI_01-02.mkv'),
    document(5, '[Fixture]_TARI_TARI_1080.mkv'),
  ]);
  assert.equal(unassigned, 2);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].season, undefined);
  const plan = proposeAnimePreview(groups[0], { ...candidate, titles: ['TARI TARI'], episodes: 13 });
  assert.equal(plan.letter, 'T');
  assert.deepEqual(plan.sorted.map(item => item.episode), [1, 2, 10]);
  assert.equal(plan.sorted[0].filename, name('01v2'));
  assert.equal(plan.sizedCount, 2);
  assert.equal(plan.totalBytes, 4_294_967_396n);
});

test('resolves one open topic per group and refuses a destination matching the intake topic', () => {
  const local = { id: 35, title: 'Letter T' };
  const backup = { id: 35, title: 'Letra T' };
  assert.deepEqual(alphabeticDestination('T', [local], 1), { state: 'found', topic: local });
  assert.deepEqual(alphabeticDestination('T', [backup]), { state: 'found', topic: backup });
  assert.equal(alphabeticDestination('T', [local], 35).state, 'source');
  assert.equal(alphabeticDestination('T', [local, { ...backup, id: 80 }]).state, 'ambiguous');
  assert.equal(alphabeticDestination('T', [{ ...local, closed: true }, { id: 1, title: 'T' }]).state, 'missing');
});

test('uses the suffix in Letter T and supports literal quotes without matching other topics', () => {
  const topics = [{ id: 12, title: 'Letter L' }, { id: 13, title: 'Letter T' },
    { id: 14, title: 'Letter TX' }, { id: 15, title: 'Letter "T' }];
  assert.equal(alphabeticDestination('T', topics).topic.id, 13);
  assert.equal(alphabeticDestination('L', topics).topic.id, 12);
  assert.equal(alphabeticDestination('T', [{ id: 13, title: '  LETTER   “T”  ' }]).topic.id, 13);
  assert.equal(alphabeticDestination('R', [{ id: 14, title: 'Letter "R"' }]).topic.id, 14);
});
