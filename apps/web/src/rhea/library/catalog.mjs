export const editionTypes = ['episode', 'ova', 'ona', 'special', 'movie', 'extra'];
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'variant', caseFirst: 'upper' });
const byId = (a, b) => a.id - b.id;
const compareText = (a, b) => collator.compare(a, b) || (a < b ? -1 : Number(a > b));
const compareNumber = (a, b) => (a ?? Infinity) - (b ?? Infinity) || 0;
const articles = ['a', 'o', 'as', 'os', 'um', 'uma', 'the', 'an'];

export function titleKey(title, { foldCase = true, foldDiacritics = true, ignoreArticles = false } = {}) {
  let value = title.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (ignoreArticles) {
    const space = value.indexOf(' ');
    if (space >= 0 && articles.includes(value.slice(0, space).toLowerCase())) value = value.slice(space + 1);
  }
  if (foldCase) value = value.toLowerCase();
  if (foldDiacritics) value = value.normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu,
    marks => marks.replace(/\p{Diacritic}/gu, ''));
  return value.normalize('NFC');
}

export function letterFor(title) {
  const letter = titleSortKey(title).charAt(0).toUpperCase();
  return /^[A-Z]$/.test(letter) ? letter : '#';
}

export function titleSortKey(title, options) {
  return titleKey(title, options).replace(/[\p{P}\p{S}]/gu, '').trim().replace(/\s+/gu, ' ');
}

export function compareTitleOrder(a, b) {
  return compareText(titleSortKey(a), titleSortKey(b));
}

export function parseEpisodeLabel(label) {
  if (typeof label !== 'string') return {};
  const text = label.normalize('NFKC');
  const matches = [...text.matchAll(/(?:^|[^\p{L}\p{N}])[ST](\d{1,3})[ ._-]*E(\d{1,4}(?:\.\d+)?)(?=$|[^\p{L}\p{N}]|V\d)/giu)];
  const part = [...text.matchAll(/\b(?:part|parte|pt)[ ._-]*(\d{1,3})\b/giu)];
  if (matches.length !== 1 || /E\d+[ ._-]*[-–][ ._-]*E?\d|\d+[ ._-]*(?:&|\+)[ ._-]*E?\d/iu.test(text)) return {};
  return { season: Number(matches[0][1]), episode: Number(matches[0][2]),
    ...(part.length === 1 && Number(part[0][1]) > 0 ? { part: Number(part[0][1]) } : {}) };
}

function validateInput(series, messages, overrides) {
  const seriesIds = new Set();
  for (const item of series) {
    if (typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || !item.title.trim() || seriesIds.has(item.id)) {
      throw new TypeError('Expected unique series IDs and canonical titles.');
    }
    seriesIds.add(item.id);
  }
  const ids = new Set();
  for (const item of messages) {
    if (!Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id)) throw new TypeError('Expected unique positive message IDs.');
    ids.add(item.id);
  }
  for (const [id, patch] of Object.entries(overrides)) {
    if (!ids.has(Number(id)) || !patch || Object.keys(patch).some(key => !['seriesId', 'season', 'episode', 'part', 'kind', 'label'].includes(key))) {
      throw new TypeError('Invalid correction.');
    }
    if (Object.hasOwn(patch, 'seriesId') && patch.seriesId !== null && !seriesIds.has(patch.seriesId)) throw new TypeError('Unknown series.');
    for (const name of ['season', 'episode', 'part']) {
      const value = patch[name];
      const minimum = name === 'part' ? 1 : 0;
      if (Object.hasOwn(patch, name) && value !== null && (!Number.isFinite(value) || value < minimum ||
        value > 99999 || (name !== 'episode' && !Number.isInteger(value)))) throw new TypeError('Invalid episode correction.');
    }
    if (Object.hasOwn(patch, 'kind') && !editionTypes.includes(patch.kind)) throw new TypeError('Invalid edition type.');
    if (Object.hasOwn(patch, 'label') && (typeof patch.label !== 'string' || patch.label.length > 160)) throw new TypeError('Invalid display label.');
  }
  return seriesIds;
}

function groupMessages(messages, issues) {
  const roots = new Map(messages.map(item => [item.id, item.id]));
  const seen = new Map();
  function root(id) {
    while (roots.get(id) !== id) {
      roots.set(id, roots.get(roots.get(id)));
      id = roots.get(id);
    }
    return id;
  }
  for (const item of messages) {
    for (const field of ['albumId', 'multipartId']) {
      if (!item[field]) continue;
      const key = field + ':' + item[field];
      if (seen.has(key)) roots.set(root(item.id), root(seen.get(key)));
      else seen.set(key, item.id);
    }
  }
  const groups = new Map();
  const albumPositions = new Map();
  messages.forEach((item, index) => {
    const id = root(item.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
    if (!item.albumId) return;
    const previous = albumPositions.get(item.albumId);
    if (previous !== undefined && previous + 1 !== index) issues.add('noncontiguous_album');
    albumPositions.set(item.albumId, index);
  });
  return [...groups.values()];
}

const editionRank = item => editionTypes.indexOf(item.kind);
const compareEpisodeSlot = (a, b) => compareNumber(a.season, b.season) || editionRank(a) - editionRank(b) ||
  compareNumber(a.episode, b.episode) || compareNumber(a.part, b.part);
const byEpisode = (a, b) => compareEpisodeSlot(a, b) || byId(a, b);

export function buildCatalog({ series, messages, overrides = {}, options = {} }) {
  const seriesIds = validateInput(series, messages, overrides);
  const issues = new Set();
  const chronological = [...messages].sort(byId).map(item => {
    const parsed = parseEpisodeLabel(item.filename ?? item.caption);
    const metadata = { ...parsed, ...item, ...overrides[item.id] };
    return { ...metadata, kind: editionTypes.includes(metadata.kind) ? metadata.kind : 'episode' };
  });
  const units = groupMessages(chronological, issues).map(items => {
    const first = items[0];
    const identities = new Set(items.map(item => item.seriesId));
    const trusted = identities.size === 1 && seriesIds.has(first.seriesId);
    if (!trusted) issues.add(identities.size > 1 ? 'conflicting_group_identity' : 'unassigned_messages');
    const withAlbum = items.some(item => item.albumId);
    const ordered = [...items].sort(byEpisode);
    if (withAlbum && items.some((item, index) => item.id !== ordered[index].id)) issues.add('album_order_conflict');
    if (items.some(item => item.multipartId) &&
      (new Set(items.map(item => [item.season, item.kind, item.episode].join('/'))).size > 1 ||
      items.some(item => !Number.isInteger(item.part) || item.part < 1) ||
      new Set(items.map(item => item.part)).size !== items.length)) issues.add('multipart_metadata_conflict');
    return { seriesId: trusted ? first.seriesId : null, sortRecord: ordered[0], items: withAlbum ? items : ordered };
  });
  const grouped = new Map(series.map(item => [item.id, []]));
  const unresolved = [];
  for (const unit of units) {
    if (unit.seriesId === null) unresolved.push(unit);
    else grouped.get(unit.seriesId).push(unit);
  }
  const entries = series.filter(item => grouped.get(item.id).length).map(item => ({
    ...item, key: titleKey(item.sortTitle || item.title, options), units: grouped.get(item.id).sort((a, b) => byEpisode(a.sortRecord, b.sortRecord)),
  })).sort((a, b) => compareText(titleSortKey(a.sortTitle || a.title, options), titleSortKey(b.sortTitle || b.title, options)) ||
    compareText(a.id, b.id));
  for (const entry of entries) {
    const rows = entry.units.flatMap(unit => unit.items);
    if (rows.some((row, index) => index > 0 && compareEpisodeSlot(rows[index - 1], row) > 0)) {
      issues.add('atomic_group_order_conflict');
    }
  }
  return { chronological, entries, unresolved, issues: [...issues].sort(),
    units: [...entries.flatMap(item => item.units), ...unresolved] };
}

export function findSeries(catalog, query, options) {
  const key = titleKey(query, options);
  return catalog.entries.filter(item => [item.title, item.sortTitle, ...(item.aliases ?? []).map(alias => alias.title)]
    .some(title => typeof title === 'string' && titleKey(title, options).includes(key)));
}

export function duplicateCandidates(catalog) {
  const buckets = new Map();
  function add(basis, key, id) {
    const token = JSON.stringify([basis, key]);
    if (!buckets.has(token)) buckets.set(token, { basis, ids: [] });
    buckets.get(token).ids.push(id);
  }
  for (const item of catalog.chronological) {
    if (item.seriesId && item.filename && item.sizeBytes != null && (item.episode != null || item.kind !== 'episode')) {
      add('exact_metadata', [item.seriesId, item.season, item.kind, item.episode, item.part, item.filename, item.caption, item.sizeBytes], item.id);
    }
    if (item.providerMediaId) add('telegram_media_identity', item.providerMediaId, item.id);
    if (/^[0-9a-f]{64}$/i.test(item.sha256 ?? '')) add('verified_sha256', item.sha256.toLowerCase(), item.id);
  }
  return [...buckets.values()].filter(item => item.ids.length > 1);
}

// Pass the bare channel ID from an authorized provider, without the Bot API -100 prefix.
export function privateMessageLink(channelId, messageId) {
  if (typeof channelId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(channelId) ||
    !Number.isSafeInteger(messageId) || messageId < 1) throw new TypeError('Invalid channel or message ID.');
  return 'https://t.me/c/' + channelId + '/' + messageId;
}
