import { episodeLabel, groupTopicDocuments, proposeAnimePreview, sortAnimeEpisodes } from './anime-enrichment.mjs';
import { exampleCandidates, examplePosts, exampleTopics } from './anime-enrichment-demo.mjs';
import { animeFormats, lookupAnime, lookupErrors } from './anime-lookup.mjs';
import { forumEnrichmentSnapshot } from './forum-panel.mjs';

const root = document.querySelector('[data-rhea-telegram-library]');
const get = id => root.querySelector('#enrich-' + id);
const select = get('group');
const title = get('title');
const status = get('status');
let source;
let groups = [];
let active;

const node = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
const list = posts => posts.map(p => node('li', episodeLabel(p) + ' · ' + (p.filename || '#' + p.id)));
const group = () => groups.find(item => item.key === select.value);

function clearChoice() {
  active?.abort();
  active = undefined;
  get('search').disabled = false;
  status.textContent = '';
  get('result').hidden = true;
  for (const id of ['match', 'destination', 'review', 'caption', 'links']) get(id).replaceChildren();
  get('sorted').replaceChildren();
  get('candidates').replaceChildren();
}

function selectGroup() {
  clearChoice();
  const item = group();
  title.value = item?.title.slice(0, 120) ?? '';
  get('order').hidden = !item;
  get('original').replaceChildren(...list(item?.posts ?? []));
  get('sorted').replaceChildren(...list(item ? sortAnimeEpisodes(item.posts) : []));
  if (!source?.demo && item) status.textContent = 'Confira o título que será enviado ao AniList. A consulta envia só esse campo.';
}

function load(input) {
  source = input;
  const result = input ? groupTopicDocuments(input.posts, input.reference) : { groups: [], unassigned: 0 };
  groups = result.groups;
  select.replaceChildren(...groups.map(item => Object.assign(node('option', item.title +
    (item.season !== undefined ? ' · Temporada ' + item.season : ' · Temporada a conferir')), { value: item.key })));
  get('form').hidden = !groups.length;
  get('source').textContent = input ? [
    input.demo ? 'Exemplo fictício' : input.title,
    groups.length + (groups.length === 1 ? ' bloco detectado' : ' blocos detectados'),
    result.unassigned ? result.unassigned + (result.unassigned === 1 ? ' arquivo sem obra' : ' arquivos sem obra') : '',
    input.complete ? '' : 'Inventário parcial',
  ].filter(Boolean).join(' · ') : '';
  selectGroup();
}

function providerLink(text, url) {
  const link = node('a', text);
  return Object.assign(link, { href: url, target: '_blank', rel: 'noopener noreferrer' });
}

function show(candidate) {
  const choice = group();
  const plan = proposeAnimePreview(choice, candidate, source.topics);
  const fmt = animeFormats[candidate.format];
  get('match').textContent = [plan.title, fmt, candidate.year, candidate.studios[0], candidate.genres.join(', ')].filter(Boolean).join(' · ');
  const destination = plan.destination || (plan.letter === '#' ? 'Escolha uma letra ou um tópico' : 'Tópico da letra ' + plan.letter);
  get('destination').textContent = 'Origem · ' + source.title + ' → ' + destination;
  const warnings = [];
  if (plan.topicAmbiguous) warnings.push('Há vários tópicos para essa letra.');
  if (plan.countMismatch) warnings.push('A entrada tem menos episódios que a numeração dos arquivos. Confira a edição.');
  if (plan.editionReview) warnings.push('O formato escolhido precisa de conferência para esta temporada.');
  if (choice.duplicate) warnings.push('Há episódios com a mesma numeração.');
  if (choice.missingEpisode) warnings.push('Há arquivos sem número de episódio.');
  if (choice.albumReview) warnings.push('Confira a associação e a ordem dos álbuns antes de usá-los.');
  if (!source.complete) warnings.push('A prévia cobre só as páginas carregadas.');
  get('review').textContent = warnings.join(' ');
  const caption = plan.caption.find(x => x.value)?.value;
  get('caption').textContent = caption || 'Confirme a edição e a numeração para montar a legenda.';
  get('sorted').replaceChildren(...list(plan.sorted));
  const links = [];
  if (candidate.url) links.push(providerLink('Ver entrada no AniList', candidate.url));
  if (candidate.cover) links.push(providerLink('Abrir capa sugerida', candidate.cover));
  get('links').replaceChildren(...links);
  get('result').hidden = false;
}

function candidateChoices(items) {
  return items.map(candidate => {
    const card = document.createElement('article');
    const description = [animeFormats[candidate.format], candidate.year, candidate.episodes && candidate.episodes + ' episódios',
      ...candidate.studios, ...candidate.genres].filter(Boolean).join(' · ');
    const choose = Object.assign(node('button', 'Usar na prévia'), { type: 'button', className: 'editorial-action' });
    choose.setAttribute('aria-pressed', 'false');
    choose.addEventListener('click', () => {
      for (const button of get('candidates').querySelectorAll('button')) button.setAttribute('aria-pressed', 'false');
      choose.setAttribute('aria-pressed', 'true');
      show(candidate);
    });
    card.append(node('h3', candidate.titles[0]), node('p', description), choose);
    return card;
  });
}

get('demo').addEventListener('click', () => load({
  demo: true, title: 'Entrada', posts: examplePosts, topics: exampleTopics, complete: true,
}));
get('topic').addEventListener('click', () => {
  const input = forumEnrichmentSnapshot();
  load(input);
  if (!input) get('source').textContent = 'Carregue primeiro as publicações de um tópico no inventário acima.';
});
select.addEventListener('change', selectGroup);
title.addEventListener('input', clearChoice);

get('form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!source || !group() || active) return;
  clearChoice();
  const request = new AbortController();
  active = request;
  get('search').disabled = true;
  status.textContent = 'Buscando candidatos…';
  try {
    const result = source.demo ? { state: 'candidates', candidates: exampleCandidates(title.value.trim()) } :
      await lookupAnime(root.dataset.animeMetadataEndpoint, title.value, request.signal);
    if (request.signal.aborted) return;
    if (result.state !== 'candidates') {
      status.textContent = lookupErrors[result.state];
      return;
    }
    get('candidates').replaceChildren(...candidateChoices(result.candidates));
    status.textContent = result.candidates.length ? 'Confirme a obra e a temporada para montar a prévia.' : 'Nenhum candidato encontrado.';
  } catch {
    if (!request.signal.aborted) status.textContent = lookupErrors.unavailable;
  } finally {
    if (active === request) {
      active = undefined;
      get('search').disabled = false;
    }
  }
});

const reset = () => load(undefined);
root.addEventListener('rhea:telegram-hide', reset);
root.addEventListener('rhea:forum-clear', reset);
root.addEventListener('rhea:forum-inventory-change', () => { if (source && !source.demo) reset(); });
window.addEventListener('pagehide', reset);
