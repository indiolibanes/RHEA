import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupAnime, lookupErrors, lookupMessage, providerFallback, retryableLookup } from '../src/rhea/library/anime-lookup.mjs';

const endpoint = '/api/rhea/anime-metadata';
const reply = (body, { status = 200, type = 'application/json', kind = 'basic' } = {}) => async () => ({
  status, ok: status >= 200 && status < 300, type: kind,
  headers: { get: name => name.toLowerCase() === 'content-type' ? type : null },
  json: async () => { if (typeof body === 'string') throw new SyntaxError('bad'); return body; },
});
const withFetch = async (fetcher, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { return await run(); } finally { globalThis.fetch = original; }
};
const lookup = fetcher => withFetch(fetcher, () => lookupAnime(endpoint, 'Tsuki ga Kirei'));

test('sends a same-origin title-only POST and never follows redirects', async () => {
  let init;
  const result = await lookup(async (_url, options) => { init = options; return reply({ state: 'candidates', candidates: [] })(); });
  assert.deepEqual(result, { state: 'candidates', candidates: [] });
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(JSON.parse(init.body), { title: 'Tsuki ga Kirei' });
});

test('an Access redirect or 401 asks for a new sign-in instead of failing silently', async () => {
  assert.equal((await lookup(reply('', { status: 0, kind: 'opaqueredirect', type: '' }))).state, 'access_required');
  assert.equal((await lookup(reply({}, { status: 401 }))).state, 'access_required');
});

test('missing route, HTML refusal and unexpected bodies are distinct states', async () => {
  assert.equal((await lookup(reply({}, { status: 404 }))).state, 'endpoint_missing');
  assert.equal((await lookup(reply({}, { status: 405 }))).state, 'endpoint_missing');
  assert.equal((await lookup(reply('', { status: 403, type: 'text/html' }))).state, 'access_refused');
  assert.equal((await lookup(reply('', { status: 200, type: 'text/html' }))).state, 'unexpected_response');
  assert.equal((await lookup(reply('not json'))).state, 'unexpected_response');
  assert.equal((await lookup(reply({ state: 'surprise' }, { status: 502 }))).state, 'unexpected_response');
});

test('provider states from the route keep their category and a bounded wait', async () => {
  for (const state of ['provider_refused', 'provider_suspended', 'provider_timeout', 'provider_unreachable', 'provider_error', 'provider_unavailable']) {
    assert.equal((await lookup(reply({ state }, { status: 503 }))).state, state);
  }
  const limited = await lookup(reply({ state: 'rate_limited', retryAfter: 12 }, { status: 429 }));
  assert.deepEqual(limited, { state: 'rate_limited', retryAfter: 12 });
  assert.equal(lookupMessage(limited), 'O AniList pediu uma pausa. Tente novamente em 12 s.');
  for (const retryAfter of [0, -1, 3601, 1.5, '10']) {
    assert.equal((await lookup(reply({ state: 'rate_limited', retryAfter }, { status: 429 }))).retryAfter, undefined);
  }
});

test('every failure has an actionable message and the retry sets are consistent', () => {
  for (const [state, message] of Object.entries(lookupErrors)) assert.match(message, /\S{10}/, state);
  for (const state of [...retryableLookup, ...providerFallback]) assert.ok(lookupErrors[state], state);
  for (const state of providerFallback) assert.ok(retryableLookup.has(state), state);
  assert.ok(!retryableLookup.has('invalid_title'));
});
