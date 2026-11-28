import { alphabeticDestination, episodeLabel, groupTopicDocuments, proposeAnimePreview, sortAnimeEpisodes } from './anime-enrichment.mjs';
import { aniListIdFromLink, animeFormats, animeProviders, lookupAnime, lookupMessage, providerFallback, retryableLookup } from './anime-lookup.mjs';
import { animeProviderPreference, onAnimeProviderChange, saveAnimeProvider } from './anime-provider-preference.mjs';
import { formatWait, sharedTelegramPause as pause } from './telegram-wait.mjs';
import { manualAnimeMetadata } from './manual-anime-metadata.mjs';
import { intakeLetterBatches, letterInsertionOptions, letterRebuildTopics, planLetterRebuild } from './letter-rebuild.mjs';
import { letterFor, titleKey } from './catalog.mjs';
import { rebuildIntakeLimit, rebuildLimit } from './organization-contract.mjs';
import { discoveredRebuildPair } from './destination-check.mjs';
import { forumEnrichmentSnapshot, readSourcePage } from './forum-panel.mjs';
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
let letterDiscovery;
let discoveredIndex;
let discoveryRead;

function telegramWait() {
  return pause.remaining();
}

// The per-work destination check stays a manual action; its button only shows the shared Telegram deadline.
function updateDestinationButton() {
  const left = telegramWait();
  const button = get('check-destinations');
  button.disabled = Boolean(destinationRead) || left > 0;
  button.textContent = left ? 'Conferir destinos em ' + formatWait(left) : 'Conferir destinos';
  if (left && !pause.waiting('destination-button')) {
    pause.wait('destination-button', { render: updateDestinationButton, resume() {
      const message = get('destination-status');
      if (message.textContent.startsWith('O Telegram pediu uma pausa.')) {
        message.textContent = 'Pausa encerrada. Confira os destinos quando estiver pronto.';
      }
    } });
  }
}

function recordTelegramWait(data) {
  const result = pause.record(data);
  updateDestinationButton();
  return result;
}

function telegramWaitMessage() {
  return 'O Telegram pediu uma pausa. ' + (telegramWait() ?
    'Aguarde ' + formatWait(telegramWait()) + ' antes de conferir novamente.' : 'O prazo não foi informado; confira novamente mais tarde.');
}

// A paused read shows a live countdown next to its own status, outside the live region: the pause and the
// resumption are announced once, the seconds are not. When the wait ends the read resumes once, by itself.
function waitTimer(status) {
  const next = status.nextElementSibling;
  if (next?.dataset.telegramWait !== undefined) return next;
  const timer = Object.assign(document.createElement('p'), { className: 'library-wait', hidden: true });
  timer.dataset.telegramWait = '';
  timer.setAttribute('role', 'timer');
  status.after(timer);
  return timer;
}

function clearWait(statusId, key) {
  pause.cancel(key);
  const timer = get(statusId).nextElementSibling;
  if (timer?.dataset.telegramWait !== undefined) {
    timer.hidden = true;
    timer.textContent = '';
  }
}

const sentence = text => text[0].toUpperCase() + text.slice(1);
// Live regions are only rewritten when the message changes, so a refreshed preview is not announced again.
const say = (id, text) => { if (get(id).textContent !== text) get(id).textContent = text; };

// Returns false when the Telegram gave no deadline: the caller then offers its own retry action.
function waitAndResume(statusId, key, what, resume) {
  const status = get(statusId);
  const timer = waitTimer(status);
  const scheduled = pause.wait(key, {
    render(left) {
      if (!left) return;
      timer.hidden = false;
      timer.textContent = sentence(what) + ' continua em ' + formatWait(left);
    },
    resume() {
      timer.hidden = true;
      timer.textContent = '';
      status.textContent = 'Pausa encerrada. Retomando ' + what + '…';
      resume();
    },
  });
  status.textContent = scheduled ? 'O Telegram pediu uma pausa. ' + sentence(what) + ' continua sozinha ao fim da espera.' :
    'O Telegram pediu uma pausa sem informar o prazo. Tente de novo em alguns minutos.';
  return scheduled;
}

// The reads of an open letter share one Telegram deadline, so they share one countdown: a single line names
// what is paused, and each task's own status only says that it is waiting.
const rebuildPaused = new Map();
const joinNames = names => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' e ' + names.at(-1);

function renderRebuildWait(left = pause.remaining()) {
  const box = get('rebuild-wait');
  if (!rebuildPaused.size || !left) {
    box.hidden = true;
    get('rebuild-wait-timer').textContent = '';
    return;
  }
  box.hidden = false;
  say('rebuild-wait-status', 'O Telegram pediu uma pausa. A RHEA retoma sozinha ao fim da espera: ' +
    joinNames([...rebuildPaused.values()]) + '.');
  get('rebuild-wait-timer').textContent = 'Retomada automática em ' + formatWait(left);
}

function pauseRebuildTask(statusId, key, name, what, resume) {
  const status = get(statusId);
  rebuildPaused.set(key, name);
  const scheduled = pause.wait(key, {
    render: renderRebuildWait,
    resume() {
      rebuildPaused.delete(key);
      renderRebuildWait();
      status.textContent = 'Retomando ' + what + '…';
      resume();
    },
  });
  if (!scheduled) {
    rebuildPaused.delete(key);
    status.textContent = 'O Telegram pediu uma pausa sem informar o prazo. Tente de novo em alguns minutos.';
  } else {
    status.textContent = sentence(what) + ' está em pausa.';
  }
  renderRebuildWait();
  return scheduled;
}

function clearRebuildWait(key) {
  pause.cancel(key);
  rebuildPaused.delete(key);
  renderRebuildWait();
}

// Telegram reads of the letter flow run one at a time: the same RPC is never in flight twice.
let telegramLane = Promise.resolve();
function inLane(task) {
  const run = telegramLane.then(task, task);
  telegramLane = run.catch(() => undefined);
  return run;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pause.refresh();
});
let preview;
let rebuildRead;
let rebuildSelection;
let rebuildPosts;
let rebuildInventory;
let rebuildLookup;
let rebuildLookupTimer;
const letterMetadata = new Map();
let cooldown;
const retryAt = new Map();
const currentProvider = () => animeProviderPreference();
const searchLabel = () => 'Buscar no ' + animeProviders[currentProvider()];

const node = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
const list = posts => posts.map(p => node('li', episodeLabel(p) + ' · ' + (p.filename || '#' + p.id)));
const group = () => groups.find(item => item.key === select.value);
const rebuildOptions = get('rebuild-options');

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
  updateDestinationButton();
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

function load(input, reuseIndex) {
  letterDiscovery?.abort();
  letterDiscovery = undefined;
  clearWait('letter-status', 'letters');
  discoveryRead = discoveredIndex = undefined;
  source = input;
  const result = input ? groupTopicDocuments(input.posts, input.reference) : { groups: [], unassigned: 0 };
  groups = result.groups;
  get('letter-plans').hidden = true;
  get('letter-options').replaceChildren();
  select.replaceChildren(...groups.map(item => Object.assign(node('option', item.title +
    (item.season !== undefined ? ' · Temporada ' + item.season : ' · Temporada a conferir')), { value: item.key })));
  get('form').hidden = !groups.length;
  get('load-more').hidden = !input || input.complete;
  describeSource(input, result);
  selectGroup();
  if (input) void discoverLetters(false, reuseIndex);
}

function describeSource(input, result) {
  get('source').textContent = input ? [
    input.title,
    groups.length ? groups.length + (groups.length === 1 ? ' obra ou temporada detectada' : ' obras ou temporadas detectadas')
      : 'Nenhuma obra identificada. Confira os nomes dos arquivos ou carregue sua lista Markdown.',
    result.unassigned ? result.unassigned + (result.unassigned === 1 ? ' arquivo sem obra' : ' arquivos sem obra') : '',
    input.complete ? '' : 'Inventário parcial',
  ].filter(Boolean).join(' · ') : 'Escolha um tópico em Arquivos por tópico e toque em Organizar arquivos deste tópico.';
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
  updateDestinationButton();
  get('check-destinations').hidden = plan.letter === '#';
  get('result').hidden = false;
  get('review-title').focus();
}

async function readForumTopics(scope, signal, existing) {
  if (existing?.topicsCursor === null) return { channelId: existing.channelId, topics: existing.topics };
  if (telegramWait()) return { state: 'rate_limited', retryAfter: telegramWait() };
  const topics = [...(existing?.topics ?? [])];
  const seen = new Set(topics.map(topic => topic.id));
  let channelId = existing?.channelId;
  let cursor = existing?.topicsCursor ?? null;
  for (let page = 0; page < 12; page++) {
    const response = await fetch(root.dataset.telegramEndpoint + '?op=forumtopics', {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, ...(scope ? { scope } : {}) }),
    });
    const data = await response.json();
    if (data.state === 'forum_disabled' && scope) return { state: 'unconfigured' };
    if (data.state === 'rate_limited') return recordTelegramWait(data);
    if (data.state === 'busy' || data.state === 'disconnected' ||
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
    if (forum.next === null) return { channelId, topics };
    if (!forum.next || forum.next === cursor) return { state: 'changed' };
    cursor = forum.next;
  }
  return { state: 'incomplete' };
}

async function checkForum(letter, scope, signal) {
  // A complete, already read list can establish the current/[NEW] pair without another Telegram RPC.
  // Only use a positive pair for the read-only preview; negative results need a fresh check.
  if (!scope) {
    const cached = discoveryRead ? await discoveryRead.catch(() => undefined) : discoveredIndex;
    if (signal.aborted) return { state: 'unavailable' };
    const pair = discoveredRebuildPair(letter, cached, source);
    if (pair) return pair;
    if (cached?.state === 'rate_limited' && telegramWait()) return cached;
  }
  const index = await readForumTopics(scope, signal);
  if (signal.aborted) return { state: 'unavailable' };
  if (!index.topics) return index;
  if (scope) return { channelId: index.channelId, ...alphabeticDestination(letter, index.topics) };
  discoveredIndex = index;
  const { current, replacement } = letterRebuildTopics(letter, index.topics, source.topicId);
  return { channelId: index.channelId, ...current, replacement };
}

async function discoverLetters(refresh = false, reuseIndex) {
  const intake = source;
  const batches = intakeLetterBatches(groups);
  const section = get('letter-plans');
  const options = get('letter-options');
  const status = get('letter-status');
  const retry = get('refresh-letters');
  section.hidden = !batches.length;
  if (!intake || !batches.length) return;
  letterDiscovery?.abort();
  clearWait('letter-status', 'letters');
  discoveredIndex = undefined;
  const request = new AbortController();
  letterDiscovery = request;
  const keep = reuseIndex?.topics && reuseIndex.channelId === intake.channelId;
  if (!keep) options.replaceChildren();
  retry.disabled = true;
  if (!keep) status.textContent = 'Identificando os tópicos das letras encontradas em ' + intake.title + '…';
  try {
    // A complete index read for the same forum is reused when only the Requests pages changed.
    const pending = keep ? Promise.resolve(reuseIndex) :
      inLane(() => request.signal.aborted ? { state: 'unavailable' } :
        readForumTopics(undefined, request.signal, refresh ? undefined : intake));
    discoveryRead = pending;
    const index = await pending;
    if (request.signal.aborted) return;
    if (index.topics) discoveredIndex = index;
    if (!index.topics) {
      if (index.state === 'rate_limited') {
        waitAndResume('letter-status', 'letters', 'a leitura dos tópicos das letras', () => {
          if (source === intake) void discoverLetters(refresh);
        });
      } else status.textContent = 'Não foi possível conferir os tópicos. Tente atualizar.';
      return;
    }
    const cards = batches.map(({ letter, series, files }) => {
      const { current, replacement } = letterRebuildTopics(letter, index.topics, intake.topicId);
      const row = node('li');
      const currentLabel = current.topic?.title ? 'Tópico atual: ' + current.topic.title :
        current.state === 'missing' ? 'Sem tópico atual' : 'Confira qual é o tópico atual';
      const targetLabel = replacement.state === 'found' ? 'Destino: ' + replacement.topic.title :
        replacement.state === 'missing' ? 'Destino [NEW] ausente' :
          replacement.state === 'closed' ? 'Destino [NEW] fechado' : 'Confira qual é o destino [NEW]';
      const button = node('button', 'Revisar letra ' + letter);
      button.type = 'button';
      button.className = 'editorial-action';
      button.disabled = !['found', 'closed', 'missing'].includes(current.state);
      button.addEventListener('click', () => {
        publication.clear();
        clearRebuild();
        startRebuild({ channelId: index.channelId, ...current, replacement }, letter);
        get('rebuild-title').focus();
      });
      if (rebuildSelection?.letter === letter) button.setAttribute('aria-current', 'true');
      row.append(node('strong', 'Letra ' + letter + ' · ' + series + (series === 1 ? ' série' : ' séries')),
        node('span', files + (files === 1 ? ' arquivo em ' : ' arquivos em ') + intake.title),
        node('span', currentLabel), node('span', targetLabel), button);
      return row;
    });
    options.replaceChildren(...cards);
    status.textContent = (batches.length === 1 ? '1 letra detectada.' : batches.length + ' letras detectadas.') +
      (intake.complete ? '' : ' A lista cobre as páginas lidas de ' + intake.title + '; ao revisar uma letra, a RHEA lê o restante.');
  } catch {
    if (!request.signal.aborted) status.textContent = 'Não foi possível conferir os tópicos. Tente atualizar.';
  } finally {
    if (letterDiscovery === request) {
      letterDiscovery = discoveryRead = undefined;
      retry.disabled = false;
    }
  }
}

get('refresh-letters').addEventListener('click', () => {
  if (rebuildSelection) {
    publication.clear();
    clearRebuild();
  }
  void discoverLetters(true);
});

function clearPosition() {
  get('position').hidden = true;
  get('rebuild-insert').hidden = true;
  get('rebuild-adjust').hidden = true;
  get('rebuild-adjust').setAttribute('aria-expanded', 'false');
  get('position-badge').textContent = get('position-reasons').textContent = '';
  get('rebuild-neighbors').replaceChildren();
  get('rebuild-summary').hidden = get('rebuild-limits').hidden = true;
  get('rebuild-summary').replaceChildren();
}

function clearRebuild() {
  rebuildRead?.abort();
  rebuildLookup?.controller.abort();
  clearTimeout(rebuildLookupTimer);
  requestsRead?.abort();
  backupRead?.abort();
  rebuildLookup = requestsRead = undefined;
  for (const key of ['letter-read', 'backup', 'requests']) clearRebuildWait(key);
  rebuildRead = rebuildSelection = rebuildPosts = rebuildInventory = undefined;
  get('rebuild').hidden = true;
  get('backup').hidden = true;
  clearPosition();
  rebuildOptions.replaceChildren();
  for (const id of ['current-inventory', 'rebuild-lookup', 'rebuild-requests', 'rebuild-status']) get(id).textContent = '';
  get('rebuild-lookup-actions').replaceChildren();
  get('rebuild-review').hidden = true;
  get('rebuild-items').replaceChildren();
}

function prepareReconstruction(slots) {
  const old = rebuildPosts.map(post => post.id);
  const { current, target, letter } = rebuildSelection;
  if (!current || !target) return;
  const combined = [];
  let start = 0;
  for (const slot of slots) {
    const before = slot.beforeId === null ? old.length : old.indexOf(slot.beforeId);
    if (before < start) return;
    combined.push(...old.slice(start, before), ...slot.ids);
    start = before;
  }
  combined.push(...old.slice(start));
  const backup = rebuildSelection.includeBackup && rebuildSelection.backup?.state === 'found' ? rebuildSelection.backup.topic : undefined;
  publication.prepare({ currentTopicId: current.id, replacementTopicId: target.id, sourceTopicId: source.topicId,
    ...(backup && { backupTopicId: backup.id }), letter, beforeId: slots.length === 1 ? slots[0].beforeId : null, ids: slots.flatMap(slot => slot.ids),
    ...(slots.length > 1 && { insertions: slots.map(({ beforeId, ids }) => ({ beforeId, ids })) }) }, combined);
  setStep('review');
}

// Notes that explain an automatic position. None of them asks for a confirmation.
const positionReasons = {
  no_selection: 'Marque as séries de Requests que deseja acrescentar.',
  incomplete: 'A posição aparece quando a leitura dos dois tópicos terminar.',
  out_of_letter: 'Há títulos de outra letra no tópico atual; eles ficam onde estão.',
  album: 'A posição foi ajustada para não dividir um álbum.',
  disorder: 'A ordem atual da letra não está toda alfabética; a RHEA usou a posição de menor desvio.',
  untrusted_header: 'A obra seguinte foi identificada por uma capa sem confirmação ("Series: …").',
  overlap: 'Dois blocos vizinhos se sobrepõem no histórico.',
};

// Before / enters here / after, with Telegram links when the neighbours are single publications.
function positionRows(slots) {
  const channel = rebuildSelection.channelId;
  const current = rebuildSelection.current;
  const label = post => (post.heading || post.filename || post.caption || 'Publicação #' + post.id).slice(0, 120);
  const link = (text, post) => post ? providerLink(label(post), 'https://t.me/c/' + channel + '/' + current.id + '/' + post.id) : text;
  const row = (heading, ...content) => {
    const item = document.createElement('li');
    item.append(Object.assign(document.createElement('strong'), { textContent: heading }), ' ', ...content);
    return item;
  };
  if (slots.length === 1) {
    const [slot] = slots;
    const before = slot.beforeId === null ? rebuildPosts.length : rebuildPosts.findIndex(post => post.id === slot.beforeId);
    return [row('Antes', slot.previousTitle ? slot.previousTitle + ' · ' : '', link('Início do tópico', rebuildPosts[before - 1])),
      row('Entra aqui', slot.works.join(', ') + ' · ' + slot.ids.length + (slot.ids.length === 1 ? ' arquivo' : ' arquivos')),
      row('Depois', slot.nextTitle ? slot.nextTitle + ' · ' : '', link('Fim do tópico', rebuildPosts[before]))];
  }
  return slots.map(slot => row(slot.works.join(', '), '→ ' + (slot.previousTitle ? 'depois de ' + slot.previousTitle : 'no início') +
    (slot.nextTitle ? ', antes de ' + slot.nextTitle : ', no fim do tópico')));
}

function showPosition(slots, mode, reasons = [], uncovered = 0, duplicates = []) {
  get('position').hidden = false;
  const many = (slots?.length ?? 0) > 1 || selectedWorks().length > 1;
  get('position-badge').textContent = {
    ready: (many ? 'Posições automáticas' : 'Posição automática') + ' · ordem alfabética',
    manual: 'Posição escolhida por você',
    review: 'Posição a definir',
  }[mode];
  get('position-badge').dataset.mode = mode;
  get('rebuild-neighbors').replaceChildren(...(slots?.length ? positionRows(slots) : []));
  get('rebuild-neighbors').toggleAttribute('data-many', (slots?.length ?? 0) > 1);
  const notes = reasons.map(code => code === 'uncovered' ? uncovered + (uncovered === 1 ? ' arquivo entre as obras vizinhas' :
    ' arquivos entre as obras vizinhas') + ' não foi associado a nenhuma obra e fica antes da nova obra.' :
    code === 'same_title' ? duplicates.join(', ') + (duplicates.length === 1 ? ' já está' : ' já estão') +
      ' na letra atual, na mesma temporada. Desmarque a série ou confira a edição.' : positionReasons[code]).filter(Boolean);
  get('position-reasons').textContent = notes.join(' ');
  const single = selectedWorks().length === 1;
  const placeable = !reasons.some(code => ['incomplete', 'no_selection', 'same_title'].includes(code));
  get('rebuild-adjust').hidden = !single || mode === 'review';
  get('rebuild-insert').hidden = !(single && mode === 'review' && placeable);
}

get('rebuild-anchor').addEventListener('change', event => {
  publication.clear();
  if (!rebuildSelection || !rebuildPosts || !event.target.value) return;
  const beforeId = event.target.value === 'end' ? null : Number(event.target.value);
  const before = beforeId === null ? rebuildPosts.length : rebuildPosts.findIndex(post => post.id === beforeId);
  if (before < 0) return;
  const [work] = selectedWorks();
  if (!work) return;
  const ids = sortAnimeEpisodes(work.posts).map(post => post.id);
  rebuildSelection.manualPosition = { beforeId, ids: ids.join(',') };
  const slot = { beforeId, works: [work.title], ids, previousTitle: undefined, nextTitle: undefined };
  showPosition([slot], 'manual');
  prepareReconstruction([{ beforeId, ids }]);
});

// Reads the current letter page by page. The verified pages and the cursor stay in the selection, so a read
// paused by the Telegram continues from the last valid point instead of starting over.
async function readCurrentLetter(selection, signal, onPage) {
  const { channelId, current } = selection;
  const read = selection.letterRead ??= { posts: new Map(), cursor: null, pages: 0, complete: false };
  if (telegramWait()) return { state: 'rate_limited', retryAfter: telegramWait() };
  while (read.pages < 20) {
    const response = await fetch(root.dataset.telegramEndpoint + '?op=forumpage', {
      method: 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: current.id, cursor: read.cursor }),
    });
    const data = await response.json().catch(() => ({}));
    if (data.state === 'rate_limited') return recordTelegramWait(data);
    if (['busy', 'disconnected', 'access_required', 'not_allowed'].includes(data.state)) return { state: data.state };
    const forum = data.forum;
    if (!response.ok || data.state !== 'forum_page' || forum?.channelId !== channelId || forum.topicId !== current.id ||
        !Array.isArray(forum.posts) || forum.posts.some(post => read.posts.has(post.id)) ||
        (forum.next !== null && (!forum.next || forum.next === read.cursor))) {
      return { state: read.cursor !== null ? 'stale' : 'unverified' };
    }
    for (const post of forum.posts) read.posts.set(post.id, post);
    read.pages++;
    if (forum.next === null) {
      read.complete = true;
      read.cursor = null;
      return { posts: [...read.posts.values()], complete: true };
    }
    read.cursor = forum.next;
    onPage?.({ posts: [...read.posts.values()], complete: false });
  }
  return { posts: [...read.posts.values()], complete: false };
}

const letterReadErrors = {
  busy: 'O leitor do Telegram está ocupado com outra leitura.',
  disconnected: 'Conecte o Telegram na seção acima.',
  access_required: 'Sua sessão expirou. Entre no Private novamente.',
  not_allowed: 'O Private não autorizou a leitura. Confira a conta conectada.',
};

async function loadCurrentLetter({ restarted = false } = {}) {
  const selection = rebuildSelection;
  if (!selection || rebuildRead) return;
  clearRebuildWait('letter-read');
  get('rebuild-review').hidden = true;
  const feedback = get('current-inventory');
  if (!selection.current) {
    feedback.textContent = 'Esta letra ainda não tem tópico atual. A prévia mostra apenas a seleção de Requests.';
    rebuildInventory = { posts: [], complete: true };
    renderRebuildPlan(rebuildInventory);
    return;
  }
  const label = selection.current.title;
  const request = new AbortController();
  rebuildRead = request;
  const read = selection.letterRead?.posts.size ?? 0;
  feedback.textContent = read ? 'Continuando a leitura de ' + label + ' · ' + read + ' publicações lidas…' : 'Lendo ' + label + '…';
  let result;
  try {
    result = await inLane(() => request.signal.aborted ? { state: 'aborted' } :
      readCurrentLetter(selection, request.signal, partial => {
        if (request.signal.aborted || rebuildSelection !== selection) return;
        feedback.textContent = label + ' · ' + partial.posts.length + ' publicações lidas · leitura em andamento.';
        rebuildInventory = partial;
        renderRebuildPlan(partial);
      }));
  } catch {
    result = { state: 'network' };
  } finally {
    if (rebuildRead === request) rebuildRead = undefined;
  }
  if (request.signal.aborted || rebuildSelection !== selection) return;
  if (result.posts) {
    rebuildInventory = { posts: result.posts, complete: result.complete };
    feedback.textContent = label + ' · ' + result.posts.length + ' publicações lidas' + (result.complete ? '.' :
      ' · leitura parcial: o tópico passa do limite de páginas desta revisão.');
    renderRebuildPlan(rebuildInventory);
    return;
  }
  if (result.state === 'rate_limited') {
    if (!pauseRebuildTask('current-inventory', 'letter-read', label, 'a leitura de ' + label, () => {
      if (rebuildSelection === selection) void loadCurrentLetter();
    })) get('rebuild-review').hidden = false;
    return;
  }
  if (result.state === 'stale' && !restarted) {
    // The adapter no longer accepts the saved cursor: read again from the start, once.
    selection.letterRead = undefined;
    feedback.textContent = 'O ponto de leitura de ' + label + ' deixou de valer. Relendo o tópico desde o início…';
    void loadCurrentLetter({ restarted: true });
    return;
  }
  feedback.textContent = (letterReadErrors[result.state] ?? 'A leitura de ' + label + ' falhou.') +
    ' Toque em Tentar leitura novamente.';
  get('rebuild-review').hidden = false;
}

get('rebuild-review').addEventListener('click', () => {
  if (rebuildSelection && !telegramWait()) void loadCurrentLetter();
});

// Requests is read to the end while a letter is under review, so the preview can become complete by itself.
let requestsRead;
const requestsPageLimit = 60;
async function continueRequests() {
  const context = rebuildSelection;
  const status = get('rebuild-requests');
  if (!context || !source || requestsRead || pause.waiting('requests')) return;
  if (source.complete) {
    status.textContent = context.requestsPages ? source.title + ' lido por completo · ' + source.posts.length + ' publicações.' : '';
    return;
  }
  if (context.requestsPages >= requestsPageLimit) {
    status.textContent = 'A RHEA leu ' + requestsPageLimit + ' páginas de ' + source.title +
      ' nesta revisão. Use Ler páginas anteriores do tópico para continuar.';
    get('load-more').hidden = false;
    return;
  }
  const request = new AbortController();
  requestsRead = request;
  status.textContent = 'Lendo páginas anteriores de ' + source.title + ' · ' + source.posts.length + ' publicações lidas…';
  let result;
  try {
    result = await inLane(() => request.signal.aborted ? { state: 'aborted' } : readSourcePage(source.topicId, source.channelId));
  } catch {
    result = { state: 'unavailable' };
  } finally {
    if (requestsRead === request) requestsRead = undefined;
  }
  if (request.signal.aborted || rebuildSelection !== context) return;
  if (result.state === 'ok') {
    context.requestsPages++;
    void continueRequests();
    return;
  }
  if (result.state === 'rate_limited') {
    pause.record(result);
    if (pauseRebuildTask('rebuild-requests', 'requests', source.title, 'a leitura de ' + source.title, () => {
      if (rebuildSelection === context) void continueRequests();
    })) return;
  } else {
    status.textContent = 'Não foi possível ler as páginas anteriores de ' + source.title + '.';
  }
  status.textContent += ' Use Ler páginas anteriores do tópico para tentar de novo.';
  get('load-more').hidden = false;
}

function selectedWorks() {
  return [...rebuildOptions.querySelectorAll('input[type="checkbox"]:checked')]
    .flatMap(input => rebuildSelection.choices.get(input.value));
}

function updateRebuildCount() {
  const works = selectedWorks();
  const count = rebuildOptions.querySelectorAll('input[type="checkbox"]:checked').length;
  const files = works.reduce((total, work) => total + work.posts.length, 0);
  get('rebuild-count').textContent = count ? count + (count === 1 ? ' série' : ' séries') + ' · ' +
    files + (files === 1 ? ' arquivo' : ' arquivos') : 'Marque ao menos uma série para ver a prévia.';
  return works;
}

// The backup group's Letter topic is a second, independently verified destination of the reconstruction.
let backupRead;
async function loadBackup(context) {
  backupRead?.abort();
  const request = new AbortController();
  backupRead = request;
  clearRebuildWait('backup');
  context.backup = { state: 'checking' };
  showBackup(context);
  const result = await inLane(() => request.signal.aborted ? { state: 'unavailable' } :
    checkForum(context.letter, 'backup', request.signal)).catch(() => ({ state: 'unavailable' }));
  if (request.signal.aborted || rebuildSelection !== context) return;
  context.backup = result;
  showBackup(context);
  if (result.state === 'rate_limited' && context.includeBackup) {
    pauseRebuildTask('backup-status', 'backup', 'backup', 'a conferência do backup', () => {
      if (rebuildSelection === context) void loadBackup(context);
    });
    showBackup(context, true);
  }
  if (rebuildInventory) renderRebuildPlan(rebuildInventory);
}

function backupBlocker(context) {
  if (!context.includeBackup) return '';
  const state = context.backup?.state;
  if (!state || state === 'checking') return 'Conferindo o tópico Letter ' + context.letter + ' no grupo de backup…';
  if (state === 'rate_limited' && pause.waiting('backup')) return 'A conferência do backup continua ao fim da pausa do Telegram.';
  return state === 'found' ? '' : 'Backup: ' + destinationMessage(state, context.letter) + ' Ou desmarque a cópia no backup.';
}

function showBackup(context, keepStatus = false) {
  const state = context.backup?.state;
  const box = get('backup');
  const input = get('backup-include');
  const status = get('backup-status');
  box.hidden = false;
  input.checked = context.includeBackup;
  if (!keepStatus) {
    status.textContent = !context.includeBackup ? 'A cópia no backup foi desmarcada. O plano inclui apenas o grupo titular.' :
      !state || state === 'checking' ? 'Conferindo o tópico Letter ' + context.letter + ' no grupo de backup…' :
      state === 'found' ? 'Backup encontrado: ' + context.backup.topic.title + '. Ele será validado de novo, sem escrever, na revisão e antes de cada cópia.' :
      state === 'rate_limited' && pause.waiting('backup') ? 'A conferência do backup está em pausa.' :
      destinationMessage(state, context.letter);
  }
  get('backup-retry').hidden = !(context.includeBackup && !pause.waiting('backup') &&
    !['found', 'checking'].includes(state ?? 'checking'));
}

get('backup-include').addEventListener('change', event => {
  if (!rebuildSelection) return;
  const context = rebuildSelection;
  context.includeBackup = event.target.checked;
  if (!context.includeBackup) clearRebuildWait('backup');
  else if (context.backup?.state === 'rate_limited') void loadBackup(context);
  showBackup(context);
  if (rebuildInventory) renderRebuildPlan(rebuildInventory);
});
get('backup-retry').addEventListener('click', () => {
  if (rebuildSelection && !telegramWait()) void loadBackup(rebuildSelection);
});

function rebuildChoices(letter, confirmed) {
  const choices = new Map();
  for (const group of groups) {
    const item = group.key === confirmed?.group.key ?
      { ...group, title: confirmed.preview.title, detectedTitle: group.title,
        countMismatch: confirmed.preview.countMismatch, editionReview: confirmed.preview.editionReview } : group;
    if (letterFor(item.title) !== letter) continue;
    const id = titleKey(item.title, { foldDiacritics: false });
    if (!choices.has(id)) choices.set(id, []);
    choices.get(id).push(item);
  }
  return choices;
}

// Keep the existing controls in place when a Requests page adds files to a series.
function renderRebuildOptions(context) {
  for (const row of [...rebuildOptions.children]) {
    if (!context.choices.has(row.dataset.series)) row.remove();
  }
  for (const [id, works] of context.choices) {
    const files = works.reduce((total, work) => total + work.posts.length, 0);
    const labelText = works[0].title + ' · ' + files + (files === 1 ? ' arquivo' : ' arquivos');
    const existing = rebuildOptions.querySelector('[data-series="' + CSS.escape(id) + '"]');
    if (existing) {
      const label = existing.querySelector('label span');
      if (label.textContent !== labelText) label.textContent = labelText;
      continue;
    }
    const row = Object.assign(document.createElement('div'), { className: 'library-series' });
    row.dataset.series = id;
    const label = node('label');
    label.append(Object.assign(node('input'), { type: 'checkbox', value: id, checked: true }), node('span', labelText));
    const meta = Object.assign(document.createElement('div'), { className: 'library-series-meta' });
    row.append(label, meta);
    rebuildOptions.append(row);
    renderSeriesMeta(id);
  }
}

function startRebuild(local, letter, confirmed) {
  seriesMetadata.clear();
  const choices = rebuildChoices(letter, confirmed);
  const current = local.topic;
  const target = local.replacement.state === 'found' ? local.replacement.topic : undefined;
  rebuildSelection = { local, confirmed, channelId: local.channelId, current, target, letter, choices,
    automaticLookup: !confirmed, includeBackup: true, requestsPages: 0 };
  get('backup-include').checked = true;
  get('rebuild-targets').textContent = [current?.title, source.title].filter(Boolean).join(' + ') + ' → ' +
    (target?.title ?? 'Letter ' + letter + ' [NEW]');
  get('rebuild-legend').textContent = 'Séries da letra ' + letter + ' em ' + source.title;
  renderRebuildOptions(rebuildSelection);
  get('rebuild').hidden = false;
  updateRebuildCount();
  // Read-only probes start by themselves, one at a time: the letter, the rest of Requests, then the backup.
  void loadCurrentLetter();
  void continueRequests();
  void loadBackup(rebuildSelection);
  void lookupSelectedSeries();
}

// New Requests pages arrived while a letter is open: keep the letter read, the backup result, the choices
// and the confirmed metadata, and only add what is new.
function refreshRebuildSource(snapshot, result) {
  const context = rebuildSelection;
  source = snapshot;
  groups = result.groups;
  context.choices = rebuildChoices(context.letter, context.confirmed);
  renderRebuildOptions(context);
  updateRebuildCount();
  if (rebuildInventory) renderRebuildPlan(rebuildInventory);
  void lookupSelectedSeries();
}

// Metadata per series. A ficha confirmed by the operator, filled by hand or identified safely is kept with its
// source when the provider changes; pending series are looked up again with the chosen provider.
const seriesMetadata = new Map();
const settled = entry => entry && (entry.state === 'applied' || entry.by === 'user');

function fichaText(candidate) {
  return [candidate.titles?.[0], animeFormats[candidate.format], candidate.year,
    candidate.episodes && candidate.episodes + ' episódios', candidate.studios?.[0]].filter(Boolean).join(' · ');
}

function provenance(entry) {
  const name = entry.candidate.provider === 'manual' ? 'Preenchida à mão' : 'Ficha do ' + animeProviders[entry.provider];
  return name + (entry.by === 'user' ? ' · confirmada por você' : entry.by === 'auto' ? ' · identificada pelo título' : '');
}

function manualSeriesForm(id, title) {
  const details = Object.assign(document.createElement('details'), { className: 'library-series-manual' });
  details.append(node('summary', 'Preencher à mão'));
  const fields = document.createElement('div');
  fields.className = 'library-form';
  const format = Object.assign(document.createElement('select'), { name: 'format' });
  format.append(new Option('Formato a conferir', ''), ...Object.entries(animeFormats).filter(([key]) => key !== 'MUSIC')
    .map(([value, text]) => new Option(text, value)));
  const field = (text, control) => { const label = node('label', text + ' '); label.append(control); return label; };
  const year = Object.assign(document.createElement('input'), { name: 'year', type: 'number', min: 1900, max: 2200, inputMode: 'numeric' });
  const episodes = Object.assign(document.createElement('input'), { name: 'episodes', type: 'number', min: 1, max: 9999, inputMode: 'numeric' });
  const use = Object.assign(node('button', 'Usar na prévia'), { type: 'button', className: 'editorial-action' });
  const note = node('p');
  note.setAttribute('role', 'status');
  use.addEventListener('click', () => {
    const candidate = manualAnimeMetadata({ title, format: format.value, year: year.value, episodes: episodes.value });
    if (!candidate) { note.textContent = 'Confira o ano e o número de episódios.'; return; }
    seriesMetadata.set(id, { state: 'applied', provider: 'manual', candidate, by: 'manual' });
    renderSeriesMeta(id);
    if (rebuildInventory) renderRebuildPlan(rebuildInventory);
    rebuildOptions.querySelector('[data-series="' + CSS.escape(id) + '"] input')?.focus();
  });
  fields.append(field('Formato', format), field('Ano', year), field('Episódios', episodes), use, note);
  details.append(fields);
  return details;
}

function renderSeriesMeta(id) {
  const row = rebuildOptions.querySelector('[data-series="' + CSS.escape(id) + '"]');
  const context = rebuildSelection;
  if (!row || !context) return;
  const meta = row.querySelector('.library-series-meta');
  const entry = seriesMetadata.get(id);
  const title = context.choices.get(id)?.[0].title ?? '';
  const checked = row.querySelector('input[type="checkbox"]').checked;
  meta.replaceChildren();
  if (!checked && !settled(entry)) return;
  if (!entry) {
    if (!context.automaticLookup) meta.append(manualSeriesForm(id, title));
    return;
  }
  if (entry.state === 'checking') {
    meta.append(node('small', 'Consultando ' + animeProviders[entry.provider] + '…'));
    return;
  }
  if (entry.state === 'applied') {
    const line = node('small', fichaText(entry.candidate) + ' · ' + provenance(entry));
    if (entry.candidate.url) line.append(' ', providerLink('Ver ficha', entry.candidate.url));
    meta.append(line);
    if (entry.candidates?.length > 1) {
      const change = Object.assign(node('button', 'Trocar edição'), { type: 'button', className: 'editorial-action' });
      change.addEventListener('click', () => {
        seriesMetadata.set(id, { ...entry, state: 'choose', candidate: undefined, by: undefined });
        renderSeriesMeta(id);
        if (rebuildInventory) renderRebuildPlan(rebuildInventory);
        row.querySelector('select')?.focus();
      });
      meta.append(change);
    }
    return;
  }
  if (entry.state === 'choose') {
    const label = node('label', 'Edição no ' + animeProviders[entry.provider] + ' ');
    const choice = document.createElement('select');
    choice.append(new Option('Escolha a edição dos arquivos…', ''),
      ...entry.candidates.map((candidate, index) => new Option(fichaText(candidate), String(index))),
      new Option('Nenhuma destas', 'none'));
    choice.addEventListener('change', () => {
      if (!choice.value) return;
      if (choice.value === 'none') seriesMetadata.set(id, { ...entry, state: 'none', by: 'user' });
      else seriesMetadata.set(id, { ...entry, state: 'applied', candidate: entry.candidates[Number(choice.value)], by: 'user' });
      renderSeriesMeta(id);
      if (rebuildInventory) renderRebuildPlan(rebuildInventory);
      row.querySelector('input[type="checkbox"]').focus();
    });
    label.append(choice);
    meta.append(node('small', context.choices.get(id).some(work => work.season > 1) ?
      'Temporada a confirmar: escolha a edição que corresponde aos arquivos.' : 'Há mais de uma ficha possível.'), label);
  } else if (entry.state === 'none') {
    meta.append(node('small', entry.by === 'user' ? 'Sem ficha: você indicou que nenhuma corresponde.' :
      'Sem ficha encontrada no ' + animeProviders[entry.provider] + '.'));
  } else if (entry.state === 'error') {
    meta.append(node('small', 'Ficha pendente: a consulta ao ' + animeProviders[entry.provider] + ' não respondeu.'));
  } else if (entry.state === 'waiting') {
    meta.append(node('small', 'Ficha em pausa por limite de consultas do ' + animeProviders[entry.provider] + '.'));
  } else if (entry.state === 'skipped') {
    meta.append(node('small', 'O título não serve para a busca automática.'));
  }
  meta.append(manualSeriesForm(id, title));
}

function showLookupHelp(state, provider) {
  const actions = get('rebuild-lookup-actions');
  const buttons = [];
  const button = (text, action) => {
    const item = Object.assign(node('button', text), { type: 'button', className: 'editorial-action' });
    item.addEventListener('click', action);
    buttons.push(item);
  };
  if (provider === 'anilist' && providerFallback.has(state)) button('Usar MyAnimeList', () => saveAnimeProvider('mal'));
  if (state === 'provider_unconfigured') button('Configurar MyAnimeList', openMalSettings);
  if (provider === 'mal' && providerFallback.has(state)) button('Voltar ao AniList', () => saveAnimeProvider('anilist'));
  if (retryableLookup.has(state) && (state !== 'rate_limited' || (retryAt.get(provider) ?? 0) <= Date.now())) {
    button('Consultar de novo', () => void lookupSelectedSeries(true));
  }
  actions.replaceChildren(...buttons);
}

function openMalSettings() {
  const settings = root.querySelector('#mal-settings');
  if (!settings) return;
  settings.open = true;
  settings.scrollIntoView({ block: 'center' });
  root.querySelector('#mal-client-id')?.focus();
}

async function lookupSelectedSeries(retry = false) {
  const context = rebuildSelection;
  if (!context?.automaticLookup) return;
  const provider = currentProvider();
  // Requests pages and checkbox changes may add work while a query is in flight. Keep that query.
  if (rebuildLookup?.provider === provider && !retry) return;
  rebuildLookup?.controller.abort();
  clearTimeout(rebuildLookupTimer);
  const controller = new AbortController();
  const request = { controller, provider };
  const { signal } = controller;
  rebuildLookup = request;
  const feedback = get('rebuild-lookup');
  feedback.textContent = '';
  get('rebuild-lookup-actions').replaceChildren();
  const schedule = () => {
    const delay = (retryAt.get(provider) ?? 0) - Date.now();
    if (delay <= 0) return false;
    rebuildLookupTimer = setTimeout(() => void lookupSelectedSeries(), delay);
    feedback.textContent = 'O ' + animeProviders[provider] +
      ' pediu uma pausa. A consulta das fichas será retomada automaticamente.';
    showLookupHelp('rate_limited', provider);
    return true;
  };
  const attempted = new Set();
  let changed = false;
  while (!signal.aborted) {
    const id = [...rebuildOptions.querySelectorAll('input[type="checkbox"]:checked')].find(({ value }) => {
      const entry = seriesMetadata.get(value);
      return !attempted.has(value) && !settled(entry) &&
        (entry?.provider !== provider || ['checking', 'waiting', 'error'].includes(entry.state) ||
          (retry && entry.state === 'none'));
    })?.value;
    if (!id) break;
    attempted.add(id);
    const entry = seriesMetadata.get(id);
    const title = context.choices.get(id)[0].title;
    if (title.length < 2 || title.length > 120 || /https?:\/\/|[\r\n]|\.(?:mkv|mp4|zip)$/iu.test(title)) {
      seriesMetadata.set(id, { state: 'skipped', provider });
      renderSeriesMeta(id);
      continue;
    }
    if (schedule()) break;
    if (!retry && entry?.provider === provider && entry.state === 'error') {
      feedback.textContent = lookupMessage(entry.result, provider);
      showLookupHelp(entry.result.state, provider);
      break;
    }
    const key = JSON.stringify([provider, titleKey(title)]);
    let result = retry && entry?.state === 'none' ? undefined : letterMetadata.get(key);
    if (!result) {
      const pending = { state: 'checking', provider };
      seriesMetadata.set(id, pending);
      renderSeriesMeta(id);
      try { result = await lookupAnime(root.dataset.animeMetadataEndpoint, title, signal, provider); }
      catch { result = { state: 'network' }; }
      if (signal.aborted || rebuildSelection !== context) return;
      if (result.state === 'candidates') letterMetadata.set(key, result);
      if (seriesMetadata.get(id) !== pending || !context.choices.has(id)) continue;
    }
    if (result.state !== 'candidates') {
      // A provider failure stops the batch: the confirmed fichas and the rest of the selection stay as they are.
      const waiting = Boolean(result.retryAfter);
      seriesMetadata.set(id, { state: waiting ? 'waiting' : 'error', provider, result });
      renderSeriesMeta(id);
      if (waiting) {
        retryAt.set(provider, Math.max(retryAt.get(provider) ?? 0, Date.now() + result.retryAfter * 1000));
        schedule();
      } else {
        feedback.textContent = lookupMessage(result, provider) ?? 'Não foi possível consultar os metadados.';
        showLookupHelp(result.state, provider);
      }
      break;
    }
    const matches = result.candidates.filter(candidate =>
      candidate.titles?.some(value => titleKey(value) === titleKey(title)));
    const seasonal = context.choices.get(id).some(work => work.season > 1);
    seriesMetadata.set(id, matches.length === 1 && !seasonal ?
      { state: 'applied', provider, candidate: matches[0], candidates: result.candidates, by: 'auto' } :
      result.candidates.length ? { state: 'choose', provider, candidates: result.candidates } : { state: 'none', provider });
    renderSeriesMeta(id);
    changed = true;
  }
  if (rebuildLookup === request) rebuildLookup = undefined;
  if (changed && rebuildInventory) renderRebuildPlan(rebuildInventory);
}

onAnimeProviderChange(value => {
  for (const id of ['provider', 'rebuild-provider']) get(id).value = value;
  updateSearchButton();
  if (rebuildSelection) void lookupSelectedSeries();
});
get('rebuild-provider').addEventListener('change', event => saveAnimeProvider(event.target.value));
root.addEventListener('rhea:mal-client-ready', () => {
  if (rebuildSelection && currentProvider() === 'mal') void lookupSelectedSeries(true);
});

function seriesId(item) {
  return titleKey(item.title, { foldDiacritics: false });
}

// A ficha with fewer episodes than the files' numbering points to another edition or season.
function fichaMismatch(work) {
  const entry = seriesMetadata.get(seriesId(work));
  const episodes = entry?.state === 'applied' ? entry.candidate.episodes : undefined;
  if (!episodes || rebuildSelection.choices.get(seriesId(work))?.length !== 1) return false;
  return Math.max(0, ...work.posts.map(post => post.episode ?? 0)) > episodes;
}

function renderRebuildPlan({ posts, complete }) {
  clearPosition();
  const selection = rebuildSelection;
  const intakeWorks = selectedWorks();
  const count = intakeWorks.reduce((total, item) => total + item.posts.length, 0);
  const plan = planLetterRebuild({ letter: selection.letter, currentPosts: posts, intakeWorks,
    reference: source.reference, complete: complete && source.complete });
  const { checks, insertion } = plan;
  const backupIssue = backupBlocker(selection);
  const mismatch = intakeWorks.filter(fichaMismatch).map(work => work.title);
  const partial = !complete ? 'Prévia parcial: a leitura de ' + (selection.current?.title ?? 'a letra atual') + ' ainda não terminou.' :
    !source.complete ? 'Prévia parcial: ainda há páginas de ' + source.title + ' para ler.' : '';
  const blocker = !intakeWorks.length ? 'Marque as séries de Requests que deseja acrescentar.' :
    !selection.current || !selection.target ? 'Para copiar, confira o tópico atual e crie um tópico [NEW] vazio para esta letra.' :
    partial ? partial + ' A publicação fica disponível quando a leitura terminar.' :
    backupIssue ? backupIssue :
    posts.length + count > rebuildLimit ? 'A letra combinada passa de ' + rebuildLimit + ' publicações, o limite do piloto. Veja os limites abaixo.' :
      count > rebuildIntakeLimit ? 'Selecione até ' + rebuildIntakeLimit + ' arquivos de Requests nesta reconstrução.' :
    checks.protectedGroups || posts.some(post => post.protected) ? 'Há publicações protegidas pelo Telegram.' :
    mismatch.length ? 'Confira a edição de ' + mismatch.join(', ') + ': a ficha tem menos episódios que a numeração dos arquivos.' :
    intakeWorks.some(item => item.duplicate || item.missingEpisode || item.albumReview || item.countMismatch || item.editionReview) ?
      'Confira a numeração, a edição e os álbuns das obras de Requests.' : '';
  const placed = insertion.slots?.reduce((total, slot) => total + slot.works.length, 0) ?? 0;
  say('rebuild-status', blocker || (insertion.state === 'ready' ?
    'Prévia completa: a RHEA posicionou ' + (placed === 1 ? 'a série' : 'as ' + placed + ' séries') +
      ' pela ordem alfabética. Revise a publicação abaixo.' :
    insertion.reasons.includes('same_title') ? 'Uma série marcada já está na letra atual. Veja a posição abaixo.' :
      'Não foi possível calcular a posição. Escolha onde a obra entra.'));
  const pending = intakeWorks.filter(work => !settled(seriesMetadata.get(seriesId(work)))).length;
  const chips = [
    partial && 'Prévia parcial',
    plan.groups.length + (plan.groups.length === 1 ? ' bloco de obra' : ' blocos de obras'),
    checks.ambiguousGroups > 0 && checks.ambiguousGroups + ' a conferir',
    checks.otherPosts > 0 && checks.otherPosts + ' capas e notas mantidas na ordem atual',
    checks.unassigned > 0 && checks.unassigned + ' arquivos sem obra mantidos na ordem atual',
    checks.protectedGroups > 0 && checks.protectedGroups + ' com conteúdo protegido',
    pending > 0 && pending + (pending === 1 ? ' ficha pendente' : ' fichas pendentes'),
  ].filter(Boolean).map(text => node('li', text));
  get('rebuild-summary').replaceChildren(...chips);
  get('rebuild-summary').hidden = false;
  const limit = (used, max, unit) => used + ' de ' + max + ' ' + unit + (used > max ? ' · acima do limite' : '');
  get('limit-intake').textContent = limit(count, rebuildIntakeLimit, 'arquivos');
  get('limit-total').textContent = limit(posts.length + count, rebuildLimit, 'publicações') +
    ' · ' + posts.length + ' na letra atual';
  get('limit-intake').dataset.over = String(count > rebuildIntakeLimit);
  get('limit-total').dataset.over = String(posts.length + count > rebuildLimit);
  get('rebuild-limits').hidden = false;
  get('rebuild-items').replaceChildren(...plan.groups.map(item => {
    const row = document.createElement('li');
    const details = document.createElement('details');
    const episodes = document.createElement('ol');
    episodes.append(...list(item.posts));
    const entry = item.origin === 'intake' ? seriesMetadata.get(seriesId(item)) : undefined;
    details.append(node('summary', [
      item.title, item.season === undefined ? '' : 'Temporada ' + item.season,
      item.posts.length ? item.posts.length + (item.posts.length === 1 ? ' arquivo' : ' arquivos') : 'Título da capa',
      item.origin === 'current' ? selection.current.title : source.title,
    ].filter(Boolean).join(' · ')), episodes);
    row.append(details);
    if (item.origin === 'intake') {
      row.append(node('small', entry?.state === 'applied' ? fichaText(entry.candidate) + ' · ' + provenance(entry) :
        entry?.state === 'choose' ? 'Ficha pendente: escolha a edição na lista de séries.' : 'Sem ficha aplicada.'));
    }
    return row;
  }));
  rebuildPosts = [...posts].sort((a, b) => a.id - b.id);
  if (blocker && !insertion.reasons?.includes('same_title')) {
    publication.clear();
    return;
  }
  if (intakeWorks.length === 1) {
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
  }
  if (insertion.state === 'review') {
    publication.clear();
    showPosition(undefined, 'review', insertion.reasons, 0, insertion.duplicates);
    return;
  }
  if (intakeWorks.length === 1) {
    const [slot] = insertion.slots;
    const manual = selection.manualPosition;
    if (manual?.ids === slot.ids.join(',') &&
        (manual.beforeId === null || [...get('rebuild-anchor').options].some(option => option.value === String(manual.beforeId)))) {
      get('rebuild-anchor').value = manual.beforeId === null ? 'end' : String(manual.beforeId);
      const chosen = { beforeId: manual.beforeId, works: slot.works, ids: slot.ids };
      showPosition([chosen], 'manual');
      prepareReconstruction([chosen]);
      return;
    }
    get('rebuild-anchor').value = slot.beforeId === null ? 'end' : String(slot.beforeId);
  }
  showPosition(insertion.slots, insertion.state, insertion.reasons, insertion.uncovered);
  if (!blocker) prepareReconstruction(insertion.slots);
}

get('rebuild-adjust').addEventListener('click', () => {
  const options = get('rebuild-insert');
  options.hidden = !options.hidden;
  get('rebuild-adjust').setAttribute('aria-expanded', String(!options.hidden));
});

function refreshRebuildPicks() {
  rebuildSelection.manualPosition = undefined;
  updateRebuildCount();
  if (rebuildInventory) renderRebuildPlan(rebuildInventory);
  void lookupSelectedSeries();
}

rebuildOptions.addEventListener('change', event => {
  if (event.target.type === 'checkbox') {
    renderSeriesMeta(event.target.value);
    refreshRebuildPicks();
  }
});
for (const [button, checked] of [['rebuild-select-all', true], ['rebuild-select-none', false]]) {
  get(button).addEventListener('click', () => {
    for (const input of rebuildOptions.querySelectorAll('input[type="checkbox"]')) {
      if (input.checked === checked) continue;
      input.checked = checked;
      renderSeriesMeta(input.value);
    }
    refreshRebuildPicks();
  });
}

function destinationMessage(state, letter) {
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
    rate_limited: telegramWaitMessage(),
    not_checked: 'Consulta pendente; não foi realizada durante a pausa do Telegram.',
    disconnected: 'Conecte o Telegram na seção acima e confira novamente.',
    access_required: 'Sua sessão expirou. Entre no Private novamente.',
    not_allowed: 'O Private não autorizou a leitura. Confira a conta conectada.',
    changed: 'A lista de tópicos mudou durante a consulta. Confira novamente.',
    incomplete: 'A lista excede o limite de conferência.',
  };
  return messages[state] ?? messages.unavailable;
}

function destinationLine(label, target, letter) {
  const line = node('li', label + ' · ');
  line.append(target.state === 'found' ?
    providerLink(target.topic.title, 'https://t.me/c/' + target.channelId + '/' + target.topic.id) :
    document.createTextNode(destinationMessage(target.state, letter)));
  return line;
}

get('check-destinations').addEventListener('click', async () => {
  if (!preview || destinationRead || telegramWait()) return;
  const request = new AbortController();
  destinationRead = request;
  const button = get('check-destinations');
  const feedback = get('destination-status');
  const results = get('destinations');
  button.disabled = true;
  results.hidden = true;
  feedback.textContent = 'Conferindo os tópicos de destino…';
  const { letter } = preview;
  publication.clear();
  clearRebuild();
  const lookup = scope => checkForum(letter, scope, request.signal).catch(() => ({ state: 'unavailable' }));
  try {
    const local = await lookup(undefined);
    if (request.signal.aborted) return;
    if (local.state === 'rate_limited') {
      results.replaceChildren(destinationLine('No mesmo grupo', local, letter),
        destinationLine('No backup', { state: 'not_checked' }, letter));
      results.hidden = false;
      get('pilot-note').hidden = true;
      get('sum-destinations').textContent = 'Consulta pausada · Backup não conferido';
      feedback.textContent = telegramWaitMessage();
      return;
    }
    if (local.topic && ['found', 'closed'].includes(local.state) && local.replacement?.state === 'found') {
      startRebuild(local, letter, { group: group(), preview });
      results.replaceChildren(destinationLine('Tópico atual (origem)', { ...local, state: 'found' }, letter),
        destinationLine('Destino da reconstrução', { ...local.replacement, channelId: local.channelId }, letter));
      results.hidden = false;
      get('pilot-note').hidden = true;
      get('sum-destinations').textContent = local.replacement.topic.title;
      feedback.textContent = 'Os tópicos da reconstrução foram encontrados. Confira a ordem antes de planejar a cópia. O tópico do backup é conferido logo abaixo, na etapa da reconstrução.';
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
    if (backup.state === 'rate_limited') {
      get('pilot-note').hidden = true;
      get('sum-destinations').textContent = 'Mesmo grupo: ' + (local.topic?.title ?? 'não confirmado') + ' · Backup: consulta pausada';
      feedback.textContent = telegramWaitMessage();
      return;
    }
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
      updateDestinationButton();
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
  if (get('letter-plans').hidden) (group() ? title : get('source')).focus();
  else get('letter-title').focus();
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
  // An AniList link is an explicit choice of AniList: the single preference follows it.
  saveAnimeProvider('anilist');
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
get('provider').addEventListener('change', event => {
  // A change of source keeps an open letter review; it only resets the lookup by work.
  if (!rebuildSelection) clearChoice();
  saveAnimeProvider(event.target.value);
});
for (const id of ['provider', 'rebuild-provider']) get(id).value = animeProviderPreference();
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

// Reading earlier pages refreshes the inventory without discarding the chosen work or title. An open letter
// review keeps its reads, choices and fichas; only the new Requests files are added.
function refreshSource(snapshot) {
  if (rebuildSelection) {
    const result = groupTopicDocuments(snapshot.posts, snapshot.reference);
    const key = select.value;
    refreshRebuildSource(snapshot, result);
    select.replaceChildren(...groups.map(item => Object.assign(node('option', item.title +
      (item.season !== undefined ? ' · Temporada ' + item.season : ' · Temporada a conferir')), { value: item.key })));
    if ([...select.options].some(option => option.value === key)) select.value = key;
    get('load-more').hidden = snapshot.complete;
    describeSource(snapshot, result);
    // Refresh the letter cards from the index already read; never read the topic list again for this.
    if (discoveredIndex) void discoverLetters(false, discoveredIndex);
    return;
  }
  const keep = { key: select.value, title: title.value };
  load(snapshot, discoveredIndex);
  if ([...select.options].some(option => option.value === keep.key)) {
    select.value = keep.key;
    selectGroup();
    title.value = keep.title;
    status.textContent = 'Inventário atualizado com ' + snapshot.posts.length +
      (snapshot.posts.length === 1 ? ' publicação lida' : ' publicações lidas') +
      (snapshot.complete ? '. O tópico está completo.' : '. Ainda há páginas anteriores.') + ' Busque ou confirme a obra novamente.';
  }
}

get('load-more').addEventListener('click', () => {
  const more = root.querySelector('#forum-more-posts');
  if (more && !more.disabled) more.click();
});
root.addEventListener('rhea:telegram-hide', reset);
root.addEventListener('rhea:forum-clear', reset);
root.addEventListener('rhea:forum-inventory-change', () => {
  if (!source) return;
  const snapshot = forumEnrichmentSnapshot();
  if (snapshot && snapshot.topicId === source.topicId && snapshot.channelId === source.channelId) refreshSource(snapshot);
  else reset();
});
let shown = root.dataset.telegramAutoload === 'true';
root.addEventListener('rhea:telegram-show', () => { shown = true; publication.restore(); });
root.addEventListener('rhea:telegram-hide', () => { shown = false; });
window.addEventListener('pagehide', reset);
window.addEventListener('pageshow', event => { if (event.persisted && shown) publication.restore(); });
reset();
if (shown) publication.restore();

