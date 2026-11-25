import assert from 'node:assert/strict';
import test from 'node:test';
import { discoveredRebuildPair, telegramReadCooldown } from '../src/rhea/library/destination-check.mjs';

test('a read wait retains the longest deadline and expires without retrying', () => {
  let now = 1000;
  const cooldown = telegramReadCooldown(() => now);
  assert.equal(cooldown.remaining(), 0);
  assert.deepEqual(cooldown.record({ state: 'rate_limited', retryAfter: 60 }), { state: 'rate_limited', retryAfter: 60 });
  now += 10_000;
  assert.equal(cooldown.remaining(), 50);
  assert.equal(cooldown.record({ state: 'rate_limited', retryAfter: 1 }).retryAfter, 50);
  assert.equal(cooldown.record({ state: 'rate_limited', retryAfter: NaN }).retryAfter, 50);
  now += 49_999;
  assert.equal(cooldown.remaining(), 1);
  now++;
  assert.equal(cooldown.remaining(), 0);
});

test('the original and replacement topics of letter K are distinct read-only preview destinations', () => {
  const source = { channelId: '22222', topicId: 1 };
  const index = { channelId: source.channelId, topics: [
    { id: 1, title: 'Requests' },
    { id: 9, title: 'Letter K', closed: true },
    { id: 40, title: 'Letter K [NEW]' },
  ] };
  const pair = discoveredRebuildPair('K', index, source);
  assert.equal(pair.topic.id, 9);
  assert.equal(pair.replacement.topic.id, 40);
  assert.equal(pair.state, 'closed');
  assert.equal(discoveredRebuildPair('K', { ...index, channelId: '11111' }, source), undefined);
  assert.equal(discoveredRebuildPair('K', { ...index, topics: index.topics.slice(0, 2) }, source), undefined);
  assert.equal(discoveredRebuildPair('K', { ...index, topics: [...index.topics, { id: 41, title: 'Letter K [NEW]' }] }, source), undefined);
  assert.equal(discoveredRebuildPair('K', index, { ...source, topicId: 40 }), undefined);
});
