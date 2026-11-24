import { alphabeticDestination, episodeLabel, groupTopicDocuments, proposeAnimePreview } from './anime-enrichment.mjs';
import { animeFormats, lookupAnime, lookupMessage } from './anime-lookup.mjs';
import { forumEnrichmentSnapshot } from './forum-panel.mjs';

const root = document.querySelector('[data-rhea-telegram-library]');
const get = id => root.querySelector('#enrich-' + id);
const select = get('group');
const title = get('title');
const status = get('status');
let source;
let groups = [];
let active;
let destinationRead;
let preview;

const node = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
const list = posts => posts.map(p => node('li', episodeLabel(p) + ' · ' + (p.filename || '#' + p.id)));
const group = () => groups.find(item => item.key === select.value);

function clearChoice() {
  active?.abort();
  active = undefined;
  destinationRead?.abort();
  destinationRead = undefined;
  preview = undefined;
  get('search').disabled = false;
  status.textContent = '';
  get('provider-search').hidden = true;
  get('result').hidden = true;
  for (const id of ['match', 'destination', 'volume', 'review', 'caption', 'links', 'destination-status', 'destinations']) {
    get(id).replaceChildren();
  }
  get('check-destinations').hidden = true;
  get('destinations').hidden = true;
  get('sorted').replaceChildren();
  get('candidates').replaceChildren();
}

function selectGroup() {
  clearChoice();
  const item = group();
  title.value = item?.title.slice(0, 120) ?? '';
  get('original').replaceChildren(...list(item?.posts ?? []));
  if (item) status.textContent = 'Confira o título da obra. A busca envia só esse título ao AniList.';
}

function load(input) {
  source = input;
  const result = input ? groupTopicDocuments(input.posts, input.reference) : { groups: [], unassigned: 0 };
  groups = result.groups;
  select.replaceChildren(...groups.map(item => Object.assign(node('option', item.title +
    (item.season !== undefined ? ' · Temporada ' + item.season : ' · Temporada a conferir')), { value: item.key })));
  get('form').hidden = !groups.length;
  get('source').textContent = input ? [
    input.title,
    groups.length ? groups.length + (groups.length === 1 ? ' obra ou temporada detectada' : ' obras ou temporadas detectadas')
      : 'Nenhuma obra identificada. Confira os nomes dos arquivos ou carregue sua lista Markdown.',
    result.unassigned ? result.unassigned + (result.unassigned === 1 ? ' arquivo sem obra' : ' arquivos sem obra') : '',
    input.complete ? '' : 'Inventário parcial',
  ].filter(Boolean).join(' · ') : 'Escolha um tópico em Arquivos por tópico e toque em Organizar arquivos deste tópico.';
  selectGroup();
}

function providerLink(text, url) {
  const link = node('a', text);
  return Object.assign(link, { href: url, target: '_blank', rel: 'noopener noreferrer' });
}

function show(candidate, manual = false) {
  destinationRead?.abort();
  destinationRead = undefined;
  get('destination-status').textContent = '';
  get('destinations').replaceChildren();
  get('destinations').hidden = true;
  const choice = group();
  const plan = proposeAnimePreview(choice, candidate, source.topics);
  preview = plan;
  const fmt = animeFormats[candidate.format];
  get('provider-search').hidden = true;
  get('match').textContent = [plan.title, manual ? 'Título informado, sem metadados do AniList' : fmt,
    candidate.year, candidate.episodes && candidate.episodes + ' episódios', candidate.studios[0],
    candidate.genres.join(', ')].filter(Boolean).join(' · ');
  get('destination').textContent = plan.letter === '#' ?
    'O título precisa começar com uma letra A–Z para sugerir um tópico.' :
    'Origem · ' + source.title + ' · Letra sugerida · ' + plan.letter;
  get('volume').textContent = plan.sizedCount ?
    new Intl.NumberFormat('pt-BR').format(plan.totalBytes) + ' bytes em ' + plan.sizedCount + ' de ' +
      plan.sorted.length + ' arquivos.' : 'Tamanho dos arquivos pendente de conferência.';
  const warnings = [];
  if (plan.countMismatch) warnings.push('A entrada tem menos episódios que a numeração dos arquivos. Confira a edição.');
  if (!manual && plan.editionReview) warnings.push('Confira se o formato escolhido corresponde a esta temporada.');
  if (choice.duplicate) warnings.push('Há episódios com a mesma numeração.');
  if (choice.missingEpisode) warnings.push('Há arquivos sem número de episódio.');
  if (choice.albumReview) warnings.push('Confira a associação e a ordem dos álbuns antes de usá-los.');
  if (choice.posts.some(post => post.protected)) warnings.push('Há arquivos com proteção de conteúdo.');
  if (!source.complete) warnings.push('A prévia cobre só as páginas carregadas.');
  get('review').textContent = warnings.join(' ');
  const caption = plan.caption.find(x => x.value)?.value;
  get('caption').textContent = caption || 'Confirme a edição e a numeração para montar a legenda.';
  get('sorted').replaceChildren(...list(plan.sorted));
  const links = [];
  if (candidate.url) links.push(providerLink('Ver entrada no AniList', candidate.url));
  if (candidate.cover) links.push(providerLink('Abrir capa sugerida', candidate.cover));
  get('links').replaceChildren(...links);
  get('check-destinations').disabled = false;
  get('check-destinations').hidden = plan.letter === '#';
  get('result').hidden = false;
  get('review-title').focus();
}

async function checkForum(letter, scope, signal) {
  const topics = [];
  const seen = new Set();
  let channelId;
  let cursor = null;
  for (let page = 0; page < 3; page++) {
    const response = await fetch(root.dataset.telegramEndpoint + '?op=forumtopics', {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, ...(scope ? { scope } : {}) }),
    });
    const data = await response.json();
    if (data.state === 'forum_disabled' && scope) return { state: 'unconfigured' };
    if (data.state === 'rate_limited' || data.state === 'busy' || data.state === 'disconnected' ||
        data.state === 'access_required' || data.state === 'not_allowed' || data.state === 'forum_unavailable') {
      return { state: data.state };
    }
    if (scope && data.state === 'invalid_request') return { state: 'adapter_update' };
    if (!response.ok || data.state !== 'forum_topics' || data.forum?.scope !== scope) return { state: 'unavailable' };
    const forum = data.forum;
    if ((!scope && forum.channelId !== source.channelId) || (scope && forum.channelId === source.channelId) ||
        (channelId && channelId !== forum.channelId)) return { state: 'unavailable' };
    channelId = forum.channelId;
    if (forum.topics.some(topic => seen.has(topic.id))) return { state: 'changed' };
    for (const topic of forum.topics) {
      seen.add(topic.id);
      topics.push(topic);
    }
    if (forum.next === null) return { channelId, ...alphabeticDestination(letter, topics, scope ? undefined : source.topicId) };
    cursor = forum.next;
  }
  return { state: 'incomplete' };
}

function destinationLine(label, target, letter) {
  const messages = {
    missing: 'Crie ou reabra o tópico Letter ' + letter + ' e confira novamente.',
    ambiguous: 'Há mais de um tópico ativo com essa letra.',
    source: 'O tópico encontrado é a origem. Use outro tópico.',
    unconfigured: 'O grupo de backup ainda precisa ser autorizado no Railway.',
    adapter_update: 'A consulta ao backup precisa da versão atual da RHEA no Railway e no Private.',
    unavailable: 'Não foi possível conferir o supergrupo.',
    forum_unavailable: 'O Telegram não confirmou o grupo privado. Confira o convite e a participação da conta conectada.',
    busy: 'O leitor está ocupado. Aguarde e confira novamente.',
    rate_limited: 'O Telegram pediu uma pausa. Confira novamente mais tarde.',
    disconnected: 'Conecte o Telegram na seção acima e confira novamente.',
    access_required: 'Sua sessão expirou. Entre no Private novamente.',
    not_allowed: 'O Private não autorizou a leitura. Confira a conta conectada.',
    changed: 'A lista de tópicos mudou durante a consulta. Confira novamente.',
    incomplete: 'A lista excede o limite de conferência.',
  };
  const line = node('li', label + ' · ');
  line.append(target.state === 'found' ?
    providerLink(target.topic.title, 'https://t.me/c/' + target.channelId + '/' + target.topic.id) :
    document.createTextNode(messages[target.state] ?? messages.unavailable));
  return line;
}

get('check-destinations').addEventListener('click', async () => {
  if (!preview || destinationRead) return;
  const request = new AbortController();
  destinationRead = request;
  const button = get('check-destinations');
  const feedback = get('destination-status');
  const results = get('destinations');
  button.disabled = true;
  results.hidden = true;
  feedback.textContent = 'Conferindo tópicos dos dois grupos…';
  const { letter } = preview;
  const lookup = scope => checkForum(letter, scope, request.signal).catch(() => ({ state: 'unavailable' }));
  try {
    const local = await lookup(undefined);
    if (request.signal.aborted) return;
    const backup = await lookup('backup');
    if (request.signal.aborted) return;
    results.replaceChildren(destinationLine('No mesmo grupo', local, letter), destinationLine('No backup', backup, letter));
    results.hidden = false;
    const found = Number(local.state === 'found') + Number(backup.state === 'found');
    feedback.textContent = found === 2 ? '2 de 2 destinos encontrados. Nenhum arquivo foi publicado.' :
      found + ' de 2 destinos encontrados. Veja o que falta abaixo.';
  } finally {
    if (destinationRead === request) {
      destinationRead = undefined;
      button.disabled = false;
    }
  }
});

function candidateChoices(items) {
  return items.map(candidate => {
    const card = document.createElement('article');
    const description = [animeFormats[candidate.format], candidate.year, candidate.episodes && candidate.episodes + ' episódios',
      ...candidate.studios, ...candidate.genres].filter(Boolean).join(' · ');
    const choose = Object.assign(node('button', 'Confirmar obra'), { type: 'button', className: 'editorial-action' });
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

root.querySelector('#forum-organize').addEventListener('click', () => {
  root.querySelector('#anime-enrichment').open = true;
  load(forumEnrichmentSnapshot());
  (groups.length > 1 ? select : group() ? title : get('source')).focus();
});

get('use-title').addEventListener('click', () => {
  if (!group() || !title.value.trim() || !title.reportValidity()) return;
  clearChoice();
  show({ titles: [title.value.trim()], studios: [], genres: [] }, true);
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
    const result = await lookupAnime(root.dataset.animeMetadataEndpoint, title.value, request.signal);
    if (request.signal.aborted) return;
    if (result.state !== 'candidates') {
      status.textContent = lookupMessage(result);
      get('provider-search').hidden = !['provider_refused', 'provider_unavailable', 'rate_limited'].includes(result.state);
      return;
    }
    get('candidates').replaceChildren(...candidateChoices(result.candidates));
    status.textContent = result.candidates.length ? 'Escolha o resultado que corresponde à edição dos seus arquivos.' :
      'Nenhuma obra encontrada. Tente um título alternativo ou use o título sem metadados.';
  } catch {
    if (!request.signal.aborted) status.textContent = lookupMessage({ state: 'network' });
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
root.addEventListener('rhea:forum-inventory-change', () => { if (source) reset(); });
window.addEventListener('pagehide', reset);
reset();
