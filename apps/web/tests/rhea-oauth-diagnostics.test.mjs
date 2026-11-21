import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../functions/api/rhea/[action].js';

const origin = 'https://workspace.example.test';
const env = {
  RHEA_PUBLIC_ORIGIN: origin,
  RHEA_GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
  RHEA_GOOGLE_CLIENT_SECRET: 'fixture-secret',
  RHEA_COOKIE_KEY: 'a'.repeat(43),
};
const data = { cloudflareAccess: { JWT: { payload: { sub: 'fixture-subject' } } } };
const call = (action, { bindings = {}, query = '', headers } = {}) => onRequest({
  request: new Request(origin + '/api/rhea/' + action + query, { headers }),
  env: { ...env, ...bindings }, data, params: { action },
});

test('reports only the incomplete Drive setup step in authenticated status', async () => {
  for (const [bindings, issue] of [
    [{ RHEA_GOOGLE_CLIENT_ID: 'invalid' }, 'google_client_id'],
    [{ RHEA_GOOGLE_CLIENT_SECRET: '  ' }, 'google_client_secret'],
    [{ RHEA_COOKIE_KEY: 'short' }, 'cookie_key'],
  ]) {
    const response = await call('status', { bindings });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.drive, false);
    assert.equal(status.driveIssue, issue);
    assert.equal(JSON.stringify(status).includes('fixture-secret'), false);
  }
  const emptyStatus = await (await call('status')).json();
  assert.equal(emptyStatus.drive, true);
  assert.equal(emptyStatus.sessionState, 'absent');
  assert.equal(emptyStatus.oauthStateCookiePresent, false);
  assert.equal(emptyStatus.account, null);
  // A bogus session cookie must not be interpreted as a successful authorization.
  const invalid = await (await call('status', {
    headers: { Cookie: '__Host-rhea-drive=not-a-real-session' },
  })).json();
  assert.equal(invalid.sessionState, 'unrecognized');
  assert.equal(invalid.account, null);
});

test('requires the original authorization state and distinguishes revoked consent from client setup', async t => {
  const begin = await call('connect');
  const oauth = new URL(begin.headers.get('location'));
  const headers = { Cookie: begin.headers.getSetCookie()[0].split(';')[0] };
  const state = oauth.searchParams.get('state');
  const expired = await call('callback', { query: '?state=other&code=fixture', headers });
  assert.equal(expired.headers.get('location'), '/rhea?drive=oauth_state#armazenamento');
  const proofStatus = await (await call('status', { headers })).json();
  assert.equal(proofStatus.oauthStateCookiePresent, true);
  assert.equal(proofStatus.sessionState, 'absent');
  assert.deepEqual(expired.headers.getSetCookie(), []);
  const denied = await call('callback', { query: '?state=' + state + '&error=access_denied', headers });
  assert.equal(denied.headers.get('location'), '/rhea?drive=oauth_consent#armazenamento');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'invalid_client', error_description: 'private upstream details' }, { status: 401 }));
  const badClient = await call('callback', { query: '?state=' + state + '&code=fixture', headers });
  assert.equal(badClient.headers.get('location'), '/rhea?drive=oauth_client#armazenamento');
  assert.equal(await badClient.text(), '');
});

test('valid OAuth authorizes the Drive session and only then reports a connected account', async t => {
  const begin = await call('connect');
  const url = new URL(begin.headers.get('location'));
  const state = url.searchParams.get('state');
  const headers = { Cookie: begin.headers.getSetCookie()[0].split(';')[0] };
  assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/rhea/callback');
  t.mock.method(globalThis, 'fetch', async uri => new URL(uri).hostname === 'oauth2.googleapis.com'
    ? Response.json({ access_token: 'fixture-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' })
    : Response.json({ user: { permissionId: 'fixture-drive-account', displayName: 'Fixture' } }));
  const result = await call('callback', { query: '?state=' + state + '&code=fixture', headers });
  assert.equal(result.headers.get('location'), '/rhea?drive=connected#armazenamento');
  const session = result.headers.getSetCookie().find(value => value.startsWith('__Host-rhea-drive='));
  assert.match(session, /HttpOnly/);
  const status = await call('status', { headers: { Cookie: session.split(';')[0] } });
  const connected = await status.json();
  assert.equal(connected.account, 'Fixture');
  assert.equal(connected.sessionState, 'connected');
  assert.equal(connected.oauthStateCookiePresent, false);
  assert.equal(JSON.stringify(connected).includes('fixture-token'), false);
});
