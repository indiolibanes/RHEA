import { forumId } from './forum-contract.mjs';

export const mirrorLimit = 20;
export const mirrorTestTopic = 'RHEA Mirror Test';
const operations = new Set(['mirrorstatus', 'mirrorpreview', 'mirrorapprove', 'mirrornext']);
const issueCodes = new Set(['account_unverified', 'group_unavailable', 'group_not_forum',
  'group_not_owned', 'group_protected', 'topic_missing', 'topic_name', 'dual_topic_name', 'topic_closed',
  'history_unverified', 'history_limit', 'unsupported_post', 'album_or_reply', 'source_empty', 'destination_not_empty', 'selection_changed']);

const postDetails = new Set(['service_event', 'reply', 'protected_or_temporary', 'forwarded_or_bot',
  'text_format', 'media_type', 'media_reference', 'filename', 'file_size', 'large_file_size']);

export function mirrorIssue(issue) {
  if (!issueCodes.has(issue?.code)) return undefined;
  if (issue.code === 'account_unverified') return issue.side === 'account' ? { side: 'account', code: issue.code } : undefined;
  if (!['source', 'destination', 'local'].includes(issue.side) ||
      (issue.code === 'source_empty' && issue.side !== 'source') ||
      (issue.code === 'destination_not_empty' && issue.side === 'source')) return undefined;
  const result = { side: issue.side, code: issue.code };
  if (issue.code === 'unsupported_post' && forumId(issue.postId) && postDetails.has(issue.detail)) {
    return { ...result, postId: issue.postId, detail: issue.detail };
  }
  return result;
}

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
        (value.localDestination !== undefined && typeof value.localDestination !== 'string') ||
        !Array.isArray(value.posts) || value.posts.length !== value.total ||
        new Set(value.posts.map(post => post?.id)).size !== value.total ||
        value.posts.some(post => !forumId(post?.id) ||
          !['photo', 'document', 'video', 'text'].includes(post.kind) || typeof post.label !== 'string')) return null;
    return { total: value.total, approval: value.approval, expiresAt: value.expiresAt,
      source: value.source.slice(0, 256), destination: value.destination.slice(0, 256),
      ...(value.localDestination !== undefined && { localDestination: value.localDestination.slice(0, 256) }),
      posts: value.posts.map(({ id, kind, label }) => ({ id, kind, label: label.slice(0, 380) })) };
  }
  const validCopies = copies => Array.isArray(copies) && copies.length <= value.total &&
    new Set(copies.map(copy => copy?.sourceId)).size === copies.length &&
    copies.every((copy, i) => forumId(copy?.sourceId) && forumId(copy?.destinationId) &&
      (!i || copy.destinationId > copies[i - 1].destinationId));
  const mapped = copies => copies.map(({ sourceId, destinationId }) => ({ sourceId, destinationId }));
  if (!validCopies(value.copies) || (state === 'mirror_done' && value.copies.length !== value.total)) return null;
  const result = { total: value.total, copies: mapped(value.copies) };
  if (value.localCopies === undefined) return result;
  if (!validCopies(value.localCopies) || (value.copies.length && value.localCopies.length !== value.total) ||
      value.copies.some((copy, i) => copy.sourceId !== value.localCopies[i].sourceId)) return null;
  return { ...result, localCopies: mapped(value.localCopies) };
}
