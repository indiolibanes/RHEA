import { clearMediaPreview, enqueueFiles, openOnDrive, setUpTools, showMediaPreview } from './tools.mjs';

const byId = id => document.getElementById(id);
const dialog = byId('file-dialog');
const drop = byId('drop');
const input = byId('file-input');
const amount = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const views = [...document.querySelectorAll('[data-rhea-view]')];
const navLinks = [...document.querySelectorAll('.side-nav a, .section-nav a')];
let opener;
let explorer;
let assistant;
let currentView;

function formattedSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const [unit, divisor] = bytes < 1024 ** 2 ? ['KiB', 1024] : ['MiB', 1024 ** 2];
  return amount.format(bytes / divisor) + ' ' + unit;
}

function showFile(file, trigger) {
  const actions = byId('dialog-actions');
  const preview = document.createElement('div');
  preview.className = 'meta muted';
  byId('file-dialog-title').textContent = file.name;
  byId('file-dialog-description').textContent = (file.size == null ? file.mimeType : formattedSize(file.size)) + ' · Google Drive';
  clearMediaPreview();
  actions.replaceChildren(openOnDrive(file), preview);
  opener = trigger;
  dialog.showModal();
  void showMediaPreview(preview, file);
}

function addFiles(files) {
  if (files.length) void enqueueFiles(Array.from(files));
}

dialog.addEventListener('close', () => {
  clearMediaPreview();
  byId('dialog-actions').replaceChildren();
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  opener = undefined;
});
byId('pick').addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  addFiles(input.files);
  input.value = '';
});
drop.addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  drop.dataset.drag = 'true';
});
drop.addEventListener('dragleave', event => {
  if (!drop.contains(event.relatedTarget)) delete drop.dataset.drag;
});
drop.addEventListener('drop', event => {
  delete drop.dataset.drag;
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  addFiles(event.dataTransfer.files);
});

function reflectView() {
  const hash = location.hash;
  const params = new URLSearchParams(location.search);
  let request = params.has('mcp_request');
  if (!request && hash === '#armazenamento' && params.get('drive') === 'connected') {
    try { request = Boolean(sessionStorage.getItem('rhea-mcp-request')); } catch { /* Storage is optional. */ }
  }
  const path = location.pathname.replace(/\/$/, '');
  const view = hash === '#assistente' || hash === '#mcp-review' || request ? 'assistente'
    : ['#explorador', '#arquivos'].includes(hash) || (!hash && path.endsWith('/arquivos')) ? 'explorador' : 'enviar';
  const changed = currentView !== view;
  currentView = view;
  for (const section of views) section.hidden = section.id !== view;
  for (const link of navLinks) {
    const active = link.hash === (hash === '#armazenamento' ? hash : '#' + view);
    if (active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
  if (!changed) return;
  if (view === 'explorador') {
    if (explorer) window.dispatchEvent(new Event('rhea-explorer-activated'));
    else explorer = import('./explorer.mjs').then(module => module.mountExplorer(showFile));
  }
  if (view === 'assistente') {
    if (assistant) window.dispatchEvent(new Event('rhea-assistant-activated'));
    else assistant = import('./assistant-connect.mjs').then(module => module.mountAssistantConnect());
  }
}

window.addEventListener('hashchange', reflectView);
window.addEventListener('popstate', reflectView);
window.addEventListener('pagehide', () => {
  clearMediaPreview();
  if (dialog.open) dialog.close();
  byId('dialog-actions').replaceChildren();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) reflectView();
});
setUpTools();
reflectView();
