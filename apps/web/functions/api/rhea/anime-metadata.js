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
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    ...(body.retryAfter ? { 'Retry-After': String(body.retryAfter) } : {}) } });
}

const userAgent = 'RHEA-AniList-Lookup/1.0 (+https://github.com/indiolibanes/RHEA)';

export async function animeMetadata({ request, data }, fetcher = fetch) {
  const origin = new URL(request.url).origin;
  if (!data.cloudflareAccess?.JWT?.payload?.sub) return json({ state: 'access_required' }, 401);
  const suppliedOrigin = request.headers.get('Origin');
  // The workspace uses no-referrer, which can suppress Origin even for same-origin POSTs.
  const sameOrigin = suppliedOrigin === origin ||
    ((!suppliedOrigin || suppliedOrigin === 'null') && request.headers.get('Sec-Fetch-Site') === 'same-origin');
  if (request.method !== 'POST' || !sameOrigin) return json({ state: 'not_allowed' }, 403);
  if (!/^application\/json(?:[; ]|$)/i.test(request.headers.get('Content-Type') ?? '')) return json({ state: 'invalid_title' }, 400);
  let title;
  try {
    const input = await boundedTelegramJson(request, 1024);
    if (Object.keys(input ?? {}).length === 1 && typeof input.title === 'string') title = input.title.trim().normalize('NFC');
  } catch { /* Reject unreadable or oversized input. */ }
  if (!title || title.length < 2 || title.length > 120 || /[\p{Cc}]/u.test(title)) return json({ state: 'invalid_title' }, 400);
  // Fixed categories only: no title, upstream body, header or session value reaches the log.
  const failed = (stage, state, status, extra = {}) => {
    console.warn('[rhea-anilist] lookup_failed', { stage, ...extra });
    return json({ state }, status);
  };
  let response;
  try {
    // Cloudflare Workers reject redirect: 'error' before any network I/O, so redirects are refused manually.
    response = await fetcher('https://graphql.anilist.co', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(6000),
      // An honest, stable identity: AniList sits behind an edge that refuses requests with no User-Agent.
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify({ query, variables: { title } }),
    });
  } catch (error) {
    return error?.name === 'TimeoutError' || error?.name === 'AbortError' ?
      failed('timeout', 'provider_timeout', 504) : failed('transport', 'provider_unreachable', 503);
  }
  try {
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      console.warn('[rhea-anilist] lookup_failed', { stage: 'rate_limit', status: 429 });
      return json({ state: 'rate_limited',
        ...(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 3600 ? { retryAfter } : {}) }, 429);
    }
    if (response.status === 403) {
      // AniList documents a JSON 403 for a temporary suspension; an HTML 403 comes from the provider's edge.
      const json403 = /^application\/json(?:[; ]|$)/i.test(response.headers.get('Content-Type') ?? '');
      return failed(json403 ? 'suspended' : 'refused', json403 ? 'provider_suspended' : 'provider_refused', 503,
        { status: 403, html: !json403 });
    }
    if (response.status >= 300 && response.status < 400) return failed('redirect', 'provider_unavailable', 503, { status: response.status });
    if (response.status >= 500) return failed('upstream_status', 'provider_unavailable', 503, { status: response.status });
    if (!response.ok) return failed('upstream_status', 'provider_error', 502, { status: response.status });
    if (!/^application\/json(?:[; ]|$)/i.test(response.headers.get('Content-Type') ?? '')) {
      return failed('content_type', 'provider_error', 502, { status: response.status });
    }
    const payload = await boundedTelegramJson(response, 65_536);
    const entries = payload?.data?.Page?.media;
    if (payload?.errors?.length) return failed('graphql_errors', 'provider_error', 502, { status: response.status });
    if (!Array.isArray(entries) || entries.length > 6) return failed('shape', 'provider_error', 502, { status: response.status });
    return json({ state: 'candidates', candidates: entries.map(candidate).filter(Boolean) });
  } catch {
    return failed('body', 'provider_unavailable', 503);
  }
}

export function onRequest(context) {
  return animeMetadata(context);
}
