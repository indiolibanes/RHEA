const MiB = 1024 ** 2;
const perFileLimit = 48 * MiB;
const retainedBytes = 128 * MiB;
const waiting = new Set(['waiting', 'offline', 'login', 'paused']);
const terminal = new Set(['synced', 'cancelled']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = error => !error.status || error.status === 429 || error.status >= 500;
const message = error => String(error?.message ?? 'O envio falhou.').slice(0, 260);

export function indexedQueue(indexedDB) {
  const connection = new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error('IndexedDB indisponível.')); return; }
    const request = indexedDB.open('rhea-uploads', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('uploads', { keyPath: ['owner', 'id'] }).createIndex('owner', 'owner');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Feche outras abas antigas do Rhea.'));
  });
  // Browsers can reject access before the first authenticated status check.
  void connection.catch(() => {});
  async function execute(mode, action) {
    const db = await connection;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('uploads', mode);
      const request = action(tx.objectStore('uploads'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }
  return {
    all: owner => execute('readonly', store => store.index('owner').getAll(owner)),
    get: (owner, id) => execute('readonly', store => store.get([owner, id])),
    put: item => execute('readwrite', store => store.put(item)),
    remove: item => execute('readwrite', store => store.delete([item.owner, item.id])),
  };
}

export function uploadQueue({ api, store, update = () => {}, complete = () => {}, online = () => true,
  locks, concurrency = 2, wait = delay }) {
  const items = new Map();
  const active = new Set();
  const activeNames = new Set();
  const maxActive = Math.max(1, Math.min(4, Math.trunc(concurrency) || 2));
  let owner = null;
  let account = null;
  let initialized = false;
  let desired;
  let boot;
  let contextChain = Promise.resolve();

  function notify() { update([...items.values()]); }

  async function persist(item) {
    if (!item.owner) return;
    const { data, stored, ...metadata } = item;
    try { await store.put({ ...metadata, ...(stored && data ? { data } : {}) }); }
    catch {
      item.stored = false;
      try { await store.put(metadata); }
      catch { item.metadataLost = true; }
    }
  }

  function setContext(nextOwner, nextAccount) {
    if (desired?.owner === nextOwner && desired?.account === nextAccount) return contextChain;
    desired = { owner: nextOwner, account: nextAccount };
    contextChain = contextChain.catch(() => {}).then(async () => {
      account = nextAccount;
      if (owner !== nextOwner) {
        const staged = owner == null ? [...items.values()].filter(item => !item.owner) : [];
        owner = nextOwner;
        initialized = false;
        boot = null;
        items.clear();
        if (owner) {
          const stored = await store.all(owner).catch(() => []);
          for (const record of stored) {
            if (terminal.has(record.state) && Date.now() - record.created > 7 * 86_400_000) {
              await store.remove(record).catch(() => {});
              continue;
            }
            const item = { ...record, stored: Boolean(record.data) };
            if (['uploading', 'confirming'].includes(item.state)) item.state = 'waiting';
            if (!terminal.has(item.state) && !item.data) {
              item.state = 'failed';
              item.error = 'Os bytes deste arquivo não estavam preservados neste navegador.';
            }
            items.set(item.id, item);
          }
          for (const item of staged) {
            item.owner = owner;
            item.stored = canStore(item.size);
            items.set(item.id, item);
            await persist(item);
          }
          initialized = true;
        } else {
          for (const item of staged) items.set(item.id, item);
        }
      }
      resume();
    });
    return contextChain;
  }

  function canStore(size) {
    const total = [...items.values()].reduce((sum, item) => sum + (item.stored ? item.size : 0), 0);
    return size <= perFileLimit && size + total <= retainedBytes;
  }

  async function add(files, parent = null) {
    await contextChain;
    const batch = crypto.randomUUID();
    for (const data of files) {
      const valid = typeof data?.name === 'string' && data.name.trim() && data.name.length <= 200 &&
        !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(data.name) && !['.', '..'].includes(data.name) &&
        data.size >= 1 && data.size <= 512 * MiB;
      const item = { id: crypto.randomUUID(), batch, owner, account, parent, name: data.name, size: data.size,
        created: Date.now(), state: valid ? 'waiting' : 'failed', offset: 0, data: valid ? data : undefined,
        stored: Boolean(valid && owner && canStore(data.size)),
        error: valid ? '' : 'Arquivo vazio, acima de 512 MiB ou com nome inválido.' };
      items.set(item.id, item);
    }
    notify();
    for (const item of items.values()) if (item.batch === batch) await persist(item);
    resume();
    return batch;
  }

  function availability(item) {
    if (!online()) return 'offline';
    if (!owner || !account) return 'login';
    if (item.owner !== owner || (item.account && item.account !== account)) return 'paused';
    return 'waiting';
  }

  function resume() {
    for (const item of items.values()) if (waiting.has(item.state)) item.state = availability(item);
    notify();
    pump();
  }

  function pump() {
    if (!initialized || !account || !online()) return;
    for (const item of items.values()) {
      if (active.size >= maxActive) return;
      if (item.state !== 'waiting' || active.has(item.id)) continue;
      const key = JSON.stringify([item.account ?? account, item.parent, item.name]);
      if (activeNames.has(key)) continue;
      active.add(item.id);
      activeNames.add(key);
      const task = async () => {
        const previous = await store.get(item.owner, item.id).catch(() => null);
        if (previous && terminal.has(previous.state)) {
          Object.assign(item, previous, { data: undefined, stored: false });
          notify();
          return;
        }
        if (previous?.reservation) {
          item.reservation = previous.reservation;
          item.ticket = previous.ticket;
        }
        await run(item);
      };
      const work = locks?.request ? locks.request('rhea-upload-' + item.id, task) : task();
      void work.catch(async error => {
        item.state = 'failed';
        item.error = message(error);
        await persist(item);
        notify();
      }).finally(() => { active.delete(item.id); activeNames.delete(key); pump(); });
    }
  }

  async function bootstrap(item) {
    if (!boot || boot.account !== item.account || boot.owner !== item.owner) {
      const execute = () => api.bootstrap(item.account);
      const result = locks?.request ? locks.request('rhea-bootstrap-' + item.owner + '-' + item.account, execute) : execute();
      boot = { account: item.account, owner: item.owner, result };
      const operation = boot;
      void result.catch(() => { if (boot === operation) boot = null; });
    }
    await boot.result;
  }

  function guard(item) {
    const state = availability(item);
    if (state !== 'waiting') throw Object.assign(new Error(), { queueState: state });
  }

  async function transfer(item) {
    guard(item);
    if (!item.reservation) {
      if (!item.parent) {
        await bootstrap(item);
        guard(item);
      }
      item.reservation = (await api.reserve(item)).reservation;
      // Store the Drive ID capability before any bytes are sent.
      await persist(item);
    }
    guard(item);
    let result;
    if (item.ticket) {
      try { result = await api.chunk(item, 'bytes */' + item.size); }
      catch (error) {
        if (error.code !== 'expired_upload' && error.code !== 'invalid_upload') throw error;
        item.ticket = undefined;
        await persist(item);
      }
      if (result?.file) return result.file;
    }
    if (!item.ticket) {
      const start = await api.start(item);
      if (start.file) return start.file;
      item.ticket = start.ticket;
      item.chunkSize = start.chunkSize;
      await persist(item);
      result = { offset: 0 };
    }
    if (!Number.isInteger(item.chunkSize) || item.chunkSize < 256 * 1024 || item.chunkSize > 8 * MiB) {
      throw Object.assign(new Error('O Drive retornou um tamanho de trecho inválido.'), { status: 400 });
    }
    item.offset = result.offset;
    while (Number.isInteger(item.offset) && item.offset >= 0 && item.offset < item.size) {
      guard(item);
      const end = Math.min(item.offset + item.chunkSize, item.size);
      item.state = end === item.size ? 'confirming' : 'uploading';
      notify();
      const part = item.data.slice(item.offset, end);
      result = await api.chunk(item, `bytes ${item.offset}-${end - 1}/${item.size}`, part);
      if (result.file) return result.file;
      if (!Number.isInteger(result.offset) || result.offset <= item.offset || result.offset > end) break;
      item.offset = result.offset;
      notify();
    }
    throw Object.assign(new Error('O Drive ainda não confirmou o arquivo.'), { status: 503 });
  }

  async function run(item) {
    if (item.state !== 'waiting') return;
    if (!item.data) {
      item.state = 'failed';
      item.error = 'Selecione novamente o arquivo de origem.';
      notify();
      return;
    }
    item.account ??= account;
    item.state = 'uploading';
    item.error = '';
    notify();
    await persist(item);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const file = await transfer(item);
        if (!file?.id || file.size !== item.size) throw new Error('Tamanho ou identificador sem confirmação no Google Drive.');
        Object.assign(item, { remote: file, state: 'synced', offset: item.size, data: undefined, stored: false,
          ticket: undefined, reservation: undefined });
        await persist(item);
        notify();
        await Promise.resolve(complete(item)).catch(() => {});
        return;
      } catch (error) {
        const stop = error.queueState ?? (!online() ? 'offline' : error.status === 401 ? 'login' : null);
        if (error.status === 401 && account === item.account) {
          account = null;
          desired = null;
          boot = null;
        }
        if (!stop && retryable(error) && attempt < 4) {
          await wait(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 200);
          continue;
        }
        item.state = stop ?? (error.code === 'name_conflict' ? 'conflict' : 'failed');
        item.error = message(error);
        await persist(item);
        notify();
        return;
      }
    }
  }

  async function cancel(item) {
    if (active.has(item.id) || terminal.has(item.state)) return;
    Object.assign(item, { state: 'cancelled', data: undefined, stored: false, reservation: undefined, ticket: undefined });
    await persist(item);
    notify();
  }

  async function retry(item, keepBoth = false) {
    if (active.has(item.id) || terminal.has(item.state) || !item.data) return;
    Object.assign(item, { state: 'paused', error: '', keepBoth: item.keepBoth || keepBoth });
    await persist(item);
    resume();
  }

  return { add, cancel, retry, resume, setContext, snapshot: () => [...items.values()] };
}
