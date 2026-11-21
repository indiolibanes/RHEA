import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oauthReturnCode, watchOAuthTabReturn } from '../src/rhea/oauth-tab-sync.mjs';

class Target {
  constructor() { this.handlers = new Map(); }
  addEventListener(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.handlers.get(name)?.delete(fn); }
  emit(name, value) { for (const fn of this.handlers.get(name) ?? []) fn(value); }
}
class Channel extends Target {
  constructor(name, peers) { super(); this.name = name; this.peers = peers; this.closed = false; peers.push(this); }
  postMessage(data) {
    for (const peer of this.peers) {
      if (peer !== this && peer.name === this.name && !peer.closed) peer.emit('message', { data });
    }
  }
  close() { this.closed = true; }
}
function context(search = '') {
  const win = new Target(); win.location = { search };
  const doc = new Target(); doc.hidden = false;
  return { win, doc };
}

test('accepts only a single fixed OAuth outcome code', () => {
  assert.equal(oauthReturnCode('?drive=connected'), 'connected');
  assert.equal(oauthReturnCode('?drive=oauth_state'), 'oauth_state');
  assert.equal(oauthReturnCode('?drive=oauth_drive&other=1'), 'oauth_drive');
  assert.equal(oauthReturnCode('?drive=custom_code'), null);
  assert.equal(oauthReturnCode('?drive=connected&drive=oauth_state'), null);
  assert.equal(oauthReturnCode(''), null);
});

test('notifies original tab of successful callback without transferring credentials', () => {
  const peers = [];
  const makeChannel = name => new Channel(name, peers);
  const original = context(); const returned = context('?drive=connected');
  const got = [];
  const stopOriginal = watchOAuthTabReturn({ ...original, onReturn: code => got.push(code), makeChannel });
  const stopReturned = watchOAuthTabReturn({ ...returned, onReturn: () => {}, makeChannel });
  assert.deepEqual(got, ['connected']);
  assert.equal(Object.keys({ type: 'oauth-return', code: got[0] }).includes('token'), false);
  stopOriginal(); stopReturned();
});

test('forwards OAuth failure reason to original tab', () => {
  const peers = [];
  const makeChannel = name => new Channel(name, peers);
  const original = context(); const returned = context('?drive=oauth_client');
  const got = [];
  const stopOriginal = watchOAuthTabReturn({ ...original, onReturn: code => got.push(code), makeChannel });
  const stopReturned = watchOAuthTabReturn({ ...returned, onReturn: () => {}, makeChannel });
  assert.deepEqual(got, ['oauth_client']);
  stopOriginal(); stopReturned();
});

test('focus fallback works without BroadcastChannel, ignores hidden tabs and cleans up', () => {
  const { win, doc } = context(); const got = [];
  const stop = watchOAuthTabReturn({
    win, doc, onReturn: code => got.push(code),
    makeChannel: () => { throw Error('unsupported'); },
  });
  doc.hidden = true; win.emit('focus');
  assert.deepEqual(got, []);
  doc.hidden = false; win.emit('focus'); doc.emit('visibilitychange');
  assert.deepEqual(got, [null]);
  stop(); win.emit('focus');
  assert.deepEqual(got, [null]);
});
