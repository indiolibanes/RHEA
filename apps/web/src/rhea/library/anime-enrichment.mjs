import { letterFor, parseEpisodeLabel, titleKey } from './catalog.mjs';

const filenameTitle = /^(?:\[[^\[\]]+\]\s*)*([^\[\]]+?)[ ._-]+S\d{1,3}[ ._-]*E\d{1,4}(?=$|[^\p{L}\p{N}]|V\d)/iu;
const seriesCaption = /^Series:[ \t]*(.{1,120}?)(?:[ \t]*\||\s*$)/iu;
const titleFromFilename = filename => filename?.match(filenameTitle)?.[1]?.replace(/[_.]+/g, ' ').trim();
const order = (a, b) => (a.season ?? Infinity) - (b.season ?? Infinity) ||
  (a.episode ?? Infinity) - (b.episode ?? Infinity) || (a.part ?? 0) - (b.part ?? 0) || a.id - b.id;
const seasonValue = value => Number.isInteger(value) ? 'T' + String(value).padStart(2, '0') : '';
const episodeValue = value => Number.isFinite(value) ? 'E' + String(value).padStart(2, '0') : '';
const slotKey = ({ season, episode, part }) => [season, episode, part ?? 0].join('/');

export const sortAnimeEpisodes = posts => [...posts].sort(order);

export function episodeLabel({ season, episode, part }) {
  const label = seasonValue(season) + episodeValue(episode);
  return label && (Number.isFinite(episode) ? label : label + ' · episódio a conferir') +
    (part ? ' · Parte ' + part : '') || 'Episódio a conferir';
}

export function groupTopicDocuments(posts, reference) {
  const groups = new Map();
  const albumGroups = new Map();
  let unassigned = 0;
  let sectionTitle;
  for (const post of [...posts].sort((a, b) => a.id - b.id)) {
    const captionTitle = seriesCaption.exec(post.caption?.split(/\r?\n/, 1)[0] ?? '')?.[1]?.trim();
    if (post.kind === 'cover' || (post.kind === 'note' && captionTitle)) sectionTitle = captionTitle;
    if (post.kind !== 'document') continue;
    const match = post.filename && reference?.match(post.filename);
    const explicit = match?.reason === 'exact' ? match.series : undefined;
    const filename = post.filename ?? '';
    const metadata = parseEpisodeLabel(filename);
    const detected = metadata.episode !== undefined && titleFromFilename(filename);
    const title = (explicit || captionTitle || detected || sectionTitle || '').trim();
    const groupKey = title && JSON.stringify([titleKey(title, { foldDiacritics: false }), metadata.season ?? null]);
    if (post.albumId) {
      if (!albumGroups.has(post.albumId)) albumGroups.set(post.albumId, new Set());
      albumGroups.get(post.albumId).add(groupKey);
    }
    if (!groupKey) { unassigned++; continue; }
    if (!groups.has(groupKey)) groups.set(groupKey, { key: groupKey, title, season: metadata.season, posts: [] });
    groups.get(groupKey).posts.push({ id: post.id, filename, albumId: post.albumId, ...metadata });
  }
  for (const group of groups.values()) {
    group.posts.sort((a, b) => a.id - b.id);
    const slots = group.posts.filter(p => Number.isFinite(p.episode)).map(slotKey);
    group.duplicate = new Set(slots).size !== slots.length;
    group.missingEpisode = slots.length !== group.posts.length;
    group.albumReview = group.posts.some(post => post.albumId && albumGroups.get(post.albumId).size > 1);
    const albums = new Map();
    for (const post of group.posts) {
      if (!post.albumId) continue;
      const previous = albums.get(post.albumId);
      if (previous && order(previous, post) > 0) group.albumReview = true;
      albums.set(post.albumId, post);
    }
  }
  return { groups: [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, 'pt-BR') ||
    (a.season ?? Infinity) - (b.season ?? Infinity)), unassigned };
}

export function proposeAnimePreview(group, candidate, topics = []) {
  const title = candidate.titles[0];
  const letter = letterFor(title);
  const topicNames = new Set([letter, 'letter ' + letter.toLowerCase(), 'letra ' + letter.toLowerCase()].map(t => t.toLowerCase()));
  const destinations = letter === '#' ? [] : topics.filter(t => !t.closed && !t.hidden && topicNames.has(t.title.trim().toLowerCase()));
  const sorted = sortAnimeEpisodes(group.posts);
  const countMismatch = Number.isSafeInteger(candidate.episodes) && sorted.some(p => p.episode > candidate.episodes);
  return { title, letter, destination: destinations.length === 1 ? destinations[0].title : undefined,
    topicAmbiguous: destinations.length > 1, countMismatch, sorted,
    editionReview: Number.isInteger(group.season) && !['TV', 'TV_SHORT', 'ONA'].includes(candidate.format),
    caption: sorted.map(post => ({
      id: post.id,
      value: post.episode === undefined || countMismatch ? '' :
        [title, episodeLabel(post), candidate.year, candidate.studios[0]].filter(Boolean).join(' · '),
    })) };
}
