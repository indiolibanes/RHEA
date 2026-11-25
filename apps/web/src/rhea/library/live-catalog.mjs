import { parseEpisodeLabel, privateMessageLink, titleKey } from './catalog.mjs';
import { groupTopicDocuments } from './anime-enrichment.mjs';
import { forumId } from './forum-contract.mjs';

function extraKind(filename) {
  if (typeof filename !== 'string') return;
  const stem = filename.normalize('NFKC').replace(/\.[a-z0-9]+$/i, '');
  const suffix = /(?:[ ._]-(?:[ ._]+)|\[)(OVA|ONA|Special|Especial)(?:[ ._-]+\d{1,3})?\s*\]?(?:[ ._-]*\[[^\[\]]+\])*[ ._-]*$/iu.exec(stem);
  const kind = suffix?.[1].toLowerCase();
  return kind === 'especial' ? 'special' : kind;
}

export function catalogSnapshot(inventory) {
  const series = new Map();
  const messages = inventory.messages.map(post => {
    const firstLine = post.caption?.split(/\r?\n/, 1)[0];
    const match = /^Series:[ \t]*(.{1,120}?)(?:[ \t]*\|[ \t]*(.{1,100}))?$/iu.exec(firstLine ?? '');
    const title = match?.[1].trim().normalize('NFC');
    if (title && !series.has(title)) series.set(title, { id: 'series-' + (series.size + 1), title });
    return {
      ...post, ...parseEpisodeLabel(match?.[2] ?? post.filename), kind: post.kind ?? extraKind(post.filename),
      seriesId: series.get(title)?.id,
      link: privateMessageLink(inventory.channelId, post.id),
    };
  });

  const albums = new Map();
  for (const post of messages) {
    if (!post.albumId) continue;
    if (!albums.has(post.albumId)) albums.set(post.albumId, []);
    albums.get(post.albumId).push(post);
  }
  for (const members of albums.values()) {
    const described = members.filter(post => post.seriesId);
    const signatures = new Set(described.map(post => JSON.stringify([post.seriesId, post.season, post.episode, post.part])));
    if (signatures.size !== 1) continue;
    const example = described[0];
    for (const post of members) {
      if (post.seriesId || post.season != null || post.episode != null || post.part != null) continue;
      Object.assign(post, { seriesId: example.seriesId, season: example.season, episode: example.episode, part: example.part });
    }
  }
  return { sourceId: 'authorized-channel', channelId: inventory.channelId, revision: inventory.revision, complete: inventory.complete,
    series: [...series.values()], messages, correctionIds: messages.map(post => post.id) };
}

export function forumCatalogSnapshot({ title, topicId, channelId, posts, complete, reference }) {
  if (!forumId(topicId)) throw new TypeError('Invalid topic ID.');
  const { groups, sections } = groupTopicDocuments(posts, reference);
  const entries = new Map();
  const assignments = new Map();
  function seriesFor(title) {
    const key = titleKey(title, { foldDiacritics: false });
    if (!entries.has(key)) entries.set(key, { id: 'forum-series-' + (entries.size + 1), title });
    return entries.get(key).id;
  }
  for (const section of sections) assignments.set(section.id, { seriesId: seriesFor(section.title), kind: 'extra' });
  for (const group of groups) {
    const seriesId = seriesFor(group.title);
    for (const { id, season, episode, part } of group.posts) assignments.set(id, { seriesId, season, episode, part });
  }
  const messages = posts.map(post => ({ ...post,
    ...(post.kind === 'document' && { kind: extraKind(post.filename) }), ...assignments.get(post.id),
    link: topicId === 1 ? privateMessageLink(channelId, post.id) : privateMessageLink(channelId, topicId) + '/' + post.id }));
  return { sourceId: 'forum-topic', channelId, title, complete, series: [...entries.values()],
    messages, correctionIds: messages.map(post => post.id) };
}
