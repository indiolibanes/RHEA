import { alphabeticDestination, groupTopicDocuments, sortAnimeEpisodes } from './anime-enrichment.mjs';
import { letterFor, titleKey } from './catalog.mjs';

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

export function letterRebuildTopics(letter, topics, intakeTopicId) {
  return {
    current: alphabeticDestination(letter, topics, intakeTopicId),
    replacement: alphabeticDestination(letter, topics, intakeTopicId, 'replacement'),
  };
}

export function planLetterRebuild({ letter, currentPosts, intakeGroup, intakeTitle, reference, complete }) {
  const existing = groupTopicDocuments(currentPosts, reference);
  const intakeKeys = new Set([titleKey(intakeTitle), titleKey(intakeGroup.title)]);
  const titleMatches = existing.groups.some(group => intakeKeys.has(titleKey(group.title)));
  const groups = [...existing.groups.map(group => ({ ...group, origin: 'current' })),
    { ...intakeGroup, title: intakeTitle, origin: 'intake' }]
    .map(group => ({ ...group, posts: sortAnimeEpisodes(group.posts) }))
    .sort((a, b) => collator.compare(a.title, b.title) || (a.season ?? Infinity) - (b.season ?? Infinity) ||
      a.posts[0].id - b.posts[0].id);
  const checks = {
    incomplete: !complete,
    sameTitle: titleMatches,
    outOfLetter: groups.some(group => letterFor(group.title) !== letter),
    ambiguousGroups: groups.filter(group => group.duplicate || group.missingEpisode || group.albumReview).length,
    protectedGroups: groups.filter(group => group.posts.some(post => post.protected)).length,
    unassigned: existing.unassigned,
    otherPosts: currentPosts.filter(post => post.kind !== 'document').length,
  };
  return { groups, checks };
}

export function letterInsertionOptions(posts, groups) {
  const old = [...posts].sort((a, b) => a.id - b.id);
  const positions = new Map(old.map((post, index) => [post.id, index]));
  const workAnchors = new Map();
  for (const group of groups) {
    if (group.origin !== 'current') continue;
    const start = positions.get(Math.min(...group.posts.map(post => post.id)));
    const previous = old[start - 1];
    const coverTitle = previous?.heading || previous?.caption;
    const cover = previous?.kind === 'cover' && coverTitle && titleKey(coverTitle) === titleKey(group.title);
    const id = old[cover ? start - 1 : start]?.id;
    if (id !== undefined) workAnchors.set(id, group.title + (group.season != null ? ' · Temporada ' + group.season : ''));
  }
  return old.flatMap((post, index) => {
    if (post.albumId != null && post.albumId === old[index - 1]?.albumId) return [];
    return [{ id: post.id, work: workAnchors.get(post.id),
      label: (post.heading || post.filename || post.caption || 'Publicação').slice(0, 120) }];
  });
}
