import { previewType } from './preview-types.mjs';
import { driveStatusMessage } from './oauth-status.mjs';
import { createDriveSmokeFile } from './drive-smoke.mjs';
import { mountUploadPanel } from './upload-panel.mjs';
import { watchOAuthTabReturn } from './oauth-tab-sync.mjs';

const byId = id => document.getElementById(id);
const driveUrl = 'https://drive.google.com';
let account;
let accountId;
let uploadPanel;
let refreshAfterUpload;
let queueOwner;
let previewUrl;
let oauthReturnSignal = null;
const driveMessage = text => { byId('drive-status').textContent = text; };
const submit = data => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export async function request(endpoint, options) {
  let response;
  try {
    response = await fetch('/api/rhea/' + endpoint, {
      ...options, headers: { Accept: 'application/json', ...options?.headers }, redirect: 'manual', cache: 'no-store',
    });
  } catch {
    throw new Error('Não foi possível alcançar a API da RHEA. Confira a conexão ou entre novamente na RHEA.');
  }
  if (response.type === 'opaqueredirect') throw Object.assign(new Error('Entre novamente na RHEA.'), { status: 401 });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const fallback = response.status === 503
      ? 'HTTP 503 no Cloudflare. Confira o deploy e os logs das Functions.'
      : 'A API da RHEA respondeu com HTTP ' + response.status + '.';
    throw Object.assign(new Error(data.error || fallback), { status: response.status, code: data.code });
  }
  return response;
}
export async function json(endpoint, options) {
  return (await request(endpoint, options)).json();
}

export function openOnDrive(file) {
  const link = document.createElement('a');
  link.className = 'editorial-action';
  link.textContent = 'Abrir no Drive ↗';
  link.href = driveUrl + '/open?id=' + encodeURIComponent(file.id);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

let statusRequest;
let lastStatusAt = 0;
let statusLoaded = false;
let persistentSession = false;

function refresh() {
  if (!statusRequest) statusRequest = loadStatus().finally(() => { statusRequest = null; });
  return statusRequest;
}

async function fetchDriveStatus() {
  for (const delay of [0, 900, 1800]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try { return await json('status'); }
    catch (error) {
      // Only retry concurrent renewal. Provider failures and rate limits remain visible.
      if (error.code !== 'drive_refresh_pending' || delay === 1800) throw error;
      driveMessage('Renovando a conexão com o Google Drive…');
    }
  }
}

async function loadStatus() {
  try {
    const status = await fetchDriveStatus();
    lastStatusAt = Date.now();
    const changed = !statusLoaded || accountId !== status.accountId || queueOwner !== status.queueOwner ||
      persistentSession !== Boolean(status.persistentSession);
    statusLoaded = true;
    persistentSession = Boolean(status.persistentSession);
    account = status.account;
    accountId = status.accountId;
    queueOwner = status.queueOwner;
    await uploadPanel.setContext(queueOwner, accountId);
    byId('drive-connect').hidden = !status.drive;
    byId('drive-connect').textContent = !account ? 'Conectar ao Google Drive' :
      status.persistentDrive && !status.persistentSession ? 'Manter o Drive conectado' : 'Trocar conta';
    byId('drive-disconnect').hidden = !account;
    byId('drive-check').hidden = !status.drive;
    byId('drive-smoke-upload').hidden = !accountId;
    if (changed) window.dispatchEvent(new Event('rhea-drive-changed'));
    if (account) {
      driveMessage((persistentSession ? 'Conta conectada automaticamente · ' : 'Conta conectada · ') + account);
      return status;
    }
    const code = oauthReturnSignal ?? new URLSearchParams(location.search).get('drive');
    const message = driveStatusMessage(code);
    const diagnostic = message && code && code !== 'connected' ? message + ' · Diagnóstico: ' + code : message;
    driveMessage(status.drive
      ? (['unrecognized', 'reauthorization_required'].includes(status.sessionState) ? 'A autorização Google expirou ou foi revogada. Conecte a conta novamente.' :
        diagnostic || 'Conecte sua conta Google para enviar e organizar arquivos.')
      : driveStatusMessage(status.driveIssue) || 'A conexão com o Drive precisa ser configurada na RHEA.');
    return status;
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      account = null;
      accountId = null;
      queueOwner = null;
      await uploadPanel.setContext(null, null);
      byId('drive-smoke-upload').hidden = true;
      byId('drive-disconnect').hidden = true;
      window.dispatchEvent(new Event('rhea-drive-changed'));
    }
    driveMessage(error.message);
    return null;
  }
}

export const submitDrive = (endpoint, body, extra = {}) =>
  json(endpoint, { ...submit(body), headers: { 'Content-Type': 'application/json', 'X-Rhea-Account': accountId ?? '', ...extra } });
export const driveAccount = () => accountId;
export function enqueueFiles(files, parent = null) {
  return uploadPanel.add(files, parent);
}
const uploadApi = {
  bootstrap: destination => submitDrive('bootstrap', {}, { 'X-Rhea-Account': destination }),
  reserve: item => submitDrive('reserve', { name: item.name, size: item.size, mimeType: item.data.type, parent: item.parent },
    { 'X-Rhea-Account': item.account }),
  start: item => submitDrive('start', { keepBoth: item.keepBoth },
    { 'X-Rhea-Account': item.account, 'X-Rhea-Reservation': item.reservation }),
  chunk: (item, range, body) => json('chunk', {
    method: 'PUT', headers: { 'X-Rhea-Upload': item.ticket, 'X-Rhea-Account': item.account, 'Content-Range': range }, body,
  }),
};

export function clearMediaPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function markdownPreview(text) {
  const article = document.createElement('article');
  article.className = 'rhea-markdown';
  // Render only local block structure. All source text is assigned through textContent.
  for (const block of text.split(/\r?\n[ \t]*\r?\n/).slice(0, 300)) {
    const heading = /^(#{1,6})[ \t]+([^\n]+)$/.exec(block);
    const node = document.createElement(heading ? 'h' + Math.min(6, heading[1].length + 2) : 'p');
    node.textContent = heading ? heading[2] : block;
    article.append(node);
  }
  return article;
}

export async function showMediaPreview(container, file) {
  const format = previewType({ name: file.name, mimeType: file.data?.type ?? file.mimeType, size: file.size });
  if (!format || (!file.data && !file.id)) return;
  if (!file.data) container.textContent = 'Carregando prévia.';
  try {
    const data = file.data ? new Blob([file.data.slice(0, format.max)], { type: format.type })
      : await (await request('preview?' + new URLSearchParams({ id: file.id }))).blob();
    if (!container.isConnected) return;
    if (format.kind === 'text') {
      const content = await data.text() + (file.size > format.max ? '\n\n[…] Prévia parcial' : '');
      if (!container.isConnected) return;
      if (/\.md$/i.test(file.name) || file.mimeType === 'text/markdown') {
        container.replaceChildren(markdownPreview(content));
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'rhea-text';
      pre.textContent = content;
      container.replaceChildren(pre);
      return;
    }
    clearMediaPreview();
    previewUrl = URL.createObjectURL(data);
    const media = document.createElement(format.kind === 'image' ? 'img' : 'video');
    media.className = 'rhea-media';
    media.addEventListener('error', () => { container.textContent = 'O navegador não conseguiu exibir este arquivo.'; });
    if (format.kind === 'image') {
      media.alt = 'Prévia de ' + file.name;
      media.decoding = 'async';
    } else {
      media.controls = true;
      media.playsInline = true;
      media.preload = 'metadata';
      media.setAttribute('aria-label', 'Prévia de ' + file.name);
    }
    media.src = previewUrl;
    container.replaceChildren(media);
  } catch (error) {
    if (container.isConnected) container.textContent = error.message;
  }
}

export function setUpTools() {
  uploadPanel = mountUploadPanel({ api: uploadApi, openOnDrive,
    complete: () => {
      clearTimeout(refreshAfterUpload);
      refreshAfterUpload = setTimeout(() => {
        window.dispatchEvent(new Event('rhea-explorer-reload'));
      }, 250);
    },
  });
  byId('drive-connect').addEventListener('click', event => {
    const pending = uploadPanel.snapshot().filter(item => item.data && !item.stored).length;
    if (pending && !window.confirm('Há ' + pending + ' arquivo(s) sem cópia nesta fila. A saída da aba pode exigir selecionar os arquivos outra vez. Prosseguir?')) {
      event.preventDefault();
    }
  });
  byId('drive-refresh').addEventListener('click', refresh);
  byId('drive-check').addEventListener('click', async event => {
    const button = event.currentTarget;
    const result = byId('drive-check-status');
    button.disabled = true;
    result.textContent = 'Verificando a sessão e a comunicação com o Google Drive…';
    try {
    const status = await fetchDriveStatus();
      if (!status.drive) throw new Error('A integração Google Drive ainda não está configurada.');
      if (!status.accountId || status.sessionState !== 'connected') {
        throw new Error('A API está configurada, mas não existe uma sessão Google conectada. Use Conectar conta Google nesta aba.');
      }
      const listing = await json('files');
      if (!Array.isArray(listing.files)) throw new Error('A listagem do Google Drive não pôde ser validada.');
      const count = listing.files.length;
      result.textContent = 'Conexão validada: sessão reconhecida e listagem do Google Drive disponível. ' +
        count + ' arquivo(s) nesta página' + (listing.page ? ' (há mais páginas).' : '.') +
        (listing.folderId ? ' A pasta de trabalho foi encontrada.' : ' A pasta será criada no primeiro envio.');
    } catch (error) {
      result.textContent = (account ? 'A sessão Google está presente. A consulta ao Drive falhou: ' : 'Teste não concluído: ') + error.message;
      if (error.status === 401) void refresh();
    } finally {
      button.disabled = false;
    }
  });
  byId('drive-smoke-upload').addEventListener('click', async event => {
    const button = event.currentTarget;
    const result = byId('drive-check-status');
    button.disabled = true;
    result.textContent = 'Preparando um arquivo TXT sintético. O envio foi autorizado por este clique.';
    try {
      const status = await json('status');
      if (!status.accountId || status.sessionState !== 'connected') {
        throw new Error('Conecte o Google Drive antes de enviar o teste.');
      }
      const data = createDriveSmokeFile();
      await enqueueFiles([data]);
      result.textContent = 'TXT de teste adicionado à fila. Acompanhe a confirmação do Drive na seção Enviar.';
    } catch (error) {
      result.textContent = 'Envio do TXT não confirmado: ' + error.message;
    } finally {
      button.disabled = false;
    }
  });
  byId('drive-disconnect').addEventListener('click', async () => {
    try {
      await request('disconnect', { method: 'POST' });
      await statusRequest;
      await refresh();
    } catch (error) { driveMessage(error.message); }
  });
  void refresh();
  // Keep account changes synchronized across tabs without polling Drive.
  // Only a fixed outcome code is sent between tabs; never a token or cookie.
  const stopOAuthWatch = watchOAuthTabReturn({
    win: window, doc: document,
    onReturn: code => {
      if (code) oauthReturnSignal = code;
      if (code || Date.now() - lastStatusAt > 15_000) void refresh();
    },
  });
  window.addEventListener('pagehide', event => { if (!event.persisted) stopOAuthWatch(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void refresh(); });
}
