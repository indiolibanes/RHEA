import { animeFormats } from './anime-lookup.mjs';

const text = (value, limit) => typeof value === 'string' ? value.trim().normalize('NFC').slice(0, limit) : '';
const number = (value, minimum, maximum) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= minimum && n <= maximum ? n : undefined;
};

export function manualAnimeMetadata(fields) {
  const title = text(fields.title, 120);
  if (title.length < 2) return null;
  const link = text(fields.link, 512);
  let url;
  if (link) {
    const match = /^https:\/\/anilist\.co\/anime\/([1-9]\d{0,11})(?:\/[\w-]+)?\/?(?:[?#][^\s]*)?$/i.exec(link);
    if (!match) return null;
    url = 'https://anilist.co/anime/' + match[1];
  }
  const optional = { year: number(fields.year, 1900, 2200), episodes: number(fields.episodes, 1, 9999),
    duration: number(fields.duration, 1, 999) };
  if (Object.entries(optional).some(([key, value]) => text(fields[key], 32) && !value)) return null;
  return {
    titles: [title], provider: 'manual', url, ...optional,
    format: Object.hasOwn(animeFormats, fields.format) ? fields.format : undefined,
    studios: [text(fields.studio, 100)].filter(Boolean),
    genres: [...new Set(text(fields.genres, 160).split(',').map(value => value.trim()).filter(Boolean))],
  };
}
