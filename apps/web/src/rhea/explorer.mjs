import { driveAccount, enqueueFiles, json, openOnDrive, submitDrive } from './tools.mjs';
const folderType = 'application/vnd.google-apps.folder';

const byId = id => document.getElementById(id);
const inputParams = () => new URLSearchParams(location.search);
const locale = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
const size = new Intl.NumberFormat('pt-BR', { style: 'unit', unit: 'byte' });
const urlFor = (action, id) => '/api/rhea/' + action + '?' + new URLSearchParams({ id });
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, handler, className = 'editorial-action') {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}
function link(label, href) {
  const node = element('a', label, 'editorial-action');
  node.href = href;
  return node;
}
const isFolder = file => file.mimeType === folderType;

export function mountExplorer(openPreview) {
  const panel = byId('explorador');
  const list = byId('explorer-files');
  const nav = byId('explorer-breadcrumbs');
  const controls = byId('explorer-tools');
  const notice = byId('explorer-status');
  const more = byId('explorer-more');
  const create = byId('explorer-create');
  const move = byId('explorer-move');
  const trash = byId('explorer-trash');
  const pick = byId('explorer-pick');
  const filter = byId('explorer-filter');
  const search = byId('explorer-search');
  const order = byId('explorer-order');
  const dialog = byId('explorer-action');
  const form = byId('explorer-form');
  const dialogTitle = byId('explorer-action-title');
  const dialogNote = byId('explorer-action-note');
  const nameField = byId('explorer-action-name');
  const nameInput = nameField.querySelector('input');
  const dest = byId('explorer-destination');
  const submit = byId('explorer-apply');
  const selected = new Map();
  let path = location.pathname.replace(/\/$/, '');
  let id = path.endsWith('/arquivos') ? inputParams().get('folder') : null;
  let cursor = '';
  let root;
  let folderChain = [];
  let known = new Set();
  let generation = 0;
  let timer;
  let operation;
  let trigger;
  let dialogGeneration = 0;
  let pickerId;
  let pickerPage;
  let selectedAccount;
  let loadedFolder;
  let loaded = false;

  function setStatus(text) { notice.textContent = text; }
  function setSelection() {
    const count = selected.size;
    byId('explorer-selection').textContent = count + ' selecionado(s)';
    move.disabled = trash.disabled = !count;
  }
  function clearSelection() {
    selected.clear();
    for (const checkbox of list.querySelectorAll('input:checked')) checkbox.checked = false;
    setSelection();
  }

  function navigate(target) {
    id = target;
    path = '/rhea/arquivos';
    history.pushState({ rheaFolder: id }, '', path + (id ? '?' + new URLSearchParams({ folder: id }) : '') + '#explorador');
    search.value = '';
    void load();
  }

  function breadcrumb(chain) {
    nav.replaceChildren();
    if (!chain.length) return;
    for (const [i, folder] of chain.entries()) {
      const control = button(folder.name, () => navigate(i === 0 ? null : folder.id));
      if (i === chain.length - 1) control.setAttribute('aria-current', 'location');
      nav.append(control);
    }
  }

  function details(file, row) {
    const menu = element('details', null, 'explorer-menu');
    const summary = element('summary', 'Ações');
    summary.setAttribute('aria-label', 'Ações de ' + file.name);
    const actions = element('div', null, 'rhea-controls');
    if (!isFolder(file)) actions.append(link('Baixar', urlFor('download', file.id)));
    actions.append(
      button('Propriedades', async () => {
        try {
          const payload = await json('metadata?' + new URLSearchParams({ id: file.id }));
          const detail = row.querySelector('.explorer-info');
          const item = payload.file;
          detail.textContent = [
            item.mimeType, item.size == null ? '' : size.format(item.size),
            item.modifiedAt ? 'Alterado ' + locale.format(new Date(item.modifiedAt)) : '',
            item.md5 ? 'MD5 ' + item.md5 : '',
          ].filter(Boolean).join(' · ');
          detail.hidden = false;
        } catch (error) { setStatus(error.message); }
      }),
      button('Renomear', event => showAction('rename', [file], event.currentTarget)),
      button('Mover', event => showAction('move', [file], event.currentTarget)),
      button('Mover para a lixeira', event => showAction('trash', [file], event.currentTarget)),
      openOnDrive(file),
    );
    menu.append(summary, actions);
    return menu;
  }

  function renderFile(file) {
    const row = element('li', null, 'file-row explorer-row');
    const checked = element('input');
    checked.type = 'checkbox';
    checked.checked = selected.has(file.id);
    checked.setAttribute('aria-label', 'Selecionar ' + file.name);
    checked.addEventListener('change', () => {
      if (checked.checked) selected.set(file.id, file);
      else selected.delete(file.id);
      setSelection();
    });
    const title = button(null, event => isFolder(file) ? navigate(file.id) : openPreview(file, event.currentTarget), 'edit-title editorial-action');
    title.append(element('bdi', file.name));
    if (!isFolder(file)) title.setAttribute('aria-haspopup', 'dialog');
    const description = element('p', isFolder(file) ? 'Pasta' : file.size == null ? file.mimeType : size.format(file.size), 'meta muted');
    const info = element('p', null, 'explorer-info meta');
    info.hidden = true;
    const label = element('div');
    label.append(title, description, info);
    row.append(checked, label, details(file, row));
    list.append(row);
  }

  async function load(append = false, preserveSelection = false) {
    const revision = ++generation;
    const account = driveAccount();
    if (selectedAccount !== account) { clearSelection(); selectedAccount = account; }
    more.disabled = true;
    loaded = false;
    byId('explorer-upload').disabled = true;
    if (!append) {
      known = new Set();
      list.replaceChildren();
      if (!preserveSelection) clearSelection();
      nav.replaceChildren();
      controls.hidden = true;
      byId('explorer-upload').hidden = !account;
    }
    if (!account) {
      setStatus('Conecte sua conta Google na seção Drive.');
      more.hidden = true;
      return;
    }
    const [sort, direction] = order.value.split(':');
    const params = new URLSearchParams({ sort: sort === 'size' ? 'name' : sort, direction, sizeSort: sort === 'size',
      q: search.value, kind: filter.value });
    if (id) params.set('id', id);
    if (append && cursor) params.set('page', cursor);
    setStatus('Consultando o Google Drive…');
    try {
      const data = await json('files?' + params, { headers: { 'X-Rhea-Account': account } });
      if (generation !== revision || account !== driveAccount()) return;
      root = data.folderId;
      folderChain = data.breadcrumbs;
      loadedFolder = folderChain.at(-1)?.id ?? null;
      loaded = true;
      byId('explorer-upload').disabled = false;
      breadcrumb(folderChain);
      controls.hidden = !root;
      create.disabled = !root;
      cursor = data.page;
      for (const file of data.files) {
        if (known.has(file.id)) continue;
        known.add(file.id);
        renderFile(file);
      }
      more.hidden = !cursor;
      setStatus(root ? known.size ? known.size + ' item(ns) carregado(s) · Sincronizado com o Drive' :
        'Nenhum item encontrado nesta pasta.' : 'Selecione arquivos para iniciar a pasta de trabalho.');
    } catch (error) {
      if (generation === revision) { setStatus(error.message); more.hidden = true; }
    } finally { if (generation === revision) more.disabled = false; }
  }

  async function selectDestination(next, append = false) {
    const current = ++dialogGeneration;
    if (!append) {
      pickerId = next;
      pickerPage = '';
      dest.replaceChildren();
    }
    dialogNote.textContent = 'Carregando destinos…';
    submit.disabled = true;
    const params = new URLSearchParams({ kind: 'folder', sort: 'name', direction: 'asc' });
    if (pickerId) params.set('id', pickerId);
    if (append && pickerPage) params.set('page', pickerPage);
    try {
      const result = await json('files?' + params, { headers: { 'X-Rhea-Account': driveAccount() ?? '' } });
      if (current !== dialogGeneration) return;
      pickerId = result.breadcrumbs.at(-1)?.id;
      pickerPage = result.page;
      dialogNote.textContent = 'Destino · ' + result.breadcrumbs.map(part => part.name).join(' / ');
      submit.disabled = !pickerId || operation.files.some(file => file.id === pickerId);
      if (!append && result.breadcrumbs.length > 1) {
        dest.append(button('Subir uma pasta', () => void selectDestination(result.breadcrumbs.at(-2).id)));
      }
      dest.querySelector('[data-picker-more]')?.remove();
      for (const folder of result.files.filter(isFolder)) {
        if (operation.files.some(file => file.id === folder.id)) continue;
        dest.append(button(folder.name, () => void selectDestination(folder.id)));
      }
      if (pickerPage) {
        const nextPage = button('Mais pastas', () => void selectDestination(pickerId, true));
        nextPage.dataset.pickerMore = 'true';
        dest.append(nextPage);
      }
    } catch (error) { if (current === dialogGeneration) dialogNote.textContent = error.message; }
  }

  function showAction(action, files, opener) {
    operation = { action, files, account: driveAccount(), parent: folderChain.at(-1)?.id };
    trigger = opener;
    const needsName = action === 'rename' || action === 'folder';
    dialogTitle.textContent = { folder: 'Criar pasta', rename: 'Renomear', move: 'Mover itens', trash: 'Mover para a lixeira' }[action];
    dialogNote.textContent = action === 'trash' ? files.length + ' item(ns) serão movidos para a lixeira do Google Drive.' : '';
    nameField.hidden = !needsName;
    nameInput.required = needsName;
    nameInput.value = action === 'rename' ? files[0].name : '';
    dest.replaceChildren();
    dest.hidden = action !== 'move';
    submit.disabled = false;
    submit.textContent = action === 'trash' ? 'Confirmar lixeira' : 'Confirmar';
    dialog.showModal();
    if (needsName) nameInput.focus();
    if (action === 'move') void selectDestination(root);
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || !operation) return;
    const current = operation;
    if (!current.account || current.account !== driveAccount()) {
      dialogNote.textContent = 'A conta Google mudou. Feche e abra a operação novamente.';
      return;
    }
    submit.disabled = true;
    const close = byId('explorer-close');
    close.disabled = true;
    dialogNote.textContent = 'Aguardando a confirmação do Drive…';
    const failures = [];
    let successes = 0;
    const apply = async (action, body) => submitDrive(action, body, { 'X-Rhea-Account': current.account });
    if (current.action === 'folder') {
      try { await apply('folder', { parent: current.parent, name: nameInput.value }); successes++; }
      catch (error) { failures.push(error.message); }
    } else {
      for (const file of current.files) {
        try {
          await apply(current.action, { id: file.id, name: nameInput.value, parent: pickerId, confirmed: current.action === 'trash' });
          successes++;
        } catch (error) { failures.push(file.name + ' · ' + error.message); }
      }
    }
    close.disabled = false;
    if (failures.length && !successes) {
      dialogNote.textContent = failures.slice(0, 3).join(' / ');
      submit.disabled = false;
      return;
    }
    dialog.close();
    await load();
    setStatus(successes + ' alteração(ões) confirmada(s) pelo Drive.' +
      (failures.length ? ' ' + failures.length + ' falha(s) · ' + failures.slice(0, 3).join(' / ') : ''));
  });
  dialog.addEventListener('cancel', event => { if (byId('explorer-close').disabled) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    dialogGeneration++;
    operation = null;
    if (trigger?.isConnected) trigger.focus();
  });

  byId('explorer-queue-link').addEventListener('click', () => byId('enviar').scrollIntoView());
  create.addEventListener('click', event => showAction('folder', [], event.currentTarget));
  move.addEventListener('click', event => showAction('move', [...selected.values()], event.currentTarget));
  trash.addEventListener('click', event => showAction('trash', [...selected.values()], event.currentTarget));
  byId('explorer-close').addEventListener('click', () => dialog.close());
  byId('explorer-refresh').addEventListener('click', () => void load());
  byId('explorer-clear').addEventListener('click', clearSelection);
  byId('explorer-select').addEventListener('click', () => {
    for (const checkbox of list.querySelectorAll('input:not(:checked)')) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));
    }
  });
  more.addEventListener('click', () => void load(true));
  for (const control of [filter, order]) control.addEventListener('change', () => void load());
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => void load(), 250); });
  byId('explorer-view').addEventListener('change', event => { list.dataset.view = event.currentTarget.value; });
  byId('explorer-upload').addEventListener('click', () => pick.click());
  pick.addEventListener('change', () => {
    const files = [...pick.files];
    pick.value = '';
    if (files.length && loaded && selectedAccount === driveAccount()) {
      void enqueueFiles(files, loadedFolder);
      setStatus(files.length + ' arquivo(s) adicionado(s) à fila de envio.');
    }
  });
  function refreshVisible() { if (!panel.hidden) void load(false, true); }
  window.addEventListener('rhea-explorer-activated', refreshVisible);
  window.addEventListener('rhea-explorer-reload', refreshVisible);
  window.addEventListener('rhea-drive-changed', refreshVisible);
  window.addEventListener('popstate', () => {
    id = location.pathname.endsWith('/arquivos') ? inputParams().get('folder') : null;
    refreshVisible();
  });
  if (path.endsWith('/arquivos') && !location.hash) requestAnimationFrame(() => panel.scrollIntoView());
  void load();
}
