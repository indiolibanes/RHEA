export function organizationPublication(get, endpoint) {
  const container = get('publish');
  const dialog = get('publish-dialog');
  const review = get('publish-review');
  const run = get('publish-run');
  const pause = get('publish-pause');
  const status = get('publish-status');
  const progress = get('progress');
  const rows = {
    local: { bar: get('progress-local'), text: get('progress-local-text') },
    backup: { bar: get('progress-backup'), text: get('progress-backup-text') },
  };
  let selection;
  let reconstructionIds;
  let approval;
  let active;
  let paused;
  let approved = false;
  let retryUntil = 0;
  let retryTimer;
  let resumeAfterWait = false;
  let lastProgress;

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
    clearInterval(retryTimer);
    resumeAfterWait = false;
    lastProgress = undefined;
    approved = false;
    paused = true;
    if (dialog.open) dialog.close();
    container.hidden = run.hidden = pause.hidden = progress.hidden = true;
    showProgress(0, 0, 0, '');
    review.disabled = false;
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
    status.textContent = copying && resumeAfterWait ?
      'O Telegram pediu uma pausa. A cópia será retomada automaticamente nesta aba.' :
      'O Telegram pediu uma pausa. Aguarde o intervalo para continuar.';
    const countdownButton = copying ? run : review;
    const actionLabel = copying ? 'Retomar cópia' : reconstructionIds ? 'Revisar reconstrução' : 'Revisar publicação';
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
      review.disabled = run.disabled = remaining > 0 || Boolean(active);
      countdownButton.textContent = remaining ? 'Aguarde ' + remaining + ' s' : actionLabel;
      if (remaining) return;
      clearInterval(retryTimer);
      pause.hidden = true;
      if (resumeAfterWait) {
        resumeAfterWait = false;
        status.textContent = 'Retomando a cópia…';
        void handle('next', true);
      } else {
        status.textContent = 'O intervalo terminou. Você pode ' + (copying ? 'retomar a cópia.' : 'repetir a revisão.');
      }
    };
    retryTimer = setInterval(tick, 1000);
    tick();
  }

  function pauseForTelegram(result, action) {
    if (!Number.isInteger(result.retryAfter) || result.retryAfter < 1) return;
    retryUntil = Date.now() + result.retryAfter * 1000;
    resumeAfterWait = action === 'next' && !paused;
    showCooldown(action);
  }

  function prepare(value, rebuildIds) {
    clear();
    selection = value;
    reconstructionIds = rebuildIds;
    rows.backup.bar.closest('li').hidden = Boolean(rebuildIds);
    rows.local.bar.closest('li').querySelector('span').textContent = rebuildIds ? 'Tópico [NEW]' : 'Mesmo grupo';
    get('publish-title').textContent = rebuildIds ? 'Aprovar reconstrução da letra' : 'Aprovar cópia para os dois tópicos';
    review.textContent = rebuildIds ? 'Revisar reconstrução' : 'Revisar publicação';
    container.hidden = false;
    if (retryUntil > Date.now()) showCooldown('preview');
  }

  async function request(operation, signal, confirmation) {
    const response = await fetch(endpoint + '?op=' + (reconstructionIds ? 'rebuild' : 'organize') + operation, { method: 'POST', credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selection, ...confirmation }),
    });
    return response.json();
  }

  function renderProgress(details, state) {
    progress.hidden = false;
    const local = (reconstructionIds ? details.copies : details.localCopies).length;
    const backup = reconstructionIds ? 0 : details.copies.length;
    showProgress(local, backup, details.total, state);
    return { local, backup };
  }

  function display(result) {
    const details = result.mirror;
    const side = { local: 'No mesmo grupo', destination: reconstructionIds ? 'No tópico [NEW]' : 'No backup',
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
      history_limit: reconstructionIds ? 'a leitura ultrapassou o limite do piloto: até 60 publicações em Requests e 240 na cópia combinada.' :
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
      if (!details?.copies || (!reconstructionIds && !details.localCopies)) {
        run.hidden = true;
        status.textContent = 'Não foi possível validar as confirmações dos dois destinos.';
        return;
      }
      lastProgress = details;
      const { local, backup } = renderProgress(details, result.state === 'mirror_done' ? 'done' : paused ? 'paused' : 'running');
      const counts = (reconstructionIds ? 'Tópico [NEW]: ' : 'Mesmo grupo: ') + local + ' de ' + details.total +
        ' verificadas.' + (reconstructionIds ? '' : ' Backup: ' + backup + ' de ' + details.total + ' verificadas.');
      status.textContent = result.state === 'mirror_done' ? 'Cópia concluída. ' + counts : counts;
      return;
    }
    const messages = {
      mirror_disabled: 'A publicação piloto precisa ser habilitada no Railway.',
      mirror_recovery: 'A execução precisa de conferência manual. Confira os tópicos antes de qualquer nova cópia.',
      mirror_changed: 'O plano ou o conteúdo mudou. Confira as origens e os destinos da revisão.',
      mirror_ineligible: 'A revisão foi bloqueada sem um motivo detalhado nesta versão do leitor. Recarregue a prévia e confira a versão do leitor no Railway.',
      disconnected: 'Reconecte o Telegram e repita a revisão.',
      access_required: 'Entre no Private novamente para revisar a cópia.',
      not_allowed: 'A conta atual não tem acesso à revisão da cópia.',
      busy: 'Outra leitura do Telegram está em andamento. Aguarde alguns instantes e tente novamente.',
      rate_limited: 'O Telegram pediu uma pausa. Aguarde antes de retomar.',
    };
    if (result.state === 'mirror_recovery' && details?.copies && (reconstructionIds || details.localCopies)) {
      renderProgress(details, 'recovery');
    }
    status.textContent = reason && side ? side + ', ' + reason + (result.issue.postId ? ' Post #' + result.issue.postId + '.' : '') :
      messages[result.state] ?? 'Não foi possível confirmar a operação. Revise o progresso antes de retomar.';
  }

  async function handle(action, automatic = false) {
    if (!selection || active || Date.now() < retryUntil) return;
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
        let remaining = reconstructionIds ? 2 * reconstructionIds.length : 4 * selection.ids.length;
        let result;
        do {
          result = await request('next', signal);
          if (signal.aborted) return;
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
          if (!preview?.destination || (reconstructionIds ? !preview.source : !preview.localDestination) ||
              preview.posts?.length !== ids.length ||
              preview.posts.some((post, index) => post.id !== ids[index])) {
            display({ state: 'mirror_changed' });
            return;
          }
          approval = preview.approval;
          get('publish-targets').textContent = reconstructionIds ? preview.source + ' → ' + preview.destination :
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
  pause.addEventListener('click', () => {
    paused = true;
    if (resumeAfterWait) {
      resumeAfterWait = false;
      pause.hidden = true;
      status.textContent = 'Retomada automática pausada. Aguarde o intervalo para retomar manualmente.';
    }
  });
  return { clear, prepare };
}
