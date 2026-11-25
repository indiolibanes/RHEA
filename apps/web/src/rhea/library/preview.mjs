import { buildCatalog, duplicateCandidates, editionTypes, findSeries, letterFor } from './catalog.mjs';
import { forumEnrichmentSnapshot } from './forum-panel.mjs';
import { forumCatalogSnapshot } from './live-catalog.mjs';

const library = document.querySelector('[data-rhea-telegram-library]');

const get = id => document.getElementById(id);
function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
const count = new Intl.NumberFormat('pt-BR');
const kindLabels = { episode: 'Episódio', ova: 'OVA', ona: 'ONA', special: 'Especial', movie: 'Filme', extra: 'Extra' };
let snapshot;
let catalog;
let messages;
let selected = '';

const alphabet = [...document.querySelectorAll('[data-letter]')];

function selectCorrection(id) {
  if (!snapshot.correctionIds.includes(id)) return;
  get('correction-id').value = String(id);
  populateCorrection();
  const row = messages.get(id);
  get('correction-file').textContent = row.filename || 'Post #' + id;
  get('correction-file').hidden = get('correction-choose-post').hidden = false;
  get('correction-post-select').hidden = true;
  get('correction-feedback').textContent = '';
  get('correcoes').scrollIntoView({ block: 'start' });
  get('correction-series').focus({ preventScroll: true });
}

function correctionButton(id) {
  const button = element('button', 'Editar no catálogo');
  button.type = 'button';
  button.className = 'editorial-action catalog-correction';
  button.setAttribute('aria-label', 'Editar no catálogo · Post #' + id);
  button.addEventListener('click', () => selectCorrection(id));
  return button;
}

function renderCatalog() {
  const entries = findSeries(catalog, get('library-query').value)
    .filter(entry => !selected || letterFor(entry.key) === selected);
  const cards = entries.map(entry => {
    const details = element('details');
    const rows = entry.units.flatMap(unit => unit.items);
    const heading = element('summary');
    heading.append(element('strong', entry.title), element('span', count.format(rows.length) + ' posts'));
    details.append(heading);
    if (entry.aliases?.length) details.append(element('p', entry.aliases.map(alias => alias.title).join(' · ')));
    const seasons = new Map();
    for (const row of rows) {
      const label = row.season == null ? 'Sem temporada definida' : 'Temporada ' + row.season;
      if (!seasons.has(label)) seasons.set(label, element('ul'));
      const item = element('li');
      item.id = 'post-' + row.id;
      item.append(element('strong', row.label || episodeLabel(row)),
        element('span', 'Post #' + row.id + (row.albumId ? ' · Álbum' : '')),
        element('span', 'Legenda · ' + (row.caption || '—')),
        element('span', 'Arquivo · ' + (row.filename || '—')));
      if (row.link) {
        const link = element('a', 'Abrir no Telegram');
        link.href = row.link;
        link.rel = 'noreferrer';
        item.append(link);
      }
      if (row.filename) item.append(correctionButton(row.id));
      seasons.get(label).append(item);
    }
    for (const [label, list] of seasons) details.append(element('h3', label), list);
    return details;
  });
  if (!selected && !get('library-query').value.trim() && catalog.unresolved.length) {
    const unresolved = element('details');
    unresolved.append(element('summary', 'Posts sem série confirmada'));
    const list = element('ul');
    for (const row of catalog.unresolved.flatMap(group => group.items)) {
      const item = element('li');
      item.append(element('span', 'Post #' + row.id + ' · ' + (row.filename || row.caption || '—')));
      if (row.link) {
        const link = element('a', 'Abrir no Telegram');
        link.href = row.link;
        link.rel = 'noreferrer';
        item.append(link);
      }
      if (row.filename) item.append(correctionButton(row.id));
      list.append(item);
    }
    unresolved.append(list);
    cards.push(unresolved);
  }
  get('catalog-items').replaceChildren(...cards);
  get('catalog-result').textContent = entries.length ? count.format(entries.length) + ' séries exibidas' :
    snapshot.sourceId === 'empty' ? 'Carregue um tópico para começar.' : 'Nenhuma série corresponde à busca.';
  if (catalog.unresolved.length) get('catalog-result').textContent += ' · ' + catalog.unresolved.flatMap(group => group.items).length + ' posts sem série confirmada.';
  for (const button of alphabet) {
    button.setAttribute('aria-pressed', String(button.dataset.letter === selected));
    button.disabled = !!button.dataset.letter && !catalog.entries.some(entry => letterFor(entry.key) === button.dataset.letter);
  }
}

function episodeLabel(row) {
  const kind = kindLabels[row.kind];
  if (row.episode == null && row.kind === 'episode') return 'Episódio sem número';
  return kind + (row.episode == null ? '' : ' ' + row.episode) + (row.part == null ? '' : ' · Parte ' + row.part);
}

function renderDuplicates() {
  const findings = duplicateCandidates(catalog);
  const clusters = new Map();
  const labels = { exact_metadata: 'Metadados iguais', telegram_media_identity: 'Mesma referência de mídia', verified_sha256: 'SHA-256 igual' };
  for (const finding of findings) {
    const key = finding.ids.join(',');
    if (!clusters.has(key)) clusters.set(key, { ids: finding.ids, labels: [] });
    clusters.get(key).labels.push(labels[finding.basis]);
  }
  get('duplicate-count').textContent = count.format(clusters.size);
  get('duplicate-items').replaceChildren(...[...clusters.values()].map(cluster =>
    element('li', cluster.ids.map(id => '#' + id).join(' e ') + ' · ' + cluster.labels.join(' · '))));
}

function populateCorrection() {
  const row = messages.get(Number(get('correction-id').value));
  for (const name of ['season', 'episode', 'part', 'kind', 'label']) get('correction-' + name).value = row?.[name] ?? '';
  get('correction-series').value = row?.seriesId ?? '';
  get('correction-details').open = false;
  get('correction-reset').disabled = !row || !Object.hasOwn(snapshot.overrides, row.id);
}

function refresh() {
  catalog = buildCatalog(snapshot);
  messages = new Map(catalog.chronological.map(row => [row.id, row]));
  get('series-count').textContent = count.format(catalog.entries.length);
  renderCatalog();
  renderDuplicates();
  populateCorrection();
}

function chooseLetter(letter) {
  selected = letter;
  renderCatalog();
}

function correctionKey(channelId, id) {
  return 'rhea:telegram:catalog:v1:' + channelId + ':' + id;
}

function loadCorrections({ channelId, series, correctionIds }) {
  const overrides = {};
  if (!channelId) return overrides;
  const byTitle = new Map(series.map(item => [item.title, item.id]));
  for (const id of correctionIds) {
    try {
      const saved = JSON.parse(localStorage.getItem(correctionKey(channelId, id)));
      if (!editionTypes.includes(saved?.kind) ||
          (saved.seriesTitle !== null && (typeof saved.seriesTitle !== 'string' || !saved.seriesTitle.trim() ||
            saved.seriesTitle.length > 160))) continue;
      if (saved.seriesTitle !== null && !byTitle.has(saved.seriesTitle)) {
        const seriesId = 'saved-series-' + id;
        series.push({ id: seriesId, title: saved.seriesTitle });
        byTitle.set(saved.seriesTitle, seriesId);
      }
      const patch = { seriesId: byTitle.get(saved.seriesTitle) ?? null, kind: saved.kind };
      if (typeof saved.label === 'string' && saved.label.length <= 160) patch.label = saved.label;
      for (const name of ['season', 'episode', 'part']) {
        const value = saved[name];
        if (value === null || (Number.isFinite(value) && value >= (name === 'part' ? 1 : 0) &&
            value <= 99999 && (name === 'episode' || Number.isInteger(value)))) patch[name] = value;
      }
      overrides[id] = patch;
    } catch { /* A missing or unreadable browser record leaves the original metadata visible. */ }
  }
  return overrides;
}

function showPostPicker() {
  get('correction-file').hidden = get('correction-choose-post').hidden = true;
  get('correction-post-select').hidden = false;
}

export function setCatalogSnapshot(current = { sourceId: 'empty', series: [], messages: [], correctionIds: [] }) {
  snapshot = { ...current, series: [...current.series] };
  snapshot.overrides = loadCorrections(snapshot);
  showPostPicker();
  get('correction-feedback').textContent = '';
  if (selected && !snapshot.series.some(entry => letterFor(entry.title) === selected)) selected = '';
  get('demo-title').textContent = snapshot.sourceId === 'forum-topic' ? 'Catálogo · ' + snapshot.title :
    snapshot.sourceId === 'empty' ? 'Catálogo do Telegram' : 'Canal de teste autorizado';
  get('inventory-source').textContent = snapshot.sourceId === 'empty' ? 'Carregue um tópico para ver as obras do seu acervo.' :
    snapshot.complete ? 'Histórico consultado no Telegram.' :
      'Inventário parcial do Telegram. O catálogo mostra os posts lidos.';
  const byId = new Map(snapshot.messages.map(post => [post.id, post]));
  get('correction-id').replaceChildren(...snapshot.correctionIds.map(id => {
    const file = byId.get(id)?.filename;
    return new Option('Post #' + id + (file ? ' · ' + file : ''), String(id));
  }));
  get('correction-series').replaceChildren(new Option('Sem série definida', ''),
    ...snapshot.series.map(item => new Option(item.title, item.id)));
  get('correction-form').querySelector('[type="submit"]').disabled = !snapshot.correctionIds.length;
  get('message-count').textContent = count.format(snapshot.messages.length);
  refresh();
}
for (const kind of editionTypes) get('correction-kind').append(new Option(kindLabels[kind], kind));
for (const button of alphabet) button.addEventListener('click', () => chooseLetter(button.dataset.letter));
get('library-query').addEventListener('input', renderCatalog);
get('correction-id').addEventListener('change', populateCorrection);
get('correction-choose-post').addEventListener('click', () => {
  showPostPicker();
  get('correction-id').focus();
});
library.addEventListener('rhea:catalog-edit', event => selectCorrection(event.detail));
get('correction-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = get('correction-id').value;
  if (!snapshot.channelId || !messages.has(Number(id))) return;
  const advanced = get('correction-details').open;
  const patch = {
    ...snapshot.overrides[id],
    seriesId: get('correction-series').value || null, kind: get('correction-kind').value,
    ...(advanced && {
      label: get('correction-label').value.trim(),
      ...Object.fromEntries(['season', 'episode', 'part'].map(name => {
        const field = get('correction-' + name);
        return [name, field.value === '' ? null : field.valueAsNumber];
      })),
    }),
  };
  const series = snapshot.series.find(item => item.id === patch.seriesId);
  const { seriesId, ...saved } = patch;
  try {
    localStorage.setItem(correctionKey(snapshot.channelId, id), JSON.stringify({ ...saved, seriesTitle: series?.title ?? null }));
  } catch {
    get('correction-feedback').textContent = 'Não foi possível salvar. Verifique se o navegador permite guardar dados deste site.';
    return;
  }
  snapshot.overrides[id] = patch;
  refresh();
  const row = messages.get(Number(id));
  get('correction-feedback').textContent = series ? 'Salvo neste navegador. ' + series.title + ' · ' + kindLabels[row.kind] + '.' :
    'Salvo neste navegador. ' + kindLabels[row.kind] + ' sem série vinculada.';
});
get('correction-reset').addEventListener('click', () => {
  const id = get('correction-id').value;
  try {
    localStorage.removeItem(correctionKey(snapshot.channelId, id));
  } catch {
    get('correction-feedback').textContent = 'O navegador não permitiu remover a correção.';
    return;
  }
  delete snapshot.overrides[id];
  refresh();
  get('correction-feedback').textContent = 'Correção removida do catálogo.';
});
selected = /^[A-Z]$/.test(location.hash.slice(1)) ? location.hash.slice(1) : '';
library.addEventListener('rhea:forum-inventory-change', () => {
  const forum = forumEnrichmentSnapshot();
  if (forum?.channelId) setCatalogSnapshot(forumCatalogSnapshot(forum));
  else if (snapshot?.sourceId === 'forum-topic') setCatalogSnapshot();
});
setCatalogSnapshot();
