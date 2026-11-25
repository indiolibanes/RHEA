import { alphabeticDestination, groupTopicDocuments, sortAnimeEpisodes } from './anime-enrichment.mjs';
import { letterFor, titleKey } from './catalog.mjs';

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const key = title => titleKey(title, { foldDiacritics: false });
const startId = group => group.header?.id ?? Math.min(...group.posts.map(post => post.id));
const endId = group => Math.max(startId(group), ...group.posts.map(post => post.id));

export function letterRebuildTopics(letter, topics, intakeTopicId) {
  return {
    current: alphabeticDestination(letter, topics, intakeTopicId),
    replacement: alphabeticDestination(letter, topics, intakeTopicId, 'replacement'),
  };
}

export function planLetterRebuild({ letter, currentPosts, intakeGroup, intakeTitle, intakeWorks, reference, complete }) {
  const existing = groupTopicDocuments(currentPosts, reference);
  const current = existing.groups.map(group => ({ ...group, origin: 'current' }));
  for (const [index, section] of existing.sections.entries()) {
    const end = existing.sections[index + 1]?.id ?? Infinity;
    const match = current.find(group => !group.header && key(group.title) === key(section.title) &&
      group.posts[0]?.id >= section.id && group.posts[0].id < end);
    if (match) match.header = { ...section, trusted: true };
    else if (!current.some(group => key(group.title) === key(section.title))) {
      current.push({ title: section.title, header: section, posts: [], origin: 'current' });
    }
  }
  const incoming = (intakeWorks ?? [{ ...intakeGroup, title: intakeTitle, detectedTitle: intakeGroup.title }])
    .filter(group => letterFor(group.title) === letter)
    .map(group => ({ ...group, origin: 'intake', posts: sortAnimeEpisodes(group.posts) }));
  const titles = new Set(incoming.flatMap(group => [key(group.title), key(group.detectedTitle ?? group.title)]));
  const titleMatches = current.some(group => titles.has(key(group.title)));
  const groups = [...current.map(group => ({ ...group, posts: sortAnimeEpisodes(group.posts) })), ...incoming]
    .sort((a, b) => collator.compare(a.title, b.title) || (a.season ?? Infinity) - (b.season ?? Infinity) ||
      startId(a) - startId(b));
  const checks = {
    incomplete: !complete,
    sameTitle: titleMatches,
    outOfLetter: groups.some(group => letterFor(group.title) !== letter),
    ambiguousGroups: groups.filter(group => group.duplicate || group.missingEpisode || group.albumReview).length,
    protectedGroups: groups.filter(group => group.posts.some(post => post.protected)).length,
    unassigned: existing.unassigned,
    otherPosts: currentPosts.filter(post => post.kind !== 'document').length,
  };
  return { groups, checks, insertion: automaticInsertions(currentPosts, current, incoming, checks) };
}

function automaticInsertions(posts, current, incoming, checks) {
  const old = [...posts].sort((a, b) => a.id - b.id);
  const anchors = [...current].sort((a, b) => startId(a) - startId(b));
  if (!incoming.length || checks.incomplete || checks.sameTitle || checks.outOfLetter) return { state: 'review' };
  let previousTitle;
  let last = 0;
  for (const group of anchors) {
    const order = previousTitle === undefined ? 0 : collator.compare(previousTitle, group.title);
    if (order > 0 || (order < 0 && last >= startId(group))) return { state: 'review' };
    previousTitle = group.title;
    last = Math.max(last, endId(group));
  }
  const covered = new Set(current.flatMap(group => [...group.posts.map(post => post.id),
    ...(group.header?.trusted ? [group.header.id] : [])]));
  const slots = new Map();
  for (const work of [...incoming].sort((a, b) => collator.compare(a.title, b.title) ||
    (a.season ?? Infinity) - (b.season ?? Infinity) || a.posts[0].id - b.posts[0].id)) {
    const following = anchors.findIndex(group => collator.compare(group.title, work.title) > 0);
    const previous = anchors[following < 0 ? anchors.length - 1 : following - 1];
    const next = anchors[following];
    const beforeId = next ? startId(next) : null;
    const previousEnd = previous ? endId(previous) : 0;
    const nextPosition = next ? old.findIndex(post => post.id === beforeId) : old.length;
    const anchor = old[nextPosition];
    if ((previous && collator.compare(previous.title, work.title) === 0) ||
        (next && next.header && !next.header.trusted) || previousEnd >= (beforeId ?? Infinity) ||
        (anchor?.albumId != null && old[nextPosition - 1]?.albumId === anchor.albumId) ||
        old.some(post => post.id > previousEnd && post.id < (beforeId ?? Infinity) &&
          ['cover', 'document'].includes(post.kind) && !covered.has(post.id))) return { state: 'review' };
    if (!slots.has(beforeId)) slots.set(beforeId, { beforeId, works: [], ids: [], nextTitle: next?.title });
    const slot = slots.get(beforeId);
    slot.works.push(work.title);
    slot.ids.push(...work.posts.map(post => post.id));
  }
  return { state: 'ready', slots: [...slots.values()] };
}

export function letterInsertionOptions(posts, groups) {
  const old = [...posts].sort((a, b) => a.id - b.id);
  const positions = new Map(old.map((post, index) => [post.id, index]));
  const workAnchors = new Map();
  for (const group of groups) {
    if (group.origin !== 'current') continue;
    const start = positions.get(startId(group));
    const previous = old[start - 1];
    const coverTitle = previous?.heading || previous?.caption;
    const cover = previous?.kind === 'cover' && coverTitle && titleKey(coverTitle) === titleKey(group.title);
    const id = old[cover && !group.header ? start - 1 : start]?.id;
    if (id !== undefined) workAnchors.set(id, group.title + (group.season != null ? ' · Temporada ' + group.season : ''));
  }
  return old.flatMap((post, index) => {
    if (post.albumId != null && post.albumId === old[index - 1]?.albumId) return [];
    return [{ id: post.id, work: workAnchors.get(post.id),
      label: (post.heading || post.filename || post.caption || 'Publicação').slice(0, 120) }];
  });
}
