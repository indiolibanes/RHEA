import { forumInput, forumResponse, isForumOperation } from './forum-contract.mjs';
import { isMirrorOperation, mirrorInput, mirrorIssue, mirrorResponse } from './mirror-contract.mjs';

export const overviewLimit = 2 * 1024 * 1024;
export const inventoryLimit = 500;
const routes = { status: 'GET', start: 'POST', code: 'POST', password: 'POST', cancel: 'POST',
  inventory: 'POST', disconnect: 'POST', stagepreview: 'POST', stagecopy: 'POST',
  forumtopics: 'POST', forumpage: 'POST',
  mirrorstatus: 'POST', mirrorpreview: 'POST', mirrorapprove: 'POST', mirrornext: 'POST' };
const statusCodes = {
  unconfigured: 200, disconnected: 200, code: 200, password: 200, connected: 200, inventory: 200,
  access_required: 401, not_allowed: 403, invalid_request: 400, invalid_code: 409, invalid_password: 409,
  expired: 409, channel_unavailable: 409, account_mismatch: 409, unsupported_delivery: 409,
  revoke_in_telegram: 409, stale_inventory: 409, busy: 409, rate_limited: 429, unavailable: 503,
  stage_preview: 200, stage_done: 200, stage_disabled: 409, stage_ineligible: 409, stage_changed: 409, stage_recovery: 409,
  forum_topics: 200, forum_page: 200, forum_disabled: 409, forum_unavailable: 409,
  forum_changed: 409, forum_cursor_invalid: 400, forum_general: 409,
  mirror_disabled: 409, mirror_ineligible: 409, mirror_changed: 409, mirror_recovery: 409,
  mirror_idle: 200, mirror_preview: 200, mirror_progress: 200, mirror_done: 200,
};

export function operationAllowed(operation, method) {
  return typeof operation === 'string' && Object.hasOwn(routes, operation) && routes[operation] === method;
}

export function acceptsInput(operation) {
  return isForumOperation(operation) || ['code', 'password', 'stagecopy', 'mirrorapprove'].includes(operation);
}

const approvalToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function inputFor(operation, value) {
  if (isForumOperation(operation)) return forumInput(operation, value);
  if (isMirrorOperation(operation)) return mirrorInput(operation, value);
  if (operation === 'stagecopy') {
    if (!value || Object.keys(value).length !== 2 || value.confirm !== true || !approvalToken(value.approval)) return null;
    return { approval: value.approval, confirm: true };
  }
  const expected = operation === 'code' ? 'code' : operation === 'password' ? 'password' : null;
  if (!expected) return value === undefined ? {} : null;
  if (!value || Object.keys(value).length !== 1 || typeof value[expected] !== 'string') return null;
  const input = value[expected];
  if (expected === 'code' ? !/^[0-9]{4,8}$/.test(input) : !input.length || input.length > 256) return null;
  return { [expected]: input };
}

const preciseId = (value, length = 19) => typeof value === 'string' &&
  /^[1-9][0-9]+$/.test(value) && value.length <= length;
const optionalText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;
const messageId = id => Number.isInteger(id) && id > 0 && id <= 2_147_483_647;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function stagingPreview(value) {
  if (!value || !approvalToken(value.approval) || !nonnegative(value.expiresAt) ||
      typeof value.source !== 'string' || typeof value.destination !== 'string' ||
      !Array.isArray(value.posts) || value.posts.length !== 3 ||
      new Set(value.posts.map(post => post?.id)).size !== 3 ||
      value.posts.some(post => !post || !messageId(post.id) || typeof post.caption !== 'string')) return null;
  return { approval: value.approval, expiresAt: value.expiresAt, source: value.source.slice(0, 128),
    destination: value.destination.slice(0, 128), posts: value.posts.map(post => ({ id: post.id, caption: post.caption.slice(0, 448) })) };
}

function overview(value) {
  if (!value || !preciseId(value.channelId) || !/^[0-9a-f]{64}$/.test(value.revision ?? '') ||
    typeof value.complete !== 'boolean' || !Array.isArray(value.messages) || value.messages.length > inventoryLimit) return null;
  const seen = new Set();
  const messages = [];
  for (const post of value.messages) {
    if (!post || !messageId(post.id) || seen.has(post.id)) return null;
    seen.add(post.id);
    messages.push({
      id: post.id, date: nonnegative(post.date), editedAt: nonnegative(post.editedAt),
      caption: optionalText(post.caption, 448), filename: optionalText(post.filename, 192),
      albumId: optionalText(post.albumId, 22), providerMediaId: optionalText(post.providerMediaId, 32),
      sizeBytes: nonnegative(post.sizeBytes),
      copyPolicy: post.copyPolicy === 'protected' ? 'protected' : 'unknown',
    });
  }
  return { channelId: value.channelId, revision: value.revision, complete: value.complete, messages };
}

export function mtprotoResult(state, extra = {}) {
  const status = Object.hasOwn(statusCodes, state) ? statusCodes[state] : null;
  if (!status) return mtprotoResult('unavailable');
  const body = { state };
  if (state === 'inventory') {
    const safe = overview(extra.inventory);
    if (!safe) return mtprotoResult('unavailable');
    body.inventory = safe;
  }
  if (state === 'forum_topics' || state === 'forum_page') {
    body.forum = forumResponse(state, extra.forum);
    if (!body.forum) return mtprotoResult('unavailable');
  }
  if (state === 'mirror_ineligible' || state === 'mirror_changed') {
    const issue = mirrorIssue(extra.issue);
    if (issue) body.issue = issue;
  }
  if (['mirror_preview', 'mirror_progress', 'mirror_done'].includes(state) ||
      (state === 'mirror_recovery' && extra.mirror)) {
    body.mirror = mirrorResponse(state, extra.mirror);
    if (!body.mirror) return mtprotoResult('unavailable');
  }
  if (state === 'stage_preview') {
    body.stage = stagingPreview(extra.stage);
    if (!body.stage) return mtprotoResult('unavailable');
  }
  if (state === 'stage_done') {
    const copies = extra.copies;
    if (!Array.isArray(copies) || copies.length !== 3 || new Set(copies.map(copy => copy?.sourceId)).size !== 3 ||
        copies.some((copy, index) => !copy || !messageId(copy.sourceId) || !messageId(copy.destinationId) ||
          (index && copy.destinationId <= copies[index - 1].destinationId))) return mtprotoResult('unavailable');
    body.copies = copies.map(({ sourceId, destinationId }) => ({ sourceId, destinationId }));
  }
  if (state === 'rate_limited' && Number.isInteger(extra.retryAfter) && extra.retryAfter > 0 && extra.retryAfter <= 86_400) {
    body.retryAfter = extra.retryAfter;
  }
  return Response.json(body, { status, headers: {
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    ...(body.retryAfter ? { 'Retry-After': String(body.retryAfter) } : {}),
  } });
}
