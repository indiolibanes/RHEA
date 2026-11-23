import { catalogSnapshot } from './live-catalog.mjs';
import { setCatalogSnapshot } from './preview.mjs';

const get = id => document.getElementById('mtproto-' + id);
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
let active = false;
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
  if (active) return;
  active = true;
  toggleButtons(true);
  status.textContent = 'Consultando o leitor de teste.';
  let result;
  try {
    const reply = await fetch('/api/rhea/telegram-mtproto?op=' + operation, {
      method: operation === 'status' ? 'GET' : 'POST',
      cache: 'no-store', credentials: 'same-origin', redirect: 'error',
      ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
    });
    result = reply.status === 401 ? { state: 'access_required' } : reply.status === 403 ? { state: 'not_allowed' } :
      reply.headers.get('Content-Type')?.includes('application/json') ? await reply.json() : { state: 'unconfigured' };
  } catch {
    result = { state: 'unavailable' };
  } finally {
    active = false;
    toggleButtons(false);
  }
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
window.addEventListener('pagehide', () => {
  for (const name of ['code', 'password']) get(name + '-input').value = '';
  if (step === 'connected') setCatalogSnapshot();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) run('status');
});
run('status');
