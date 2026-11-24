import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animeMetadata } from '../functions/api/rhea/anime-metadata.js';

const url = 'https://workspace.example';
function call(body, fetcher, { origin = url, authorized = true, site, env } = {}) {
  const request = new Request(url + '/api/rhea/anime-metadata', { method: 'POST',
    headers: { ...(origin && { Origin: origin }), ...(site && { 'Sec-Fetch-Site': site }),
      'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return animeMetadata({ request, env,
    data: authorized ? { cloudflareAccess: { JWT: { payload: { sub: 'operator' } } } } : {} }, fetcher);
}

test('uses the configured MyAnimeList client ID only at the official API and maps public metadata', async () => {
  const result = await call({ title: '  Synthetic "T" ', provider: 'mal' }, (endpoint, init) => {
    const target = new URL(endpoint);
    assert.equal(target.origin + target.pathname, 'https://api.myanimelist.net/v2/anime');
    assert.equal(target.searchParams.get('q'), 'Synthetic "T"');
    assert.equal(target.searchParams.get('limit'), '6');
    assert.equal(target.searchParams.get('nsfw'), 'false');
    assert.match(target.searchParams.get('fields'), /studios/);
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('X-MAL-Client-ID'), 'fixture-client-id');
    assert.equal(init.body, undefined);
    return Response.json({ data: [null, { node: { id: 75, title: 'Synthetic T', media_type: 'tv', start_date: '2017-04-07',
      num_episodes: 12, average_episode_duration: 1500, studios: [{ name: 'Fixture Studio' }],
      genres: [{ name: 'Romance' }], main_picture: { large: 'https://cdn.myanimelist.net/images/anime/9/3.jpg' } } }] });
  }, { env: { RHEA_MAL_CLIENT_ID: 'fixture-client-id' } });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { state: 'candidates', candidates: [{
    id: 75, provider: 'mal', titles: ['Synthetic T'], format: 'TV', year: 2017, episodes: 12, duration: 25,
    studios: ['Fixture Studio'], genres: ['Romance'], url: 'https://myanimelist.net/anime/75',
    cover: 'https://cdn.myanimelist.net/images/anime/9/3.jpg',
  }] });
});

test('requires a configured MAL ID and rejects private fields and arbitrary providers before fetching', async () => {
  const noFetch = () => assert.fail('Input must not reach a provider.');
  const input = { title: 'Synthetic T', provider: 'mal' };
  assert.deepEqual(await (await call(input, noFetch)).json(), { state: 'provider_unconfigured' });
  assert.equal((await call(input, noFetch, { authorized: false })).status, 401);
  assert.equal((await call({ ...input, filename: 'Private.mkv' }, noFetch)).status, 400);
  assert.equal((await call({ ...input, provider: 'https://untrusted.invalid' }, noFetch)).status, 400);
});

test('sends the session MAL Client ID only in the MyAnimeList header', async () => {
  const clientId = 'a'.repeat(32);
  const stored = 'b'.repeat(32);
  const reply = await call({ title: 'Synthetic T', provider: 'mal', malClientId: clientId }, (endpoint, init) => {
    assert.equal(new URL(endpoint).host, 'api.myanimelist.net');
    assert.equal(new Headers(init.headers).get('X-MAL-Client-ID'), clientId);
    assert.ok(!endpoint.includes(clientId));
    return Response.json({ data: [] });
  }, { env: { RHEA_MAL_CLIENT_ID: stored } });
  assert.deepEqual(await reply.json(), { state: 'candidates', candidates: [] });
  const noFetch = () => assert.fail('A credential outside its provider must not be sent.');
  assert.equal((await call({ title: 'Synthetic T', malClientId: clientId }, noFetch)).status, 400);
  assert.equal((await call({ title: 'Synthetic T', provider: 'mal', malClientId: 'invalid' }, noFetch)).status, 400);
});

test('anime lookup sends only the typed public title and sanitizes candidates and links', async () => {
  const result = await call({ title: '  Te\u0301st Title  ' }, (target, init) => {
    assert.equal(target, 'https://graphql.anilist.co');
    assert.equal(init.redirect, 'manual');
    assert.ok(!new Headers(init.headers).has('Authorization'));
    const body = JSON.parse(init.body);
    assert.deepEqual(body.variables, { title: 'Tést Title' });
    assert.match(body.query, /ANIME/);
    return Response.json({ data: { Page: { media: [
      { id: 27, title: { romaji: 'Tést Title', english: 'Test title', native: 'テスト' }, format: 'OVA',
        startDate: { year: 2003 }, episodes: 2, genres: ['Drama'], studios: { nodes: [{ name: 'Test Studio' }] },
        siteUrl: 'https://other.invalid/27', coverImage: { large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/test.jpg' } },
      { id: 28, title: { romaji: 'Other Test' }, coverImage: { large: 'https://s4.anilist.co.attacker.invalid/test.jpg' } },
      { id: 'broken', title: { romaji: 'Invalid test' } },
    ] } } });
  });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual(await result.json(), { state: 'candidates', candidates: [
    { id: 27, titles: ['Tést Title', 'Test title', 'テスト'], url: 'https://anilist.co/anime/27',
      cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/test.jpg',
      format: 'OVA', year: 2003, episodes: 2, genres: ['Drama'], studios: ['Test Studio'] },
    { id: 28, titles: ['Other Test'], url: 'https://anilist.co/anime/28', genres: [], studios: [] },
  ] });
});

test('accepts a suppressed Origin only with same-origin browser metadata and an Access session', async () => {
  const reply = () => Response.json({ data: { Page: { media: [] } } });
  const input = { title: 'Synthetic title' };
  assert.equal((await call(input, reply, { origin: 'null', site: 'same-origin' })).status, 200);
  assert.equal((await call(input, reply, { origin: '', site: 'same-origin' })).status, 200);
  assert.equal((await call(input, reply, { origin: 'null', site: 'same-site' })).status, 403);
  assert.equal((await call(input, reply, { origin: 'https://other.invalid', site: 'same-origin' })).status, 403);
  assert.equal((await call(input, reply, { origin: 'null', site: 'same-origin', authorized: false })).status, 401);
});

test('prevents cross-origin requests, extra private fields and oversized results', async () => {
  const noFetch = () => { assert.fail('Unauthorized input must not reach the provider.'); };
  assert.equal((await call({ title: 'Aurora' }, noFetch, { authorized: false })).status, 401);
  assert.equal((await call({ title: 'Aurora' }, noFetch, { origin: 'https://other.invalid' })).status, 403);
  assert.equal((await call({ title: 'Aurora', caption: 'private' }, noFetch)).status, 400);
  assert.equal((await call({ title: 'a'.repeat(4096) }, noFetch)).status, 400);
  const oversized = await call({ title: 'Aurora' }, () => Response.json({ fill: 'a'.repeat(80_000) }));
  assert.equal(oversized.status, 503);
  const flooded = await call({ title: 'Aurora' }, () => new Response('Provider error', { status: 429 }));
  assert.deepEqual(await flooded.json(), { state: 'rate_limited' });
});

test('distinguishes an AniList refusal, rate limit and unavailable upstream without exposing the response body', async () => {
  const refused = await call({ title: 'Aurora' }, () => new Response('<p>Provider challenge</p>', { status: 403 }));
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { state: 'provider_refused' });
  const throttled = await call({ title: 'Aurora' }, () => new Response(null, { status: 429, headers: { 'Retry-After': '30' } }));
  assert.equal(throttled.headers.get('Retry-After'), '30');
  assert.deepEqual(await throttled.json(), { state: 'rate_limited', retryAfter: 30 });
  const down = await call({ title: 'Aurora' }, () => new Response(null, { status: 502 }));
  assert.deepEqual(await down.json(), { state: 'provider_unavailable' });
});

// Cloudflare Workers accept only the follow and manual redirect modes and fail the call before network I/O.
const workers = reply => (target, init) => {
  if (init.redirect !== 'follow' && init.redirect !== 'manual') throw new TypeError('Unsupported redirect mode.');
  return reply(target, init);
};
const empty = () => Response.json({ data: { Page: { media: [] } } });

test('a Workers-style runtime reaches the provider and a legitimate empty result is not a failure', async () => {
  const result = await call({ title: 'Synthetic title' }, workers(empty));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { state: 'candidates', candidates: [] });
});

test('classifies timeouts, transport failures, redirects and malformed provider answers separately', async () => {
  const cases = [
    [() => { throw new DOMException('timed out', 'TimeoutError'); }, 504, 'provider_timeout'],
    [() => { throw new TypeError('network'); }, 503, 'provider_unreachable'],
    [() => new Response(null, { status: 302, headers: { Location: 'https://other.invalid/' } }), 503, 'provider_unavailable'],
    [() => new Response('Unavailable', { status: 503 }), 503, 'provider_unavailable'],
    [() => new Response('{}', { status: 400, headers: { 'Content-Type': 'application/json' } }), 502, 'provider_error'],
    [() => Response.json({ errors: [{ message: 'Validation failed', status: 400 }], data: null }), 502, 'provider_error'],
    [() => new Response('<html>challenge</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 502, 'provider_error'],
    [() => Response.json({ data: { Page: { media: 'unexpected' } } }), 502, 'provider_error'],
  ];
  for (const [reply, status, state] of cases) {
    const result = await call({ title: 'Aurora' }, reply);
    assert.equal(result.status, status, state);
    assert.deepEqual(await result.json(), { state });
  }
});

test('failure logs carry fixed categories only', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...values) => warnings.push(JSON.stringify(values));
  try {
    await call({ title: 'Private Synthetic Title' }, () => new Response('<p>Secret provider body</p>', {
      status: 403, headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'secret=1' } }));
    await call({ title: 'Private Synthetic Title' }, () => Response.json({ errors: [{ message: 'Secret provider message' }] }));
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /"refused"/);
  assert.match(warnings[1], /"graphql_errors"/);
  assert.doesNotMatch(warnings.join(), /Private Synthetic|Secret|secret/);
});

test('sends only the confirmed public title and keeps cookies and credentials out of the provider request', async () => {
  let seen;
  const request = new Request(url + '/api/rhea/anime-metadata', { method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json', Cookie: 'session=private', Authorization: 'Bearer private' },
    body: JSON.stringify({ title: 'Tsuki ga Kirei' }) });
  const result = await animeMetadata({ request, data: { cloudflareAccess: { JWT: { payload: { sub: 'operator' } } } } },
    workers((target, init) => { seen = init; return empty(); }));
  assert.equal(result.status, 200);
  const names = [...new Headers(seen.headers).keys()];
  assert.deepEqual(names.sort(), ['accept', 'content-type']);
  assert.deepEqual(JSON.parse(seen.body).variables, { title: 'Tsuki ga Kirei' });
});
