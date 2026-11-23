const extension = /\.(?:mkv|mp4|webm|avi|ass|srt|m4v|mov|ts)$/i;
const keyFor = value => value.normalize('NFC').replace(extension, '');
const tags = value => [...new Set([...value.matchAll(/\[([a-f0-9]{8})\]/gi)].map(match => match[1].toUpperCase()))];

export function filenameReference(markdown) {
  const byName = new Map();
  const byTag = new Map();
  let series = '';
  let section = '';
  let count = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{2,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (heading[1].length === 2) series = section = '';
      if (heading[1].length === 3) { series = heading[2]; section = ''; }
      if (heading[1].length >= 4) section = heading[2];
    }
    const name = /^\s*[-*]\s+`([^`]+)`\s*$/.exec(line)?.[1];
    if (!name || name.length > 512 || /[\x00-\x1f]/.test(name)) continue;
    const entry = { name, series, section };
    count++;
    const key = keyFor(name);
    const identity = JSON.stringify([name, series, section]);
    if (!byName.has(key)) byName.set(key, new Map());
    byName.get(key).set(identity, entry);
    for (const tag of tags(name)) {
      if (!byTag.has(tag)) byTag.set(tag, new Map());
      byTag.get(tag).set(identity, entry);
    }
  }
  return {
    count,
    match(filename) {
      if (!filename) return { reason: 'unmatched' };
      const exact = byName.get(keyFor(filename));
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
