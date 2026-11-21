import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { uploadQueue } from '../src/rhea/upload-queue.mjs';

function fixture() {
  const db = new Map();
  const store = {
    put: async item => db.set(item.id, { ...item }),
    get: async (owner, id) => db.get(id)?.owner === owner ? db.get(id) : null,
    all: async owner => [...db.values()].filter(item => item.owner === owner),
    remove: async item => db.delete(item.id),
  };
  const file = name => new File(['the original bytes'], name, { type: 'text/plain' });
  const error = (status, code) => Object.assign(new Error(code), { status, code });
  const until = async check => {
    for (let n = 0; n < 200; n++) {
      if (check()) return;
      await delay(5);
    }
    assert.fail('Queue did not reach the expected state');
  };
  return { db, store, file, error, until };
}

test('selection queues ten uploads, caps concurrency, and isolates a failed item', async () => {
  const { db, store, file, error, until } = fixture();
  let running = 0, peak = 0, starts = 0;
  let initialCount = 0;
  const queue = uploadQueue({ store, update: items => { initialCount ||= items.length; }, api: {
    bootstrap: async () => {},
    reserve: async item => ({ reservation: item.id }),
    start: async item => { starts++; return { ticket: item.id, chunkSize: 262144 }; },
    chunk: async (item, range, part) => {
      peak = Math.max(peak, ++running);
      await delay(6);
      running--;
      assert.equal(await part.text(), 'the original bytes');
      assert.equal(range, 'bytes 0-17/18');
      if (item.name === 'bad.txt') throw error(403, 'permission');
      return { file: { id: item.id, size: item.size } };
    },
  } });
  await queue.setContext('access-user', 'google-user');
  await queue.add(Array.from({ length: 10 }, (_, i) => file(i === 3 ? 'bad.txt' : i + '.txt')));
  await until(() => queue.snapshot().filter(i => i.state === 'synced').length === 9);
  assert.equal(initialCount, 10);
  assert.equal(starts, 10);
  assert.equal(peak, 2);
  assert.equal([...db.values()].filter(item => item.state === 'synced' && 'data' in item).length, 0);
  assert.equal(queue.snapshot().filter(i => i.state === 'failed').length, 1);
});

test('lost final response is probed using the same ticket and reservation', async () => {
  const { store, file, until, error } = fixture();
  let reserves = 0, chunks = 0, probes = 0;
  const queue = uploadQueue({ store, wait: async () => {}, api: {
    bootstrap: async () => {},
    reserve: async () => { reserves++; return { reservation: 'reserved' }; },
    start: async () => ({ ticket: 'ticket', chunkSize: 262144 }),
    chunk: async (item, range) => {
      assert.equal(item.reservation, 'reserved');
      if (range.startsWith('bytes */')) { probes++; return { file: { id: 'remote', size: item.size } }; }
      chunks++;
      throw error(503, 'lost_response');
    },
  } });
  await queue.setContext('actor', 'account');
  await queue.add([file('a.txt')]);
  await until(() => queue.snapshot()[0]?.state === 'synced');
  assert.deepEqual([reserves, chunks, probes], [1, 1, 1]);
});

test('reload restores preserved bytes and account pinning, then requires a decision for a name conflict', async () => {
  const { store, file, until, error } = fixture();
  let starts = 0;
  const api = {
    bootstrap: async () => {},
    reserve: async () => ({ reservation: 'r' }),
    start: async item => {
      starts++;
      if (!item.keepBoth) throw error(409, 'name_conflict');
      return { ticket: 'ticket', chunkSize: 262144 };
    },
    chunk: async item => ({ file: { id: 'remote', size: item.size } }),
  };
  const first = uploadQueue({ store, online: () => false, api });
  await first.setContext('actor', 'first-account');
  await first.add([file('a.txt')]);
  const second = uploadQueue({ store, api });
  await second.setContext('actor', 'other-account');
  assert.equal(second.snapshot()[0].state, 'paused');
  assert.equal(starts, 0);
  await second.setContext('actor', 'first-account');
  await until(() => second.snapshot()[0].state === 'conflict');
  await second.retry(second.snapshot()[0], true);
  await until(() => second.snapshot()[0].state === 'synced');
  await second.setContext('other-actor', 'first-account');
  assert.equal(second.snapshot().length, 0);
});

test('expired Google session pauses work until the same account reconnects', async () => {
  const { store, file, until, error } = fixture();
  let connected = false;
  const queue = uploadQueue({ store, api: {
    bootstrap: async () => {},
    reserve: async () => ({ reservation: 'r' }),
    start: async item => {
      if (!connected) throw error(401, 'session');
      return { file: { id: 'remote', size: item.size } };
    },
  } });
  await queue.setContext('actor', 'account');
  await queue.add([file('a.txt')]);
  await until(() => queue.snapshot()[0]?.state === 'login');
  connected = true;
  await queue.setContext('actor', 'account');
  await until(() => queue.snapshot()[0]?.state === 'synced');
});
