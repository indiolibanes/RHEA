import assert from 'node:assert/strict';
import { test } from 'node:test';
import { driveFiles, folderType } from '../src/rhea/drive-files.mjs';

const entry = (id, parents, more = {}) => ({ id, name: id, mimeType: folderType, parents, trashed: false, ...more });
function fixture({ movedRoot = false } = {}) {
  const root = entry('rhea-root', ['my-drive'], { name: 'RHEA', appProperties: { rheaWorkspace: 'folder' } });
  const entities = new Map([
    [root.id, root], ['folder-alpha', entry('folder-alpha', [root.id])], ['folder-deep', entry('folder-deep', ['folder-alpha'])],
    ['folder-beta', entry('folder-beta', [root.id])],
    ['outside-folder', entry('outside-folder', ['my-drive'])],
    ['outside-asset', entry('outside-asset', ['outside-folder'], { mimeType: 'text/plain', appProperties: { rheaWorkspace: 'asset' } })],
    ['inside-asset', entry('inside-asset', ['folder-deep'], { mimeType: 'text/plain', size: '4' })],
    ['rhea-shortcut', entry('rhea-shortcut', [root.id], { mimeType: 'application/vnd.google-apps.shortcut' })],
    ['bad-parent-asset', entry('bad-parent-asset', [root.id, 'outside-folder'], { mimeType: 'text/plain' })],
  ]);
  const writes = [];
  let media = 0;
  const responses = async (input, opts) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(opts.redirect, 'manual');
    assert.equal(opts.headers.Authorization, 'Bearer mock-token');
    const id = url.pathname.split('/').at(-1);
    const data = entities.get(id);
    const q = url.searchParams.get('q') ?? '';
    if (url.searchParams.get('alt') === 'media') { media++; return new Response('data'); }
    if (id === 'root' || id === 'my-drive') return Response.json({}, { status: 404 });
    if (id === root.id && movedRoot) return Response.json({ ...root, parents: ['outside-folder'] });
    if (id === 'files' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      const added = entry('created-folder', body.parents, body);
      entities.set(added.id, added);
      writes.push(added.id);
      return Response.json(added);
    }
    if (id === 'files') {
      const name = / and name = '([^']+)'/.exec(q)?.[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      return Response.json({ files: [...entities.values()].filter(node => node.parents.includes(parent === 'root' ? 'my-drive' : parent) &&
        (!name || node.name === name) && !node.trashed) });
    }
    if (opts.method === 'PATCH') {
      writes.push(id);
      Object.assign(data, JSON.parse(opts.body));
      if (url.searchParams.has('addParents')) data.parents = [url.searchParams.get('addParents')];
    }
    return data ? Response.json(data) : Response.json({}, { status: 404 });
  };
  return { service: () => driveFiles('mock-token', responses), entities, root, writes, media: () => media };
}

test('a real ancestry check blocks outside IDs, app-marker bypass, shortcuts and multi-parent files', async () => {
  const f = fixture();
  const service = f.service();
  const proof = await service.authorize('inside-asset');
  assert.deepEqual(proof.chain.map(item => item.id), ['rhea-root', 'folder-alpha', 'folder-deep', 'inside-asset']);
  for (const id of ['outside-asset', 'rhea-shortcut', 'bad-parent-asset']) {
    await assert.rejects(service.authorize(id), { status: 404 });
    await assert.rejects(service.media(id), { status: 404 });
    await assert.rejects(service.change('rename', id, { name: 'x' }), { status: 404 });
  }
  await assert.rejects(service.listing({ id: 'outside-folder' }), { status: 404 });
  assert.deepEqual(f.writes, []);
  assert.equal(f.media(), 0);
});

test('root conflict stops access and mutations before any write', async () => {
  const f = fixture();
  f.entities.set('other-rhea', { ...f.root, id: 'other-rhea' });
  await assert.rejects(f.service().listing(), { status: 409, code: 'ambiguous_root' });
  await assert.rejects(f.service().createFolder(null, 'new'), { status: 409 });
  assert.deepEqual(f.writes, []);
});

test('authorized folder creation, rename, move and confirmed trash are verified by metadata', async () => {
  const f = fixture();
  const s = f.service();
  const folder = await s.createFolder('folder-alpha', 'New');
  assert.equal(folder.name, 'New');
  assert.equal((await s.change('rename', 'inside-asset', { name: 'renamed' })).name, 'renamed');
  await assert.rejects(s.change('move', 'inside-asset', { parent: 'outside-folder' }), { status: 404 });
  await assert.rejects(s.change('move', 'folder-alpha', { parent: 'folder-deep' }), { status: 409 });
  assert.equal((await s.change('move', 'inside-asset', { parent: 'folder-beta' })).id, 'inside-asset');
  await assert.rejects(s.change('trash', 'inside-asset', {}), { status: 400 });
  for (const action of ['rename', 'move', 'trash']) {
    await assert.rejects(s.change(action, 'rhea-root', { name: 'x', parent: 'folder-beta', confirmed: true }), { status: 403 });
  }
  assert.deepEqual(await s.change('trash', 'inside-asset', { confirmed: true }), { id: 'inside-asset', trashed: true });
  assert.deepEqual(f.writes, ['created-folder', 'inside-asset', 'inside-asset', 'inside-asset']);
});

test('drive.file can list the Rhea even when Google rejects direct metadata for My Drive root', async () => {
  const f = fixture();
  assert.equal((await f.service().listing()).folderId, f.root.id);
});

test('a candidate that moved out after the provider applied the root filter is refused', async () => {
  const f = fixture({ movedRoot: true });
  await assert.rejects(f.service().listing(), { status: 409, code: 'unapproved_root' });
  await assert.rejects(f.service().media('inside-asset'), { status: 409, code: 'unapproved_root' });
  assert.equal(f.media(), 0);
});
