const api = 'https://www.googleapis.com/drive/v3';
export const uploadEndpoint = 'https://www.googleapis.com/upload/drive/v3/files';
export const folderType = 'application/vnd.google-apps.folder';
const shortcutType = 'application/vnd.google-apps.shortcut';
export const maxFile = 512 * 1024 ** 2;
const nodeFields = 'id,name,mimeType,parents,trashed,size,createdTime,modifiedTime,md5Checksum,appProperties';
const contentTypes = /^[\w.+-]+\/[\w.+-]+$/;
const rootName = 'RHEA';
const orders = new Set(['name', 'modifiedTime', 'createdTime', 'mimeType']);
const quote = value => "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
const query = (url, params) => url + '?' + new URLSearchParams(params);
const jsonOptions = (data, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

export class DriveError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{5,200}$/.test(id);
}

function requireId(id) {
  if (!validId(id)) throw new DriveError(400, 'Identificador do Drive inválido.');
  return id;
}

export function requireName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200 ||
      /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name) || name === '.' || name === '..') {
    throw new DriveError(400, 'Use um nome de arquivo válido com até 200 caracteres.');
  }
  return name;
}

export function uploadMetadata(input) {
  const { name, size, mimeType } = input ?? {};
  requireName(name);
  if (!Number.isInteger(size) || size < 1 || size > maxFile) {
    throw new DriveError(400, 'Use um arquivo de 1 byte a 512 MiB.');
  }
  const type = typeof mimeType === 'string' && mimeType.length <= 120 && contentTypes.test(mimeType) &&
    !mimeType.toLowerCase().startsWith('application/vnd.google-apps.') ? mimeType : 'application/octet-stream';
  return { name, size, mimeType: type };
}

export function publicFile(file) {
  return {
    id: requireId(file.id), name: String(file.name ?? '').slice(0, 512),
    mimeType: String(file.mimeType ?? '').slice(0, 120), size: file.size == null ? null : Number(file.size),
    createdAt: file.createdTime, modifiedAt: file.modifiedTime,
    ...(typeof file.md5Checksum === 'string' && /^[\da-f]{32}$/.test(file.md5Checksum) ? { md5: file.md5Checksum } : {}),
  };
}

export async function driveRequest(url, token, options = {}, fetcher = fetch) {
  // Callers construct fixed Google origins. Never follow a provider redirect with credentials.
  let response;
  try {
    response = await fetcher(url, { ...options, redirect: 'manual', signal: options.signal ?? AbortSignal.timeout(20_000),
      headers: { ...options.headers, Authorization: 'Bearer ' + token } });
  } catch {
    throw new DriveError(503, 'Sem resposta do Google Drive.');
  }
  if (response.ok || response.status === 308) return response;
  const status = response.status;
  const body = status === 403 ? await response.json().catch(() => null) : null;
  const reason = body?.error?.errors?.[0]?.reason;
  if (status === 429 || ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) {
    throw new DriveError(429, 'Limite temporário do Google Drive. Tente novamente em instantes.');
  }
  if (status === 401) throw new DriveError(401, 'Reconecte a sua conta Google.');
  if (status === 403) throw new DriveError(403, 'O Google Drive recusou esta operação.');
  if (status === 404 || status === 410) throw new DriveError(status, 'O recurso não está disponível no Drive.');
  if (status === 409) throw new DriveError(409, 'O Google Drive encontrou um conflito.');
  throw new DriveError(502, 'O Google Drive não concluiu a operação.');
}

export function driveFiles(token, fetcher = fetch) {
  const call = (url, options) => driveRequest(url, token, options, fetcher);
  const read = async (url, options) => (await call(url, options)).json();
  const raw = id => read(query(api + '/files/' + requireId(id), { fields: nodeFields }));
  const list = (q, options = {}) => read(query(api + '/files', {
    q, spaces: 'drive', fields: 'nextPageToken,incompleteSearch,files(' + nodeFields + ')', pageSize: '50', ...options,
  }));
  const absent = () => new DriveError(404, 'Arquivo fora da pasta de trabalho autorizada.');
  let resolveRoot;

  async function findRoot() {
    const result = await list("'root' in parents and trashed = false and mimeType = " + quote(folderType) +
      " and name = " + quote(rootName));
    const files = result.files ?? [];
    if (result.nextPageToken || result.incompleteSearch || files.length > 1) {
      throw new DriveError(409, 'Há mais de uma pasta RHEA acessível na raiz do Drive.', 'ambiguous_root');
    }
    const candidate = files[0];
    if (!candidate) return null;
    // A drive.file grant can see the app-created folder while files.get('root') is denied.
    // Drive applies the My Drive root filter. Re-read the candidate and pin its real parent
    // to the metadata from that filtered response before using it as the trust boundary.
    const actual = await raw(candidate.id);
    if (actual.id !== candidate.id || actual.name !== rootName || actual.mimeType !== folderType ||
        actual.trashed !== false || actual.parents?.length !== 1 || candidate.parents?.length !== 1 ||
        !validId(candidate.parents[0]) || actual.parents[0] !== candidate.parents[0] ||
        actual.appProperties?.rheaWorkspace !== 'folder') {
      throw new DriveError(409, 'A pasta raiz precisa ser autorizada pela RHEA.', 'unapproved_root');
    }
    return actual;
  }

  const root = () => resolveRoot ??= findRoot();

  async function bootstrap() {
    const current = await root();
    if (current) return current;
    await read(api + '/files', jsonOptions({
      name: rootName, mimeType: folderType, appProperties: { rheaWorkspace: 'folder' },
    }));
    resolveRoot = findRoot();
    const created = await resolveRoot;
    if (!created) throw new DriveError(503, 'A pasta raiz ainda não foi confirmada pelo Google Drive.');
    return created;
  }

  async function authorize(id, mustBeFolder = false) {
    const base = await root();
    if (!base) throw absent();
    const chain = [];
    let current = id == null ? base.id : requireId(id);
    const visited = new Set();
    for (let depth = 0; depth < 32; depth++) {
      if (visited.has(current)) throw absent();
      visited.add(current);
      if (current === base.id) {
        const file = chain[0] ?? base;
        if (mustBeFolder && file.mimeType !== folderType) throw absent();
        return { root: base, file, chain: [base, ...chain.reverse()] };
      }
      const file = await raw(current);
      if (file.id !== current || file.trashed !== false || file.mimeType === shortcutType ||
          file.parents?.length !== 1 || !validId(file.parents[0]) ||
          (depth > 0 && file.mimeType !== folderType)) throw absent();
      chain.push(file);
      current = file.parents[0];
    }
    throw absent();
  }

  async function listing({ id = null, page = '', search = '', sort = 'modifiedTime', direction = 'desc', kind = '', sizeSort = false } = {}) {
    if (typeof page !== 'string' || page.length > 2048 || typeof search !== 'string' || search.length > 120 ||
        !orders.has(sort) || !['asc', 'desc'].includes(direction) || !['', 'folder', 'file', 'image', 'video'].includes(kind)) {
      throw new DriveError(400, 'Filtro ou página inválida.');
    }
    const base = await root();
    if (!base && id == null) return { files: [], page: '', folderId: null, breadcrumbs: [] };
    const { file, chain } = await authorize(id, true);
    const conditions = [quote(file.id) + ' in parents', 'trashed = false', 'mimeType != ' + quote(shortcutType)];
    if (search.trim()) conditions.push('name contains ' + quote(search.trim()));
    if (kind === 'folder') conditions.push('mimeType = ' + quote(folderType));
    if (kind === 'file') conditions.push('mimeType != ' + quote(folderType));
    if (['image', 'video'].includes(kind)) conditions.push('mimeType contains ' + quote(kind + '/'));
    // Drive orderBy has no size or MIME sort. Size/type presentation applies to the loaded page.
    const driveSort = sort === 'mimeType' ? 'name' : sort;
    const result = await list(conditions.join(' and '), { orderBy: driveSort + (direction === 'desc' ? ' desc' : ''),
      ...(page ? { pageToken: page } : {}) });
    if (result.incompleteSearch) throw new DriveError(503, 'O Google Drive retornou uma lista incompleta.');
    const files = (result.files ?? []).filter(item => item.trashed === false && item.mimeType !== shortcutType &&
      item.parents?.length === 1 && item.parents[0] === file.id).map(publicFile);
    if (sizeSort || sort === 'mimeType') {
      const compare = sizeSort ? (a, b) => (a.size ?? -1) - (b.size ?? -1) : (a, b) => a.mimeType.localeCompare(b.mimeType);
      files.sort((a, b) => (direction === 'asc' ? 1 : -1) * compare(a, b) || a.name.localeCompare(b.name));
    }
    return { files, page: result.nextPageToken ?? '', folderId: base.id, breadcrumbs: chain.map(publicFile) };
  }

  async function matches(parent, name) {
    const result = await list(quote(parent) + ' in parents and trashed = false and name = ' + quote(name), { pageSize: '10' });
    if (result.incompleteSearch || (result.nextPageToken && !result.files?.length)) throw new DriveError(503, 'A verificação de nomes no Google Drive está incompleta.');
    return (result.files ?? []).filter(file => file.trashed === false && file.parents?.length === 1 &&
      file.parents[0] === parent && file.name === name);
  }

  async function createFolder(parent, name) {
    requireName(name);
    const { file } = await authorize(parent, true);
    if ((await matches(file.id, name)).length) throw new DriveError(409, 'Já existe um item com este nome nesta pasta.', 'name_conflict');
    const made = await read(api + '/files', jsonOptions({ name, parents: [file.id], mimeType: folderType }));
    const verified = await authorize(made.id, true);
    if (verified.file.parents[0] !== file.id || verified.file.name !== name) throw new DriveError(502, 'A pasta não foi confirmada pelo Drive.');
    return publicFile(verified.file);
  }

  async function change(action, id, input) {
    const { root: base, file } = await authorize(requireId(id));
    if (file.id === base.id) throw new DriveError(403, 'A pasta raiz da RHEA está protegida.');
    let params = { fields: nodeFields };
    let body;
    let destination;
    if (action === 'rename') {
      const name = requireName(input.name);
      if ((await matches(file.parents[0], name)).some(item => item.id !== id)) {
        throw new DriveError(409, 'Já existe um item com este nome nesta pasta.', 'name_conflict');
      }
      body = { name };
    } else if (action === 'move') {
      const target = await authorize(requireId(input.parent), true);
      destination = target.file.id;
      if (target.chain.some(item => item.id === id)) throw new DriveError(409, 'A pasta não pode ser movida para dentro dela mesma.');
      if (destination === file.parents[0]) return publicFile(file);
      if ((await matches(destination, file.name)).length) {
        throw new DriveError(409, 'Já existe um item com este nome na pasta de destino.', 'name_conflict');
      }
      params = { ...params, addParents: destination, removeParents: file.parents[0] };
      body = {};
    } else if (action === 'trash' && input.confirmed === true) {
      body = { trashed: true };
    } else {
      throw new DriveError(400, 'Operação ou confirmação inválida.');
    }
    await read(query(api + '/files/' + id, params), jsonOptions(body, 'PATCH'));
    if (action === 'trash') {
      const trashed = await raw(id);
      if (trashed.id !== id || trashed.trashed !== true || trashed.parents?.[0] !== file.parents[0]) {
        throw new DriveError(502, 'O Drive não confirmou a lixeira.');
      }
      await authorize(file.parents[0], true);
      return { id, trashed: true };
    }
    const verified = (await authorize(id)).file;
    if ((destination && verified.parents[0] !== destination) || (body.name != null && verified.name !== body.name)) {
      throw new DriveError(502, 'O Drive não confirmou a alteração.');
    }
    return publicFile(verified);
  }

  async function media(id, headers) {
    const { file } = await authorize(requireId(id));
    if (file.mimeType.startsWith('application/vnd.google-apps.')) throw new DriveError(415, 'Abra este formato no Google Drive.');
    return call(query(api + '/files/' + id, { alt: 'media' }), { headers });
  }

  async function reserveId() {
    const result = await read(query(api + '/files/generateIds', { count: '1', space: 'drive', type: 'files' }));
    if (!validId(result.ids?.[0])) throw new DriveError(502, 'O Drive não reservou um identificador.');
    return result.ids[0];
  }

  return { root, bootstrap, authorize, listing, matches, createFolder, change, media, reserveId, call };
}
