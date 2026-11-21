import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { onRequest } from '../functions/api/rhea/[action].js';
import { privateMcp } from '../src/rhea/mcp/private.mjs';
import { configuration, digest, random, timestamp } from '../src/rhea/mcp/security.mjs';
import { driveLinks } from '../src/rhea/mcp/drive-link.mjs';
import { fetchGateway } from '../src/rhea/mcp/rhea-mcp.mjs';
import { folderType } from '../src/rhea/drive-files.mjs';

const origin = 'https://mcp.rhea.test';
const approval = 'https://private.rhea.test';
const resource = origin + '/mcp';
const googleSession = { token: 'mock-google-secret', name: 'Synthetic account', account: 'mock-google-account', exp: timestamp() + 1400 };
const callback = 'https://client.rhea.test/callback';
const client = 'rhea-test';
const verifier = 'Z'.repeat(50);

function envFor(t, persistent = false) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  for (const name of ['0001_gateway.sql', '0002_proposals.sql', '0003_drive_links.sql']) sql.exec(readFileSync(new URL('../mcp-gateway/' + name, import.meta.url), 'utf8'));
  const d1 = {
    prepare(query) {
      return { bind(...values) {
        const statement = sql.prepare(query);
        return {
          first: async () => statement.get(...values) ?? null,
          run: () => {
            const { changes } = statement.run(...values);
            return { meta: { changes } };
          },
          all: async () => ({ results: statement.all(...values) }),
        };
      } };
    },
    async batch(items) {
      sql.exec('BEGIN');
      try {
        const result = items.map(item => item.run());
        sql.exec('COMMIT');
        return result;
      }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  return {
    ...(persistent ? { RHEA_DRIVE_PERSISTENCE: 'true', RHEA_GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
      RHEA_GOOGLE_CLIENT_SECRET: 'synthetic-client-secret' } : {}),
    RHEA_MCP_ORIGIN: origin, RHEA_MCP_APPROVAL_ORIGIN: approval, RHEA_MCP_KEY: random(), RHEA_MCP_DB: d1,
    RHEA_MCP_CLIENTS: JSON.stringify({
      [client]: { label: 'Synthetic MCP client', redirects: [callback], propose: true, organize: true },
      'other-client': { label: 'Other MCP client', redirects: [callback] },
    }),
  };
}

const form = (path, fields) => new Request(origin + path, { method: 'POST', body: new URLSearchParams(fields) });
const rpc = (method, params, token, headers = {}) => new Request(resource, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});

async function requestApproval(env, overrides = {}) {
  const fields = { response_type: 'code', client_id: client, redirect_uri: callback, state: 'state-bound-to-client',
    code_challenge_method: 'S256', code_challenge: await digest(verifier), resource, scope: 'rhea:read', ...overrides };
  return fetchGateway(new Request(origin + '/authorize?' + new URLSearchParams(fields)), env);
}

async function approvedCode(env, overrides) {
  const begin = await requestApproval(env, overrides);
  assert.equal(begin.status, 303);
  const url = new URL(begin.headers.get('Location'));
  assert.equal(url.origin, approval);
  const id = url.searchParams.get('mcp_request');
  const privateApp = privateMcp(env, approval);
  assert.equal(privateMcp(env, 'https://other.rhea.test'), null);
  const request = await privateApp.review(id, 'private-user', googleSession);
  assert.equal(request.client, 'Synthetic MCP client');
  assert.equal(await privateApp.approve({ id, accepted: true, proof: request.proof }, 'other-user', googleSession), null);
  assert.equal(await privateApp.approve({ id, accepted: true, proof: request.proof }, 'private-user',
    { ...googleSession, account: 'changed-google-account' }), null);
  assert.equal(await privateApp.approve({ id, proof: request.proof }, 'private-user', googleSession), null);
  const consent = await privateApp.approve({ id, accepted: true, proof: request.proof }, 'private-user', googleSession);
  const returned = new URL(consent.callback);
  assert.equal(returned.searchParams.get('iss'), origin);
  assert.equal(returned.searchParams.get('state'), 'state-bound-to-client');
  assert.equal(await privateApp.review(id, 'private-user', googleSession), null);
  return returned.searchParams.get('code');
}

function redeem(env, code, overrides = {}) {
  return fetchGateway(form('/token', { grant_type: 'authorization_code', client_id: client, redirect_uri: callback,
    code, code_verifier: verifier, resource, ...overrides }), env);
}

const google = async (input, config) => {
  const url = new URL(input);
  assert.equal(config.headers.Authorization, 'Bearer ' + googleSession.token);
  const root = { id: 'rhea-root', name: 'RHEA', mimeType: folderType, trashed: false,
    parents: ['my-drive'], appProperties: { rheaWorkspace: 'folder' } };
  if (url.pathname.endsWith('/root')) return Response.json({ id: 'my-drive' });
  if (url.pathname.endsWith('/rhea-root')) return Response.json(root);
  if (url.pathname.endsWith('/outside-asset')) return Response.json({
    id: 'outside-asset', name: 'Should not leak', mimeType: 'text/plain', parents: ['my-drive'], trashed: false,
  });
  if (url.pathname.endsWith('/files')) {
    const q = url.searchParams.get('q');
    return Response.json({ files: q.includes("'root' in parents") ? [root] : [
      { id: 'listed-file', name: 'Test.txt', size: '18', parents: [root.id], mimeType: 'text/plain', trashed: false },
    ] });
  }
  return Response.json({}, { status: 404 });
};

test('discovery and authenticated MCP list work while unapproved calls, audience confusion and outside IDs are refused', async t => {
  const env = envFor(t);
  const response = await fetchGateway(new Request(origin + '/.well-known/oauth-protected-resource/mcp'), env);
  const metadata = await response.json();
  assert.equal(metadata.resource, resource);
  assert.equal(metadata.resource_name, 'RHEA');
  assert.equal((await fetchGateway(rpc('tools/list', {}), env)).status, 401);
  assert.equal((await fetchGateway(rpc('tools/list', {}, undefined, { Origin: 'https://bad.rhea.test' }), env)).status, 403);
  assert.equal((await requestApproval(env, { resource: origin + '/different-api' })).status, 400);
  assert.equal((await requestApproval(env, { redirect_uri: 'https://other.rhea.test/callback' })).status, 400);
  const code = await approvedCode(env);
  assert.equal((await redeem(env, code, { client_id: 'other-client' })).status, 400);
  assert.equal((await redeem(env, code, { code_verifier: 'N'.repeat(50) })).status, 400);
  const grant = await (await redeem(env, code)).json();
  assert.ok(grant.expires_in <= 300);
  assert.equal(JSON.stringify(grant).includes(googleSession.token), false);
  assert.equal((await redeem(env, code)).status, 400);
  const initialize = await fetchGateway(rpc('initialize', { protocolVersion: '2025-11-25' }, grant.access_token), env);
  const initialized = (await initialize.json()).result;
  assert.equal(initialized.protocolVersion, '2025-11-25');
  assert.equal(initialized.serverInfo.name, 'rhea');
  assert.equal(initialized.serverInfo.title, 'RHEA');
  const listing = await (await fetchGateway(rpc('tools/list', {}, grant.access_token), env)).json();
  assert.equal(listing.result.tools.length, 7);
  assert.ok(listing.result.tools.every(tool => tool.annotations.readOnlyHint));
  const call = (name, args) => fetchGateway(rpc('tools/call', { name, arguments: args }, grant.access_token), env, google);
  const result = (await (await call('rhea_list_folder', {})).json()).result;
  assert.equal(result.structuredContent.files[0].id, 'listed-file');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const outside = await (await call('rhea_get_file_metadata', { file_id: 'outside-asset' })).json();
  assert.equal(outside.result.isError, true);
  assert.equal(JSON.stringify(outside).includes('Should not leak'), false);
  assert.equal((await (await call('rhea_trash_file', { file_id: 'listed-file' })).json()).error.code, -32602);
});

test('parallel refresh retries converge, and replay outside the retry window revokes the grant', async t => {
  const env = envFor(t);
  const grant = await (await redeem(env, await approvedCode(env))).json();
  const refresh = id => fetchGateway(form('/token', { grant_type: 'refresh_token', resource, client_id: id,
    refresh_token: grant.refresh_token }), env);
  assert.equal((await refresh('other-client')).status, 400);
  const replies = await Promise.all([refresh(client), refresh(client)]);
  assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
  const [rotated, retry] = await Promise.all(replies.map(reply => reply.json()));
  assert.notEqual(rotated.refresh_token, grant.refresh_token);
  assert.equal(retry.refresh_token, rotated.refresh_token);
  assert.equal(retry.access_token, rotated.access_token);
  assert.equal((await fetchGateway(rpc('tools/list', {}, rotated.access_token), env)).status, 200);
  await env.RHEA_MCP_DB.prepare('UPDATE oauth_tokens SET consumed=? WHERE hash=?')
    .bind(timestamp() - 16, await digest(grant.refresh_token)).run();
  assert.equal((await refresh(client)).status, 400);
  assert.equal((await fetchGateway(rpc('tools/list', {}, rotated.access_token), env)).status, 401);
});

test('Workspace revocation is actor-bound and takes effect immediately', async t => {
  const env = envFor(t);
  const grant = await (await redeem(env, await approvedCode(env))).json();
  const privateApp = privateMcp(env, approval);
  const [link] = await privateApp.grants('private-user');
  assert.equal(await privateApp.revoke(link.id, 'other-user'), false);
  assert.equal(await privateApp.revoke(link.id, 'private-user'), true);
  assert.equal((await fetchGateway(rpc('tools/list', {}, grant.access_token), env)).status, 401);
});

test('a model can propose a mutation but only a matching Access actor can review and explicitly execute it once', async t => {
  const env = envFor(t);
  const code = await approvedCode(env, { scope: 'rhea:read rhea:propose' });
  const grant = await (await redeem(env, code)).json();
  const fetcher = async (...args) => google(...args);
  const names = (await (await fetchGateway(rpc('tools/list', {}, grant.access_token), env)).json()).result.tools;
  assert.equal(names.length, 12);
  const proposal = await (await fetchGateway(rpc('tools/call', { name: 'rhea_prepare_upload',
    arguments: { name: 'candidate.txt', size: 26 } }, grant.access_token), env, fetcher)).json();
  const id = proposal.result.structuredContent.proposalId;
  const plan = privateMcp(env, approval).proposals;
  assert.equal((await plan.list('other-user', googleSession.account)).length, 0);
  assert.equal((await plan.list('private-user', 'other-account')).length, 0);
  await assert.rejects(plan.execute({ id, confirmed: true }, 'private-user', googleSession, fetcher), { status: 409 });
  assert.equal(await plan.review(id, 'other-user', googleSession.account), false);
  assert.equal(await plan.review(id, 'private-user', googleSession.account), true);
  await assert.rejects(plan.execute({ id, confirmed: false }, 'private-user', googleSession, fetcher), { status: 400 });
  assert.deepEqual(await plan.execute({ id, confirmed: true }, 'private-user', googleSession, fetcher),
    { state: 'VERIFIED', result: { preparationOnly: true, folderId: 'rhea-root', name: 'candidate.txt', size: 26 } });
  await assert.rejects(plan.execute({ id, confirmed: true }, 'private-user', googleSession, fetcher), { status: 409 });
});

test('a rename changes Drive only after confirmed workspace review', async t => {
  const env = envFor(t);
  const grant = await (await redeem(env, await approvedCode(env, { scope: 'rhea:read rhea:propose' }))).json();
  const file = { id: 'listed-file', name: 'Before.txt', mimeType: 'text/plain', parents: ['rhea-root'], trashed: false, size: '18' };
  let writes = 0;
  const fetcher = async (input, options) => {
    if (!new URL(input).pathname.endsWith('/listed-file')) return google(input, options);
    if (options.method === 'PATCH') { writes++; Object.assign(file, JSON.parse(options.body)); }
    return Response.json(file);
  };
  const result = await (await fetchGateway(rpc('tools/call', { name: 'rhea_rename_file',
    arguments: { file_id: file.id, name: 'After.txt' } }, grant.access_token), env, fetcher)).json();
  assert.equal(writes, 0);
  const plan = privateMcp(env, approval).proposals;
  const id = result.result.structuredContent.proposalId;
  assert.equal(await plan.review(id, 'private-user', googleSession.account), true);
  assert.equal(writes, 0);
  const receipt = await plan.execute({ id, confirmed: true }, 'private-user', googleSession, fetcher);
  assert.equal(receipt.result.name, 'After.txt');
  assert.equal(writes, 1);
});

async function consentWithLink(env, session, organize, requested = 'rhea:read') {
  const response = await requestApproval(env, { scope: requested });
  assert.equal(response.status, 303);
  const id = new URL(response.headers.get('Location')).searchParams.get('mcp_request');
  const app = privateMcp(env, approval);
  const review = await app.review(id, 'private-user', session);
  assert.equal(review.canOrganize, Boolean(session.linkId));
  const inputs = { id, accepted: true, organize, proof: review.proof };
  const confirmed = await app.approve(inputs, 'private-user', session);
  return confirmed ? (await redeem(env, new URL(confirmed.callback).searchParams.get('code'))).json() : null;
}

function simulatedDrive() {
  const root = { id: 'rhea-root', name: 'RHEA', mimeType: folderType, parents: ['my-drive'],
    trashed: false, appProperties: { rheaWorkspace: 'folder' } };
  const items = new Map([[root.id, root]]);
  const ids = ['asset-front', 'asset-left', 'asset-right', 'asset-back'];
  for (const id of ids) items.set(id, { id, name: id + '.png', mimeType: 'image/png', parents: [root.id], trashed: false, size: '8' });
  items.set('outside-file', { id: 'outside-file', name: 'Outside.png', parents: ['my-drive'], mimeType: 'image/png', trashed: false });
  let created = 0;
  let moved = 0;
  let stop;
  async function fetcher(input, options) {
    const url = new URL(input);
    assert.equal(options.headers.Authorization, 'Bearer ' + googleSession.token);
    const id = url.pathname.split('/').at(-1);
    if (id === 'files' && options.method === 'POST') {
      const { name, parents, mimeType } = JSON.parse(options.body);
      const folder = { id: 'folder-' + (++created), name, parents, mimeType, trashed: false };
      items.set(folder.id, folder);
      return Response.json(folder);
    }
    if (id === 'files') {
      const q = url.searchParams.get('q');
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = / and name = '([^']+)'/.exec(q)?.[1];
      return Response.json({ files: [...items.values()].filter(item => item.parents.includes(parent === 'root' ? 'my-drive' : parent) &&
        (!name || item.name === name)) });
    }
    if (!items.has(id)) return Response.json({}, { status: 404 });
    const file = items.get(id);
    if (options.method === 'PATCH') {
      if (id === stop) return Response.json({}, { status: 429 });
      file.parents = [url.searchParams.get('addParents')];
      moved++;
    }
    return Response.json(file);
  }
  return { ids, fetcher, counts: () => [created, moved], stopAt: id => { stop = id; } };
}

test('one explicit organizational grant moves four files, refuses an outside ID and retries partial batches', async t => {
  const env = envFor(t, true);
  const cfg = configuration(env);
  const links = driveLinks(cfg);
  assert.equal(await consentWithLink(env, googleSession, true), null);
  assert.equal(await links.connect('private-user', googleSession, 'mock-offline-token'), true);
  const { session } = await links.session('private-user');
  const readonly = await consentWithLink(env, session, false, 'rhea:read rhea:organize');
  assert.equal(readonly.scope, 'rhea:read');
  const readOnlyTools = await (await fetchGateway(rpc('tools/list', {}, readonly.access_token), env)).json();
  assert.equal(readOnlyTools.result.tools.length, 7);

  const issued = await consentWithLink(env, session, true);
  assert.equal(issued.scope, 'rhea:read rhea:organize');
  assert.equal(JSON.stringify(issued).includes('mock-offline-token'), false);
  const discovered = await (await fetchGateway(rpc('tools/list', {}, issued.access_token, { Origin: 'https://claude.com' }), env)).json();
  assert.deepEqual(discovered.result.tools.filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name),
    ['rhea_create_folder', 'rhea_move_file', 'rhea_organize_files']);
  const individual = simulatedDrive();
  const individualCall = async (name, args) => (await (await fetchGateway(rpc('tools/call', {
    name, arguments: args,
  }, issued.access_token), env, individual.fetcher)).json()).result;
  const folder = await individualCall('rhea_create_folder', { name: 'Synthetic Folder' });
  assert.equal(folder.structuredContent.file.name, 'Synthetic Folder');
  assert.equal((await individualCall('rhea_move_file', {
    file_id: individual.ids[0], parent_id: folder.structuredContent.file.id,
  })).structuredContent.file.id, individual.ids[0]);
  assert.equal((await individualCall('rhea_move_file', {
    file_id: individual.ids[0], parent_id: 'outside-file',
  })).isError, true);
  assert.deepEqual(individual.counts(), [1, 1]);

  const store = simulatedDrive();
  const invoke = (fileIds, token = issued.access_token) => fetchGateway(rpc('tools/call', {
    name: 'rhea_organize_files', arguments: { folder_path: ['Demo', 'References', 'Design'], file_ids: fileIds },
  }, token), env, store.fetcher);
  assert.equal((await (await invoke([store.ids[0], 'outside-file'])).json()).result.isError, true);
  assert.deepEqual(store.counts(), [0, 0]);
  store.stopAt(store.ids[1]);
  const partial = (await (await invoke(store.ids)).json()).result.structuredContent;
  assert.equal(partial.state, 'PARTIAL');
  assert.equal(partial.completed.length, 1);
  assert.deepEqual(partial.remaining, store.ids.slice(1));
  store.stopAt(null);
  const result = (await (await invoke(store.ids)).json()).result.structuredContent;
  assert.equal(result.state, 'VERIFIED');
  assert.equal(result.completed.length, 4);
  assert.deepEqual(store.counts(), [3, 4]);

  const reduced = await (await fetchGateway(form('/token', { grant_type: 'refresh_token', resource, client_id: client,
    scope: 'rhea:read', refresh_token: issued.refresh_token }), env)).json();
  assert.equal(reduced.scope, 'rhea:read');
  const widenedRetry = await fetchGateway(form('/token', { grant_type: 'refresh_token', resource, client_id: client,
    refresh_token: issued.refresh_token }), env);
  assert.equal(widenedRetry.status, 400);
  assert.equal((await (await invoke(store.ids, reduced.access_token)).json()).error.code, -32602);
  await links.disconnect('private-user');
  assert.equal((await links.session('private-user')).known, true);
  assert.equal((await links.session('private-user')).session, null);
  assert.equal((await fetchGateway(rpc('tools/list', {}, reduced.access_token), env)).status, 401);
});

test('Google client rejection reports a safe operator error and preserves the assistant grant', async t => {
  const env = envFor(t, true);
  const cfg = configuration(env);
  const links = driveLinks(cfg);
  await links.connect('private-user', googleSession, 'mock-offline-token');
  const session = (await links.session('private-user')).session;
  const grant = await consentWithLink(env, session, true);
  await cfg.db.prepare('UPDATE rhea_drive_links SET access_expires=? WHERE actor=?')
    .bind(timestamp() - 1, 'private-user').run();
  const denied = await fetchGateway(rpc('tools/call', { name: 'rhea_connection_status', arguments: {} }, grant.access_token),
    env, async () => Response.json({ error: 'invalid_client', error_description: 'private-fixture-detail' }, { status: 401 }));
  const { result } = await denied.json();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /rejected the server OAuth client configuration/i);
  assert.equal(JSON.stringify(result).includes('private-fixture-detail'), false);
  assert.equal((await fetchGateway(rpc('tools/list', {}, grant.access_token), env)).status, 200);
});

test('an expired Google access token renews in the background without replacing the provider grant', async t => {
  const env = envFor(t, true);
  const cfg = configuration(env);
  const links = driveLinks(cfg);
  await links.connect('private-user', { ...googleSession, exp: timestamp() - 1 }, 'mock-offline-token');
  let exchanges = 0;
  const refreshed = driveLinks(cfg, async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.body.get('refresh_token'), 'mock-offline-token');
    exchanges++;
    await new Promise(resolve => setTimeout(resolve, 40));
    return Response.json({ access_token: googleSession.token, expires_in: 3600 });
  });
  const [first, second] = await Promise.all([refreshed.session('private-user'), refreshed.session('private-user')]);
  assert.equal(exchanges, 1);
  assert.deepEqual(first.session, second.session);
  const grant = await consentWithLink(env, first.session, true);
  await cfg.db.prepare('UPDATE rhea_drive_links SET access_expires=? WHERE actor=?').bind(timestamp() - 1, 'private-user').run();
  const renewed = await (await fetchGateway(rpc('tools/call', { name: 'rhea_connection_status', arguments: {} }, grant.access_token),
    env, async (url, options) => new URL(url).hostname === 'oauth2.googleapis.com'
      ? Response.json({ access_token: googleSession.token, expires_in: 3600 }) : google(url, options))).json();
  assert.deepEqual(renewed.result.structuredContent.permissions, ['read', 'organize']);
  await cfg.db.prepare('UPDATE rhea_drive_links SET access_expires=? WHERE actor=?').bind(timestamp() - 1, 'private-user').run();
  const rejected = await (await fetchGateway(rpc('tools/call', { name: 'rhea_connection_status', arguments: {} }, grant.access_token),
    env, async () => Response.json({ error: 'invalid_grant' }, { status: 400 }))).json();
  assert.equal(rejected.result.isError, true);
  assert.deepEqual(await links.session('private-user'), { known: true, session: null, reauthorize: true });
  assert.equal((await fetchGateway(rpc('tools/list', {}, grant.access_token), env)).status, 401);
});

test('Google Drive credentials are never accepted as Gemini RHEA OAuth client credentials', async t => {
  const response = await requestApproval(envFor(t), { client_id: 'some-id.apps.googleusercontent.com' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error_description, /registered RHEA OAuth client/);
});

test('The workspace keeps the consented Google account after browser cookies change', async t => {
  const env = { ...envFor(t, true), RHEA_COOKIE_KEY: random() };
  const data = { cloudflareAccess: { JWT: { payload: { sub: 'private-user' } } } };
  const route = (action, path = '/api/rhea/' + action, options) =>
    onRequest({ env, data, params: { action }, request: new Request(approval + path, options) });

  const start = await route('connect');
  const login = new URL(start.headers.get('Location'));
  assert.equal(login.searchParams.get('access_type'), 'offline');
  const proof = start.headers.getSetCookie()[0].split(';')[0];
  t.mock.method(globalThis, 'fetch', async url => {
    if (new URL(url).pathname === '/token') {
      return Response.json({ access_token: googleSession.token, refresh_token: 'offline-google-fixture',
        expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' });
    }
    assert.equal(new URL(url).pathname, '/drive/v3/about');
    return Response.json({ user: { permissionId: googleSession.account, displayName: googleSession.name } });
  });
  const params = new URLSearchParams({ code: 'google-code-fixture', state: login.searchParams.get('state') });
  const callbackResponse = await route('callback', '/api/rhea/callback?' + params, { headers: { Cookie: proof } });
  assert.match(callbackResponse.headers.get('Location'), /drive=connected/);
  assert.ok(callbackResponse.headers.getSetCookie().every(cookie => !cookie.includes('offline-google-fixture')));
  const state = await (await route('status')).json();
  assert.equal(state.accountId, googleSession.account);
  assert.equal(state.persistentSession, true);
  assert.equal(JSON.stringify(state).includes('offline-google-fixture'), false);
  const session = (await driveLinks(configuration(env)).session('private-user')).session;
  const grant = await consentWithLink(env, session, true);
  assert.equal(await driveLinks(configuration(env)).connect('private-user', googleSession, 'replacement-google-fixture'), true);
  assert.equal((await driveLinks(configuration(env)).session('private-user')).session.linkId, session.linkId);
  assert.equal((await fetchGateway(rpc('tools/list', {}, grant.access_token), env)).status, 200);
  const misconfiguredWorker = { ...env, RHEA_GOOGLE_CLIENT_SECRET: undefined };
  assert.equal((await fetchGateway(rpc('tools/list', {}, grant.access_token), misconfiguredWorker)).status, 503);
  assert.equal((await fetchGateway(rpc('tools/list', {}, grant.access_token), env)).status, 200);
  const [link] = await privateMcp(env, approval).grants('private-user');
  const unlink = await route('mcp-unlink', '/api/rhea/mcp-unlink', { method: 'POST', body: JSON.stringify({ id: link.id }) });
  assert.equal((await unlink.json()).revoked, true);
  assert.equal((await (await route('status')).json()).persistentSession, true);
  assert.equal((await fetchGateway(rpc('tools/list', {}, grant.access_token), env)).status, 401);
  const disconnect = await route('disconnect', '/api/rhea/disconnect', { method: 'POST' });
  assert.equal(disconnect.status, 204);
  assert.equal(disconnect.headers.getSetCookie().length, 2);
  assert.equal((await (await route('status')).json()).persistentSession, false);
});

test('switching the linked Drive account invalidates the original account grant', async t => {
  const env = envFor(t, true);
  const links = driveLinks(configuration(env));
  await links.connect('private-user', googleSession, 'offline-google-fixture');
  const original = (await links.session('private-user')).session;
  const grant = await consentWithLink(env, original, true);
  const next = { ...googleSession, account: 'second-google-account' };
  assert.equal(await links.connect('private-user', next, 'second-offline-token'), true);
  assert.equal((await links.session('private-user')).session.account, next.account);
  assert.equal((await fetchGateway(rpc('tools/list', {}, grant.access_token), env)).status, 401);
});

test('an incomplete persistent Pages configuration does not start temporary Google consent', async t => {
  const env = { ...envFor(t, true), RHEA_COOKIE_KEY: random(), RHEA_MCP_DB: undefined };
  const data = { cloudflareAccess: { JWT: { payload: { sub: 'private-user' } } } };
  const route = action => onRequest({ env, data, params: { action }, request: new Request(approval + '/api/rhea/' + action) });
  const status = await (await route('status')).json();
  assert.equal(status.sessionState, 'unconfigured');
  assert.equal(status.driveIssue, 'drive_persistence_config');
  const connect = await route('connect');
  assert.equal(connect.status, 503);
  assert.equal(connect.headers.get('Location'), null);
});
