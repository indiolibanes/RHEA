import { forumId } from './forum-contract.mjs';

export const mirrorLimit = 20;
export const mirrorTestTopic = 'RHEA Mirror Test';
const operations = new Set(['mirrorstatus', 'mirrorpreview', 'mirrorapprove', 'mirrornext']);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export const isMirrorOperation = operation => operations.has(operation);

export function mirrorInput(operation, input) {
  if (operation !== 'mirrorapprove') return input === undefined ? {} : null;
  if (!input || Object.keys(input).length !== 2 || input.confirm !== true || !token(input.approval)) return null;
  return { approval: input.approval, confirm: true };
}

export function mirrorResponse(state, value) {
  if (state === 'mirror_idle') return {};
  if (!value || !Number.isInteger(value.total) || value.total < 1 || value.total > mirrorLimit) return null;
  if (state === 'mirror_preview') {
    if (!token(value.approval) || !Number.isSafeInteger(value.expiresAt) ||
        typeof value.source !== 'string' || typeof value.destination !== 'string' ||
        !Array.isArray(value.posts) || value.posts.length !== value.total ||
        value.posts.some((post, i) => !forumId(post?.id) || (i && post.id <= value.posts[i - 1].id) ||
          !['photo', 'document', 'text'].includes(post.kind) || typeof post.label !== 'string')) return null;
    return { total: value.total, approval: value.approval, expiresAt: value.expiresAt,
      source: value.source.slice(0, 256), destination: value.destination.slice(0, 256),
      posts: value.posts.map(({ id, kind, label }) => ({ id, kind, label: label.slice(0, 380) })) };
  }
  if (!Array.isArray(value.copies) || value.copies.length > value.total ||
      value.copies.some((copy, i) => !forumId(copy?.sourceId) || !forumId(copy?.destinationId) ||
        (i && (copy.sourceId <= value.copies[i - 1].sourceId || copy.destinationId <= value.copies[i - 1].destinationId))) ||
      (state === 'mirror_done' && value.copies.length !== value.total)) return null;
  return { total: value.total, copies: value.copies.map(({ sourceId, destinationId }) => ({ sourceId, destinationId })) };
}
