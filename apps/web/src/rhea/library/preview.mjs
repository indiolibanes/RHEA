import { buildCatalog, duplicateCandidates, editionTypes, findSeries, letterFor } from './catalog.mjs';
import { syntheticSnapshot } from './fixtures.mjs';
import { planReflow } from './planner.mjs';

const get = id => document.getElementById(id);
function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
const count = new Intl.NumberFormat('pt-BR');
const kindLabels = { episode: 'Episódio', ova: 'OVA', ona: 'ONA', special: 'Especial', movie: 'Filme', extra: 'Extra' };
const snapshot = syntheticSnapshot();
snapshot.overrides = {};
let catalog;
let messages;
let selected = '';
let planVersion = 0;

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
      seasons.get(label).append(item);
    }
    for (const [label, list] of seasons) details.append(element('h3', label), list);
    return details;
  });
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

function renderOrder(target, ids) {
  const series = new Map(snapshot.series.map(item => [item.id, item.title]));
  target.replaceChildren(...ids.map(id => {
    const row = messages.get(id);
    return element('li', [series.get(row.seriesId) ?? 'Sem série definida',
      row.season == null ? null : 'T' + row.season, episodeLabel(row), '#' + id].filter(Boolean).join(' · '));
  }));
}

async function renderPlan() {
  const version = ++planVersion;
  get('plan-review').disabled = true;
  const batch = get('plan-batch');
  if (!batch.validity.valid) {
    get('plan-estimates').textContent = 'Escolha um tamanho de lote entre 1 e 100.';
    get('plan-description').textContent = '';
    get('plan-blockers').hidden = true;
    get('original-order').replaceChildren();
    get('target-order').replaceChildren();
    get('plan-review').disabled = true;
    return;
  }
  const strategy = get('plan-strategy').value;
  const plan = await planReflow(snapshot, { strategy, batchSize: batch.valueAsNumber });
  if (version !== planVersion) return;
  get('plan-review').disabled = false;
  get('plan-description').textContent = strategy === 'staging'
    ? 'A reconstrução publica o catálogo inteiro em outro canal privado. O canal de origem fica disponível para consulta.'
    : 'O início que já está em ordem permanece no canal. A partir da primeira divergência, todo o sufixo entra no plano, inclusive as letras seguintes.';
  const copyRequests = plan.estimates.copyRequests == null ? 'chamadas pendentes de revisão' : count.format(plan.estimates.copyRequests) + ' chamadas estimadas';
  const summary = count.format(plan.estimates.copiedMessages) + ' mensagens para copiar · ' + copyRequests +
    ' · ' + count.format(plan.originalIdsForSeparateCleanup.length) + ' originais sujeitos à aprovação de limpeza';
  get('plan-estimates').textContent = summary;
  get('plan-dialog-count').textContent = summary;
  const explanations = {
    group_exceeds_batch_limit: 'Um grupo é maior que o lote escolhido.',
    group_requires_separate_transport: 'Um grupo exige outro método para preservar a ordem.',
    unassigned_messages: 'Há posts sem série confirmada.',
    incomplete_snapshot: 'O inventário está incompleto.',
    copy_permission_unverified: 'A permissão de cópia precisa ser verificada.',
    album_order_conflict: 'A ordem de um álbum diverge dos metadados.',
    atomic_group_order_conflict: 'Um grupo impede a ordem de episódios proposta.',
    multipart_metadata_conflict: 'As partes de um grupo têm metadados conflitantes.',
    conflicting_group_identity: 'Um grupo contém séries conflitantes.',
    noncontiguous_album: 'Há um álbum incompleto ou fora de sequência.',
  };
  get('plan-blockers').hidden = !plan.blockers.length;
  get('plan-blockers').textContent = plan.blockers.map(code => explanations[code] ?? code).join(' ');
  renderOrder(get('original-order'), plan.originalIds);
  renderOrder(get('target-order'), plan.targetIds);
}

function populateCorrection() {
  const row = messages.get(Number(get('correction-id').value));
  for (const name of ['season', 'episode', 'part', 'kind', 'label']) get('correction-' + name).value = row[name] ?? '';
  get('correction-series').value = row.seriesId;
}

function refresh() {
  catalog = buildCatalog(snapshot);
  messages = new Map(catalog.chronological.map(row => [row.id, row]));
  renderCatalog();
  renderDuplicates();
  populateCorrection();
  return renderPlan();
}

function chooseLetter(letter) {
  selected = letter;
  renderCatalog();
}

for (const id of snapshot.correctionIds) {
  get('correction-id').append(new Option('Post #' + id, String(id)));
}
for (const item of snapshot.series) get('correction-series').append(new Option(item.title, item.id));
for (const kind of editionTypes) get('correction-kind').append(new Option(kindLabels[kind], kind));
get('series-count').textContent = count.format(snapshot.series.length);
get('message-count').textContent = count.format(snapshot.messages.length);
for (const button of alphabet) button.addEventListener('click', () => chooseLetter(button.dataset.letter));
get('library-query').addEventListener('input', renderCatalog);
const planError = () => { get('plan-estimates').textContent = 'A prévia não pôde ser calculada neste navegador.'; };
for (const control of ['plan-strategy', 'plan-batch']) get(control).addEventListener('change', () => renderPlan().catch(planError));
get('plan-review').addEventListener('click', () => get('plan-dialog').showModal());
get('correction-id').addEventListener('change', populateCorrection);
get('correction-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = get('correction-id').value;
  snapshot.overrides[id] = {
    seriesId: get('correction-series').value, kind: get('correction-kind').value,
    label: get('correction-label').value.trim(),
    ...Object.fromEntries(['season', 'episode', 'part'].map(name => [name, get('correction-' + name).value === '' ? null : get('correction-' + name).valueAsNumber])),
  };
  await refresh();
  get('correction-feedback').textContent = 'Prévia atualizada para o post #' + id + '.';
});
get('correction-reset').addEventListener('click', async () => {
  delete snapshot.overrides[get('correction-id').value];
  await refresh();
  get('correction-feedback').textContent = 'Correção removida da prévia.';
});
selected = /^[A-Z]$/.test(location.hash.slice(1)) ? location.hash.slice(1) : '';
refresh().catch(planError);
