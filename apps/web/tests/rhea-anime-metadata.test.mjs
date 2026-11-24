import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animeMetadata } from '../functions/api/rhea/anime-metadata.js';

const url = 'https://workspace.example';
function call(body, fetcher, { origin = url, authorized = true, site } = {}) {
  const request = new Request(url + '/api/rhea/anime-metadata', { method: 'POST',
    headers: { ...(origin && { Origin: origin }), ...(site && { 'Sec-Fetch-Site': site }),
      'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return animeMetadata({ request, data: authorized ? { cloudflareAccess: { JWT: { payload: { sub: 'operator' } } } } : {} }, fetcher);
}

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
