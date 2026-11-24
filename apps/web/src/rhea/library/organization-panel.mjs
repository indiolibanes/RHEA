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
  let approval;
  let active;
  let paused;
  let approved = false;

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
    active = selection = approval = undefined;
    approved = false;
    paused = true;
    if (dialog.open) dialog.close();
    container.hidden = run.hidden = pause.hidden = progress.hidden = true;
    showProgress(0, 0, 0, '');
    review.disabled = false;
    status.textContent = '';
  }

  function prepare(value) {
    clear();
    selection = value;
    container.hidden = false;
  }

  async function request(operation, signal, confirmation) {
    const response = await fetch(endpoint + '?op=organize' + operation, { method: 'POST', credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selection, ...confirmation }),
    });
    return response.json();
  }

  function display(result) {
    const details = result.mirror;
    const side = { local: 'No mesmo grupo', destination: 'No backup', source: 'Na origem' }[result.issue?.side];
    const reason = {
      destination_not_empty: 'o tópico precisa estar vazio para o piloto.',
      group_protected: 'o Telegram impede a cópia de conteúdo protegido.',
      group_not_owned: 'a conta conectada precisa ser proprietária do grupo.',
      history_limit: 'o tópico de origem precisa ter até 60 publicações neste piloto.',
      selection_changed: 'um arquivo aprovado mudou ou saiu do tópico.',
      topic_name: 'o tópico deixou de corresponder à letra esperada.',
      album_or_reply: 'a seleção dividiria um álbum ou uma resposta.',
      unsupported_post: 'uma publicação selecionada exige conferência no Telegram.',
    }[result.issue?.code];
    run.hidden = result.state !== 'mirror_progress';
    if (result.state === 'mirror_progress' || result.state === 'mirror_done') {
      if (!details?.localCopies || !details.copies) {
        run.hidden = true;
        status.textContent = 'Não foi possível validar as confirmações dos dois destinos.';
        return;
      }
      progress.hidden = false;
      showProgress(details.localCopies.length, details.copies.length, details.total,
        result.state === 'mirror_done' ? 'done' : paused ? 'paused' : 'running');
      const counts = 'Mesmo grupo: ' + details.localCopies.length + ' de ' + details.total +
        ' verificadas. Backup: ' + details.copies.length + ' de ' + details.total + ' verificadas.';
      status.textContent = result.state === 'mirror_done' ? 'Cópia concluída. ' + counts : counts;
      return;
    }
    const messages = {
      mirror_disabled: 'A publicação piloto precisa ser habilitada no Railway.',
      mirror_recovery: 'A execução precisa de conferência manual. Confira os tópicos antes de qualquer nova cópia.',
      mirror_changed: 'O plano ou o conteúdo mudou. Confira a origem e ambos os destinos.',
      mirror_ineligible: 'A seleção ainda não atende às condições da cópia.',
      rate_limited: 'O Telegram pediu uma pausa. Aguarde antes de retomar.',
    };
    if (result.state === 'mirror_recovery' && details?.localCopies && details.copies) {
      progress.hidden = false;
      showProgress(details.localCopies.length, details.copies.length, details.total, 'recovery');
    }
    status.textContent = reason && side ? side + ', ' + reason + (result.issue.postId ? ' Post #' + result.issue.postId + '.' : '') :
      messages[result.state] ?? 'Não foi possível confirmar a operação. Revise o progresso antes de retomar.';
  }

  async function handle(action) {
    if (!selection || active) return;
    if (action === 'preview') approved = false;
    const controller = new AbortController();
    active = controller;
    review.disabled = run.disabled = true;
    const { signal } = controller;
    try {
      if (action === 'next') {
        pause.hidden = false;
        paused = false;
        let remaining = 4 * selection.ids.length;
        let result;
        do {
          result = await request('next', signal);
          if (signal.aborted) return;
          display(result);
        } while (result.state === 'mirror_progress' && !paused && --remaining > 0);
        if (paused && result.state === 'mirror_progress') {
          status.textContent += ' Cópia pausada.';
          const d = result.mirror;
          if (d?.localCopies && d.copies) showProgress(d.localCopies.length, d.copies.length, d.total, 'paused');
        }
      } else {
        status.textContent = action === 'preview' ? 'Validando os arquivos e os dois tópicos…' : 'Registrando sua aprovação…';
        const result = await request(action, signal, action === 'approve' ? { approval, confirm: true } : undefined);
        if (signal.aborted) return;
        if (action === 'preview' && result.state === 'mirror_preview') {
          const preview = result.mirror;
          if (!preview?.localDestination || !preview.destination ||
              preview.posts?.length !== selection.ids.length ||
              preview.posts.some((post, index) => post.id !== selection.ids[index])) {
            display({ state: 'mirror_changed' });
            return;
          }
          approval = preview.approval;
          get('publish-targets').textContent = preview.localDestination + ' · ' + preview.destination;
          get('publish-files').replaceChildren(...preview.posts.map(post =>
            Object.assign(document.createElement('li'), { textContent: '#' + post.id + ' · ' + post.label })));
          status.textContent = 'Confira a ordem e confirme a cópia no diálogo.';
          dialog.showModal();
        } else display(result);
      }
    } catch {
      if (!signal.aborted) display({ state: 'unavailable' });
    } finally {
      if (active === controller) {
        active = undefined;
        pause.hidden = true;
        review.disabled = run.disabled = false;
        if (action === 'approve' && !run.hidden) run.focus();
        else if (action !== 'approve' && !dialog.open && !run.hidden) run.focus();
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
  pause.addEventListener('click', () => { paused = true; });
  return { clear, prepare };
}
