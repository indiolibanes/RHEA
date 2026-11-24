import { filenameReference, forumDocumentTotals } from './forum-names.mjs';

const root = document.querySelector('[data-rhea-telegram-library]');
const get = id => root.querySelector('#forum-' + id);
const endpoint = root.dataset.telegramEndpoint;
const topicSelect = get('topic');
const status = get('status');
const topics = new Map();
const inventories = new Map();
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const labels = { cover: 'Capa / imagem', document: 'Arquivo', note: 'Nota', media: 'Mídia' };
const errors = {
  disconnected: 'Conecte a conta de teste antes de ler os tópicos.',
  forum_disabled: 'O supergrupo ainda precisa ser autorizado no adaptador.',
  forum_unavailable: 'Não foi possível confirmar o supergrupo privado ou o tópico autorizado.',
  forum_changed: 'A página retornada pelo Telegram não pôde ser validada. Tente a leitura novamente.',
  forum_cursor_invalid: 'O ponto de leitura deixou de ser válido. Reabra o inventário.',
  forum_general: 'O tópico Geral ainda precisa de uma leitura específica.',
  rate_limited: 'O Telegram pediu uma pausa. Tente mais tarde.',
  busy: 'Outra leitura está em andamento. Tente novamente.',
  not_allowed: 'Esta sessão não tem acesso ao inventário.',
};
const element = (tag, value) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  return node;
};
const privateLink = (channel, topic, message) => 'https://t.me/c/' + channel + '/' + topic + '/' + message;
const MiB = value => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value / 2 ** 20) + ' MiB';

let active;
let cursor = null;
let reference;
let channelId;
let visible = 80;

function current() { return inventories.get(Number(topicSelect.value)); }

export function forumEnrichmentSnapshot() {
  const selected = current();
  if (!selected) return undefined;
  const topic = topics.get(Number(topicSelect.value));
  return { title: topic?.title ?? 'Tópico carregado', posts: [...selected.posts.values()],
    topics: [...topics.values()], complete: selected.next === null, reference };
}

function notifyInventoryChanged() {
  root.dispatchEvent(new Event('rhea:forum-inventory-change'));
}

function refreshButtons() {
  get('load').disabled = Boolean(active);
  topicSelect.disabled = Boolean(active) || !topics.size;
  get('more-topics').hidden = cursor === null;
  get('more-topics').disabled = Boolean(active);
  const selected = current();
  get('more-posts').hidden = !topicSelect.value || selected?.next === null;
  get('more-posts').disabled = Boolean(active);
  get('more-posts').textContent = selected ? 'Ler página anterior do tópico' : 'Ler tópico';
}

async function read(operation, input) {
  if (active) return null;
  const request = new AbortController();
  active = request;
  refreshButtons();
  status.textContent = 'Lendo metadados no Telegram…';
  try {
    const response = await fetch(endpoint + '?op=' + operation, { method: 'POST', credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', signal: request.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input) });
    const result = await response.json();
    if (request.signal.aborted) return null;
    if (!response.ok) {
      status.textContent = errors[result.state] ?? 'Não foi possível ler o inventário.';
      return null;
    }
    return result.forum;
  } catch {
    if (!request.signal.aborted) status.textContent = 'Não foi possível ler o inventário.';
    return null;
  } finally {
    if (request === active) { active = undefined; refreshButtons(); }
  }
}

function topicChoices() {
  const previous = topicSelect.value;
  const options = [element('option', 'Escolha um tópico')];
  options[0].value = '';
  for (const topic of [...topics.values()].sort((a, b) => collator.compare(a.title, b.title))) {
    const option = element('option', topic.title + (topic.id === 1 ? ' · leitura indisponível' : ''));
    option.value = String(topic.id);
    option.disabled = topic.id === 1;
    options.push(option);
  }
  topicSelect.replaceChildren(...options);
  if (topics.has(Number(previous))) topicSelect.value = previous;
}

async function readTopics(next) {
  const data = await read('forumtopics', { cursor: next });
  if (!data) return;
  if (channelId && channelId !== data.channelId) reset();
  if (next === null) {
    topics.clear();
    inventories.clear();
    notifyInventoryChanged();
    topicSelect.value = '';
    render();
  }
  channelId = data.channelId;
  for (const topic of data.topics) topics.set(topic.id, topic);
  cursor = data.next;
  topicChoices();
  status.textContent = topics.size + ' tópicos carregados.';
  refreshButtons();
}

async function readPosts() {
  const topicId = Number(topicSelect.value);
  if (!topics.has(topicId)) return;
  const selected = current() ?? { next: null, posts: new Map() };
  const data = await read('forumpage', { topicId, cursor: selected.next });
  if (!data) return;
  if (data.channelId !== channelId || data.topicId !== topicId) {
    reset();
    status.textContent = 'O supergrupo mudou. Carregue os tópicos novamente.';
    return;
  }
  for (const post of data.posts) selected.posts.set(post.id, post);
  selected.next = data.next;
  inventories.set(topicId, selected);
  notifyInventoryChanged();
  status.textContent = selected.posts.size + ' publicações lidas' +
    (data.next ? '. Há páginas anteriores para conferir.' : '. Fim do tópico.');
  refreshButtons();
  render();
}

function postLine(post, referenceMatch, topicId) {
  const line = element('div');
  const title = element('strong', labels[post.kind] + (post.heading ? ' · ' + post.heading : ''));
  const link = element('a', 'Abrir no Telegram');
  link.href = privateLink(channelId, topicId, post.id);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  line.append(title);
  if (post.caption) line.append(element('p', post.caption));
  if (post.filename) line.append(element('p', 'No Telegram · ' + post.filename));
  if (referenceMatch?.name) {
    line.append(element('p', 'Nome de referência · ' + referenceMatch.name));
    const section = [referenceMatch.series, referenceMatch.section].filter(Boolean).join(' · ');
    if (section) line.append(element('small', section));
    if (referenceMatch.reason === 'tag') line.append(element('small', 'Sugestão pela etiqueta hexadecimal. Confira o episódio.'));
  } else if (referenceMatch) line.append(element('small', 'Nome original pendente de conferência.'));
  if (post.declaredSize) line.append(element('p', 'Tamanho informado · ' + post.declaredSize));
  if (post.sizeBytes !== undefined) line.append(element('p', 'Tamanho do arquivo · ' + MiB(post.sizeBytes)));
  if (post.protected) line.append(element('p', 'Conteúdo protegido'));
  line.append(link);
  return line;
}

function render() {
  const selected = current();
  const total = get('size-total');
  const bySeason = get('size-by-season');
  total.hidden = !selected;
  bySeason.hidden = true;
  get('size-list').replaceChildren();
  if (!selected) { total.textContent = ''; get('items').replaceChildren(); get('more-results').hidden = true; return; }
  const term = get('query').value.trim().toLocaleLowerCase('pt-BR');
  const posts = [...selected.posts.values()].map(post => ({
    post, referenceMatch: post.filename ? reference?.match(post.filename) : undefined,
  }));
  const volumes = forumDocumentTotals(posts);
  const format = bucket => new Intl.NumberFormat('pt-BR').format(bucket.bytes) + ' bytes em ' +
    bucket.sized + ' de ' + bucket.count + ' arquivos.';
  total.textContent = (selected.next ? 'Páginas carregadas' : 'Tópico completo') + ' · ' + format(volumes);
  if (volumes.groups.length) {
    bySeason.hidden = false;
    const rows = volumes.groups.sort((a, b) => collator.compare(a.series, b.series) || collator.compare(a.section, b.section));
    get('size-list').replaceChildren(...rows.map(group =>
      element('li', [group.series, group.section, format(group)].filter(Boolean).join(' · '))));
  }
  const filtered = posts.filter(({ post, referenceMatch }) =>
    [post.filename, post.heading, post.caption, referenceMatch?.name].some(value => value?.toLocaleLowerCase('pt-BR').includes(term)) || !term);
  const groups = new Map();
  const nodes = [];
  for (const { post, referenceMatch } of filtered.slice(0, visible)) {
    const line = postLine(post, referenceMatch, Number(topicSelect.value));
    if (!post.albumId) { nodes.push(line); continue; }
    if (!groups.has(post.albumId)) {
      const group = element('details');
      group.append(element('summary', 'Lote de arquivos'));
      groups.set(post.albumId, group);
      nodes.push(group);
    }
    groups.get(post.albumId).append(line);
  }
  for (const details of groups.values()) {
    const count = details.children.length - 1;
    details.firstChild.textContent += ' · ' + count + (count === 1 ? ' item' : ' itens') + ' nesta lista';
  }
  get('items').replaceChildren(...nodes);
  get('more-results').hidden = filtered.length <= visible;
}

function reset() {
  active?.abort();
  active = undefined;
  topics.clear();
  inventories.clear();
  notifyInventoryChanged();
  cursor = null;
  channelId = reference = undefined;
  visible = 80;
  get('reference').value = get('query').value = '';
  get('reference-status').textContent = '';
  status.textContent = 'Escolha o tópico para ler os metadados.';
  topicChoices();
  refreshButtons();
  render();
}

get('load').addEventListener('click', () => readTopics(null));
get('more-topics').addEventListener('click', () => readTopics(cursor));
get('more-posts').addEventListener('click', readPosts);
get('more-results').addEventListener('click', () => { visible += 80; render(); });
topicSelect.addEventListener('change', () => {
  notifyInventoryChanged();
  visible = 80;
  render();
  refreshButtons();
  if (topicSelect.value && !current()) void readPosts();
  else if (current()) status.textContent = current().posts.size + ' publicações lidas neste tópico.';
});
get('query').addEventListener('input', () => { visible = 80; render(); });
get('reference').addEventListener('change', async event => {
  const file = event.target.files[0];
  reference = undefined;
  notifyInventoryChanged();
  if (!file) { get('reference-status').textContent = ''; render(); return; }
  if (file.size > 2 * 1024 * 1024) {
    get('reference-status').textContent = 'O Markdown pode ter até 2 MiB.';
    render();
    return;
  }
  try {
    const text = await file.text();
    if (event.target.files[0] !== file) return;
    reference = filenameReference(text);
    notifyInventoryChanged();
    get('reference-status').textContent = reference.count + ' nomes de referência carregados neste navegador.';
  } catch {
    get('reference-status').textContent = 'Não foi possível ler o Markdown.';
  }
  render();
});
root.addEventListener('rhea:telegram-hide', reset);
root.addEventListener('rhea:forum-clear', reset);
window.addEventListener('pagehide', reset);
reset();
