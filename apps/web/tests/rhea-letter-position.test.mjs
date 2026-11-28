import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupTopicDocuments } from '../src/rhea/library/anime-enrichment.mjs';
import { planLetterRebuild } from '../src/rhea/library/letter-rebuild.mjs';

const doc = (id, filename) => ({ id, kind: 'document', filename });
const note = (id, title) => ({ id, kind: 'note', caption: 'Series: ' + title });
const intake = (title, ids) => [{ title, posts: ids.map(id => ({ id, episode: id % 100 })) }];

test('reads underscore releases with a group tag, a Final marker and a CRC tail', () => {
  const posts = [
    doc(1, '#AnimeNSK_Kanata_no_Astra_11_BD_1920x1080_HEVC_10Bit_AAAAAAAA.mkv'),
    doc(2, '#AnimeNSK_Kanata_no_Astra_12_Final_BD_1920x1080_HEVC_10Bit_6C697CD8.mkv'),
    doc(3, 'Tsuki_ga_Kirei_03_1080p.mkv'),
    doc(4, 'random_stuff.zip'),
  ];
  const { groups, unassigned } = groupTopicDocuments(posts);
  const kanata = groups.find(group => group.title === 'Kanata no Astra');
  assert.deepEqual(kanata.posts.map(post => post.episode), [11, 12]);
  assert.equal(groups.find(group => group.title === 'Tsuki ga Kirei').posts[0].episode, 3);
  assert.equal(unassigned, 1);
});

test('groups a film named with its year and no episode number', () => {
  const { groups, unassigned } = groupTopicDocuments([doc(1, 'Kaze no Tani no Nausicaä (1984) [1080p].mkv')]);
  assert.equal(unassigned, 0);
  assert.equal(groups[0].title, 'Kaze no Tani no Nausicaä');
  assert.equal(groups[0].missingEpisode, true);
});

function letterK(extra = []) {
  return [
    doc(110, '#AnimeNSK_Kanata_no_Astra_11_BD_1920x1080_HEVC_10Bit_AAAAAAAA.mkv'),
    doc(111, '#AnimeNSK_Kanata_no_Astra_12_Final_BD_1920x1080_HEVC_10Bit_6C697CD8.mkv'),
    ...extra,
    note(120, 'Kaze no Tani no Nausicaä'), doc(121, 'Kaze no Tani no Nausicaä (1984) [1080p].mkv'),
    doc(125, '[Fixture] K-ON!! - 01 [BD].mkv'), doc(126, '[Fixture] K-ON!! - 02 [BD].mkv'),
  ];
}

test('places a work between its alphabetical neighbours without asking', () => {
  const plan = planLetterRebuild({ letter: 'K', currentPosts: letterK(), complete: true,
    intakeWorks: intake('Kaze ga Tsuyoku Fuiteiru', [301, 302, 303]) });
  assert.equal(plan.insertion.state, 'ready');
  assert.deepEqual(plan.insertion.reasons, []);
  assert.deepEqual(plan.insertion.slots, [{ beforeId: 120, works: ['Kaze ga Tsuyoku Fuiteiru'], ids: [301, 302, 303],
    previousTitle: 'Kanata no Astra', nextTitle: 'Kaze no Tani no Nausicaä' }]);
});

test('puts a work at the end or at the start of the letter', () => {
  const end = planLetterRebuild({ letter: 'K', currentPosts: letterK(), complete: true, intakeWorks: intake('Kuzu no Honkai', [301]) });
  assert.equal(end.insertion.state, 'ready');
  assert.equal(end.insertion.slots[0].beforeId, null);
  const start = planLetterRebuild({ letter: 'K', currentPosts: letterK(), complete: true, intakeWorks: intake('K-1 Grand Prix', [301]) });
  assert.equal(start.insertion.slots[0].beforeId, 110);
});

test('places the work automatically and explains unidentified files between the neighbours', () => {
  const plan = planLetterRebuild({ letter: 'K', currentPosts: letterK([doc(115, 'extras.zip')]), complete: true,
    intakeWorks: intake('Kaze ga Tsuyoku Fuiteiru', [301]) });
  assert.equal(plan.insertion.state, 'ready');
  assert.deepEqual(plan.insertion.reasons, ['uncovered']);
  assert.equal(plan.insertion.uncovered, 1);
  assert.equal(plan.insertion.slots[0].beforeId, 120);
});

test('still proposes the least disordered position when the current letter is not strictly alphabetical', () => {
  const posts = [note(50, 'Kaze no Tani no Nausicaä'), doc(51, 'Kaze no Tani no Nausicaä (1984).mkv'),
    doc(60, '#AnimeNSK_Kanata_no_Astra_12_Final_BD_1920x1080_HEVC_10Bit_6C697CD8.mkv')];
  const plan = planLetterRebuild({ letter: 'K', currentPosts: posts, complete: true, intakeWorks: intake('Kaze ga Tsuyoku Fuiteiru', [301]) });
  assert.equal(plan.insertion.state, 'ready');
  assert.ok(plan.insertion.reasons.includes('disorder'));
  assert.equal(plan.insertion.slots[0].beforeId, 50);
});

test('refuses a position only when the same season already exists or the read is partial', () => {
  const same = planLetterRebuild({ letter: 'K', currentPosts: letterK(), complete: true, intakeWorks: intake('Kanata no Astra', [301]) });
  assert.deepEqual([same.insertion.state, same.insertion.reasons], ['review', ['same_title']]);
  const partial = planLetterRebuild({ letter: 'K', currentPosts: letterK(), complete: false, intakeWorks: intake('Kimi', [301]) });
  assert.deepEqual([partial.insertion.state, partial.insertion.reasons], ['review', ['incomplete']]);
  assert.deepEqual(same.insertion.duplicates, ['Kanata no Astra']);
});

test('moves the work before an album instead of splitting it', () => {
  const album = letterK().map(post => post.id === 111 || post.id === 120 ? { ...post, albumId: 'A1' } : post);
  const split = planLetterRebuild({ letter: 'K', currentPosts: album, complete: true, intakeWorks: intake('Kaze ga Tsuyoku Fuiteiru', [301]) });
  assert.equal(split.insertion.state, 'ready');
  assert.ok(split.insertion.reasons.includes('album'));
  assert.equal(split.insertion.slots[0].beforeId, 111);
});

test('a new season of a work already in the letter goes right after it, without asking', () => {
  const works = [{ title: 'Kanata no Astra', season: 2, posts: [{ id: 301, episode: 1 }, { id: 302, episode: 2 }] }];
  const plan = planLetterRebuild({ letter: 'K', currentPosts: letterK(), complete: true, intakeWorks: works });
  assert.equal(plan.insertion.state, 'ready');
  assert.deepEqual(plan.insertion.slots.map(slot => [slot.beforeId, slot.previousTitle]), [[120, 'Kanata no Astra']]);
});

test('several works are all placed automatically, even in a letter that is not strictly alphabetical', () => {
  const posts = [...letterK(), doc(130, '[Fixture] Kakegurui - 01.mkv')];
  const works = [...intake('Kimi no Na wa', [301]), ...intake('Kaze ga Tsuyoku Fuiteiru', [302]), ...intake('K-1 Grand Prix', [303])];
  const plan = planLetterRebuild({ letter: 'K', currentPosts: posts, complete: true, intakeWorks: works });
  assert.equal(plan.insertion.state, 'ready');
  assert.ok(plan.insertion.reasons.includes('disorder'));
  const order = plan.insertion.slots.map(slot => slot.works).flat();
  assert.deepEqual(order, ['K-1 Grand Prix', 'Kaze ga Tsuyoku Fuiteiru', 'Kimi no Na wa']);
});

test('orders several works from Requests into their own slots', () => {
  const works = [...intake('Kimi no Na wa', [301]), ...intake('Kaze ga Tsuyoku Fuiteiru', [302])];
  const plan = planLetterRebuild({ letter: 'K', currentPosts: letterK(), complete: true, intakeWorks: works });
  assert.equal(plan.insertion.state, 'ready');
  assert.deepEqual(plan.insertion.slots.map(slot => [slot.beforeId, slot.works]),
    [[120, ['Kaze ga Tsuyoku Fuiteiru']], [125, ['Kimi no Na wa']]]);
});
