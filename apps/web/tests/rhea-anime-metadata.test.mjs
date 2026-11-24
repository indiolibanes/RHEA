import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animeMetadata } from '../functions/api/rhea/anime-metadata.js';

const url = 'https://workspace.example';
function call(body, fetcher, { origin = url, authorized = true } = {}) {
  const request = new Request(url + '/api/rhea/anime-metadata', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return animeMetadata({ request, data: authorized ? { cloudflareAccess: { JWT: { payload: { sub: 'operator' } } } } : {} }, fetcher);
}

test('anime lookup sends only the typed public title and sanitizes candidates and links', async () => {
  const result = await call({ title: '  Te\u0301st Title  ' }, (target, init) => {
    assert.equal(target, 'https://graphql.anilist.co');
    assert.equal(init.redirect, 'error');
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
