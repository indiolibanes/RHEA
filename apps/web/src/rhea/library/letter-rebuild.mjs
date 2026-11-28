import { alphabeticDestination, groupTopicDocuments, sortAnimeEpisodes } from './anime-enrichment.mjs';
import { compareTitleOrder, letterFor, titleKey } from './catalog.mjs';

const key = title => titleKey(title, { foldDiacritics: false });
const startId = group => group.header?.id ?? Math.min(...group.posts.map(post => post.id));
const endId = group => Math.max(startId(group), ...group.posts.map(post => post.id));

export function letterRebuildTopics(letter, topics, intakeTopicId) {
  return {
    current: alphabeticDestination(letter, topics, intakeTopicId),
    replacement: alphabeticDestination(letter, topics, intakeTopicId, 'replacement'),
  };
}

export function intakeLetterBatches(groups) {
  const letters = new Map();
  for (const group of groups) {
    const letter = letterFor(group.title);
    if (letter === '#') continue;
    if (!letters.has(letter)) letters.set(letter, { letter, series: new Set(), files: 0 });
    const entry = letters.get(letter);
    entry.series.add(key(group.title));
    entry.files += group.posts.length;
  }
  return [...letters.values()].sort((a, b) => a.letter.localeCompare(b.letter))
    .map(({ letter, series, files }) => ({ letter, series: series.size, files }));
}

const season = group => group.season ?? 1;
// Alphabetical by title, then by season: a later season of a work already in the letter goes right after it.
const compareWork = (a, b) => compareTitleOrder(a.title, b.title) || season(a) - season(b);

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
  // Only the same work and the same season is a duplicate; another season of a known title is ordered after it.
  const duplicates = incoming.filter(work => current.some(group => season(group) === season(work) &&
    [key(work.title), key(work.detectedTitle ?? work.title)].includes(key(group.title)))).map(work => work.title);
  const groups = [...current.map(group => ({ ...group, posts: sortAnimeEpisodes(group.posts) })), ...incoming]
    .sort((a, b) => compareWork(a, b) || startId(a) - startId(b));
  const checks = {
    incomplete: !complete,
    sameTitle: duplicates.length > 0,
    duplicates,
    outOfLetter: groups.some(group => letterFor(group.title) !== letter),
    ambiguousGroups: groups.filter(group => group.duplicate || group.missingEpisode || group.albumReview).length,
    protectedGroups: groups.filter(group => group.posts.some(post => post.protected)).length,
    unassigned: existing.unassigned,
    otherPosts: currentPosts.filter(post => post.kind !== 'document').length,
  };
  return { groups, checks, insertion: automaticInsertions(currentPosts, current, incoming, checks) };
}

// Position with the fewest inversions against the alphabetical order. In a strictly ordered topic this is the
// first block that sorts after the work, so the result matches a plain search; a topic with a stray block still
// gets the most plausible position instead of no answer.
function bestIndex(anchors, work) {
  let best = { index: 0, cost: Infinity };
  for (let index = 0; index <= anchors.length; index++) {
    let cost = 0;
    for (let j = 0; j < anchors.length; j++) {
      const order = compareWork(anchors[j], work);
      if ((j < index && order > 0) || (j >= index && order < 0)) cost++;
    }
    if (cost < best.cost) best = { index, cost };
  }
  return best;
}

// The position always follows the alphabetical order, for one work or for many, without asking. States:
// "ready" (positions computed; "reasons" are notes the interface explains, never a confirmation step) and
// "review" (no safe position: nothing selected, a partial read, or a work that is already in the letter).
function automaticInsertions(posts, current, incoming, checks) {
  const old = [...posts].sort((a, b) => a.id - b.id);
  const indexOf = new Map(old.map((post, index) => [post.id, index]));
  const anchors = [...current].sort((a, b) => startId(a) - startId(b));
  if (!incoming.length) return { state: 'review', reasons: ['no_selection'] };
  if (checks.incomplete) return { state: 'review', reasons: ['incomplete'] };
  if (checks.sameTitle) return { state: 'review', reasons: ['same_title'], duplicates: checks.duplicates };
  const reasons = new Set();
  if (checks.outOfLetter) reasons.add('out_of_letter');
  let last = 0;
  for (let index = 0; index < anchors.length; index++) {
    const group = anchors[index];
    if (index && compareWork(anchors[index - 1], group) > 0) reasons.add('disorder');
    if (index && last >= startId(group)) reasons.add('overlap');
    last = Math.max(last, endId(group));
  }
  const covered = new Set(current.flatMap(group => [...group.posts.map(post => post.id),
    ...(group.header?.trusted ? [group.header.id] : [])]));
  const slots = new Map();
  let uncovered = 0;
  for (const work of [...incoming].sort((a, b) => compareWork(a, b) || a.posts[0].id - b.posts[0].id)) {
    const { index: following, cost } = bestIndex(anchors, work);
    if (cost) reasons.add('disorder');
    const previous = anchors[following - 1];
    const next = anchors[following];
    let beforeId = next ? startId(next) : null;
    const previousEnd = previous ? endId(previous) : 0;
    let nextPosition = beforeId === null ? old.length : indexOf.get(beforeId);
    // Never split an album: the work goes right before the album that holds the next block.
    const album = old[nextPosition]?.albumId;
    if (album != null && old[nextPosition - 1]?.albumId === album) {
      while (old[nextPosition - 1]?.albumId === album) nextPosition--;
      beforeId = old[nextPosition].id;
      reasons.add('album');
    }
    if (next && next.header && !next.header.trusted) reasons.add('untrusted_header');
    if (previousEnd >= (beforeId ?? Infinity)) reasons.add('overlap');
    const loose = old.filter(post => post.id > previousEnd && post.id < (beforeId ?? Infinity) &&
      ['cover', 'document'].includes(post.kind) && !covered.has(post.id));
    if (loose.length) {
      reasons.add('uncovered');
      uncovered += loose.length;
    }
    if (!slots.has(beforeId)) {
      slots.set(beforeId, { beforeId, works: [], ids: [], previousTitle: previous?.title, nextTitle: next?.title });
    }
    const slot = slots.get(beforeId);
    slot.works.push(work.title);
    slot.ids.push(...work.posts.map(post => post.id));
  }
  const at = slot => slot.beforeId === null ? old.length : indexOf.get(slot.beforeId);
  return { state: 'ready', reasons: [...reasons], uncovered, slots: [...slots.values()].sort((a, b) => at(a) - at(b)) };
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
