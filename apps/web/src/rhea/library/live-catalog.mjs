import { parseEpisodeLabel, privateMessageLink } from './catalog.mjs';

export function catalogSnapshot(inventory) {
  const series = new Map();
  const messages = inventory.messages.map(post => {
    const firstLine = post.caption?.split(/\r?\n/, 1)[0];
    const match = /^Series:[ \t]*(.{1,120}?)(?:[ \t]*\|[ \t]*(.{1,100}))?$/iu.exec(firstLine ?? '');
    const title = match?.[1].trim().normalize('NFC');
    if (title && !series.has(title)) series.set(title, { id: 'series-' + (series.size + 1), title });
    return {
      ...post, ...parseEpisodeLabel(match?.[2] ?? post.filename),
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
  return { sourceId: 'authorized-channel', revision: inventory.revision, complete: inventory.complete,
    series: [...series.values()], messages, correctionIds: messages.map(post => post.id) };
}
