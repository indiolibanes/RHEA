import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stagingControl } from './staging.mjs';
import { mtprotoControl } from './control.mjs';

const titles = ['Saffron Signals | S01E01', 'Kestrel Circuit | S01E02', 'Kestrel Circuit | S01E01'];

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rhea-staging-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { actor: 'approved-operator', ownerId: '1234567', key: 'x'.repeat(43),
    channelId: '1234567890', staging: { channelId: '1234567891' }, file: join(dir, 'session.enc') };
  const source = { pts: 8, head: 8, posts: titles.map((title, index) => ({
    id: 6 + index, caption: 'Series: ' + title, mediaId: String(200 + index), size: 5120,
  })) };
  const destination = { pts: 1, head: 1, posts: [] };
  const issued = [];
  const readMedia = [];
  const transport = {
    sourceTitle: 'Sandbox source', destinationTitle: 'Empty sandbox destination',
    readSource: async () => structuredClone(source),
    readDestination: async () => structuredClone(destination),
    async copy(sourceId, randomId) {
      issued.push([sourceId, randomId]);
      const destinationId = ++destination.head;
      destination.pts++;
      destination.posts.push({ ...source.posts.find(post => post.id === sourceId), id: destinationId });
      return destinationId;
    },
    async verifyMedia(id) { readMedia.push(id); return true; },
  };
  const client = { staging: async () => transport };
  const run = stagingControl(config).handle;
  const preview = () => run('stagepreview', {}, client);
  const execute = approval => run('stagecopy', { approval, confirm: true }, client);
  return { dir, config, source, destination, issued, readMedia, transport, client, preview, execute };
}

test('staging previews the exact order and journals verified copies without mutating the source', async t => {
  const f = await fixture(t);
  const original = structuredClone(f.source);
  const proposal = await f.preview();
  assert.equal(proposal.state, 'stage_preview');
  assert.deepEqual(proposal.stage.posts.map(post => post.id), [8, 7, 6]);
  assert.equal(proposal.stage.destination, 'Empty sandbox destination');
  assert.deepEqual(f.issued, []);
  assert.equal((await f.execute('wrong-token')).state, 'stage_changed');
  const result = await f.execute(proposal.stage.approval);
  assert.equal(result.state, 'stage_done');
  assert.deepEqual(f.issued.map(([id]) => id), [8, 7, 6]);
  assert.deepEqual(f.source, original);
  assert.deepEqual(f.readMedia, [2, 3, 4]);
  const journal = await readFile(join(f.dir, (await readdir(f.dir))[0]), 'utf8');
  assert.equal(journal.includes('Kestrel Circuit'), false);
  assert.equal(journal.includes(proposal.stage.approval), false);
  assert.deepEqual(await stagingControl(f.config).handle('stagepreview', {}, f.client), result);
  assert.deepEqual(await f.execute(proposal.stage.approval), result);
  assert.equal(f.issued.length, 3);
});

test('staging refuses an expired approval, changed source, or a nonempty destination', async t => {
  const f = await fixture(t);
  let now = 1;
  const run = stagingControl(f.config, () => now).handle;
  const first = await run('stagepreview', {}, f.client);
  assert.equal((await run('stagecopy', { approval: first.stage.approval }, f.client)).state, 'stage_changed');
  assert.deepEqual(f.issued, []);
  now = first.stage.expiresAt;
  assert.equal((await run('stagecopy', { approval: first.stage.approval, confirm: true }, f.client)).state, 'stage_changed');
  const second = await f.preview();
  f.source.pts++;
  assert.equal((await f.execute(second.stage.approval)).state, 'stage_changed');
  f.destination.posts.push({ id: 2 });
  assert.equal((await f.preview()).state, 'stage_ineligible');
  assert.deepEqual(f.issued, []);
});

test('staging preserves an ambiguous write journal and refuses a retry after a restart', async t => {
  const f = await fixture(t);
  const copy = f.transport.copy;
  f.transport.copy = async (...args) => {
    await copy(...args);
    throw new Error('network interruption after publication');
  };
  const proposal = await f.preview();
  assert.equal((await f.execute(proposal.stage.approval)).state, 'stage_recovery');
  assert.equal(f.destination.posts.length, 1);
  assert.equal((await stagingControl(f.config).handle('stagepreview', {}, f.client)).state, 'stage_recovery');
  assert.equal(f.issued.length, 1);
});

test('staging reports recovery if the media cannot be read back', async t => {
  const f = await fixture(t);
  f.transport.verifyMedia = async () => false;
  const proposal = await f.preview();
  assert.equal((await f.execute(proposal.stage.approval)).state, 'stage_recovery');
  assert.equal(f.destination.posts.length, 3);
});

test('adapter requires enrolled owner, exact staging input and dedicated configuration', async t => {
  const f = await fixture(t);
  const auth = { Authorization: 'Bearer ' + f.config.key, 'X-Rhea-Access-Subject': f.config.actor };
  const request = (verb, value, headers = auth) => new Request('https://adapter.example.test/v1/' + verb,
    { method: 'POST', headers, ...(value && { body: JSON.stringify(value) }) });
  const handle = mtprotoControl(f.config, { read: async () => 'fixture-session' }, async (_, action) => action(f.client));
  assert.equal((await handle(request('stagepreview', undefined, { ...auth, 'X-Rhea-Access-Subject': 'other-operator' }))).status, 403);
  const preview = await (await handle(request('stagepreview'))).json();
  assert.equal((await handle(request('stagecopy', { approval: preview.stage.approval }))).status, 400);
  assert.equal((await handle(request('stagecopy', { approval: preview.stage.approval, confirm: true, channel: 'other' }))).status, 400);
  assert.equal((await handle(request('delete'))).status, 400);
  assert.deepEqual(f.issued, []);
  assert.equal((await handle(request('stagecopy', { approval: preview.stage.approval, confirm: true }))).status, 200);
});
