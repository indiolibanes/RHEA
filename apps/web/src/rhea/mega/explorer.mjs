import { formatSize } from '../library/sizes.mjs';
import { entryLink, MEGA_API_ORIGIN, parseFolderLink } from './folder-link.mjs';

const element = id => document.getElementById(`mega-${id}`);
const form = element('form');
const input = element('link');
const load = element('load');
const cancel = element('cancel');
const explorer = element('explorer');
const folderName = element('folder-name');
const open = element('open');
const breadcrumbs = element('breadcrumbs');
const search = element('search');
const list = element('files');
const more = element('more');
const status = element('status');

const pageSize = 50;
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
let activeRequest;
let shareLink;
let path = [];
let entries = [];
let visible = pageSize;

function action(tag, label) {
  const element = document.createElement(tag);
  element.className = 'editorial-action';
  element.textContent = label;
  if (tag === 'button') element.type = 'button';
  return element;
}

const searchKey = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');

function renderItems() {
  const query = searchKey(search.value.trim());
  const matches = query ? entries.filter(entry => searchKey(entry.name).includes(query)) : entries;
  const rows = matches.slice(0, visible).map(entry => {
    const row = document.createElement('li');
    row.className = 'mega-row';
    const href = entry.directory ? null : entryLink(shareLink, entry);
    const name = action(entry.directory ? 'button' : href ? 'a' : 'span', entry.name);
    if (entry.directory) {
      name.addEventListener('click', () => showFolder([...path, entry]));
    } else if (href) {
      name.href = href;
      name.target = '_blank';
      name.rel = 'noopener noreferrer';
      name.setAttribute('aria-label', `Abrir ${entry.name} no MEGA`);
    }
    const info = document.createElement('small');
    info.className = 'muted';
    info.textContent = entry.directory ? 'Pasta' : ['Arquivo', formatSize(entry.size)].filter(Boolean).join(' · ');
    row.append(name, info);
    return row;
  });
  list.replaceChildren(...rows);
  more.hidden = matches.length <= visible;
  if (matches.length === 0) {
    status.textContent = query ? 'Nenhum item encontrado.' : 'Nenhum item disponível nesta pasta.';
  } else {
    const total = matches.length === 1 ? '1 item' : `${matches.length} itens`;
    status.textContent = more.hidden ? total : `${rows.length} de ${total}`;
  }
}

function showFolder(nextPath) {
  path = nextPath;
  const folder = path.at(-1);
  folderName.textContent = folder.name;
  open.href = entryLink(shareLink, folder) || shareLink;
  breadcrumbs.replaceChildren(...path.map((item, index) => {
    const current = index === path.length - 1;
    const crumb = action(current ? 'span' : 'button', item.name);
    if (current) crumb.setAttribute('aria-current', 'location');
    else crumb.addEventListener('click', () => showFolder(path.slice(0, index + 1)));
    return crumb;
  }));
  entries = (folder.children ?? []).filter(entry => typeof entry.name === 'string' && entry.name)
    .sort((a, b) => Number(b.directory) - Number(a.directory) || collator.compare(a.name, b.name));
  search.value = '';
  visible = pageSize;
  renderItems();
  folderName.focus();
}

function setLoading(loading) {
  load.disabled = loading;
  input.readOnly = loading;
  cancel.hidden = !loading;
}

function disconnect() {
  activeRequest?.abort();
  activeRequest = undefined;
  shareLink = undefined;
  path = [];
  entries = [];
  input.value = '';
  input.removeAttribute('aria-invalid');
  search.value = '';
  folderName.textContent = '';
  status.textContent = '';
  open.removeAttribute('href');
  breadcrumbs.replaceChildren();
  list.replaceChildren();
  more.hidden = true;
  explorer.hidden = true;
  form.hidden = false;
  setLoading(false);
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (activeRequest) return;
  const link = parseFolderLink(input.value);
  if (!link) {
    input.setAttribute('aria-invalid', 'true');
    status.textContent = 'Use o link completo de uma pasta do MEGA, com a chave após #.';
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  const controller = new AbortController();
  activeRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  setLoading(true);
  status.textContent = 'Carregando a pasta compartilhada…';

  try {
    const { API, File } = await import('megajs');
    const api = new API(false, {
      gateway: `${MEGA_API_ORIGIN}/`,
      fetch: (url, options) => fetch(url, {
        ...options,
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }),
    });
    const folder = await File.fromURL(link, { api }).loadAttributes();
    if (activeRequest !== controller) return;
    if (typeof folder.name !== 'string' || !folder.directory) throw new Error('Invalid MEGA folder');
    shareLink = link;
    input.value = '';
    form.hidden = true;
    explorer.hidden = false;
    showFolder([folder]);
  } catch {
    if (activeRequest !== controller) return;
    status.textContent = controller.signal.aborted
      ? 'O MEGA demorou a responder. Tente novamente.'
      : 'Não foi possível abrir a pasta. Confira se o link e a chave estão válidos e tente novamente.';
  } finally {
    clearTimeout(timeout);
    if (activeRequest === controller) {
      activeRequest = undefined;
      setLoading(false);
    }
  }
});

input.addEventListener('input', () => {
  input.removeAttribute('aria-invalid');
  status.textContent = '';
});
search.addEventListener('input', () => {
  visible = pageSize;
  renderItems();
});
more.addEventListener('click', () => {
  const firstNewItem = visible;
  visible += pageSize;
  renderItems();
  list.children[firstNewItem]?.firstElementChild?.focus();
});
for (const button of [cancel, element('disconnect')]) {
  button.addEventListener('click', () => {
    disconnect();
    input.focus();
  });
}
window.addEventListener('pagehide', disconnect);
input.disabled = false;
load.disabled = false;
