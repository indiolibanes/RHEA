import { organizationInput, rebuildIntakeLimit, rebuildIntakeScan, rebuildLimit } from './organization-contract.mjs';

export function organizationPublication(get, endpoint) {
  const container = get('publish');
  const dialog = get('publish-dialog');
  const review = get('publish-review');
  const run = get('publish-run');
  const pause = get('publish-pause');
  const reopen = get('publish-reopen');
  const status = get('publish-status');
  const progress = get('progress');
  const storageKey = 'rhea:telegram:copy:v1:' + endpoint;
  const rows = {
    local: { bar: get('progress-local'), text: get('progress-local-text') },
    backup: { bar: get('progress-backup'), text: get('progress-backup-text') },
  };
  let selection;
  let rebuild;
  let reconstructionIds;
  let approval;
  let active;
  let paused;
  let approved = false;
  let retryUntil = 0;
  let retryTimer;
  let resumeAfterWait = false;
  let lastProgress;
  let recovery;

  function savedCopy() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!Number.isSafeInteger(saved?.retryAt) || saved.retryAt < 1 || typeof saved.automatic !== 'boolean') return;
      const operation = saved.selection?.replacementTopicId === undefined ? 'organizestatus' : 'rebuildstatus';
      const plan = organizationInput(operation, saved.selection);
      if (plan) return { selection: plan, retryAt: saved.retryAt, automatic: saved.automatic };
    } catch { /* Storage can be disabled or cleared by the browser. */ }
  }

  const matchesSavedCopy = plan => JSON.stringify(plan) === JSON.stringify(savedCopy()?.selection);

  function saveCopy(onlyIfSaved = false) {
    try {
      const plan = organizationInput(rebuild ? 'rebuildstatus' : 'organizestatus', selection);
      if (plan && (!onlyIfSaved || matchesSavedCopy(plan))) {
        localStorage.setItem(storageKey, JSON.stringify({ selection: plan, retryAt: retryUntil, automatic: resumeAfterWait }));
      }
    } catch { /* The copy can still continue in the current tab. */ }
  }

  function removeSavedCopy() {
    try {
      const plan = organizationInput(rebuild ? 'rebuildstatus' : 'organizestatus', selection);
      if (plan && matchesSavedCopy(plan)) localStorage.removeItem(storageKey);
    } catch { /* Storage can be disabled. */ }
  }

  // Each destination reports on its own: verified copies of the total plus a text state, never color alone.
  function showProgress(local, backup, total, state) {
    const label = (count, done) => {
      const stateText = state === 'recovery' ? 'conferência manual' : done ? 'concluído' :
        state === 'paused' ? 'pausado' : state === 'running' ? 'em andamento' : 'aguardando';
      return count + ' de ' + total + ' verificadas · ' + stateText;
    };
    for (const [key, count] of [['local', local], ['backup', backup]]) {
      rows[key].bar.max = Math.max(total, 1);
      rows[key].bar.value = count;
      rows[key].text.textContent = total ? label(count, count === total) : '';
    }
  }

  function clear() {
    active?.abort();
    active = selection = approval = reconstructionIds = undefined;
    rebuild = false;
    recovery = undefined;
    clearInterval(retryTimer);
    resumeAfterWait = false;
    lastProgress = undefined;
    approved = false;
    paused = true;
    if (dialog.open) dialog.close();
    container.hidden = run.hidden = pause.hidden = progress.hidden = reopen.hidden = true;
    showProgress(0, 0, 0, '');
    review.hidden = review.disabled = false;
    status.textContent = '';
    run.textContent = 'Executar cópia';
  }

  function showCooldown(action) {
    clearInterval(retryTimer);
    const copying = action === 'next';
    run.hidden = !copying;
    pause.hidden = !resumeAfterWait;
    pause.textContent = 'Pausar retomada automática';
    if (copying && lastProgress) renderProgress(lastProgress, 'paused');
    status.textContent = recovery ? 'Letra ' + selection.letter + ' · Reabra a cópia salva para continuar.' : copying && resumeAfterWait ?
      'O Telegram pediu uma pausa. A cópia será retomada automaticamente nesta aba.' :
      'O Telegram pediu uma pausa. Aguarde o intervalo para continuar.';
    const countdownButton = copying ? run : review;
    const actionLabel = copying ? 'Retomar cópia' : rebuild ? 'Revisar reconstrução' : 'Revisar publicação';
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
      review.disabled = run.disabled = remaining > 0 || Boolean(active || recovery);
      run.hidden = !copying || (!remaining && Boolean(recovery));
      countdownButton.textContent = remaining ? 'Aguarde ' + remaining + ' s' : actionLabel;
      if (remaining) return;
      clearInterval(retryTimer);
      pause.hidden = true;
      if (recovery) return;
      if (resumeAfterWait) {
        resumeAfterWait = false;
        status.textContent = 'Retomando a cópia…';
        void handle('next', true);
      } else {
        status.textContent = 'O intervalo terminou. Você pode ' + (copying ? 'retomar a cópia.' : 'repetir a revisão.');
      }
    };
    retryTimer = setInterval(tick, 1000);
    if (!active || retryUntil > Date.now()) tick();
  }

  function pauseForTelegram(result, action) {
    if (!Number.isInteger(result.retryAfter) || result.retryAfter < 1) return;
    const received = Date.now();
    const estimate = received + result.retryAfter * 1000;
    retryUntil = Number.isSafeInteger(result.retryAt) && Math.abs(result.retryAt - estimate) <= 5000 ? result.retryAt : estimate;
    resumeAfterWait = action === 'next' && !paused;
    if (action === 'next') saveCopy();
    showCooldown(action);
  }

  // A reconstruction may include the backup group's Letter topic as a second destination.
  const hasBackup = () => !rebuild || selection?.backupTopicId !== undefined;

  function configure(value, rebuildIds) {
    clear();
    selection = value;
    rebuild = value.replacementTopicId !== undefined;
    reconstructionIds = rebuildIds;
    rows.backup.bar.closest('li').hidden = rebuild && !hasBackup();
    rows.local.bar.closest('li').querySelector('span').textContent = rebuild ? 'Tópico [NEW]' : 'Mesmo grupo';
    get('publish-title').textContent = rebuild ? 'Aprovar reconstrução da letra' : 'Aprovar cópia para os dois tópicos';
    review.textContent = rebuild ? 'Revisar reconstrução' : 'Revisar publicação';
    container.hidden = false;
  }

  function prepare(value, rebuildIds) {
    configure(value, rebuildIds);
    if (retryUntil > Date.now()) showCooldown('preview');
  }

  function restore() {
    if (selection) return;
    const saved = savedCopy();
    if (!saved) return;
    configure(saved.selection);
    recovery = saved;
    retryUntil = Math.max(retryUntil, saved.retryAt);
    review.hidden = true;
    reopen.hidden = false;
    container.closest('details').open = true;
    showCooldown('next');
  }

  async function request(operation, signal, confirmation) {
    const response = await fetch(endpoint + '?op=' + (rebuild ? 'rebuild' : 'organize') + operation, { method: 'POST', credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selection, ...confirmation }),
    });
    return response.json();
  }

  function renderProgress(details, state) {
    progress.hidden = false;
    const local = (hasBackup() ? details.localCopies : details.copies).length;
    const backup = hasBackup() ? details.copies.length : 0;
    showProgress(local, backup, details.total, state);
    return { local, backup };
  }

  function display(result) {
    const details = result.mirror;
    const side = { local: rebuild ? 'No tópico [NEW]' : 'No mesmo grupo', destination: rebuild && !hasBackup() ? 'No tópico [NEW]' : 'No backup',
      source: 'Na origem', account: 'Na conexão Telegram' }[result.issue?.side];
    const postReason = {
      service_event: 'é um evento de serviço do Telegram.',
      reply: 'tem uma resposta com vínculo que a RHEA não conseguiu preservar.',
      protected_or_temporary: 'tem conteúdo protegido ou temporário.',
      forwarded_or_bot: 'foi encaminhada ou veio de um bot.',
      text_format: 'usa uma legenda ou formatação que o piloto não consegue preservar.',
      media_type: 'usa um tipo de mídia fora do piloto.',
      media_reference: 'tem uma referência de mídia indisponível.',
      filename: 'tem um nome de arquivo que o piloto não consegue preservar.',
      file_size: 'excede o limite permitido para mídia nesse piloto.',
      large_file_size: 'excede 4 GiB por arquivo.',
    }[result.issue?.detail];
    const reason = {
      account_unverified: 'reconecte a conta autorizada e tente novamente.',
      group_unavailable: 'confira o convite e a participação da conta conectada no grupo.',
      group_not_forum: 'o grupo cadastrado precisa ter tópicos habilitados.',
      destination_not_empty: 'o tópico precisa estar vazio para o piloto.',
      group_protected: 'o Telegram impede a cópia de conteúdo protegido.',
      group_not_owned: 'a conta conectada precisa ser proprietária do grupo.',
      backup_unconfigured: 'o grupo de backup não está configurado no Railway. Configure-o ou desmarque a cópia no backup.',
      history_limit: rebuild ? (result.issue?.detail === 'scan_budget' ?
        'um arquivo selecionado está além das últimas ' + rebuildIntakeScan + ' mensagens de Requests. Selecione arquivos mais recentes ou divida o lote.' :
        'a letra combinada passa de ' + rebuildLimit + ' publicações (limite de um plano), ou o tópico atual é maior que isso. Selecione até ' + rebuildIntakeLimit + ' arquivos de Requests por plano.') :
        'o tópico de origem precisa ter até 60 publicações neste piloto.',
      selection_changed: 'um arquivo aprovado mudou ou saiu do tópico.',
      topic_name: 'o tópico deixou de corresponder à letra esperada.',
      dual_topic_name: 'o nome do tópico deixou de corresponder à configuração do piloto.',
      topic_missing: 'o tópico não foi encontrado. Confira os destinos novamente.',
      topic_closed: 'reabra o tópico de destino no Telegram e confira os destinos novamente.',
      source_empty: 'nenhuma publicação da seleção foi encontrada. Recarregue o inventário.',
      history_unverified: 'a leitura ficou incompleta ou o tópico mudou durante a revisão. Pause novas publicações no tópico e carregue a prévia novamente.',
      album_or_reply: 'a seleção dividiria um álbum ou uma resposta.',
      insertion_splits_album: 'o ponto de inserção divide um álbum. Escolha o começo do lote ou a publicação seguinte.',
      unsupported_post: postReason ? 'a publicação ' + postReason : 'uma publicação selecionada exige conferência no Telegram.',
    }[result.issue?.code];
    run.hidden = result.state !== 'mirror_progress';
    if (result.state === 'mirror_progress' || result.state === 'mirror_done') {
      if (!details?.copies || (hasBackup() && !details.localCopies)) {
        run.hidden = true;
        status.textContent = 'Não foi possível validar as confirmações dos dois destinos.';
        return;
      }
      lastProgress = details;
      const { local, backup } = renderProgress(details, result.state === 'mirror_done' ? 'done' : paused ? 'paused' : 'running');
      const counts = (rebuild ? 'Tópico [NEW]: ' : 'Mesmo grupo: ') + local + ' de ' + details.total +
        ' verificadas.' + (hasBackup() ? ' Backup: ' + backup + ' de ' + details.total + ' verificadas.' : '');
      status.textContent = result.state === 'mirror_done' ? 'Cópia concluída. ' + counts : counts;
      return;
    }
    const messages = {
      mirror_disabled: 'A publicação piloto precisa ser habilitada no Railway.',
      mirror_recovery: 'A execução precisa de conferência manual. Confira os tópicos antes de qualquer nova cópia.',
      mirror_changed: 'O plano ou o conteúdo mudou. Confira as origens e os destinos da revisão.',
      mirror_idle: 'A cópia salva não tem uma aprovação ativa. Prepare uma nova revisão.',
      mirror_ineligible: 'A revisão foi bloqueada sem um motivo detalhado nesta versão do leitor. Recarregue a prévia e confira a versão do leitor no Railway.',
      disconnected: 'Reconecte o Telegram e repita a revisão.',
      access_required: 'Entre no Private novamente para revisar a cópia.',
      not_allowed: 'A conta atual não tem acesso à revisão da cópia.',
      busy: 'Outra leitura do Telegram está em andamento. Aguarde alguns instantes e tente novamente.',
      rate_limited: 'O Telegram pediu uma pausa. Aguarde antes de retomar.',
    };
    if (result.state === 'mirror_recovery' && details?.copies && (!hasBackup() || details.localCopies)) {
      renderProgress(details, 'recovery');
    }
    status.textContent = reason && side ? side + ', ' + reason + (result.issue.postId ? ' Post #' + result.issue.postId + '.' : '') :
      messages[result.state] ?? 'Não foi possível confirmar a operação. Revise o progresso antes de retomar.';
  }

  async function handle(action, automatic = false) {
    if (!selection || active || recovery || Date.now() < retryUntil) return;
    if (action === 'preview') approved = false;
    const controller = new AbortController();
    active = controller;
    review.disabled = run.disabled = true;
    const { signal } = controller;
    try {
      if (action === 'next') {
        pause.hidden = false;
        pause.textContent = 'Pausar após este lote';
        paused = false;
        if (lastProgress) renderProgress(lastProgress, 'running');
        let remaining = rebuild ? (hasBackup() ? 4 : 2) * (reconstructionIds?.length ?? rebuildLimit) : 4 * selection.ids.length;
        let result;
        do {
          result = await request('next', signal);
          if (signal.aborted) return;
          if (['mirror_done', 'mirror_recovery', 'mirror_changed', 'mirror_idle'].includes(result.state)) removeSavedCopy();
          display(result);
          if (result.state === 'rate_limited') pauseForTelegram(result, action);
        } while (result.state === 'mirror_progress' && !paused && --remaining > 0);
        if (paused && result.state === 'mirror_progress') {
          status.textContent += ' Cópia pausada.';
        }
      } else {
        status.textContent = action === 'preview' ? 'Validando as publicações e os tópicos…' : 'Registrando sua aprovação…';
        const result = await request(action, signal, action === 'approve' ? { approval, confirm: true } : undefined);
        if (signal.aborted) return;
        if (action === 'preview' && result.state === 'mirror_preview') {
          const preview = result.mirror;
          const ids = reconstructionIds ?? selection.ids;
          if (!preview?.destination || (rebuild ? !preview.source : !preview.localDestination) ||
              (rebuild && hasBackup() && !preview.localDestination) ||
              preview.posts?.length !== ids.length ||
              preview.posts.some((post, index) => post.id !== ids[index])) {
            display({ state: 'mirror_changed' });
            return;
          }
          approval = preview.approval;
          get('publish-targets').textContent = rebuild ? preview.source + ' → ' + (hasBackup() ? preview.localDestination + ' · ' + preview.destination : preview.destination) :
            preview.localDestination + ' · ' + preview.destination;
          get('publish-files').replaceChildren(...preview.posts.map(post =>
            Object.assign(document.createElement('li'), { textContent: '#' + post.id + ' · ' + post.label })));
          status.textContent = 'Confira a ordem e confirme a cópia no diálogo.';
          dialog.showModal();
        } else {
          display(result);
          if (result.state === 'rate_limited') pauseForTelegram(result, action);
        }
      }
    } catch {
      if (!signal.aborted) display({ state: 'unavailable' });
    } finally {
      if (active === controller) {
        active = undefined;
        pause.hidden = !resumeAfterWait;
        review.disabled = run.disabled = Date.now() < retryUntil;
        if (!automatic && !dialog.open && !run.hidden && !run.disabled) run.focus();
      }
    }
  }

  // Closing the dialog returns focus to the control that opened it, or to the next action after approval.
  dialog.addEventListener('close', () => { if (selection && !approved) review.focus(); });
  review.addEventListener('click', () => handle('preview'));
  get('publish-approve').addEventListener('click', () => {
    if (!approval) return;
    approved = true;
    dialog.close();
    void handle('approve');
  });
  run.addEventListener('click', () => handle('next'));
  reopen.addEventListener('click', () => {
    if (!recovery) return;
    resumeAfterWait = recovery.automatic;
    recovery = undefined;
    reopen.hidden = true;
    showCooldown('next');
    if (!run.disabled) run.focus();
    else if (!pause.hidden) pause.focus();
  });
  pause.addEventListener('click', () => {
    paused = true;
    if (resumeAfterWait) {
      resumeAfterWait = false;
      pause.hidden = true;
      status.textContent = 'Retomada automática pausada. Aguarde o intervalo para retomar manualmente.';
    }
    saveCopy(true);
  });
  return { clear, prepare, restore };
}
