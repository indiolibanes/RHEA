import { letterRebuildTopics } from './letter-rebuild.mjs';

// This state belongs to the read-only planning UI. The adapter remains authoritative.
export function telegramReadCooldown(now = Date.now) {
  let until = 0;
  const remaining = () => Math.max(0, Math.ceil((until - now()) / 1000));
  return {
    remaining,
    record(data) {
      if (data.state === 'rate_limited' && Number.isInteger(data.retryAfter) &&
          data.retryAfter > 0 && data.retryAfter <= 2_147_483_647) {
        until = Math.max(until, now() + data.retryAfter * 1000);
      }
      return { state: 'rate_limited', retryAfter: remaining() || undefined };
    },
  };
}

// Only reuse an independently verified, complete topic index from the same forum.
// This identifies a preview pair; it does not verify emptiness or authorize any write.
export function discoveredRebuildPair(letter, index, source) {
  if (!index?.topics || !source || index.channelId !== source.channelId) return undefined;
  const { current, replacement } = letterRebuildTopics(letter, index.topics, source.topicId);
  if (!current.topic || !['found', 'closed'].includes(current.state) || replacement.state !== 'found') return undefined;
  return { channelId: index.channelId, ...current, replacement };
}
