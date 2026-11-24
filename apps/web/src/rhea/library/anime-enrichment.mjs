import { letterFor, parseEpisodeLabel, titleKey } from './catalog.mjs';
import { forumId } from './forum-contract.mjs';

const filenameTitle = /^(?:\[[^\[\]]+\]\s*)*([^\[\]]+?)[ ._-]+[ST]\d{1,3}[ ._-]*E\d{1,4}(?=$|[^\p{L}\p{N}]|V\d)/iu;
const numberedFansubTitle = /^(?:\[[^\[\]]+\][ ._-]*)+([^\[\]]+?)[ _-]+(\d{1,3})(?:v[1-9]\d?)?(?:[ ._-]*\[[^\[\]]+\])*[ ._-]*\.(?:mkv|mp4|avi|webm)$/iu;
const seriesCaption = /^Series:[ \t]*(.{1,120}?)(?:[ \t]*\||\s*$)/iu;
const titleFromFilename = filename => filename?.match(filenameTitle)?.[1]?.replace(/[_.]+/g, ' ').trim();
const order = (a, b) => (a.season ?? Infinity) - (b.season ?? Infinity) ||
  (a.episode ?? Infinity) - (b.episode ?? Infinity) || (a.part ?? 0) - (b.part ?? 0) || a.id - b.id;
const seasonValue = value => Number.isInteger(value) ? 'T' + String(value).padStart(2, '0') : '';
const episodeValue = value => Number.isFinite(value) ? 'E' + String(value).padStart(2, '0') : '';
const slotKey = ({ season, episode, part }) => [season, episode, part ?? 0].join('/');

export const sortAnimeEpisodes = posts => [...posts].sort(order);

function numberedFansubEpisode(filename) {
  const match = numberedFansubTitle.exec(filename.normalize('NFKC'));
  if (!match || !/\p{L}/u.test(match[1]) || /(?:^|[ ._-])[ST]?\d{1,3}$/i.test(match[1])) return null;
  return { title: match[1].replace(/[_.]+/g, ' ').trim(), episode: Number(match[2]) };
}

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
    const numbered = metadata.episode === undefined ? numberedFansubEpisode(filename) : null;
    if (numbered) metadata.episode = numbered.episode;
    const detected = numbered?.title || (metadata.episode !== undefined && titleFromFilename(filename));
    const title = (explicit || captionTitle || detected || sectionTitle || '').trim();
    const groupKey = title && JSON.stringify([titleKey(title, { foldDiacritics: false }), metadata.season ?? null]);
    if (post.albumId) {
      if (!albumGroups.has(post.albumId)) albumGroups.set(post.albumId, new Set());
      albumGroups.get(post.albumId).add(groupKey);
    }
    if (!groupKey) { unassigned++; continue; }
    if (!groups.has(groupKey)) groups.set(groupKey, { key: groupKey, title, season: metadata.season, posts: [] });
    groups.get(groupKey).posts.push({ id: post.id, filename, albumId: post.albumId, sizeBytes: post.sizeBytes,
      protected: post.protected === true, ...metadata });
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

export function alphabeticDestination(letter, topics, sourceTopicId, role = 'letter') {
  if (!/^[A-Z]$/.test(letter)) return { state: 'unsupported' };
  const matches = topics.filter(topic => {
    if (!forumId(topic.id) || topic.id === 1 || topic.hidden || typeof topic.title !== 'string') return false;
    const label = titleKey(topic.title).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    const match = /^(?:(?:letter|letra) )?(?:([a-z])|"([a-z])"|'([a-z])')( \[new\])?$/.exec(label);
    return match && (match[1] ?? match[2] ?? match[3]).toUpperCase() === letter &&
      (match[4] ? 'replacement' : 'letter') === role;
  });
  // A closed topic is located but cannot receive files: it needs its own message, not "missing".
  const open = matches.filter(topic => !topic.closed);
  if (open.length > 1) return { state: 'ambiguous' };
  const [topic] = open;
  if (!topic) return { state: matches.length ? 'closed' : 'missing', ...(matches.length === 1 && { topic: matches[0] }) };
  return topic.id === sourceTopicId ? { state: 'source' } : { state: 'found', topic };
}

export function proposeAnimePreview(group, candidate, topics = []) {
  const title = candidate.titles[0];
  const letter = letterFor(title);
  const { topic: destination, state } = alphabeticDestination(letter, topics);
  const sorted = sortAnimeEpisodes(group.posts);
  const countMismatch = Number.isSafeInteger(candidate.episodes) && sorted.some(p => p.episode > candidate.episodes);
  const sized = sorted.filter(post => Number.isSafeInteger(post.sizeBytes) && post.sizeBytes >= 0);
  return { title, letter, destination: destination?.title, destinationTopicId: destination?.id,
    topicAmbiguous: state === 'ambiguous', countMismatch, sorted, sizedCount: sized.length,
    totalBytes: sized.reduce((total, post) => total + BigInt(post.sizeBytes), 0n),
    editionReview: Number.isInteger(group.season) && !['TV', 'TV_SHORT', 'ONA'].includes(candidate.format),
    caption: sorted.map(post => ({
      id: post.id,
      value: post.episode === undefined || countMismatch ? '' :
        [title, episodeLabel(post), candidate.year, candidate.studios[0]].filter(Boolean).join(' · '),
    })) };
}
