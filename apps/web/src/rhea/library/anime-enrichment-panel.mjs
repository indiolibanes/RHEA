import { alphabeticDestination, episodeLabel, groupTopicDocuments, proposeAnimePreview } from './anime-enrichment.mjs';
import { aniListIdFromLink, animeFormats, animeProviders, lookupAnime, lookupMessage, providerFallback, retryableLookup } from './anime-lookup.mjs';
import { manualAnimeMetadata } from './manual-anime-metadata.mjs';
import { letterInsertionOptions, letterRebuildTopics, planLetterRebuild } from './letter-rebuild.mjs';
import { letterFor } from './catalog.mjs';
import { rebuildIntakeLimit, rebuildLimit } from './organization-contract.mjs';
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
let rebuildInventory;
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
  get('fetch-link').disabled = false;
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
  clearCapture();
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
  rebuildRead = rebuildSelection = rebuildPosts = rebuildInventory = undefined;
  get('rebuild').hidden = true;
  get('rebuild-insert').hidden = true;
  get('rebuild-adjust').hidden = true;
  get('rebuild-batch').hidden = true;
  get('rebuild-neighbors').hidden = true;
  get('rebuild-neighbors').replaceChildren();
  get('rebuild-review').disabled = false;
  get('rebuild-status').textContent = '';
  get('rebuild-items').replaceChildren();
}

function prepareReconstruction(slots) {
  const old = rebuildPosts.map(post => post.id);
  const { current, target } = rebuildSelection;
  const combined = [];
  let start = 0;
  for (const slot of slots) {
    const before = slot.beforeId === null ? old.length : old.indexOf(slot.beforeId);
    if (before < start) return;
    combined.push(...old.slice(start, before), ...slot.ids);
    start = before;
  }
  combined.push(...old.slice(start));
  publication.prepare({ currentTopicId: current.id, replacementTopicId: target.id, sourceTopicId: source.topicId,
    letter: preview.letter, beforeId: slots.length === 1 ? slots[0].beforeId : null, ids: slots.flatMap(slot => slot.ids),
    ...(slots.length > 1 && { insertions: slots.map(({ beforeId, ids }) => ({ beforeId, ids })) }) }, combined);
  setStep('review');
}

get('rebuild-anchor').addEventListener('change', event => {
  publication.clear();
  const context = get('rebuild-neighbors');
  context.hidden = true;
  if (!rebuildSelection || !rebuildPosts || !event.target.value) return;
  const beforeId = event.target.value === 'end' ? null : Number(event.target.value);
  const oldIds = rebuildPosts.map(post => post.id);
  const before = beforeId === null ? oldIds.length : oldIds.indexOf(beforeId);
  if (before < 0) return;
  const ids = preview.sorted.map(post => post.id);
  const { current } = rebuildSelection;
  const neighbor = (label, post, whenMissing) => {
    const row = node('li', label + ' · ');
    row.append(post ? providerLink((post.heading || post.filename || post.caption || 'Publicação #' + post.id).slice(0, 120),
      'https://t.me/c/' + rebuildSelection.channelId + '/' + current.id + '/' + post.id) : whenMissing);
    return row;
  };
  context.replaceChildren(neighbor('Última publicação anterior', rebuildPosts[before - 1], 'Início do tópico'),
    node('li', 'Obra de Requests · ' + preview.title + ' · ' + ids.length + ' arquivos'),
    neighbor('Primeira publicação seguinte', rebuildPosts[before], 'Fim do tópico'));
  context.hidden = false;
  prepareReconstruction([{ beforeId, ids }]);
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
    if (data.state === 'rate_limited' && Number.isInteger(data.retryAfter) && data.retryAfter > 0) {
      throw Object.assign(new Error('Telegram requested a wait.'), { retryAfter: data.retryAfter });
    }
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
  rebuildInventory = undefined;
  rebuildPosts = undefined;
  publication.clear();
  get('rebuild-insert').hidden = true;
  get('rebuild-neighbors').hidden = true;
  get('rebuild-review').disabled = true;
  get('rebuild-items').replaceChildren();
  get('rebuild-status').textContent = 'Lendo as publicações do tópico atual…';
  try {
    const inventory = await readCurrentLetter(selection, request.signal);
    if (request.signal.aborted) return;
    rebuildInventory = inventory;
    renderRebuildPlan(inventory);
  } catch (error) {
    if (!request.signal.aborted) get('rebuild-status').textContent = error.retryAfter ?
      'O Telegram pediu uma pausa. Aguarde ' + error.retryAfter + ' s antes de repetir a leitura.' :
      'A leitura do tópico atual falhou. Confira o acesso e tente novamente.';
  } finally {
    if (rebuildRead === request) {
      rebuildRead = undefined;
      get('rebuild-review').disabled = false;
    }
  }
});

function relatedIntakeGroups() {
  return groups.filter(item => item.key !== group()?.key && letterFor(item.title) === preview.letter);
}

function renderRebuildPlan({ posts, complete }) {
  publication.clear();
  get('rebuild-insert').hidden = get('rebuild-neighbors').hidden = get('rebuild-adjust').hidden = true;
  get('rebuild-adjust').setAttribute('aria-expanded', 'false');
  const selection = rebuildSelection;
  const otherWorks = get('rebuild-all').checked ? relatedIntakeGroups() : [];
  const intakeWorks = [{ ...group(), title: preview.title, detectedTitle: group().title }, ...otherWorks];
  const count = intakeWorks.reduce((total, item) => total + item.posts.length, 0);
  const plan = planLetterRebuild({ letter: preview.letter, currentPosts: posts, intakeWorks,
    reference: source.reference, complete: complete && source.complete });
  const { checks } = plan;
  const blocker = checks.incomplete ? 'Termine a leitura dos dois tópicos antes de publicar.' :
    posts.length + count > rebuildLimit ? 'O piloto aceita até ' + rebuildLimit + ' publicações por reconstrução.' :
      count > rebuildIntakeLimit ? 'Selecione até ' + rebuildIntakeLimit + ' arquivos de Requests nesta reconstrução.' :
    checks.protectedGroups || posts.some(post => post.protected) ? 'Há publicações protegidas pelo Telegram.' :
    intakeWorks.some(item => item.duplicate || item.missingEpisode || item.albumReview) || preview.countMismatch || preview.editionReview ?
      'Confira a numeração, a edição e os álbuns das obras de Requests.' : '';
  const automatic = plan.insertion.state === 'ready';
  const messages = [
    plan.groups.length + ' blocos identificados, com ' + intakeWorks.length + (intakeWorks.length === 1 ?
      ' obra de Requests.' : ' obras de Requests.'),
    checks.incomplete && 'A leitura é parcial.',
    checks.sameTitle && 'A obra também aparece no tópico atual. Confira a edição e possíveis duplicatas.',
    checks.outOfLetter && 'Há títulos fora da letra escolhida.',
    checks.ambiguousGroups > 0 && checks.ambiguousGroups + ' blocos com episódios ou álbuns a conferir.',
    checks.protectedGroups > 0 && checks.protectedGroups + ' blocos com conteúdo protegido.',
    checks.unassigned > 0 && checks.unassigned + ' arquivos sem obra identificada serão mantidos na ordem atual.',
    checks.otherPosts > 0 && checks.otherPosts + ' capas, notas ou outras publicações serão mantidas na ordem atual.',
    blocker || (automatic ? 'A RHEA calculou a posição pela ordem alfabética.' :
      intakeWorks.length > 1 ? 'Há limites entre obras que precisam de conferência. Revise uma obra por vez.' :
        'Confira a posição apenas neste trecho: o histórico não permite localizar a obra seguinte com segurança.'),
  ];
  get('rebuild-status').textContent = messages.filter(Boolean).join(' ');
  get('rebuild-items').replaceChildren(...plan.groups.map(item => {
    const row = document.createElement('li');
    const details = document.createElement('details');
    const episodes = document.createElement('ol');
    episodes.append(...list(item.posts));
    details.append(node('summary', [
      item.title, item.season === undefined ? '' : 'Temporada ' + item.season,
      item.posts.length ? item.posts.length + (item.posts.length === 1 ? ' arquivo' : ' arquivos') : 'Título da capa',
      item.origin === 'current' ? selection.current.title : source.title,
    ].filter(Boolean).join(' · ')), episodes);
    row.append(details);
    return row;
  }));
  rebuildPosts = [...posts].sort((a, b) => a.id - b.id);
  if (!blocker && intakeWorks.length === 1) {
    const choices = letterInsertionOptions(rebuildPosts, plan.groups);
    const byWork = document.createElement('optgroup');
    byWork.label = 'Obra seguinte';
    const byPost = document.createElement('optgroup');
    byPost.label = 'Publicação seguinte';
    for (const { id, work, label } of choices) {
      (work ? byWork : byPost).append(new Option(work || label + ' · #' + id, String(id)));
    }
    get('rebuild-anchor').replaceChildren(new Option('Escolha a posição no tópico', ''),
      new Option('No fim do tópico', 'end'), ...[byWork, byPost].filter(option => option.children.length));
    get('rebuild-insert').hidden = automatic;
    get('rebuild-adjust').hidden = !automatic;
  }
  if (!blocker && automatic) {
    const positions = get('rebuild-neighbors');
    positions.replaceChildren(...plan.insertion.slots.map(slot => node('li', slot.works.join(', ') +
      (slot.nextTitle ? ' → antes de ' + slot.nextTitle : ' → no fim do tópico'))));
    positions.hidden = false;
    prepareReconstruction(plan.insertion.slots);
  }
}

get('rebuild-adjust').addEventListener('click', () => {
  const options = get('rebuild-insert');
  options.hidden = !options.hidden;
  get('rebuild-adjust').setAttribute('aria-expanded', String(!options.hidden));
});

get('rebuild-all').addEventListener('change', () => {
  if (rebuildInventory) renderRebuildPlan(rebuildInventory);
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
      const relatedCount = relatedIntakeGroups().length;
      get('rebuild-all').checked = true;
      get('rebuild-batch').hidden = relatedCount === 0;
      get('rebuild-batch-label').textContent = 'Incluir as ' + (relatedCount + 1) + ' obras da letra ' + letter + ' em Requests';
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
function clearCapture() {
  captureVersion++;
  const canvas = get('capture-preview');
  canvas.hidden = true;
  canvas.width = canvas.height = 0;
  get('capture-status').textContent = 'A imagem fica neste aparelho para você consultar enquanto preenche os campos.';
}

let captureVersion = 0;
const captureTypes = ['image/png', 'image/jpeg', 'image/webp'];

async function showCapture(file) {
  clearCapture();
  if (!file) return;
  const version = captureVersion;
  const feedback = get('capture-status');
  if (!captureTypes.includes(file.type) || file.size > 8 * 1024 ** 2) {
    feedback.textContent = 'Use uma imagem PNG, JPEG ou WebP de até 8 MiB.';
    return;
  }
  let image;
  try {
    image = await createImageBitmap(file);
    if (version !== captureVersion) return;
    const canvas = get('capture-preview');
    const scale = Math.min(1, 950 / image.width, 1800 / image.height);
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.hidden = false;
    feedback.textContent = 'Consulte a captura abaixo e preencha os campos que você quer usar na prévia.';
  } catch {
    if (version === captureVersion) feedback.textContent = 'Não foi possível abrir essa imagem neste navegador.';
  } finally {
    image?.close();
  }
}

get('capture').addEventListener('change', event => void showCapture(event.currentTarget.files[0]));
const pasteArea = get('paste-area');
pasteArea.addEventListener('input', () => { pasteArea.value = ''; });
pasteArea.addEventListener('paste', event => {
  event.preventDefault();
  const files = [...(event.clipboardData?.files ?? [])];
  const file = files.find(item => captureTypes.includes(item.type)) ?? files[0];
  if (file) {
    get('capture').value = '';
    void showCapture(file);
  } else {
    get('capture-status').textContent = 'Copie uma imagem e cole nesta área.';
  }
});

get('paste-image').addEventListener('click', async () => {
  const version = captureVersion;
  try {
    const items = await navigator.clipboard.read();
    if (version !== captureVersion) return;
    for (const item of items) {
      const type = captureTypes.find(value => item.types.includes(value));
      if (!type) continue;
      const file = await item.getType(type);
      if (version !== captureVersion) return;
      get('capture').value = '';
      await showCapture(file);
      return;
    }
    get('capture-status').textContent = 'Copie uma imagem e cole nesta área.';
  } catch {
    if (version !== captureVersion) return;
    get('capture-status').textContent = 'Toque e segure na área de colagem e selecione Colar, ou use Ctrl+V.';
  }
  pasteArea.focus();
});

get('fetch-link').addEventListener('click', () => {
  const value = get('manual').elements.link.value;
  const id = aniListIdFromLink(value);
  if (!id) {
    get('manual-status').textContent = 'Cole o link da ficha da obra no AniList, no formato anilist.co/anime/ID.';
    return;
  }
  if ((retryAt.get('anilist') ?? 0) > Date.now()) {
    get('manual-status').textContent = 'Aguarde o limite temporário do AniList. O preenchimento manual já está disponível.';
    return;
  }
  get('provider').value = 'anilist';
  get('manual-status').textContent = '';
  void runLookup('anilist', 'https://anilist.co/anime/' + id);
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
  get('capture').value = '';
  clearCapture();
  get('manual-open').setAttribute('aria-expanded', 'false');
  clearChoice();
  show(candidate);
});
select.addEventListener('change', selectGroup);
title.addEventListener('input', clearChoice);
get('provider').addEventListener('change', clearChoice);
get('manual').elements.link.addEventListener('input', clearChoice);

get('form').addEventListener('submit', event => {
  event.preventDefault();
  void runLookup(currentProvider(), title.value);
});

async function runLookup(provider, query) {
  if (!source || !group() || active || (retryAt.get(provider) ?? 0) > Date.now()) return;
  clearChoice();
  const request = new AbortController();
  active = request;
  get('search').disabled = true;
  get('fetch-link').disabled = true;
  status.textContent = 'Consultando o ' + animeProviders[provider] + '…';
  try {
    const result = await lookupAnime(root.dataset.animeMetadataEndpoint, query, request.signal, provider);
    if (request.signal.aborted) return;
    if (result.state !== 'candidates') {
      status.textContent = lookupMessage(result, provider);
      const site = get('provider-search');
      const id = provider === 'anilist' ? aniListIdFromLink(query) : undefined;
      site.href = provider === 'mal' ? 'https://myanimelist.net/anime.php' :
        id ? 'https://anilist.co/anime/' + id : 'https://anilist.co/search/anime';
      site.textContent = id ? 'Abrir a ficha no AniList' : 'Pesquisar no site do ' + animeProviders[provider];
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
      get('fetch-link').disabled = false;
      if (!cooldown) get('search').disabled = false;
    }
  }
}

const reset = () => {
  load(undefined);
  stopCooldown();
};
root.addEventListener('rhea:telegram-hide', reset);
root.addEventListener('rhea:forum-clear', reset);
root.addEventListener('rhea:forum-inventory-change', () => { if (source) reset(); });
let shown = root.dataset.telegramAutoload === 'true';
root.addEventListener('rhea:telegram-show', () => { shown = true; publication.restore(); });
root.addEventListener('rhea:telegram-hide', () => { shown = false; });
window.addEventListener('pagehide', reset);
window.addEventListener('pageshow', event => { if (event.persisted && shown) publication.restore(); });
reset();
if (shown) publication.restore();
