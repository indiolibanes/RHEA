import assert from 'node:assert/strict';
import { test } from 'node:test';
import { letterRebuildTopics, planLetterRebuild } from '../src/rhea/library/letter-rebuild.mjs';
import { manualAnimeMetadata } from '../src/rhea/library/manual-anime-metadata.mjs';

test('resolves Letter T as the current catalog and Letter T [NEW] as a separate target', () => {
  const current = { id: 11, title: 'Letter T' };
  const replacement = { id: 13, title: 'Letter "T" [NEW]' };
  const topics = [current, replacement, { id: 14, title: 'Letter L [NEW]' }, { id: 1, title: 'Requests' }];
  assert.deepEqual(letterRebuildTopics('T', topics, 1), {
    current: { state: 'found', topic: current }, replacement: { state: 'found', topic: replacement },
  });
  assert.equal(letterRebuildTopics('T', [...topics, { id: 15, title: 'Letra T [NEW]' }], 1).replacement.state, 'ambiguous');
  assert.equal(letterRebuildTopics('T', topics, 13).replacement.state, 'source');
});

test('previews an alphabetical combination and keeps duplicate works and attachments for review', () => {
  const currentPosts = [
    { id: 11, kind: 'document', filename: '[Fixture] Tundra - 01.mkv' },
    { id: 12, kind: 'document', filename: '[Fixture] Tapestry - 01.mkv' },
    { id: 13, kind: 'document', filename: 'unknown.zip' },
    { id: 14, kind: 'cover', caption: 'Tundra' },
  ];
  const input = { letter: 'T', currentPosts, intakeGroup: { title: 'Timber', posts: [{ id: 31, episode: 10 }, { id: 32, episode: 2 }] },
    intakeTitle: 'Timber', complete: true };
  const plan = planLetterRebuild(input);
  assert.deepEqual(plan.groups.map(g => [g.title, g.origin]), [['Tapestry', 'current'], ['Timber', 'intake'], ['Tundra', 'current']]);
  assert.deepEqual(plan.groups[1].posts.map(post => post.episode), [2, 10]);
  assert.equal(plan.checks.unassigned, 1);
  assert.equal(plan.checks.otherPosts, 1);
  const duplicate = planLetterRebuild({ ...input, intakeTitle: 'Tundra', complete: false });
  assert.equal(duplicate.checks.sameTitle, true);
  assert.equal(duplicate.checks.incomplete, true);
  assert.equal(duplicate.groups.length, 3);
});

test('accepts manual AniList attribution without provider access and rejects unrelated links', () => {
  const fields = { title: 'Synthetic Title', link: 'https://anilist.co/anime/123/Synthetic-Title?unused=1',
    format: 'TV', year: '2017', episodes: '12', duration: '25', studio: 'Test Studio', genres: 'Drama, Romance, Drama' };
  assert.deepEqual(manualAnimeMetadata(fields), { titles: ['Synthetic Title'], url: 'https://anilist.co/anime/123',
    provider: 'manual', format: 'TV', year: 2017, episodes: 12, duration: 25, studios: ['Test Studio'], genres: ['Drama', 'Romance'] });
  assert.equal(manualAnimeMetadata({ ...fields, link: 'https://anilist.co.invalid/anime/123' }), null);
  assert.equal(manualAnimeMetadata({ ...fields, episodes: '0' }), null);
});
