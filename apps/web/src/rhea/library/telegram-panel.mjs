const endpoint = '/api/rhea/telegram';
const status = document.getElementById('telegram-status');
const button = document.getElementById('telegram-check');
const messages = {
  unconfigured: 'Ambiente de teste ainda não configurado.',
  ready: 'Ambiente de teste configurado. Verifique o bot e as permissões do canal.',
  verified: 'Bot e permissões verificados no canal de teste. A importação do histórico ainda não está ativa.',
  access_required: 'Entre na RHEA para verificar a conexão.',
  not_allowed: 'Esta conta não está autorizada a verificar o canal de teste.',
  review_channel: 'O Telegram não confirmou o canal privado configurado.',
  review_bot_permissions: 'Confira se o bot é administrador com as permissões mínimas, sem publicar, editar ou excluir mensagens.',
  review_owner: 'O Telegram não confirmou o proprietário configurado.',
  telegram_rejected: 'O Telegram recusou a verificação. Confira a configuração do bot e do canal.',
  rate_limited: 'O Telegram limitou as verificações. Aguarde antes de tentar novamente.',
  unavailable: 'A verificação está indisponível.',
};

function display(state, retryAfter) {
  status.textContent = Object.hasOwn(messages, state) ? messages[state] : messages.unavailable;
  button.disabled = false;
  if (state !== 'rate_limited') return;
  button.disabled = true;
  if (Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 86_400) {
    status.textContent = 'O Telegram limitou as verificações. Tente novamente em ' + retryAfter + ' s.';
    setTimeout(() => { button.disabled = false; }, retryAfter * 1000);
  }
}

async function request(method) {
  try {
    const reply = await fetch(endpoint, { method, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    if (reply.status === 401) return { state: 'access_required' };
    if (reply.status === 403) return { state: 'not_allowed' };
    if (!reply.headers.get('Content-Type')?.includes('application/json')) return { state: 'unconfigured' };
    return await reply.json();
  } catch {
    return { state: 'unavailable' };
  }
}

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Conferindo o canal no Telegram.';
  const { state, retryAfter } = await request('POST');
  display(state, retryAfter);
});

request('GET').then(({ state }) => {
  button.hidden = state !== 'ready';
  display(state);
});
