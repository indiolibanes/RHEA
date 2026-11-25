import { boundedTelegramJson } from '../../../src/rhea/library/telegram-contract.mjs';
import { validAniListId, validMalClientId } from '../../../src/rhea/library/anime-lookup.mjs';

const mediaFields = `id title { romaji english native } startDate { year }
  episodes duration format genres studios(isMain: true) { nodes { name } }
  coverImage { large }`;
const query = `query ($title: String!) {
  Page(page: 1, perPage: 6) {
    media(type: ANIME, search: $title, isAdult: false) {
      ${mediaFields}
    }
  }
}`;
const byIdQuery = `query ($id: Int!) { Media(id: $id, type: ANIME) { isAdult ${mediaFields} } }`;

const text = value => typeof value === 'string' ? value.trim().slice(0, 160) : '';
const number = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const formats = new Set(['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']);
const names = values => Array.isArray(values) ? [...new Set(values.map(text).filter(Boolean))].slice(0, 12) : [];
const malFormats = { tv: 'TV', movie: 'MOVIE', special: 'SPECIAL', ova: 'OVA', ona: 'ONA', music: 'MUSIC',
  tv_special: 'SPECIAL' };

function candidate(entry) {
  const id = number(entry?.id);
  const titles = [entry?.title?.romaji, entry?.title?.english, entry?.title?.native].map(text).filter(Boolean);
  if (!id || !titles.length) return null;
  const cover = entry.coverImage?.large;
  return { id, titles: [...new Set(titles)], url: 'https://anilist.co/anime/' + id,
    cover: typeof cover === 'string' && cover.length <= 512 &&
      /^https:\/\/s4\.anilist\.co\/file\/anilistcdn\/media\/anime\/cover\/large\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(cover) ? cover : undefined,
    format: formats.has(entry.format) ? entry.format : undefined, year: number(entry.startDate?.year),
    episodes: number(entry.episodes), duration: number(entry.duration), genres: names(entry.genres),
    studios: Array.isArray(entry.studios?.nodes) ? names(entry.studios.nodes.map(studio => studio?.name)) : [] };
}

function malCandidate(entry) {
  const node = entry?.node;
  const id = number(node?.id);
  const titles = [node?.title, node?.alternative_titles?.en, node?.alternative_titles?.ja].map(text).filter(Boolean);
  if (!id || !titles.length) return null;
  const cover = node.main_picture?.large ?? node.main_picture?.medium;
  return { id, titles: [...new Set(titles)], url: 'https://myanimelist.net/anime/' + id, provider: 'mal',
    cover: typeof cover === 'string' && cover.length <= 512 &&
      /^https:\/\/cdn\.myanimelist\.net\/images\/anime\/[\w/.-]+\.(?:png|jpe?g|webp)$/i.test(cover) ? cover : undefined,
    format: Object.hasOwn(malFormats, node.media_type) ? malFormats[node.media_type] : undefined,
    year: typeof node.start_date === 'string' && /^[0-9]{4}(?:-|$)/.test(node.start_date) ?
      number(Number(node.start_date.slice(0, 4))) : undefined,
    episodes: number(node.num_episodes), duration: number(Math.round(node.average_episode_duration / 60)),
    genres: names(Array.isArray(node.genres) ? node.genres.map(item => item?.name) : []),
    studios: names(Array.isArray(node.studios) ? node.studios.map(item => item?.name) : []) };
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    ...(body.retryAfter ? { 'Retry-After': String(body.retryAfter) } : {}) } });
}

export async function animeMetadata({ request, data, env }, fetcher = fetch) {
  const origin = new URL(request.url).origin;
  if (!data.cloudflareAccess?.JWT?.payload?.sub) return json({ state: 'access_required' }, 401);
  const suppliedOrigin = request.headers.get('Origin');
  // The workspace uses no-referrer, which can suppress Origin even for same-origin POSTs.
  const sameOrigin = suppliedOrigin === origin ||
    ((!suppliedOrigin || suppliedOrigin === 'null') && request.headers.get('Sec-Fetch-Site') === 'same-origin');
  if (request.method !== 'POST' || !sameOrigin) return json({ state: 'not_allowed' }, 403);
  if (!/^application\/json(?:[; ]|$)/i.test(request.headers.get('Content-Type') ?? '')) return json({ state: 'invalid_title' }, 400);
  let title;
  let aniListId;
  let provider = 'anilist';
  let sessionClientId;
  try {
    const input = await boundedTelegramJson(request, 1024);
    const keys = Object.keys(input ?? {});
    if (keys.length === 1 && validAniListId(input?.aniListId)) aniListId = input.aniListId;
    else if (typeof input?.title === 'string' && keys.every(key => ['title', 'provider', 'malClientId'].includes(key)) &&
        (!Object.hasOwn(input, 'malClientId') || (input.provider === 'mal' && validMalClientId(input.malClientId))) &&
        (input.provider === undefined || ['anilist', 'mal'].includes(input.provider))) {
      title = input.title.trim().normalize('NFC');
      provider = input.provider ?? provider;
      sessionClientId = input.malClientId;
    }
  } catch { /* Reject unreadable or oversized input. */ }
  if (!aniListId && (!title || title.length < 2 || title.length > 120 || /[\p{Cc}]/u.test(title))) {
    return json({ state: 'invalid_title' }, 400);
  }
  const useMal = provider === 'mal';
  let endpoint = 'https://graphql.anilist.co';
  let options = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(aniListId ? { query: byIdQuery, variables: { id: aniListId } } : { query, variables: { title } }) };
  if (useMal) {
    const clientId = sessionClientId ?? env?.RHEA_MAL_CLIENT_ID?.trim();
    if (!clientId) return json({ state: 'provider_unconfigured' }, 503);
    const url = new URL('https://api.myanimelist.net/v2/anime');
    url.search = new URLSearchParams({ q: title, limit: '6', nsfw: 'false',
      fields: 'id,title,alternative_titles,start_date,num_episodes,average_episode_duration,media_type,genres,studios,main_picture' });
    endpoint = url.href;
    options = { headers: { 'X-MAL-Client-ID': clientId, Accept: 'application/json' } };
  }
  // Fixed categories only: no title, upstream body, header or session value reaches the log.
  const failed = (stage, state, status, extra = {}) => {
    console.warn('[rhea-anime-metadata] lookup_failed', { provider, stage, ...extra });
    return json({ state }, status);
  };
  let response;
  try {
    // Cloudflare Workers reject redirect: 'error' before any network I/O, so redirects are refused manually.
    response = await fetcher(endpoint, { ...options, redirect: 'manual', signal: AbortSignal.timeout(6000) });
  } catch (error) {
    return error?.name === 'TimeoutError' || error?.name === 'AbortError' ?
      failed('timeout', 'provider_timeout', 504) : failed('transport', 'provider_unreachable', 503);
  }
  try {
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      console.warn('[rhea-anime-metadata] lookup_failed', { provider, stage: 'rate_limit', status: 429 });
      return json({ state: 'rate_limited',
        ...(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 3600 ? { retryAfter } : {}) }, 429);
    }
    if (response.status === 403 || (useMal && response.status === 401)) {
      return failed('refused', 'provider_refused', 503,
        { status: response.status, html: /text\/html/i.test(response.headers.get('Content-Type') ?? '') });
    }
    if (response.status >= 300 && response.status < 400) return failed('redirect', 'provider_unavailable', 503, { status: response.status });
    if (response.status >= 500) return failed('upstream_status', 'provider_unavailable', 503, { status: response.status });
    if (aniListId && response.status === 404) return json({ state: 'candidates', candidates: [] });
    if (!response.ok) return failed('upstream_status', 'provider_error', 502, { status: response.status });
    if (!/^application\/json(?:[; ]|$)/i.test(response.headers.get('Content-Type') ?? '')) {
      return failed('content_type', 'provider_error', 502, { status: response.status });
    }
    const payload = await boundedTelegramJson(response, 65_536);
    if (aniListId && payload?.errors?.length && payload.errors.every(error => error?.status === 404)) {
      return json({ state: 'candidates', candidates: [] });
    }
    if (aniListId && payload?.data?.Media && payload.data.Media.id !== aniListId) return failed('shape', 'provider_error', 502);
    const entries = useMal ? payload?.data : aniListId ?
      (Object.hasOwn(payload?.data ?? {}, 'Media') ? [payload.data.Media].filter(entry => !entry?.isAdult) : undefined) :
      payload?.data?.Page?.media;
    if (payload?.errors?.length) return failed('graphql_errors', 'provider_error', 502, { status: response.status });
    if (!Array.isArray(entries) || entries.length > 6) return failed('shape', 'provider_error', 502, { status: response.status });
    return json({ state: 'candidates', candidates: entries.map(useMal ? malCandidate : candidate).filter(Boolean) });
  } catch {
    return failed('body', 'provider_unavailable', 503);
  }
}

export function onRequest(context) {
  return animeMetadata(context);
}
