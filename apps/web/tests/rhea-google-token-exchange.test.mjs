import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../functions/api/rhea/[action].js';
import { tokenFailureCode, tokenTransportFailure } from '../src/rhea/oauth-token-errors.mjs';
import { oauthReturnCode } from '../src/rhea/oauth-tab-sync.mjs';
import { driveStatusMessage } from '../src/rhea/oauth-status.mjs';

const origin = 'https://workspace.example.test';
const environment = {
  RHEA_GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
  RHEA_GOOGLE_CLIENT_SECRET: 'fake-secret-do-not-use',
  RHEA_COOKIE_KEY: 'z'.repeat(43),
};
const identity = { cloudflareAccess: { JWT: { payload: { sub: 'synthetic-test-subject' } } } };

const call = (action, query = '', cookies = '') => onRequest({
  request: new Request(origin + '/api/rhea/' + action + query, {
    headers: cookies ? { Cookie: cookies } : undefined,
  }),
  env: environment, data: identity, params: { action },
});

async function beginFlow() {
  const start = await call('connect');
  assert.equal(start.status, 303);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cookie = start.headers.getSetCookie().find(item => item.startsWith('__Host-rhea-oauth=')).split(';')[0];
  return { state, cookie };
}

test('Google failures map only to fixed safe categories', () => {
  assert.equal(tokenFailureCode('invalid_grant'), 'oauth_grant');
  assert.equal(tokenFailureCode('invalid_request'), 'oauth_request');
  assert.equal(tokenFailureCode('invalid_client'), 'oauth_client');
  assert.equal(tokenFailureCode('redirect_uri_mismatch'), 'oauth_redirect');
  assert.equal(tokenFailureCode('sensitive_novel_google_error'), 'oauth_token_rejected');
  assert.equal(tokenFailureCode(null), 'oauth_token_rejected');
  assert.equal(tokenTransportFailure({ name: 'TimeoutError' }), 'oauth_token_timeout');
  assert.equal(tokenTransportFailure({ name: 'AbortError' }), 'oauth_token_timeout');
  assert.equal(tokenTransportFailure(new Error('private explanation')), 'oauth_token_network');
  for (const code of ['oauth_grant', 'oauth_code', 'oauth_request',
    'oauth_token_network', 'oauth_token_timeout', 'oauth_token_response', 'oauth_token_rejected']) {
    assert.equal(oauthReturnCode('?drive=' + code), code);
    assert.ok(driveStatusMessage(code));
  }
});

test('missing Google callback code is reported distinctly without token fetch', async () => {
  const { state, cookie } = await beginFlow();
  const reply = await call('callback', '?state=' + encodeURIComponent(state), cookie);
  assert.equal(reply.headers.get('location'), '/rhea?drive=oauth_code#armazenamento');
  assert.equal(reply.status, 303);
});

for (const [providerError, outcome] of [
  ['invalid_grant', 'oauth_grant'],
  ['invalid_request', 'oauth_request'],
  ['unknown_private_provider_error', 'oauth_token_rejected'],
]) {
  test('Google HTTP 400 ' + providerError + ' is sanitized as ' + outcome, async t => {
    const { state, cookie } = await beginFlow();
    const captured = [];
    t.mock.method(console, 'warn', (...args) => captured.push(args));
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      error: providerError, error_description: 'DO_NOT_LOG_SENSITIVE_DESCRIPTION',
    }, { status: 400 }));
    const reply = await call('callback', '?state=' + encodeURIComponent(state) + '&code=test-code', cookie);
    assert.equal(reply.status, 303);
    assert.equal(reply.headers.get('location'), '/rhea?drive=' + outcome + '#armazenamento');
    assert.equal(reply.headers.getSetCookie().some(item => item.startsWith('__Host-rhea-drive=')), false);
    assert.equal(JSON.stringify(captured).includes('DO_NOT_LOG_SENSITIVE_DESCRIPTION'), false);
    assert.equal(JSON.stringify(captured).includes('test-code'), false);
    assert.ok(captured.some(args => args[0] === '[rhea-oauth] token_exchange_rejected' &&
      args[1].category === outcome && args[1].httpStatus === 400));
  });
}

test('Google token endpoint network failure yields a specific fixed code', async t => {
  const { state, cookie } = await beginFlow();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private network failure details'); });
  const reply = await call('callback', '?state=' + encodeURIComponent(state) + '&code=test-code', cookie);
  assert.equal(reply.headers.get('location'), '/rhea?drive=oauth_token_network#armazenamento');
});

test('Google token exchange timeout yields a specific fixed code', async t => {
  const { state, cookie } = await beginFlow();
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('private timeout details', 'TimeoutError'); });
  const reply = await call('callback', '?state=' + encodeURIComponent(state) + '&code=test-code', cookie);
  assert.equal(reply.headers.get('location'), '/rhea?drive=oauth_token_timeout#armazenamento');
});

test('malformed successful token response is distinguished from refused grant', async t => {
  const { state, cookie } = await beginFlow();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ no_access_token: true }));
  const reply = await call('callback', '?state=' + encodeURIComponent(state) + '&code=test-code', cookie);
  assert.equal(reply.headers.get('location'), '/rhea?drive=oauth_token_response#armazenamento');
});


test('Cloudflare-compatible OAuth token fetch uses redirect:manual and succeeds', async t => {
  const { state, cookie } = await beginFlow();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), mode: init?.redirect });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return Response.json({
        access_token: 'SYNTHETIC_TOKEN_DO_NOT_PERSIST',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/drive.file',
      });
    }
    return Response.json({ user: { permissionId: 'synthetic-account', displayName: 'Test account' } });
  });
  const reply = await call('callback', '?state=' + encodeURIComponent(state) + '&code=synthetic-code', cookie);
  assert.equal(reply.status, 303);
  assert.equal(reply.headers.get('location'), '/rhea?drive=connected#armazenamento');
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(requests[0].mode, 'manual');
  assert.equal(requests.length, 2);
  const sessionCookie = reply.headers.getSetCookie().find(v => v.startsWith('__Host-rhea-drive='));
  assert.ok(sessionCookie, 'Session cookie should be issued only on successful token exchange');
});

test('302 from token endpoint must never redirect or forward OAuth credentials', async t => {
  const { state, cookie } = await beginFlow();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), mode: options?.redirect });
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://untrusted.invalid/collect-credentials' },
    });
  });
  const reply = await call('callback', '?state=' + encodeURIComponent(state) + '&code=synthetic-code', cookie);
  assert.equal(reply.status, 303);
  assert.equal(reply.headers.get('location'), '/rhea?drive=oauth_token_redirect#armazenamento');
  assert.deepEqual(requests, [{ url: 'https://oauth2.googleapis.com/token', mode: 'manual' }]);
  assert.equal(reply.headers.getSetCookie().some(v => v.startsWith('__Host-rhea-drive=')), false);
  assert.equal(oauthReturnCode('?drive=oauth_token_redirect'), 'oauth_token_redirect');
  assert.ok(driveStatusMessage('oauth_token_redirect'));
});

test('assistant access is available through MCP only', async t => {
  const outbound = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected outbound request');
  });
  const response = await onRequest({
    request: new Request(origin + '/api/rhea/assistant', {
      method: 'POST',
    }),
    env: environment,
    data: identity,
    params: { action: 'assistant' },
  });
  assert.equal(response.status, 405);
  assert.equal(outbound.mock.callCount(), 0);
});
