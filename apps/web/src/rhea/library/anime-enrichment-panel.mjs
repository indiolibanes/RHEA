import { alphabeticDestination, episodeLabel, groupTopicDocuments, proposeAnimePreview } from './anime-enrichment.mjs';
import { animeFormats, animeProviders, lookupAnime, lookupMessage, providerFallback, retryableLookup } from './anime-lookup.mjs';
import { manualAnimeMetadata } from './manual-anime-metadata.mjs';
import { letterRebuildTopics, planLetterRebuild } from './letter-rebuild.mjs';
import { rebuildLimit } from './organization-contract.mjs';
import { forumEnrichmentSnapshot } from './forum-panel.mjs';
import { organizationPublication } from './organization-panel.mjs';
import { mirrorLimit } from './mirror-contract.mjs';
import { formatSize } from './sizes.mjs';

const root = document.querySelector('[data-rhea-telegram-library]');
const get = id => root.querySelector('#enrich-' + id);
const select = get('group');
const title = get('title');
const status = get('status');
const publication = organizationPublication(get, root.dataset.telegramEndpoint);
let source;
let groups = [];
let active;
let destinationRead;
let preview;
let rebuildRead;
let rebuildSelection;
let rebuildPosts;
let cooldown;
const retryAt = new Map();
const currentProvider = () => get('provider').value;
const searchLabel = () => 'Buscar no ' + animeProviders[currentProvider()];

const node = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
const list = posts => posts.map(p => node('li', episodeLabel(p) + ' · ' + (p.filename || '#' + p.id)));
const group = () => groups.find(item => item.key === select.value);

const stepNames = ['search', 'confirm', 'destinations', 'review'];
const stepState = { done: 'concluída', current: 'etapa atual', todo: 'pendente' };

// The tracker shows position by text and marker, never by color alone.
function setStep(current) {
  const index = stepNames.indexOf(current);
  get('steps').hidden = !groups.length;
  stepNames.forEach((name, position) => {
    const item = get('steps').querySelector('[data-step="' + name + '"]');
    const state = position < index ? 'done' : position === index ? 'current' : 'todo';
    item.dataset.state = state;
    if (state === 'current') item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    let hint = item.querySelector('.library-sr');
    if (!hint) item.append(' ', hint = Object.assign(document.createElement('span'), { className: 'library-sr' }));
    hint.textContent = '(' + stepState[state] + ')';
  });
}

function summarize(work, files, letter, destinations) {
  get('sum-work').textContent = work;
  get('sum-files').textContent = files;
  get('sum-letter').textContent = letter;
  get('sum-destinations').textContent = destinations;
}

function stopCooldown() {
  clearInterval(cooldown);
  cooldown = undefined;
}

// A rate limit disables the search button for the provider's wait time (bounded by the route to 1 hour).
function updateSearchButton() {
  stopCooldown();
  const search = get('search');
  const provider = currentProvider();
  const tick = () => {
    const left = Math.ceil(((retryAt.get(provider) ?? 0) - Date.now()) / 1000);
    if (left <= 0) {
      const waited = retryAt.has(provider);
      retryAt.delete(provider);
      stopCooldown();
      search.disabled = Boolean(active);
      search.textContent = waited ? 'Tentar novamente' : searchLabel();
      return false;
    }
    search.disabled = true;
    search.textContent = 'Tentar novamente em ' + left + ' s';
    return true;
  };
  if (tick()) cooldown = setInterval(tick, 1000);
}

// The provider wait survives edits to the title so the rate limit is honored; reset() ends it.
function clearChoice() {
  publication.clear();
  clearRebuild();
  active?.abort();
  active = undefined;
  destinationRead?.abort();
  destinationRead = undefined;
  preview = undefined;
  updateSearchButton();
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
  get('pilot-note').hidden = true;
  summarize('', '', '', 'Ainda não conferidos');
  setStep('search');
}

function selectGroup() {
  clearChoice();
  get('manual').reset();
  get('manual').hidden = true;
  get('manual-open').setAttribute('aria-expanded', 'false');
  get('manual-status').textContent = '';
  const item = group();
  title.value = item?.title.slice(0, 120) ?? '';
  get('original').replaceChildren(...list(item?.posts ?? []));
  if (item) status.textContent = 'Confira o título da obra. A busca envia apenas esse campo à fonte que você escolher.';
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
  publication.clear();
  clearRebuild();
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
  const providerLabel = candidate.provider === 'manual' ? 'Dados preenchidos manualmente' : animeProviders[candidate.provider ?? 'anilist'];
  get('match').textContent = [plan.title, manual ? 'Título informado, sem metadados do AniList' : providerLabel, fmt,
    candidate.year, candidate.episodes && candidate.episodes + ' episódios',
    candidate.duration && candidate.duration + ' min por episódio', candidate.studios[0],
    candidate.genres.join(', ')].filter(Boolean).join(' · ');
  get('destination').textContent = plan.letter === '#' ?
    'O título precisa começar com uma letra A–Z para sugerir um tópico.' :
    'Origem · ' + source.title + ' · Letra sugerida · ' + plan.letter;
  get('volume').textContent = plan.sizedCount ?
    formatSize(plan.totalBytes, { exact: true }) + ' em ' + plan.sizedCount + ' de ' +
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
  if (candidate.url) links.push(providerLink(candidate.provider === 'mal' ? 'Ver no MyAnimeList' : 'Ver no AniList', candidate.url));
  if (candidate.cover) links.push(providerLink('Abrir capa sugerida', candidate.cover));
  get('links').replaceChildren(...links);
  summarize(plan.title, plan.sorted.length + (plan.sorted.length === 1 ? ' arquivo' : ' arquivos') +
    (plan.sizedCount ? ' · ' + formatSize(plan.totalBytes) : ''), plan.letter === '#' ? 'Indefinida' : plan.letter,
    'Ainda não conferidos');
  setStep('destinations');
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
    if (forum.next === null) {
      if (scope) return { channelId, ...alphabeticDestination(letter, topics) };
      const { current, replacement } = letterRebuildTopics(letter, topics, source.topicId);
      return { channelId, ...current, replacement };
    }
    cursor = forum.next;
  }
  return { state: 'incomplete' };
}

function clearRebuild() {
  rebuildRead?.abort();
  rebuildRead = rebuildSelection = rebuildPosts = undefined;
  get('rebuild').hidden = true;
  get('rebuild-insert').hidden = true;
  get('rebuild-review').disabled = false;
  get('rebuild-status').textContent = '';
  get('rebuild-items').replaceChildren();
}

get('rebuild-anchor').addEventListener('change', event => {
  publication.clear();
  if (!rebuildSelection || !rebuildPosts || !event.target.value) return;
  const beforeId = event.target.value === 'end' ? null : Number(event.target.value);
  const oldIds = rebuildPosts.map(post => post.id);
  const before = beforeId === null ? oldIds.length : oldIds.indexOf(beforeId);
  if (before < 0) return;
  const ids = preview.sorted.map(post => post.id);
  const { current, target } = rebuildSelection;
  publication.prepare({ currentTopicId: current.id, replacementTopicId: target.id, sourceTopicId: source.topicId,
    letter: preview.letter, beforeId, ids }, [...oldIds.slice(0, before), ...ids, ...oldIds.slice(before)]);
  setStep('review');
});

async function readCurrentLetter({ channelId, current }, signal) {
  const posts = new Map();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const response = await fetch(root.dataset.telegramEndpoint + '?op=forumpage', {
      method: 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: current.id, cursor }),
    });
    const data = await response.json();
    const forum = data.forum;
    if (!response.ok || data.state !== 'forum_page' || forum?.channelId !== channelId || forum.topicId !== current.id ||
        !Array.isArray(forum.posts) || forum.posts.some(post => posts.has(post.id)) ||
        (forum.next !== null && (!forum.next || forum.next === cursor))) throw new Error('Letter page could not be verified.');
    for (const post of forum.posts) posts.set(post.id, post);
    if (forum.next === null) return { posts: [...posts.values()], complete: true };
    cursor = forum.next;
  }
  return { posts: [...posts.values()], complete: false };
}

get('rebuild-review').addEventListener('click', async () => {
  if (!rebuildSelection || rebuildRead) return;
  const request = new AbortController();
  const selection = rebuildSelection;
  rebuildRead = request;
  rebuildPosts = undefined;
  publication.clear();
  get('rebuild-insert').hidden = true;
  get('rebuild-review').disabled = true;
  get('rebuild-items').replaceChildren();
  get('rebuild-status').textContent = 'Lendo as publicações do tópico atual…';
  try {
    const { posts, complete } = await readCurrentLetter(selection, request.signal);
    if (request.signal.aborted) return;
    const plan = planLetterRebuild({ letter: preview.letter, currentPosts: posts, intakeGroup: group(),
      intakeTitle: preview.title, reference: source.reference, complete: complete && source.complete });
    const { checks } = plan;
    const blocker = checks.incomplete ? 'Termine a leitura dos dois tópicos antes de publicar.' :
      posts.length + preview.sorted.length > rebuildLimit ? 'O piloto aceita até ' + rebuildLimit + ' publicações por reconstrução.' :
      preview.sorted.length > mirrorLimit ? 'O piloto aceita até ' + mirrorLimit + ' arquivos vindos de Requests.' :
      checks.protectedGroups || posts.some(post => post.protected) ? 'Há publicações protegidas pelo Telegram.' :
      group().duplicate || group().missingEpisode || group().albumReview || preview.countMismatch || preview.editionReview ?
        'Confira a numeração, a edição e os álbuns da obra de Requests.' : '';
    const messages = [
      plan.groups.length + ' blocos identificados, exibidos por título.',
      checks.incomplete && 'A leitura é parcial.',
      checks.sameTitle && 'A obra também aparece no tópico atual. Confira a edição e possíveis duplicatas.',
      checks.outOfLetter && 'Há títulos fora da letra escolhida.',
      checks.ambiguousGroups > 0 && checks.ambiguousGroups + ' blocos com episódios ou álbuns a conferir.',
      checks.protectedGroups > 0 && checks.protectedGroups + ' blocos com conteúdo protegido.',
      checks.unassigned > 0 && checks.unassigned + ' arquivos sem obra identificada serão mantidos na ordem atual.',
      checks.otherPosts > 0 && checks.otherPosts + ' capas, notas ou outras publicações serão mantidas na ordem atual.',
      blocker || 'Escolha o ponto de inserção para revisar a cópia de todas as publicações do tópico atual.',
    ];
    get('rebuild-status').textContent = messages.filter(Boolean).join(' ');
    get('rebuild-items').replaceChildren(...plan.groups.map(item => {
      const row = document.createElement('li');
      const details = document.createElement('details');
      const episodes = document.createElement('ol');
      episodes.append(...list(item.posts));
      details.append(node('summary', [
        item.title, item.season === undefined ? '' : 'Temporada ' + item.season,
        item.posts.length + (item.posts.length === 1 ? ' arquivo' : ' arquivos'),
        item.origin === 'current' ? selection.current.title : source.title,
      ].filter(Boolean).join(' · ')), episodes);
      row.append(details);
      return row;
    }));
    if (!blocker) {
      rebuildPosts = [...posts].sort((a, b) => a.id - b.id);
      get('rebuild-anchor').replaceChildren(new Option('Escolha o ponto de inserção', ''),
        ...rebuildPosts.map(post => new Option('Antes de #' + post.id + ' · ' +
          (post.heading || post.filename || post.caption || post.kind).slice(0, 120), String(post.id))),
        new Option('Depois da última publicação', 'end'));
      get('rebuild-insert').hidden = false;
    }
  } catch {
    if (!request.signal.aborted) get('rebuild-status').textContent = 'A leitura do tópico atual falhou. Confira o acesso e tente novamente.';
  } finally {
    if (rebuildRead === request) {
      rebuildRead = undefined;
      get('rebuild-review').disabled = false;
    }
  }
});

function destinationLine(label, target, letter) {
  const messages = {
    missing: 'Não há tópico Letter ' + letter + ' neste grupo. Crie o tópico e confira novamente.',
    closed: 'O tópico Letter ' + letter + ' está fechado. Reabra-o e confira novamente.',
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
  publication.clear();
  clearRebuild();
  const lookup = scope => checkForum(letter, scope, request.signal).catch(() => ({ state: 'unavailable' }));
  try {
    const local = await lookup(undefined);
    if (request.signal.aborted) return;
    if (local.topic && ['found', 'closed'].includes(local.state) && local.replacement?.state === 'found') {
      rebuildSelection = { channelId: local.channelId, current: local.topic, target: local.replacement.topic };
      get('rebuild-targets').textContent = local.topic.title + ' + ' + source.title + ' → ' + local.replacement.topic.title;
      get('rebuild').hidden = false;
      results.replaceChildren(destinationLine('Destino da reconstrução', { ...local.replacement, channelId: local.channelId }, letter));
      results.hidden = false;
      get('pilot-note').hidden = true;
      get('sum-destinations').textContent = local.replacement.topic.title;
      feedback.textContent = 'Os tópicos da reconstrução foram encontrados. Confira a ordem antes de planejar a cópia.';
      return;
    }
    if (['closed', 'ambiguous'].includes(local.replacement?.state)) {
      feedback.textContent = local.replacement.state === 'closed' ? 'O tópico de reconstrução está fechado.' :
        'Há mais de um tópico de reconstrução com a mesma letra.';
      return;
    }
    const backup = await lookup('backup');
    if (request.signal.aborted) return;
    results.replaceChildren(destinationLine('No mesmo grupo', local, letter), destinationLine('No backup', backup, letter));
    results.hidden = false;
    get('pilot-note').hidden = false;
    const found = Number(local.state === 'found') + Number(backup.state === 'found');
    const word = target => target.state === 'found' ? 'encontrado' : target.state === 'closed' ? 'fechado' :
      target.state === 'ambiguous' ? 'ambíguo' : target.state === 'missing' ? 'ausente' : 'indisponível';
    get('sum-destinations').textContent = 'Mesmo grupo: ' + word(local) + ' · Backup: ' + word(backup);
    feedback.textContent = found === 2 ? '2 de 2 destinos encontrados.' :
      found + ' de 2 destinos encontrados. Veja o que falta abaixo.';
    if (found === 2) {
      const choice = group();
      const blocker = !source.complete ? 'Carregue as páginas anteriores do tópico antes de publicar.' :
        preview.sorted.length > mirrorLimit ? 'O piloto permite até ' + mirrorLimit + ' arquivos por obra.' :
        choice.posts.some(post => post.protected) ? 'O Telegram protege um ou mais arquivos contra cópia.' :
        choice.duplicate || choice.missingEpisode || choice.albumReview || preview.countMismatch || preview.editionReview ?
          'Confira a edição, os episódios e os álbuns antes de publicar.' : '';
      if (blocker) feedback.textContent += ' ' + blocker;
      else {
        publication.prepare({
          sourceTopicId: source.topicId, localTopicId: local.topic.id, backupTopicId: backup.topic.id,
          letter, ids: preview.sorted.map(post => post.id),
        });
        setStep('review');
      }
    }
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
get('manual-open').addEventListener('click', () => {
  const form = get('manual');
  form.hidden = !form.hidden;
  get('manual-open').setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) form.elements.link.focus();
});
get('manual').addEventListener('submit', event => {
  event.preventDefault();
  if (!group() || !title.reportValidity()) return;
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  const candidate = manualAnimeMetadata({ ...fields, title: title.value });
  if (!candidate) {
    get('manual-status').textContent = 'Confira os campos. O link deve apontar para a ficha da obra no AniList.';
    return;
  }
  get('manual-status').textContent = '';
  get('manual').hidden = true;
  get('manual-open').setAttribute('aria-expanded', 'false');
  clearChoice();
  show(candidate);
});
select.addEventListener('change', selectGroup);
title.addEventListener('input', clearChoice);
get('provider').addEventListener('change', clearChoice);

get('form').addEventListener('submit', async event => {
  event.preventDefault();
  const provider = currentProvider();
  if (!source || !group() || active || (retryAt.get(provider) ?? 0) > Date.now()) return;
  clearChoice();
  const request = new AbortController();
  active = request;
  get('search').disabled = true;
  status.textContent = 'Consultando o ' + animeProviders[provider] + '…';
  try {
    const result = await lookupAnime(root.dataset.animeMetadataEndpoint, title.value, request.signal, provider);
    if (request.signal.aborted) return;
    if (result.state !== 'candidates') {
      status.textContent = lookupMessage(result, provider);
      const site = get('provider-search');
      site.href = provider === 'mal' ? 'https://myanimelist.net/anime.php' : 'https://anilist.co/search/anime';
      site.textContent = 'Pesquisar no site do ' + animeProviders[provider];
      site.hidden = !providerFallback.has(result.state);
      if (result.state === 'rate_limited' && result.retryAfter) {
        retryAt.set(provider, Date.now() + result.retryAfter * 1000);
        updateSearchButton();
      }
      else if (retryableLookup.has(result.state)) get('search').textContent = 'Tentar novamente';
      return;
    }
    get('candidates').replaceChildren(...candidateChoices(result.candidates));
    if (result.candidates.length) setStep('confirm');
    status.textContent = result.candidates.length ? 'Escolha o resultado que corresponde à edição dos seus arquivos.' :
      'Nenhuma obra encontrada. Tente um título alternativo ou use o título sem metadados.';
  } catch {
    if (!request.signal.aborted) {
      status.textContent = lookupMessage({ state: 'network' });
      get('search').textContent = 'Tentar novamente';
    }
  } finally {
    if (active === request) {
      active = undefined;
      if (!cooldown) get('search').disabled = false;
    }
  }
});

const reset = () => {
  load(undefined);
  stopCooldown();
};
root.addEventListener('rhea:telegram-hide', reset);
root.addEventListener('rhea:forum-clear', reset);
root.addEventListener('rhea:forum-inventory-change', () => { if (source) reset(); });
window.addEventListener('pagehide', reset);
reset();
