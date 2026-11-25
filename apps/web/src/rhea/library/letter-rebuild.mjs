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

// Position with the fewest inversions against the alphabetical order. In a strictly ordered topic this is the
// first block that sorts after the work, so the result matches a plain search; a topic with a stray block still
// gets the most plausible position instead of no answer.
function bestIndex(anchors, work) {
  let best = { index: 0, cost: Infinity };
  for (let index = 0; index <= anchors.length; index++) {
    let cost = 0;
    for (let j = 0; j < anchors.length; j++) {
      const order = collator.compare(anchors[j].title, work.title);
      if ((j < index && order > 0) || (j >= index && order < 0)) cost++;
    }
    if (cost < best.cost) best = { index, cost };
  }
  return best;
}

// States: "ready" (safe to prepare), "suggest" (a position exists but the operator must confirm it, with the
// reasons), "review" (no position can be proposed). The reasons are fixed codes the interface explains.
function automaticInsertions(posts, current, incoming, checks) {
  const old = [...posts].sort((a, b) => a.id - b.id);
  const anchors = [...current].sort((a, b) => startId(a) - startId(b));
  if (!incoming.length) return { state: 'review', reasons: ['no_selection'] };
  if (checks.incomplete) return { state: 'review', reasons: ['incomplete'] };
  if (checks.sameTitle) return { state: 'review', reasons: ['same_title'] };
  if (checks.outOfLetter) return { state: 'review', reasons: ['out_of_letter'] };
  const reasons = new Set();
  let last = 0;
  let disorder = 0;
  for (let index = 0; index < anchors.length; index++) {
    const group = anchors[index];
    if (index && collator.compare(anchors[index - 1].title, group.title) > 0) disorder++;
    if (index && last >= startId(group)) reasons.add('overlap');
    last = Math.max(last, endId(group));
  }
  if (disorder) reasons.add('disorder');
  const covered = new Set(current.flatMap(group => [...group.posts.map(post => post.id),
    ...(group.header?.trusted ? [group.header.id] : [])]));
  const slots = new Map();
  let uncovered = 0;
  for (const work of [...incoming].sort((a, b) => collator.compare(a.title, b.title) ||
    (a.season ?? Infinity) - (b.season ?? Infinity) || a.posts[0].id - b.posts[0].id)) {
    const { index: following, cost } = bestIndex(anchors, work);
    if (cost) reasons.add('disorder');
    const previous = anchors[following - 1];
    const next = anchors[following];
    const beforeId = next ? startId(next) : null;
    const previousEnd = previous ? endId(previous) : 0;
    const nextPosition = next ? old.findIndex(post => post.id === beforeId) : old.length;
    const anchor = old[nextPosition];
    if (previous && collator.compare(previous.title, work.title) === 0) return { state: 'review', reasons: ['same_title'] };
    if (anchor?.albumId != null && old[nextPosition - 1]?.albumId === anchor.albumId) {
      return { state: 'review', reasons: ['album'] };
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
  return { state: reasons.size ? 'suggest' : 'ready', reasons: [...reasons], uncovered, slots: [...slots.values()] };
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
