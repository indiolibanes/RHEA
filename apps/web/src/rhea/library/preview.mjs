import { buildCatalog, duplicateCandidates, editionTypes, findSeries, letterFor } from './catalog.mjs';
import { syntheticSnapshot } from './fixtures.mjs';

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
      const item = element('li', 'Post #' + row.id + ' · ' + (row.filename || row.caption || '—'));
      if (row.link) {
        const link = element('a', 'Abrir no Telegram');
        link.href = row.link;
        link.rel = 'noreferrer';
        item.append(link);
      }
      list.append(item);
    }
    unresolved.append(list);
    cards.push(unresolved);
  }
  get('catalog-items').replaceChildren(...cards);
  get('catalog-result').textContent = entries.length ? count.format(entries.length) + ' séries exibidas' : 'Nenhuma série corresponde à busca.';
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

export function setCatalogSnapshot(current = syntheticSnapshot()) {
  snapshot = { ...current, overrides: {} };
  get('demo-title').textContent = snapshot.sourceId === 'demo' ? 'Canal de demonstração' : 'Canal de teste autorizado';
  get('inventory-source').textContent = snapshot.sourceId === 'demo' ? 'Dados fictícios para explorar o catálogo.' :
    snapshot.complete ? 'Histórico consultado no Telegram. As correções valem nesta sessão.' :
      'Inventário parcial do Telegram. O catálogo mostra os posts lidos.';
  get('correction-id').replaceChildren(...snapshot.correctionIds.map(id => new Option('Post #' + id, String(id))));
  get('correction-series').replaceChildren(new Option('Sem série definida', ''),
    ...snapshot.series.map(item => new Option(item.title, item.id)));
  for (const button of get('correction-form').querySelectorAll('button')) button.disabled = !snapshot.messages.length || !snapshot.series.length;
  get('message-count').textContent = count.format(snapshot.messages.length);
  refresh();
}
for (const kind of editionTypes) get('correction-kind').append(new Option(kindLabels[kind], kind));
for (const button of alphabet) button.addEventListener('click', () => chooseLetter(button.dataset.letter));
get('library-query').addEventListener('input', renderCatalog);
get('correction-id').addEventListener('change', populateCorrection);
get('correction-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = get('correction-id').value;
  snapshot.overrides[id] = {
    seriesId: get('correction-series').value || null, kind: get('correction-kind').value,
    label: get('correction-label').value.trim(),
    ...Object.fromEntries(['season', 'episode', 'part'].map(name => [name, get('correction-' + name).value === '' ? null : get('correction-' + name).valueAsNumber])),
  };
  refresh();
  get('correction-feedback').textContent = 'Catálogo atualizado para o post #' + id + '.';
});
get('correction-reset').addEventListener('click', () => {
  delete snapshot.overrides[get('correction-id').value];
  refresh();
  get('correction-feedback').textContent = 'Correção removida do catálogo.';
});
selected = /^[A-Z]$/.test(location.hash.slice(1)) ? location.hash.slice(1) : '';
setCatalogSnapshot();
