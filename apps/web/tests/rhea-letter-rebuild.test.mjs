import assert from 'node:assert/strict';
import { test } from 'node:test';
import { letterInsertionOptions, letterRebuildTopics, planLetterRebuild } from '../src/rhea/library/letter-rebuild.mjs';
import { manualAnimeMetadata } from '../src/rhea/library/manual-anime-metadata.mjs';
import { forumCatalogSnapshot } from '../src/rhea/library/live-catalog.mjs';
import { buildCatalog } from '../src/rhea/library/catalog.mjs';

test('suggests the kind of an explicitly marked extra without assigning its series', () => {
  const posts = [
    { id: 20, kind: 'document', filename: '[Fixture] Tidal Library - OVA [1080p].mkv' },
    { id: 21, kind: 'document', filename: '[Fixture] Tidal Library [Especial 1].mkv' },
    { id: 22, kind: 'document', filename: '[Fixture] Special Library - 01.mkv' },
    { id: 23, kind: 'document', filename: '[OVA] Tidal Library - 02.mkv' },
  ];
  const catalog = buildCatalog(forumCatalogSnapshot({ title: 'Letter T', channelId: '11111', topicId: 10, posts, complete: true }));
  assert.deepEqual(catalog.chronological.map(post => post.kind), ['ova', 'special', 'episode', 'episode']);
  assert.deepEqual(catalog.unresolved.flatMap(unit => unit.items.map(item => item.id)), [20, 21]);
});

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

test('offers a named work boundary before its matching cover and hides positions inside an album', () => {
  const posts = [{ id: 32, kind: 'cover', heading: 'Tundra' },
    { id: 33, kind: 'document', filename: 'Episode 1', albumId: 'a' },
    { id: 34, kind: 'document', filename: 'Episode 2', albumId: 'a' }];
  const groups = [{ title: 'Tundra', origin: 'current', posts: posts.slice(1) }];
  const options = letterInsertionOptions(posts, groups);
  assert.deepEqual(options.map(option => [option.id, option.work]), [[32, 'Tundra'], [33, undefined]]);
});

test('uses cover titles and safe numbered formats in the same catalog and plans multiple Requests works', () => {
  const posts = [
    { id: 11, kind: 'cover', heading: 'Tales Archive [2 GB]' },
    { id: 12, kind: 'document', filename: 'E01.mkv' },
    { id: 13, kind: 'cover', heading: 'Towa no Yuugure' },
    { id: 14, kind: 'document', filename: '01 [1080p].mkv' },
    { id: 15, kind: 'document', filename: 'Tundra Files - EP01.mkv' },
  ];
  const snapshot = forumCatalogSnapshot({ title: 'Letter T', channelId: '123', topicId: 10, posts, complete: true });
  assert.deepEqual(buildCatalog(snapshot).entries.map(item => item.title), ['Tales Archive', 'Towa no Yuugure', 'Tundra Files']);
  const incoming = [{ title: 'Tsuki ga Kirei', posts: [{ id: 31, episode: 2 }, { id: 32, episode: 1 }] },
    { title: 'Tada-kun', posts: [{ id: 41, episode: 1 }] }];
  const plan = planLetterRebuild({ letter: 'T', currentPosts: posts, intakeWorks: incoming, complete: true });
  assert.equal(plan.checks.unassigned, 0);
  assert.deepEqual(plan.insertion, { state: 'ready', slots: [
    { beforeId: 11, works: ['Tada-kun'], ids: [41], nextTitle: 'Tales Archive' },
    { beforeId: 15, works: ['Tsuki ga Kirei'], ids: [32, 31], nextTitle: 'Tundra Files' },
  ] });
  assert.equal(planLetterRebuild({ letter: 'T', currentPosts: posts, intakeWorks: incoming, complete: false }).insertion.state, 'review');
});

test('includes a cover-only work and requires review if a title at the insertion boundary is weak', () => {
  const plan = planLetterRebuild({ letter: 'T', complete: true,
    currentPosts: [{ id: 32, kind: 'cover', caption: 'Towa no Yuugure' }], intakeWorks: [
      { title: 'Tada-kun', posts: [{ id: 29, episode: 1 }] },
    ] });
  assert.deepEqual(plan.groups.map(item => item.title), ['Tada-kun', 'Towa no Yuugure']);
  assert.equal(plan.insertion.state, 'review');
});

test('keeps more than ten titled covers visible in both catalog and reconstruction', () => {
  const titles = [...Array.from({ length: 11 }, (_, i) => 'Tales Collection ' + String(i + 1).padStart(2, '0')), 'Towa no Yuugure'];
  const posts = titles.map((heading, i) => ({ id: 20 + i, kind: 'cover', heading }));
  const catalog = buildCatalog(forumCatalogSnapshot({ title: 'Letter T', channelId: '11111', topicId: 10, posts, complete: true }));
  const plan = planLetterRebuild({ letter: 'T', currentPosts: posts, complete: true,
    intakeWorks: [{ title: 'Tsuki ga Kirei', posts: [{ id: 90, episode: 1 }] }] });
  assert.deepEqual(catalog.entries.map(entry => entry.title), titles);
  assert.deepEqual(plan.groups.filter(entry => entry.origin === 'current').map(entry => entry.title), titles);
  assert.equal(plan.insertion.slots[0].beforeId, null);
});
