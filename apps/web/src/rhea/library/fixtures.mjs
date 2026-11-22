// All titles, message IDs and media descriptors here are fictional.
const series = [
  { id: 'amber', title: 'Amber Atlas' },
  { id: 'kiro', title: 'Kiro Lantern', aliases: [{ language: 'ja', title: 'キロ灯台' }, { language: 'ja-Latn', title: 'Kiro Tōdai' }] },
  { id: 'kestrel', title: 'Kestrel Circuit' },
  { id: 'kumo', title: 'Kumo Station', aliases: [{ language: 'en', title: 'Cloud Terminal' }] },
  { id: 'silk', title: 'Silk Observatory', aliases: [{ language: 'ja', title: '霧の駅' }] },
  { id: 'star', title: 'Starling Workshop', aliases: [{ language: 'en', title: 'Cloud Terminal' }, { language: 'ja', title: '霧の駅' }] },
  { id: 'saffron', title: 'Saffron Signals' },
  { id: 'velvet', title: 'The Velvet Tide' },
];

export function syntheticSnapshot() {
  const messages = [];
  let nextId = 100;
  function post(seriesId, season, episode, extra = {}) {
    const id = nextId++;
    const slot = season == null ? 'bonus' : 'S' + String(season).padStart(2, '0') + 'E' + String(episode ?? 0).padStart(2, '0');
    const message = { id, seriesId, season, episode, caption: episode == null ? 'Material de demonstração' : 'Episódio ' + episode,
      filename: seriesId + '-' + slot + '.mkv', sizeBytes: 16384 + (episode ?? 0), copyPolicy: 'allowed',
      providerMediaId: 'synthetic-' + id, ...extra };
    messages.push(message);
    return message;
  }
  function seasonOf(id, season, count) {
    for (let episode = 1; episode <= count; episode++) post(id, season, episode);
  }
  seasonOf('amber', 1, 8);
  for (const id of ['kiro', 'kestrel', 'kumo', 'silk', 'star', 'saffron', 'velvet']) {
    seasonOf(id, 1, 24);
    seasonOf(id, 2, 24);
  }
  post('kestrel', 2, 25, { albumId: 'kestrel-25', filename: 'kestrel-part-a.mkv' });
  post('kestrel', 2, 25, { albumId: 'kestrel-25', filename: 'kestrel-part-b.mkv' });
  post('kumo', 2, 25, { multipartId: 'kumo-25', part: 1 });
  post('kumo', 2, 25, { multipartId: 'kumo-25', part: 2 });
  post('silk', 2, null);
  for (const kind of ['ova', 'ona', 'special', 'movie', 'extra']) post('star', null, null, { kind });
  const duplicate = messages.find(item => item.seriesId === 'saffron' && item.season === 1 && item.episode === 9);
  const { id: originalId, ...metadata } = duplicate;
  const duplicatePost = post('saffron', 1, 9, metadata);
  return { sourceId: 'demo', complete: true, revision: 'synthetic-v1', messages, series,
    correctionIds: [originalId, duplicatePost.id, messages.find(item => item.seriesId === 'silk' && item.episode === null).id] };
}
