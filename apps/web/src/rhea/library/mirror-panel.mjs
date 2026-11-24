const root = document.querySelector('[data-rhea-telegram-library]');
const get = id => root.querySelector('#mirror-' + id);
const endpoint = root.dataset.telegramEndpoint;
const panel = get('panel');
const dialog = get('dialog');
const status = get('status');
const previewButton = get('preview');
const continueButton = get('continue');
const pauseButton = get('pause');
const labels = { photo: 'Imagem', document: 'Arquivo', text: 'Texto' };
const errors = {
  disconnected: 'Conecte a conta de teste para consultar o espelho.',
  mirror_disabled: 'O espelhamento ainda precisa ser habilitado no adaptador de teste.',
  mirror_ineligible: 'Confira se os tópicos de teste foram autorizados, se o destino está vazio e se a origem atende aos limites do piloto.',
  mirror_changed: 'A origem, o destino ou a aprovação divergiu da prévia. Confira os tópicos antes de prosseguir.',
  mirror_recovery: 'A cópia precisa de conferência manual. Abra os tópicos de teste antes de tentar outra execução.',
  rate_limited: 'O Telegram pediu uma pausa. Consulte o progresso mais tarde.',
  busy: 'Uma operação ainda está em andamento. Consulte o progresso em instantes.',
};
const issueMessages = {
  account_unverified: 'A conta conectada não corresponde à conta de teste. Confira a conexão na seção Histórico do Telegram.',
  group_unavailable: 'O convite e o ID no Railway precisam apontar para o mesmo supergrupo privado, já acessível pela conta de teste.',
  group_not_forum: 'Ative Tópicos nas configurações do supergrupo de teste.',
  group_not_owned: 'A conta conectada precisa ser proprietária deste supergrupo de teste.',
  group_protected: 'Este supergrupo tem proteção de conteúdo. Use um supergrupo descartável com mídias de teste que possam ser copiadas.',
  topic_missing: 'Não encontrei o tópico nesse supergrupo. Confira o ID do tópico no Railway.',
  topic_name: 'O nome do tópico deve ser exatamente RHEA Mirror Test.',
  topic_closed: 'Abra o tópico de teste antes de preparar a prévia.',
  history_unverified: 'O Telegram não devolveu um histórico completo e verificável para o tópico. Tente novamente.',
  history_limit: 'O tópico ultrapassou o limite de 20 publicações do piloto.',
  unsupported_post: 'Há uma publicação fora do formato do piloto. Use foto, texto ou documento de até 25 MiB, enviados diretamente no tópico.',
  album_or_reply: 'Confira se o álbum tem de 2 a 10 itens do mesmo tipo e se as respostas apontam para posts anteriores do próprio tópico.',
  source_empty: 'Publique o material de teste dentro do tópico da origem.',
  destination_not_empty: 'Use um tópico de destino vazio para a primeira execução.',
};
function issueMessage(issue) {
  if (!issue || !Object.hasOwn(issueMessages, issue.code)) return '';
  const side = issue.side === 'source' ? 'Origem · ' : issue.side === 'destination' ? 'Destino · ' : '';
  return side + issueMessages[issue.code];
}

const node = (tag, value) => Object.assign(document.createElement(tag), { textContent: value });
let active;
let running = false;
let expected;
let canContinue = false;

function buttons() {
  get('check').disabled = Boolean(active) || running;
  previewButton.disabled = Boolean(active) || running;
  continueButton.hidden = !canContinue || running;
  continueButton.disabled = Boolean(active);
  pauseButton.hidden = !running;
}

async function request(operation, input) {
  if (active) return null;
  const controller = new AbortController();
  active = controller;
  buttons();
  try {
    const response = await fetch(endpoint + '?op=' + operation, { method: 'POST', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', signal: controller.signal,
      ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) });
    const data = await response.json();
    return controller.signal.aborted ? null : data;
  } catch {
    return controller.signal.aborted ? null : { state: 'unavailable' };
  } finally {
    if (active === controller) { active = undefined; buttons(); }
  }
}

function render(result) {
  if (!result) return;
  const { state, mirror, issue } = result;
  canContinue = state === 'mirror_progress';
  const copies = mirror?.copies ?? [];
  const count = mirror ? copies.length + ' de ' + mirror.total + ' posts verificados.' : '';
  if (state === 'mirror_idle') status.textContent = 'Nenhuma cópia aprovada.';
  else if (state === 'mirror_progress') status.textContent = count;
  else if (state === 'mirror_done') status.textContent = 'Cópia de teste concluída. ' + count;
  else status.textContent = [issueMessage(issue) || errors[state] || 'Não foi possível consultar o espelho.', count].filter(Boolean).join(' ');
  get('receipts').hidden = !copies.length;
  get('mapping').replaceChildren(...copies.map(copy => node('li', '#' + copy.sourceId + ' → #' + copy.destinationId)));
  buttons();
}

async function preview() {
  status.textContent = 'Conferindo os tópicos de teste…';
  const result = await request('mirrorpreview');
  if (result?.state !== 'mirror_preview') return render(result);
  expected = result.mirror.approval;
  get('source').textContent = result.mirror.source;
  get('destination').textContent = result.mirror.destination;
  get('posts').replaceChildren(...result.mirror.posts.map(post =>
    node('li', ['#' + post.id, labels[post.kind], post.label].filter(Boolean).join(' · '))));
  dialog.showModal();
}

async function copy() {
  running = true;
  buttons();
  while (running && canContinue) {
    const result = await request('mirrornext');
    if (!result) break;
    render(result);
  }
  running = false;
  buttons();
}

function reset() {
  running = canContinue = false;
  active?.abort();
  active = expected = undefined;
  if (dialog.open) dialog.close();
  status.textContent = 'Consulte o progresso quando o adaptador estiver configurado para o piloto.';
  get('source').textContent = get('destination').textContent = '';
  get('posts').replaceChildren();
  get('receipts').hidden = true;
  get('mapping').replaceChildren();
  buttons();
}

get('check').addEventListener('click', async () => render(await request('mirrorstatus')));
previewButton.addEventListener('click', preview);
get('approve').addEventListener('click', async () => {
  if (!expected) return;
  const approval = expected;
  expected = undefined;
  dialog.close();
  render(await request('mirrorapprove', { confirm: true, approval }));
});
continueButton.addEventListener('click', copy);
pauseButton.addEventListener('click', () => {
  running = false;
  buttons();
});
dialog.addEventListener('close', () => { expected = undefined; });
panel.addEventListener('toggle', () => { if (!panel.open) reset(); });
root.addEventListener('rhea:telegram-hide', reset);
root.addEventListener('rhea:forum-clear', reset);
window.addEventListener('pagehide', reset);

reset();
