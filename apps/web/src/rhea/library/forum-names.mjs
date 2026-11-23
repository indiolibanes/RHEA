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
    if (!byName.has(key)) byName.set(key, new Map());
    byName.get(key).set(name, entry);
    for (const tag of tags(name)) {
      if (!byTag.has(tag)) byTag.set(tag, new Map());
      byTag.get(tag).set(name, entry);
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
