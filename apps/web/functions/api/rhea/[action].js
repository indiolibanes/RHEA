import { storage } from '../../../src/rhea/mcp/storage.mjs';
import { driveLinks } from '../../../src/rhea/mcp/drive-link.mjs';
import { configuration } from '../../../src/rhea/mcp/security.mjs';
import { privateMcp } from '../../../src/rhea/mcp/private.mjs';
import { driveFiles, DriveError, maxFile, publicFile, uploadEndpoint, uploadMetadata } from '../../../src/rhea/drive-files.mjs';
import { previewType } from '../../../src/rhea/preview-types.mjs';
import { driveStatusMessage } from '../../../src/rhea/oauth-status.mjs';
import { tokenFailureCode, tokenTransportFailure } from '../../../src/rhea/oauth-token-errors.mjs';

const google = 'https://www.googleapis.com';
const drive = google + '/drive/v3';
const scope = 'https://www.googleapis.com/auth/drive.file';
const stateCookie = '__Host-rhea-oauth';
const sessionCookie = '__Host-rhea-drive';
const chunkSize = 2 * 1024 ** 2;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class RheaError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const json = (data, status = 200) => Response.json(data, { status, headers });
const now = () => Math.floor(Date.now() / 1000);
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
const cookie = (name, value, age) => name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + age;
const readCookie = (request, name) => request.headers.get('Cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith(name + '='))?.slice(name.length + 1);

async function keyFor(secret) {
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(secret, purpose, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) },
    await keyFor(secret), encoder.encode(JSON.stringify(value)));
  return encode(iv) + '.' + encode(new Uint8Array(data));
}
async function open(secret, purpose, value, sub) {
  if (!value || value.length > 3500 || !/^[\w-]+\.[\w-]+$/.test(value)) return null;
  try {
    const [iv, data] = value.split('.').map(decode);
    const payload = JSON.parse(decoder.decode(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, await keyFor(secret), data)));
    return payload.sub === sub && payload.exp > now() ? payload : null;
  } catch {
    return null;
  }
}
function redirect(location, cookies = []) {
  const response = new Response(null, { status: 303, headers: { ...headers, Location: location } });
  for (const value of cookies) response.headers.append('Set-Cookie', value);
  return response;
}
async function bodyJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new RheaError(400, 'Envie os dados da operação.');
  let text = '';
  let count = 0;
  const streamDecoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    count += value.length;
    if (count > 24 * 1024) {
      await reader.cancel();
      throw new RheaError(413, 'Dados da operação muito extensos.');
    }
    text += streamDecoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + streamDecoder.decode()); }
  catch { throw new RheaError(400, 'Dados da operação inválidos.'); }
}
function driveSetupIssue(env) {
  if (!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(env.RHEA_GOOGLE_CLIENT_ID ?? '')) return 'google_client_id';
  if (typeof env.RHEA_GOOGLE_CLIENT_SECRET !== 'string' || !env.RHEA_GOOGLE_CLIENT_SECRET ||
      /\s/.test(env.RHEA_GOOGLE_CLIENT_SECRET)) return 'google_client_secret';
  if (!/^[a-zA-Z0-9_-]{43,128}$/.test(env.RHEA_COOKIE_KEY ?? '')) return 'cookie_key';
  if (env.RHEA_DRIVE_PERSISTENCE === 'true' && !persistentDrive(env)) return 'drive_persistence_config';
  return null;
}

function oauthFailure(reason, clear = true) {
  console.warn('[rhea-oauth] authorization_incomplete', { reason });
  return redirect('/rhea?' + new URLSearchParams({ drive: reason }) + '#armazenamento',
    clear ? [cookie(stateCookie, '', 0)] : []);
}
function persistentDrive(env) {
  const config = configuration(env);
  return config?.google ? driveLinks(config) : null;
}

async function driveState(env, request, sub) {
  const stored = await persistentDrive(env)?.session(sub);
  if (stored?.known) return stored;
  return { session: await open(env.RHEA_COOKIE_KEY, 'drive', readCookie(request, sessionCookie), sub) };
}
const driveSession = async (env, request, sub) => (await driveState(env, request, sub)).session;
const driveError = status => status === 401 ? new RheaError(401, 'Reconecte a sua conta Google.')
  : new RheaError(502, 'O Drive não concluiu a operação. Tente novamente.');

async function googleFetch(path, token, options = {}) {
  const response = await fetch(path, {
    ...options, redirect: 'manual', headers: { ...options.headers, Authorization: 'Bearer ' + token },
  });
  if (!response.ok && response.status !== 308) throw driveError(response.status);
  return response;
}
const query = (url, params) => url + '?' + new URLSearchParams(params);
const postJson = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
async function connect(env, sub, callbackUrl) {
  const state = encode(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
  const offline = Boolean(persistentDrive(env));
  const proof = await seal(env.RHEA_COOKIE_KEY, 'oauth', { sub, state, verifier, offline, exp: now() + 600 });
  return redirect(query('https://accounts.google.com/o/oauth2/v2/auth', {
    client_id: env.RHEA_GOOGLE_CLIENT_ID, redirect_uri: callbackUrl, response_type: 'code',
    scope, state, code_challenge: challenge, code_challenge_method: 'S256', access_type: offline ? 'offline' : 'online', prompt: offline ? 'consent select_account' : 'select_account',
  }), [cookie(stateCookie, proof, 600)]);
}
async function callback(env, request, url, sub) {
  const callbackUrl = url.origin + '/api/rhea/callback';
  // Only bounded presence flags, never OAuth codes/state values, credentials or cookies.
  console.info('[rhea-oauth] callback_received', {
    oauthProofCookiePresent: Boolean(readCookie(request, stateCookie)),
    authorizationCodePresent: url.searchParams.has('code'),
    providerErrorPresent: url.searchParams.has('error'),
  });
  const proof = await open(env.RHEA_COOKIE_KEY, 'oauth', readCookie(request, stateCookie), sub);
  if (!proof || proof.state !== url.searchParams.get('state')) return oauthFailure('oauth_state', false);
  if (url.searchParams.get('error') === 'access_denied') return oauthFailure('oauth_consent');
  const code = url.searchParams.get('code');
  if (!code || code.length > 2048) return oauthFailure('oauth_code');
  // Token exchange MUST run only once with the matching PKCE verifier. On error,
  // log only fixed categories + HTTP status, never the code or Google's payload.
  let response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000), body: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: env.RHEA_GOOGLE_CLIENT_ID,
        client_secret: env.RHEA_GOOGLE_CLIENT_SECRET, redirect_uri: callbackUrl, code_verifier: proof.verifier,
      }),
    });
  } catch (error) {
    return oauthFailure(tokenTransportFailure(error));
  }
  // Cloudflare Workers rejects redirect: 'error' before network I/O.
  // Handle 3xx manually: never forward a one-time OAuth code or client secret to a redirect target.
  if (response.status >= 300 && response.status < 400) {
    console.warn('[rhea-oauth] token_exchange_redirect_rejected', { httpStatus: response.status });
    return oauthFailure('oauth_token_redirect');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const reason = tokenFailureCode(body?.error);
    console.warn('[rhea-oauth] token_exchange_rejected', {
      category: reason, httpStatus: response.status,
    });
    return oauthFailure(reason);
  }
  let payload;
  try { payload = await response.json(); }
  catch { return oauthFailure('oauth_token_response'); }
  const { access_token: token, expires_in: duration, scope: granted } = payload ?? {};
  if (typeof token !== 'string' || !token || !Number.isFinite(duration) || duration < 60) {
    return oauthFailure('oauth_token_response');
  }
  if (typeof granted !== 'string' || !granted.split(/\s+/).includes(scope)) return oauthFailure('oauth_scope');
  let user;
  try {
    const about = await googleFetch(query(drive + '/about', { fields: 'user(displayName,emailAddress,permissionId)' }),
      token, { signal: AbortSignal.timeout(15_000) });
    ({ user } = await about.json());
  } catch {
    return oauthFailure('oauth_drive');
  }
  if (!user?.permissionId) return oauthFailure('oauth_drive');
  const age = Math.min(duration - 30, 3600);
  const values = { sub, token, account: user.permissionId, name: user.emailAddress || user.displayName || 'Google Drive', exp: now() + age };
  if (proof.offline) {
    if (typeof payload.refresh_token !== 'string' || !payload.refresh_token || payload.refresh_token.length > 4096) {
      return oauthFailure('oauth_offline');
    }
    const linked = await persistentDrive(env)?.connect(sub, values, payload.refresh_token);
    if (!linked) return oauthFailure('oauth_link_changed');
    return redirect('/rhea?drive=connected#armazenamento', [cookie(stateCookie, '', 0), cookie(sessionCookie, '', 0)]);
  }
  const session = await seal(env.RHEA_COOKIE_KEY, 'drive', values);
  // No token, cookie value, account identity or provider response in logs.
  console.info('[rhea-oauth] session_cookie_issued', { sessionCookieIssued: true });
  // The fixed outcome marker tells the return page to refresh without transmitting tokens.
  return redirect('/rhea?drive=connected#armazenamento', [cookie(stateCookie, '', 0), cookie(sessionCookie, session, age)]);
}

function uploadProof(env, request, sub, session, purpose, header) {
  return open(env.RHEA_COOKIE_KEY, purpose, request.headers.get(header), sub).then(payload => {
    if (!payload || payload.account !== session.account) {
      throw new RheaError(409, 'Este envio não pertence à sessão atual.', 'invalid_upload');
    }
    return payload;
  });
}

async function reserveUpload(env, request, sub, session, service) {
  const input = await bodyJson(request) ?? {};
  const file = uploadMetadata(input);
  const parent = (await service.authorize(input.parent ?? null, true)).file.id;
  const id = await service.reserveId();
  const draft = { ...file, id, parent, sub, account: session.account, exp: now() + 7 * 86_400 };
  return json({ reservation: await seal(env.RHEA_COOKIE_KEY, 'reserve', draft) });
}

async function verifiedUpload(service, upload) {
  let found;
  try { found = (await service.authorize(upload.id)).file; }
  catch (error) {
    if (error instanceof DriveError && [404, 410].includes(error.status)) return null;
    throw error;
  }
  if (found.parents?.[0] !== upload.parent || found.id !== upload.id || found.name !== upload.name ||
      Number(found.size) !== upload.size || found.appProperties?.rheaUpload !== upload.id) {
    throw new RheaError(409, 'O identificador reservado pertence a um arquivo divergente.', 'verification_conflict');
  }
  return publicFile(found);
}

async function startUpload(env, request, sub, session, service) {
  const draft = await uploadProof(env, request, sub, session, 'reserve', 'X-Rhea-Reservation');
  const { keepBoth } = await bodyJson(request) ?? {};
  await service.authorize(draft.parent, true);
  const finished = await verifiedUpload(service, draft);
  if (finished) return json({ file: finished });
  const conflicts = (await service.matches(draft.parent, draft.name)).filter(file => file.id !== draft.id);
  if (conflicts.length && keepBoth !== true) throw new RheaError(409,
    conflicts.some(file => Number(file.size) === draft.size) ? 'Já existe um item com o mesmo nome e tamanho.' : 'Já existe um item com este nome.',
    'name_conflict');
  const options = postJson({ id: draft.id, name: draft.name, mimeType: draft.mimeType, parents: [draft.parent],
    appProperties: { rheaWorkspace: 'asset', rheaUpload: draft.id } });
  options.headers['X-Upload-Content-Type'] = draft.mimeType;
  options.headers['X-Upload-Content-Length'] = String(draft.size);
  let response;
  try { response = await service.call(query(uploadEndpoint, { uploadType: 'resumable', fields: 'id,size' }), options); }
  catch (error) {
    if (error.status !== 409) throw error;
    const file = await verifiedUpload(service, draft);
    if (file) return json({ file });
    throw new RheaError(503, 'O Drive ainda está confirmando o identificador reservado.');
  }
  const url = new URL(response.headers.get('Location') ?? google);
  if (url.origin !== google || url.pathname !== '/upload/drive/v3/files' || url.username || url.password ||
      !url.searchParams.has('upload_id') || url.href.length > 1500) {
    throw new RheaError(502, 'O Drive não iniciou o envio.');
  }
  return json({ ticket: await seal(env.RHEA_COOKIE_KEY, 'upload', {
    ...draft, url: url.href, exp: now() + 86_400,
  }), chunkSize });
}

async function writeChunk(env, request, sub, session, service) {
  const upload = await uploadProof(env, request, sub, session, 'upload', 'X-Rhea-Upload');
  await service.authorize(upload.parent, true);
  const range = request.headers.get('Content-Range') ?? '';
  const probe = range === 'bytes */' + upload.size;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
  const [first, last, total] = match?.slice(1).map(Number) ?? [];
  const length = last - first + 1;
  if (!probe && (total !== upload.size || first < 0 || last >= total || !(length > 0 && length <= chunkSize) ||
      first % (256 * 1024) !== 0 || (last + 1 !== total && length % (256 * 1024) !== 0))) {
    throw new RheaError(400, 'Trecho do arquivo inválido.');
  }
  if (probe && Number(request.headers.get('Content-Length') ?? 0) !== 0) throw new RheaError(400, 'Sondagem inválida.');
  if (!probe && Number(request.headers.get('Content-Length')) !== length) throw new RheaError(400, 'Tamanho do trecho inválido.');
  const bytes = probe ? new ArrayBuffer(0) : await request.arrayBuffer();
  if (!probe && bytes.byteLength !== length) throw new RheaError(400, 'Trecho incompleto.');
  let response;
  try {
    response = await service.call(upload.url, { method: 'PUT', body: bytes,
      headers: { 'Content-Range': range, 'Content-Type': 'application/octet-stream' } });
  } catch (error) {
    if (![404, 409, 410].includes(error.status)) throw error;
    const file = await verifiedUpload(service, upload);
    if (file) return json({ file });
    throw new RheaError(409, 'A sessão de envio expirou. O mesmo identificador será reutilizado.', 'expired_upload');
  }
  if (response.status === 308) {
    const accepted = /^bytes=0-(\d+)$/.exec(response.headers.get('Range') ?? '');
    const offset = accepted ? Number(accepted[1]) + 1 : 0;
    if (!Number.isSafeInteger(offset) || offset > upload.size) throw new RheaError(502, 'Intervalo inválido retornado pelo Drive.');
    return json({ offset });
  }
  const result = await response.json();
  if (result.id !== upload.id || Number(result.size) !== upload.size) throw new RheaError(502, 'O Drive retornou um arquivo divergente.');
  const file = await verifiedUpload(service, upload);
  if (!file) throw new RheaError(503, 'Aguardando confirmação dos metadados no Drive.');
  return json({ file });
}

function folderParams(url) {
  const p = url.searchParams;
  return { id: p.get('id') ?? null, page: p.get('page') ?? '', search: p.get('q') ?? '',
    sort: p.get('sort') ?? 'modifiedTime', direction: p.get('direction') ?? 'desc',
    kind: p.get('kind') ?? '', sizeSort: p.get('sizeSort') === 'true' };
}

function boundedBody(response, max) {
  let count = 0;
  return response.body?.pipeThrough(new TransformStream({
    transform(bytes, control) {
      count += bytes.length;
      if (count > max) throw new Error('Limite de transferência.');
      control.enqueue(bytes);
    },
  }));
}

async function renderPreview(url, service) {
  const id = url.searchParams.get('id') ?? '';
  const file = publicFile((await service.authorize(id)).file);
  const format = previewType(file);
  if (!format) throw new RheaError(415, 'Este formato ou tamanho não tem prévia na RHEA.');
  const partial = format.kind === 'text' && file.size > format.max;
  const response = await service.media(id, partial ? { Range: 'bytes=0-' + (format.max - 1) } : undefined);
  if (partial && response.status !== 206) {
    await response.body?.cancel();
    throw new RheaError(502, 'O Drive não retornou um trecho do texto.');
  }
  return new Response(boundedBody(response, format.max), { headers: {
    ...headers, 'Content-Type': format.type, 'Content-Disposition': 'attachment',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}

async function download(url, service) {
  const id = url.searchParams.get('id') ?? '';
  const file = publicFile((await service.authorize(id)).file);
  if (file.size === null || file.size > maxFile) throw new RheaError(413, 'Abra este arquivo no Google Drive.');
  const response = await service.media(id);
  return new Response(boundedBody(response, maxFile), { headers: {
    ...headers, 'Content-Type': 'application/octet-stream',
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16)),
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}

const methods = { status: 'GET', connect: 'GET', callback: 'GET', disconnect: 'POST',
  files: 'GET', preview: 'GET', download: 'GET', metadata: 'GET', bootstrap: 'POST', reserve: 'POST',
  start: 'POST', chunk: 'PUT', 'mcp-grants': 'GET', 'mcp-review': 'GET', 'mcp-approve': 'POST', 'mcp-unlink': 'POST', 'mcp-plans': 'GET', 'mcp-plan-review': 'POST', 'mcp-plan-execute': 'POST', folder: 'POST', rename: 'POST', move: 'POST', trash: 'POST' };

export async function onRequest({ request, env, data, params }) {
  const sub = data.cloudflareAccess?.JWT?.payload?.sub;
  if (typeof sub !== 'string' || !sub) return json({ error: 'Entre na RHEA para continuar.' }, 401);
  const action = params.action;
  if (!Object.hasOwn(methods, action) || request.method !== methods[action]) return json({ error: 'Operação indisponível.' }, 405);
  const url = new URL(request.url);
  try {
    const driveIssue = driveSetupIssue(env);
    if (action === 'status') {
      const sessionCookiePresent = Boolean(readCookie(request, sessionCookie));
      const oauthStateCookiePresent = Boolean(readCookie(request, stateCookie));
      const { session, reauthorize } = driveIssue ? {} : await driveState(env, request, sub);
      // Safe diagnostic: never expose token, session cookie, user identity or Access claims.
      // Distinguish callback failures (no cookie) from expired, changed-key or mismatched sessions.
      const sessionState = driveIssue ? 'unconfigured'
        : session ? 'connected' : reauthorize ? 'reauthorization_required' : sessionCookiePresent ? 'unrecognized' : 'absent';
      const queueOwner = driveIssue ? null : encode(new Uint8Array(await crypto.subtle.sign('HMAC',
        await crypto.subtle.importKey('raw', encoder.encode(env.RHEA_COOKIE_KEY),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encoder.encode('rhea-queue:' + sub))));
      return json({ queueOwner, persistentDrive: Boolean(persistentDrive(env)), persistentSession: Boolean(session?.linkId), drive: !driveIssue, driveIssue, account: session?.name ?? null, accountId: session?.account ?? null,
        sessionState, oauthStateCookiePresent });
    }
    if (action.startsWith('mcp-')) {
      const mcp = privateMcp(env, url.origin);
      if (!mcp) throw new RheaError(503, 'O gateway MCP da RHEA ainda precisa ser configurado.');
      if (action === 'mcp-grants') return json({ endpoint: mcp.endpoint, grants: await mcp.grants(sub) });
      if (action === 'mcp-unlink') return json({ revoked: await mcp.revoke((await bodyJson(request))?.id, sub) });
      const session = driveIssue ? null : await driveSession(env, request, sub);
      if (action === 'mcp-plans') return json({ plans: session ? await mcp.proposals.list(sub, session.account) : [] });
      if (action === 'mcp-plan-review' || action === 'mcp-plan-execute') {
        if (!session) throw new RheaError(401, 'Conecte a conta Google da proposta.');
        const input = await bodyJson(request);
        if (action === 'mcp-plan-review') return json({ reviewed: await mcp.proposals.review(input?.id, sub, session.account) });
        return json(await mcp.proposals.execute(input, sub, session));
      }
      if (action === 'mcp-review') {
        const pending = await mcp.review(url.searchParams.get('id'), sub, session);
        if (!pending) throw new RheaError(404, 'A solicitação de conexão expirou. Inicie novamente no assistente.');
        return json(pending);
      }
      const input = await bodyJson(request);
      const result = await mcp.approve(input, sub, session);
      if (result?.reconnect) throw new RheaError(401, 'Reconecte a conta Google antes de autorizar.');
      if (!result) throw new RheaError(409, 'Atualize a solicitação e confirme com a conta Google atual.');
      return json(result);
    }
    if (action === 'disconnect') {
      const config = configuration(env);
      if (config?.persistent) await driveLinks(config).disconnect(sub);
      else if (config) await storage(config).disconnectActor(sub);
      const response = new Response(null, { status: 204, headers });
      response.headers.append('Set-Cookie', cookie(sessionCookie, '', 0));
      response.headers.append('Set-Cookie', cookie(stateCookie, '', 0));
      return response;
    }
    if (driveIssue) throw new RheaError(503, driveStatusMessage(driveIssue));
    if (action === 'connect') return await connect(env, sub, url.origin + '/api/rhea/callback');
    if (action === 'callback') return await callback(env, request, url, sub);
    const session = await driveSession(env, request, sub);
    if (!session) throw new RheaError(401, 'Conecte a sua conta Google.', 'drive_connection_required');
    const expectedAccount = request.headers.get('X-Rhea-Account');
    if ((expectedAccount !== null || request.method !== 'GET') && expectedAccount !== session.account) {
      throw new RheaError(403, 'A conta Google mudou. Atualize a conexão e confira o destino.');
    }
    const service = driveFiles(session.token);
    if (action === 'files') return json(await service.listing(folderParams(url)));
    if (action === 'preview') return await renderPreview(url, service);
    if (action === 'download') return await download(url, service);
    if (action === 'metadata') {
      const result = await service.authorize(url.searchParams.get('id'));
      return json({ file: publicFile(result.file), breadcrumbs: result.chain.map(publicFile) });
    }
    if (action === 'bootstrap') return json({ folderId: (await service.bootstrap()).id });
    if (action === 'reserve') return await reserveUpload(env, request, sub, session, service);
    if (action === 'start') return await startUpload(env, request, sub, session, service);
    if (action === 'chunk') return await writeChunk(env, request, sub, session, service);
    const input = await bodyJson(request) ?? {};
    if (action === 'folder') return json({ file: await service.createFolder(input.parent ?? null, input.name) }, 201);
    return json({ file: await service.change(action, input.id, input) });
  } catch (error) {
    if (action === 'callback') return oauthFailure('oauth_exchange');
    if (error instanceof RheaError || error instanceof DriveError) return json({ error: error.message, code: error.code }, error.status);
    return json({ error: 'A operação não foi concluída. Tente novamente.' }, 502);
  }
}
