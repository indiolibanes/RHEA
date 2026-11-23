import { boundedTelegramJson } from '../../../src/rhea/library/telegram-contract.mjs';

const query = `query ($title: String!) {
  Page(page: 1, perPage: 6) {
    media(type: ANIME, search: $title, isAdult: false) {
      id title { romaji english native } startDate { year }
      episodes format genres studios(isMain: true) { nodes { name } }
      coverImage { large }
    }
  }
}`;

const text = value => typeof value === 'string' ? value.trim().slice(0, 160) : '';
const number = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const formats = new Set(['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']);
const names = values => Array.isArray(values) ? [...new Set(values.map(text).filter(Boolean))].slice(0, 12) : [];

function candidate(entry) {
  const id = number(entry?.id);
  const titles = [entry?.title?.romaji, entry?.title?.english, entry?.title?.native].map(text).filter(Boolean);
  if (!id || !titles.length) return null;
  const cover = entry.coverImage?.large;
  return { id, titles: [...new Set(titles)], url: 'https://anilist.co/anime/' + id,
    cover: typeof cover === 'string' && cover.length <= 512 &&
      /^https:\/\/s4\.anilist\.co\/file\/anilistcdn\/media\/anime\/cover\/large\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(cover) ? cover : undefined,
    format: formats.has(entry.format) ? entry.format : undefined, year: number(entry.startDate?.year),
    episodes: number(entry.episodes), genres: names(entry.genres),
    studios: Array.isArray(entry.studios?.nodes) ? names(entry.studios.nodes.map(studio => studio?.name)) : [] };
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function animeMetadata({ request, data }, fetcher = fetch) {
  const origin = new URL(request.url).origin;
  if (!data.cloudflareAccess?.JWT?.payload?.sub) return json({ state: 'access_required' }, 401);
  if (request.method !== 'POST' || request.headers.get('Origin') !== origin) return json({ state: 'not_allowed' }, 403);
  if (!/^application\/json(?:[; ]|$)/i.test(request.headers.get('Content-Type') ?? '')) return json({ state: 'invalid_title' }, 400);
  let title;
  try {
    const input = await boundedTelegramJson(request, 1024);
    if (Object.keys(input ?? {}).length === 1 && typeof input.title === 'string') title = input.title.trim().normalize('NFC');
  } catch { /* Reject unreadable or oversized input. */ }
  if (!title || title.length < 2 || title.length > 120 || /[\p{Cc}]/u.test(title)) return json({ state: 'invalid_title' }, 400);
  try {
    const response = await fetcher('https://graphql.anilist.co', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { title } }),
    });
    if (response.status === 429) return json({ state: 'rate_limited' }, 429);
    if (!response.ok) return json({ state: 'unavailable' }, 503);
    const payload = await boundedTelegramJson(response, 65_536);
    const entries = payload?.data?.Page?.media;
    if (payload?.errors?.length || !Array.isArray(entries) || entries.length > 6) return json({ state: 'unavailable' }, 503);
    return json({ state: 'candidates', candidates: entries.map(candidate).filter(Boolean) });
  } catch {
    return json({ state: 'unavailable' }, 503);
  }
}

export function onRequest(context) {
  return animeMetadata(context);
}
