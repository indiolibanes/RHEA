import { indexedQueue, uploadQueue } from './upload-queue.mjs';

const labels = {
  waiting: 'AGUARDANDO', uploading: 'ENVIANDO', confirming: 'CONFIRMANDO', synced: 'SINCRONIZADO',
  paused: 'PAUSADO', offline: 'SEM CONEXÃO', failed: 'FALHOU', login: 'REQUER LOGIN', cancelled: 'CANCELADO',
  conflict: 'CONFLITO DE NOME',
};
const size = new Intl.NumberFormat('pt-BR', { style: 'unit', unit: 'byte' });
const byId = id => document.getElementById(id);
function make(tag, text) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  return element;
}
function action(label, handler) {
  const button = make('button', label);
  button.type = 'button';
  button.className = 'editorial-action';
  button.addEventListener('click', handler);
  return button;
}

export function mountUploadPanel({ api, complete, openOnDrive }) {
  const batches = byId('upload-batches');
  const summary = byId('upload-summary');
  const rows = new Map();
  const groups = new Map();
  const panel = byId('upload-panel');
  let queue;
  function render(items) {
    panel.hidden = !items.length;
    const visible = new Set(items.map(item => item.id));
    for (const [id, row] of rows) {
      if (!visible.has(id)) { row.node.remove(); rows.delete(id); }
    }
    const stats = new Map();
    for (const item of items) {
      let group = groups.get(item.batch);
      if (!group) {
        const info = make('p');
        const progress = make('progress');
        progress.max = 100;
        progress.setAttribute('aria-label', 'Progresso do lote');
        const list = make('ul');
        list.className = 'file-list';
        const node = make('section');
        info.className = 'meta';
        node.append(info, progress, list);
        batches.prepend(node);
        group = { node, list, info, progress };
        groups.set(item.batch, group);
      }
      const batch = stats.get(item.batch) ?? { total: 0, sent: 0, failed: 0, cancelled: 0, bytes: 0, confirmed: 0 };
      batch.total++;
      batch.sent += Number(item.state === 'synced');
      batch.failed += Number(['failed', 'conflict'].includes(item.state));
      batch.cancelled += Number(item.state === 'cancelled');
      batch.bytes += item.size;
      batch.confirmed += item.state === 'synced' ? item.size : item.offset;
      stats.set(item.batch, batch);
      let row = rows.get(item.id);
      if (!row) {
        const name = make('bdi', item.name);
        const status = make('p');
        const detail = make('p');
        const controls = make('div');
        const progress = make('progress');
        const node = make('li');
        node.className = 'rhea-upload-row';
        status.className = detail.className = 'meta';
        controls.className = 'rhea-controls';
        progress.max = 100;
        progress.setAttribute('aria-label', 'Progresso de ' + item.name);
        node.append(name, status, progress, detail, controls);
        group.list.append(node);
        row = { node, status, detail, controls, progress };
        rows.set(item.id, row);
      }
      const percent = item.state === 'synced' ? 100 : Math.min(99, Math.floor((item.offset || 0) / Math.max(1, item.size) * 100));
      row.progress.value = percent;
      row.status.textContent = size.format(item.size) + ' · ' + labels[item.state] + ' · ' + percent + '%';
      row.detail.textContent = item.error || (item.data && !item.stored ? 'Abra esta aba até concluir. Os bytes não foram preservados.' :
        item.state === 'paused' ? 'Reconecte a conta Google que recebeu este lote.' : '');
      const stateKey = item.state + ':' + Boolean(item.data);
      if (row.stateKey === stateKey) continue;
      row.stateKey = stateKey;
      row.controls.replaceChildren();
      if (item.state === 'synced') row.controls.append(openOnDrive(item.remote));
      if (item.state === 'conflict') {
        row.controls.append(action('Manter ambos', () => void queue.retry(item, true)), action('Ignorar', () => void queue.cancel(item)));
      }
      if (item.state === 'failed' && item.data) row.controls.append(action('Tentar novamente', () => void queue.retry(item)));
      if (['waiting', 'login', 'offline', 'paused', 'failed'].includes(item.state)) {
        row.controls.append(action('Cancelar', () => void queue.cancel(item)));
      }
    }
    let pending = 0;
    let synced = 0;
    let failed = 0;
    for (const [id, group] of groups) {
      const count = stats.get(id);
      if (!count) { group.node.remove(); groups.delete(id); continue; }
      const remaining = count.total - count.sent - count.failed - count.cancelled;
      pending += remaining;
      synced += count.sent;
      failed += count.failed;
      const percent = Math.min(count.sent === count.total ? 100 : 99, Math.floor(count.confirmed / Math.max(1, count.bytes) * 100));
      group.progress.value = percent;
      group.info.textContent = `${percent}% · ${count.sent} enviados · ${remaining} pendentes · ${count.failed} falhas · ${count.cancelled} cancelados`;
    }
    const text = `${synced} sincronizados · ${pending} pendentes · ${failed} falhas`;
    if (summary.textContent !== text) summary.textContent = text;
  }

  queue = uploadQueue({
    api, update: render, complete, store: indexedQueue(globalThis.indexedDB),
    online: () => navigator.onLine, locks: navigator.locks,
  });
  window.addEventListener('online', queue.resume);
  window.addEventListener('offline', queue.resume);
  return queue;
}
