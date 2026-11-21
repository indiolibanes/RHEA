import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardRhea } from '../src/rhea/access-gate.mjs';

const origin = 'https://workspace.example.test';
const domain = 'https://rhea-audit.cloudflareaccess.com';
const generalAudience = 'a'.repeat(64);
const rheaAudience = 'b'.repeat(64);
const env = { CF_PAGES_BRANCH: 'main', ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: generalAudience };
const payload = { acc: 'fixture', iss: domain, aud: [generalAudience], exp: Math.floor(Date.now() / 1000) + 300, sub: 'test-user' };

async function run({
  bindings = {}, request = new Request(origin + '/api/rhea/status'), claims = payload, pluginReject = false,
} = {}) {
  const data = {};
  let next = 0;
  let used;
  const response = await guardRhea({
    request, data, env: { ...env, ...bindings }, next() { next++; return new Response('allowed', { status: 200 }); },
  }, {
    origin, productionBranch: 'main', accessPlugin: args => context => {
      used = args;
      if (pluginReject) return new Response(null, { status: 302, headers: { Location: domain } });
      context.data.cloudflareAccess = { JWT: { payload: claims } };
      return context.next();
    },
  });
  return { next, response, used };
}

test('accepts the exact audience and normalizes the team host', async () => {
  const { response, next, used } = await run({
    bindings: { ACCESS_TEAM_DOMAIN: ' Rhea-audit.CloudflareAccess.com/ ' },
  });
  assert.equal(response.status, 200);
  assert.equal(next, 1);
  assert.deepEqual(used, { domain, aud: generalAudience });
});

test('selects exactly the Rhea audience override', async () => {
  const { response, used } = await run({
    bindings: { RHEA_ACCESS_AUD: ' ' + rheaAudience + ' ' }, claims: { ...payload, aud: [rheaAudience] },
  });
  assert.equal(response.status, 200);
  assert.equal(used.aud, rheaAudience);
  const wrong = await run({ bindings: { RHEA_ACCESS_AUD: rheaAudience } });
  assert.equal((await wrong.response.json()).code, 'RHEA_ACCESS_AUDIENCE');
  assert.equal(wrong.next, 0);
});

test('returns non-cacheable configuration codes without values', async () => {
  for (const [bindings, code] of [
    [{ ACCESS_TEAM_DOMAIN: 'https://wrong.example/' }, 'RHEA_ACCESS_DOMAIN_CONFIG'],
    [{ RHEA_ACCESS_AUD: '' }, 'RHEA_ACCESS_AUD_CONFIG'],
    [{ CF_PAGES_BRANCH: undefined }, 'RHEA_RUNTIME_BRANCH'],
  ]) {
    const { response, next } = await run({ bindings });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes('wrong.example'), false);
    assert.equal(next, 0);
  }
});

test('checks the actual branch when provided and supports an explicit production runtime binding', async () => {
  const runtime = await run({ bindings: { CF_PAGES_BRANCH: undefined, RHEA_RUNTIME_BRANCH: 'main' } });
  assert.equal(runtime.response.status, 200);
  const wrong = await run({ bindings: { CF_PAGES_BRANCH: 'feature', RHEA_RUNTIME_BRANCH: 'main' } });
  assert.equal(wrong.response.status, 403);
  assert.equal(wrong.next, 0);
  const preview = await run({ request: new Request('https://preview.pages.dev/api/rhea/status') });
  assert.equal(preview.response.status, 403);
  assert.equal(preview.next, 0);
});

test('requires an exact issuer, matching audience, valid expiry and user identity after the Access plugin', async () => {
  for (const [claims, code] of [
    [{ ...payload, iss: undefined }, 'RHEA_ACCESS_ISSUER'],
    [{ ...payload, aud: undefined }, 'RHEA_ACCESS_AUDIENCE'],
    [{ ...payload, aud: 'prefix_' + generalAudience }, 'RHEA_ACCESS_AUDIENCE'],
    [{ ...payload, exp: undefined }, 'RHEA_ACCESS_EXPIRY'],
    [{ ...payload, sub: '' }, 'RHEA_ACCESS_IDENTITY'],
  ]) {
    const result = await run({ claims });
    assert.equal((await result.response.json()).code, code);
    assert.equal(result.next, 0);
  }
});

test('translates Access redirects for the status API while keeping clean top-level login', async () => {
  const noSession = await run({ pluginReject: true });
  assert.equal(noSession.response.status, 401);
  const rejected = await run({
    pluginReject: true,
    request: new Request(origin + '/api/rhea/status', { headers: { 'Cf-Access-Jwt-Assertion': 'synthetic-marker' } }),
  });
  assert.equal(rejected.response.status, 403);
  assert.equal((await rejected.response.json()).code, 'RHEA_ACCESS_REJECTED');
  const login = await run({ pluginReject: true, request: new Request(origin + '/api/rhea/connect') });
  assert.equal(login.response.status, 302);
});

test('blocks a foreign-origin mutation and permits the Google top-level callback', async () => {
  const mutation = await run({
    request: new Request(origin + '/api/rhea/start', { method: 'POST', headers: { Origin: 'https://other.example' } }),
  });
  assert.equal(mutation.response.status, 403);
  assert.equal(mutation.next, 0);
  const redirect = await run({
    request: new Request(origin + '/api/rhea/callback', { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
  });
  assert.equal(redirect.response.status, 200);
});
