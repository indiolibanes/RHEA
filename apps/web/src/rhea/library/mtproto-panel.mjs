import { catalogSnapshot } from './live-catalog.mjs';
import { setCatalogSnapshot } from './preview.mjs';

const root = document.querySelector('[data-rhea-telegram-library]');
const get = id => root.querySelector('#mtproto-' + id);
const endpoint = root.dataset.telegramEndpoint;
const supportedEndpoint = ['/api/rhea/telegram-mtproto', '/api/relay/telegram-mtproto'].includes(endpoint);
const status = get('status');
const actions = ['start', 'code', 'password', 'cancel', 'inventory', 'disconnect'];
const notification = {
  unconfigured: 'Leitor do Telegram ainda não configurado no ambiente de teste.',
  disconnected: 'Conecte a conta de teste para ler o histórico do canal autorizado.',
  code: 'Abra o app do Telegram, veja o código e digite-o aqui.',
  password: 'Digite sua senha de verificação em duas etapas do Telegram.',
  connected: 'Conta de teste conectada. Você já pode ler o histórico do canal autorizado.',
  inventory: 'Inventário atualizado. A reordenação é apenas uma prévia.',
  access_required: 'Entre no ambiente de teste da RHEA para conectar o Telegram.',
  not_allowed: 'Esta conta da RHEA não tem acesso ao leitor de teste.',
  invalid_code: 'O Telegram recusou o código. Confira no app e tente novamente.',
  invalid_password: 'O Telegram recusou a senha. Confira e tente novamente.',
  expired: 'A sessão ou o código expirou. Inicie uma nova conexão.',
  channel_unavailable: 'O Telegram não confirmou o acesso ao canal privado configurado.',
  account_mismatch: 'A conta confirmada pelo Telegram difere da conta de teste configurada.',
  unsupported_delivery: 'O Telegram pediu outro método de login. A conexão de teste aceita código recebido no app.',
  revoke_in_telegram: 'Sessão removida da RHEA. Encerre o dispositivo RHEA em Telegram → Configurações → Dispositivos.',
  stale_inventory: 'O histórico mudou durante a leitura. Leia novamente para gerar uma nova prévia.',
  rate_limited: 'Aguarde o intervalo solicitado antes de tentar novamente.',
  busy: 'Uma verificação já está em andamento.',
  unavailable: 'O leitor de teste está indisponível.',
};

let step = 'unconfigured';
let activeRequest;
let pause = 0;

function display(result, operation) {
  const state = result.state;
  if (state === 'inventory') {
    setCatalogSnapshot(catalogSnapshot(result.inventory));
    step = 'connected';
  } else if (state === 'expired' || state === 'revoke_in_telegram' || state === 'account_mismatch') {
    step = 'disconnected';
    setCatalogSnapshot();
  } else if (['unconfigured', 'disconnected', 'code', 'password', 'connected', 'access_required', 'not_allowed'].includes(state)) {
    step = state;
    if (state === 'disconnected') setCatalogSnapshot();
  } else if (operation === 'status') {
    step = 'unconfigured';
  }

  status.textContent = Object.hasOwn(notification, state) ? notification[state] : notification.unavailable;
  clearTimeout(pause);
  for (const action of actions) {
    const visible = (step === 'disconnected' && action === 'start') ||
      (step === 'connected' && ['inventory', 'disconnect'].includes(action)) ||
      (['code', 'password'].includes(step) && [step, 'cancel'].includes(action));
    get(action).hidden = !visible;
  }
  if (state === 'rate_limited' && Number.isInteger(result.retryAfter) && result.retryAfter > 0 && result.retryAfter <= 86_400) {
    status.textContent = 'Aguarde ' + result.retryAfter + ' s antes de tentar novamente.';
    toggleButtons(true);
    pause = setTimeout(() => toggleButtons(false), result.retryAfter * 1000);
  }
}

function toggleButtons(disabled) {
  for (const button of get('controls').querySelectorAll('button')) {
    if (button.id !== 'mtproto-cancel' && button.id !== 'mtproto-disconnect') button.disabled = disabled;
  }
}

async function run(operation, input) {
  if (activeRequest || !supportedEndpoint) return;
  const request = new AbortController();
  activeRequest = request;
  toggleButtons(true);
  status.textContent = 'Consultando o leitor de teste.';
  let result;
  try {
    const reply = await fetch(endpoint + '?op=' + operation, {
      method: operation === 'status' ? 'GET' : 'POST',
      cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: request.signal,
      ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
    });
    result = reply.status === 401 ? { state: 'access_required' } : reply.status === 403 ? { state: 'not_allowed' } :
      reply.headers.get('Content-Type')?.includes('application/json') ? await reply.json() : { state: 'unconfigured' };
  } catch {
    result = { state: 'unavailable' };
  } finally {
    if (activeRequest === request) {
      activeRequest = undefined;
      toggleButtons(false);
    }
  }
  if (request.signal.aborted) return;
  try {
    display(result, operation);
  } catch {
    status.textContent = notification.unavailable;
  }
}

for (const action of ['start', 'cancel', 'inventory', 'disconnect']) {
  get(action).addEventListener('click', () => run(action));
}
for (const action of ['code', 'password']) {
  get(action).addEventListener('submit', event => {
    event.preventDefault();
    const field = get(action + '-input');
    const input = field.value;
    field.value = '';
    run(action, { [action]: input });
  });
}
let shown = root.dataset.telegramAutoload === 'true';
function clearView() {
  activeRequest?.abort();
  activeRequest = undefined;
  for (const name of ['code', 'password']) get(name + '-input').value = '';
  display({ state: 'unconfigured' });
  toggleButtons(false);
  setCatalogSnapshot();
  get('status').textContent = 'Verificando se o leitor está disponível.';
  const dialog = root.querySelector('#plan-dialog');
  if (dialog.open) dialog.close();
}

root.addEventListener('rhea:telegram-show', () => {
  shown = true;
  if (supportedEndpoint) run('status');
  else display({ state: 'unconfigured' });
});
root.addEventListener('rhea:telegram-hide', () => {
  shown = false;
  clearView();
});
window.addEventListener('pagehide', clearView);
window.addEventListener('pageshow', event => {
  if (event.persisted && shown) run('status');
});
if (shown) root.dispatchEvent(new Event('rhea:telegram-show'));
