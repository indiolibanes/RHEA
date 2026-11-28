const extension = /\.(?:mkv|mp4|webm|avi|ass|srt|m4v|mov|ts)$/i;
const keyFor = value => value.normalize('NFC').replace(extension, '');
const tags = value => [...new Set([...value.matchAll(/\[([a-f0-9]{8})\]/gi)].map(match => match[1].toUpperCase()))];
const bracketedPrefix = /^\[([^\[\]]+)\][ ._-]*/u;
const knownFansub = /^(Infinite[ ._]+Fansub)[ ._-]+(?=\S)/iu;
const fileLine = /^(?:\[[^\[\]]+\]|#[^_\s]+_).*\[[^\[\]]+\]$/u;
const prefixKey = value => value.toLowerCase().replace(/[ ._]+/gu, ' ');

// Only prefixes present in the reference or known release names are stripped from unbracketed text.
export function stripFansubPrefix(filename, reference) {
  return reference?.stripPrefix(filename) ?? filename.replace(knownFansub, '');
}

export function filenameReference(markdown) {
  const byName = new Map();
  const byRelease = new Map();
  const byTag = new Map();
  const prefixes = new Set();
  let parent = '';
  let series = '';
  let section = '';
  let season;
  let edition;
  let count = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (heading) {
      const [, marks, title] = heading;
      if (marks.length === 1) parent = series = section = '';
      if (marks.length === 2) {
        parent = /^[a-z]$|^(?:Letter|Letra)\s+[a-z]$/iu.test(title) ? '' : title;
        series = parent;
        section = '';
      }
      if (marks.length <= 3) season = edition = undefined;
      if (marks.length === 3) {
        series = parent || title;
        section = parent ? title : '';
        const ordinal = /^(?:(\d{1,3})(?:st|nd|rd|th|[ªº])?\s+(?:Season|Temporada)|(?:Season|Temporada)\s+(\d{1,3}))\b/iu.exec(section);
        if (ordinal) season = Number(ordinal[1] ?? ordinal[2]);
        if (/\b(?:movies?|films?|filmes?|oas|ovas?|onas?|specials?|especiais?|extras?)\b/iu.test(section)) edition = section;
      }
      if (marks.length >= 4) section = title;
      continue;
    }
    const bare = line.trim();
    const name = /^\s*(?:[-*]\s+)?`([^`]+)`\s*$/.exec(line)?.[1] ??
      (series && (fileLine.test(bare) || extension.test(bare)) && !/\]\(|https?:\/\//iu.test(bare) ? bare : undefined);
    if (!name || name.length > 512 || /[\x00-\x1f]/.test(name)) continue;
    const entry = { name, series, section, ...(season !== undefined && { season }), ...(edition && { edition }) };
    count++;
    const key = keyFor(name);
    const identity = JSON.stringify([name, series, section]);
    if (!byName.has(key)) byName.set(key, new Map());
    byName.get(key).set(identity, entry);
    const prefix = bracketedPrefix.exec(key);
    if (prefix && /\p{L}/u.test(prefix[1]) && prefix[1].length <= 64) {
      const tag = prefixKey(prefix[1]);
      prefixes.add(tag);
      const release = tag + '\0' + key.slice(prefix[0].length);
      if (!byRelease.has(release)) byRelease.set(release, new Map());
      byRelease.get(release).set(identity, entry);
    }
    for (const tag of tags(name)) {
      if (!byTag.has(tag)) byTag.set(tag, new Map());
      byTag.get(tag).set(identity, entry);
    }
  }
  const escaped = [...prefixes].sort((a, b) => b.length - a.length)
    .map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replaceAll(' ', '[ ._]+'));
  const unbracketed = escaped.length ? new RegExp('^(' + escaped.join('|') + ')[ ._-]+(?=\\S)', 'iu') : knownFansub;
  return {
    count,
    stripPrefix: filename => filename.replace(unbracketed, '').replace(knownFansub, ''),
    match(filename) {
      if (!filename) return { reason: 'unmatched' };
      const key = keyFor(filename);
      const prefix = bracketedPrefix.exec(key) ?? unbracketed.exec(key);
      const exact = byName.get(key) ?? (prefix && byRelease.get(prefixKey(prefix[1]) + '\0' + key.slice(prefix[0].length)));
      if (exact?.size === 1) return { ...exact.values().next().value, reason: 'exact' };
      if (exact?.size > 1) return { reason: 'ambiguous' };
      const markers = tags(filename);
      if (markers.length !== 1) return { reason: 'unmatched' };
      const candidates = byTag.get(markers[0]);
      if (candidates?.size === 1) return { ...candidates.values().next().value, reason: 'tag' };
      return { reason: candidates?.size ? 'ambiguous' : 'unmatched' };
    },
  };
}

export function forumDocumentTotals(posts) {
  const total = { count: 0, sized: 0, bytes: 0n };
  const groups = new Map();
  const add = (bucket, size) => {
    bucket.count++;
    if (!Number.isSafeInteger(size) || size < 0) return;
    bucket.sized++;
    bucket.bytes += BigInt(size);
  };
  for (const { post, referenceMatch } of posts) {
    if (post.kind !== 'document') continue;
    add(total, post.sizeBytes);
    if (referenceMatch?.reason !== 'exact' || !referenceMatch.series) continue;
    const { series, section } = referenceMatch;
    const key = JSON.stringify([series, section]);
    if (!groups.has(key)) groups.set(key, { series, section, count: 0, sized: 0, bytes: 0n });
    add(groups.get(key), post.sizeBytes);
  }
  return { ...total, groups: [...groups.values()] };
}
