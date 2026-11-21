import { json } from './tools.mjs';

const idPattern = /^[A-Za-z0-9_-]{43}$/;
const byId = id => document.getElementById(id);
const requestKey = 'rhea-mcp-request';
const body = input => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });

export function mountMcpPanel() {
  const panel = byId('mcp-review');
  const notice = byId('mcp-notice');
  const approval = byId('mcp-approval');
  const entries = byId('mcp-grants');
  const approve = byId('mcp-approve');
  const deny = byId('mcp-deny');
  const allowOrganize = byId('mcp-allow-organize');
  let id;
  let pending;
  let revision = 0;
  let displayedRequest = null;
  let grants;
  const provider = byId('assistant-provider');
  const state = byId('assistant-mcp-state');
  const plans = byId('mcp-proposals');
  const planList = byId('mcp-proposal-list');
  const planStatus = byId('mcp-proposal-status');
  let planGeneration = 0;

  function updateProvider() {
    const selected = grants?.filter(item => item.provider === provider.value) ?? [];
    state.textContent = !grants ? 'A autorização MCP pela RHEA ainda está indisponível.' : !selected.length ? 'Sem autorização MCP nesta sessão.' :
      selected.some(item => item.scope.includes('rhea:organize')) ? 'MCP autorizado · leitura e organização até revogação.' :
      selected.some(item => item.scope.includes('rhea:propose')) ? 'MCP autorizado · leitura e propostas sujeitas à sua confirmação.' :
        'MCP autorizado · somente leitura.';
  }
  provider.addEventListener('change', updateProvider);

  const labels = {
    rhea_create_folder: 'Criar pasta', rhea_rename_file: 'Renomear', rhea_move_file: 'Mover',
    rhea_trash_file: 'Mover para a lixeira', rhea_prepare_upload: 'Preparar destino de upload',
  };
  const states = {
    PROPOSED: 'Aguardando revisão', USER_REVIEW: 'Pronta para confirmar',
    AUTHORIZED: 'Autorizada', EXECUTING: 'Em execução', VERIFIED: 'Verificada', FAILED: 'Falhou',
  };
  async function loadPlans() {
    const current = ++planGeneration;
    try {
      const result = await json('mcp-plans');
      if (current !== planGeneration) return;
      plans.hidden = false;
      planList.replaceChildren();
      for (const plan of result.plans) {
        const row = document.createElement('li');
        row.className = 'rhea-upload-row';
        const title = document.createElement('strong');
        title.textContent = labels[plan.action] + ' · ' + plan.client;
        const description = document.createElement('p');
        const { source, destination, name, size } = plan.payload;
        description.textContent = [source?.name, name, destination?.path, size ? size + ' bytes' : null].filter(Boolean).join(' → ');
        const status = document.createElement('p');
        status.textContent = states[plan.state] ?? plan.state;
        row.append(title, description, status);
        if (['PROPOSED', 'USER_REVIEW'].includes(plan.state)) {
          const step = document.createElement('button');
          step.type = 'button';
          step.className = 'editorial-action';
          step.textContent = plan.state === 'PROPOSED' ? 'Revisar esta proposta' :
            plan.action === 'rhea_prepare_upload' ? 'Confirmar destino' : 'Confirmar alteração no Drive';
          step.addEventListener('click', async () => {
            step.disabled = true;
            try {
              if (plan.state === 'PROPOSED') {
                const result = await json('mcp-plan-review', body({ id: plan.id }));
                if (!result.reviewed) throw new Error('A proposta expirou ou já foi revisada.');
                planStatus.textContent = 'Revise os detalhes antes de autorizar.';
              } else {
                const result = await json('mcp-plan-execute', body({ id: plan.id, confirmed: true }));
                if (result.result?.preparationOnly) {
                  const link = document.createElement('a');
                  link.href = '/rhea/arquivos?' + new URLSearchParams({ folder: result.result.folderId }) + '#explorador';
                  link.textContent = 'Abrir pasta e selecionar o arquivo';
                  planStatus.replaceChildren(document.createTextNode('Destino confirmado. '), link);
                } else {
                  planStatus.textContent = 'Alteração confirmada pelo Google Drive.';
                  window.dispatchEvent(new Event('rhea-explorer-reload'));
                }
              }
              await loadPlans();
            } catch (error) { planStatus.textContent = error.message; step.disabled = false; }
          });
          row.append(step);
        }
        planList.append(row);
      }
      if (!result.plans.length && !planStatus.textContent) planStatus.textContent = 'Nenhuma proposta pendente nesta conta.';
    } catch (error) {
      if (current === planGeneration && !plans.hidden) planStatus.textContent = error.message;
    }
  }
  byId('mcp-proposal-refresh').addEventListener('click', () => {
    planStatus.textContent = '';
    void loadPlans();
  });
  const initial = new URL(location.href);
  if (initial.searchParams.has('mcp_request')) {
    const value = initial.searchParams.get('mcp_request');
    if (idPattern.test(value ?? '')) {
      id = value;
      try { sessionStorage.setItem(requestKey, id); } catch { /* Keep it for this view only. */ }
    }
    initial.searchParams.delete('mcp_request');
    history.replaceState(history.state, '', initial.pathname + initial.search + initial.hash);
  } else {
    try { id = sessionStorage.getItem(requestKey); } catch { /* No stored request. */ }
  }
  function clearRequest() {
    id = pending = null;
    try { sessionStorage.removeItem(requestKey); } catch { /* The current view has already cleared it. */ }
    approval.hidden = true;
  }

  async function refresh() {
    const current = ++revision;
    try {
      const result = await json('mcp-grants');
      if (current !== revision) return;
      panel.hidden = false;
      grants = result.grants;
      updateProvider();
      void loadPlans();
      if (typeof result.endpoint === 'string' && result.endpoint !== byId('mcp-endpoint').value) {
        byId('mcp-endpoint').value = result.endpoint;
        byId('mcp-endpoint').dispatchEvent(new Event('change'));
      }
      notice.textContent = result.grants.length ? '' : 'Nenhum assistente autorizado nesta sessão.';
      entries.replaceChildren();
      for (const grant of result.grants) {
        const row = document.createElement('li');
        row.className = 'rhea-controls';
        const label = document.createElement('span');
        label.textContent = grant.client + ' · ' + (grant.persistent
          ? (grant.scope.includes('rhea:organize') ? 'Leitura e organização até revogação' : 'Leitura até revogação')
          : 'Autorização até ' + new Date(grant.expires * 1000).toLocaleTimeString('pt-BR'));
        const revoke = document.createElement('button');
        revoke.className = 'editorial-action';
        revoke.type = 'button';
        revoke.textContent = 'Revogar';
        revoke.setAttribute('aria-label', 'Revogar ' + grant.client);
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try { await json('mcp-unlink', body({ id: grant.id })); await refresh(); }
          catch (error) { notice.textContent = error.message; revoke.disabled = false; }
        });
        row.append(label, revoke);
        entries.append(row);
      }
      if (!id) return;
      pending = null;
      approve.disabled = allowOrganize.disabled = deny.disabled = true;
      try {
        const result = await json('mcp-review?' + new URLSearchParams({ id }));
        if (current !== revision) return;
        pending = result;
        approval.hidden = false;
        approve.disabled = !pending.account;
        allowOrganize.disabled = deny.disabled = false;
        allowOrganize.hidden = !pending.canOrganize;
        approve.textContent = pending.scope.includes('rhea:propose') ? 'Autorizar leitura e propostas' : 'Autorizar leitura';
        if (displayedRequest !== id) {
          displayedRequest = id;
          approval.scrollIntoView({ block: 'nearest' });
        }
        byId('mcp-consent-text').textContent = pending.client + ' solicita ler nomes, metadados e trechos de texto de arquivos autorizados na RHEA' +
          (pending.scope.includes('rhea:propose') ? ' e propor alterações para sua aprovação' : '') +
          (pending.account ? ' na conta ' + pending.account + '.' : '. Conecte sua conta na seção Google Drive.') +
          (pending.canOrganize ? ' Se permitir organização, o conector também poderá criar pastas e mover arquivos dentro da raiz até você revogar.' : '');
      } catch (error) {
        if (current !== revision) return;
        if (error.status === 404) clearRequest();
        notice.textContent = error.message;
      }
    } catch (error) {
      if (current !== revision) return;
      panel.hidden = false;
      plans.hidden = true;
      grants = null;
      updateProvider();
      notice.textContent = error.message;
    }
  }

  for (const [control, accepted, organize] of [[approve, true, false], [allowOrganize, true, true], [deny, false, false]]) {
    control.addEventListener('click', async () => {
      if (!pending) return;
      approve.disabled = allowOrganize.disabled = deny.disabled = true;
      try {
        const result = await json('mcp-approve', body({ id, accepted, organize, proof: pending.proof }));
        clearRequest();
        location.assign(result.callback);
      } catch (error) {
        notice.textContent = error.message;
        if (error.status === 409 || error.status === 404) {
          void refresh();
          return;
        }
        deny.disabled = allowOrganize.disabled = false;
        approve.disabled = !pending?.account;
      }
    });
  }
  byId('mcp-refresh').addEventListener('click', () => void refresh());
  window.addEventListener('rhea-assistant-activated', () => void refresh());
  window.addEventListener('rhea-drive-changed', () => { if (!byId('assistente').hidden) void refresh(); });
  void refresh();
}
