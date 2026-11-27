import { timingSafeEqual } from 'node:crypto';
import { boundedTelegramJson } from '../src/rhea/library/telegram-contract.mjs';
import { acceptsInput, inputFor, mtprotoResult, operationAllowed } from '../src/rhea/library/mtproto-contract.mjs';
import { stagingControl } from './staging.mjs';
import { isForumOperation } from '../src/rhea/library/forum-contract.mjs';
import { isMirrorOperation } from '../src/rhea/library/mirror-contract.mjs';
import { mirrorControl, telegramWaitSeconds } from './mirror.mjs';
import { isOrganizationOperation, isRebuildOperation, organizationOperations, rebuildRequestLimit } from '../src/rhea/library/organization-contract.mjs';

const enrollmentTtl = 5 * 60_000;
const startCooldown = 60_000;
const errorCode = error => error?.errorMessage;
const peerErrors = new Set(['CHANNEL_PRIVATE', 'INVITE_HASH_INVALID', 'INVITE_HASH_EXPIRED', 'CHANNEL_INVALID']);

function matchesSecret(header, key) {
  const input = Buffer.from(header ?? '');
  const expected = Buffer.from('Bearer ' + key);
  return input.length === expected.length && timingSafeEqual(input, expected);
}

export function mtprotoControl(config, store, withClient, now = Date.now) {
  const staging = stagingControl(config, now);
  const mirror = mirrorControl(config, now);
  let organization;
  let pending;
  let busy = false;
  let throttledUntil = 0;
  let nextCode = 0;
  let expiresTimer;

  function clearEnrollment() {
    clearTimeout(expiresTimer);
    pending = undefined;
  }

  function setEnrollment(draft) {
    pending = draft;
    expiresTimer = setTimeout(clearEnrollment, enrollmentTtl);
    expiresTimer.unref();
  }

  function handleError(error, operation) {
    const code = errorCode(error);
    const wait = telegramWaitSeconds(error);
    if (wait) {
      throttledUntil = Math.max(throttledUntil, now() + wait * 1000);
      return { state: 'rate_limited', retryAt: throttledUntil, retryAfter: wait };
    }
    if (code === 'PHONE_CODE_INVALID') return { state: 'invalid_code' };
    if (code === 'PASSWORD_HASH_INVALID') return { state: 'invalid_password' };
    if (code === 'PHONE_CODE_EXPIRED' || code === 'PHONE_CODE_HASH_EMPTY') {
      clearEnrollment();
      return { state: 'expired' };
    }
    if (peerErrors.has(code)) return { state: 'channel_unavailable' };
    if (['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED'].includes(code) && operation === 'inventory') {
      return { state: 'expired' };
    }
    return { state: 'unavailable' };
  }

  async function enroll(operation, input, draft) {
    return withClient(draft?.session ?? null, async client => {
      if (operation === 'start') {
        const sent = await client.sendCode();
        if (sent.className === 'auth.SentCodeSuccess') {
          if (sent.authorization?.className === 'auth.Authorization') return accept(client, sent.authorization);
          return { state: 'unsupported_delivery' };
        }
        if (sent.className !== 'auth.SentCode' || sent.type?.className !== 'auth.SentCodeTypeApp' ||
          typeof sent.phoneCodeHash !== 'string' || !sent.phoneCodeHash) return { state: 'unsupported_delivery' };
        return { state: 'code', provisional: { session: client.save(), hash: sent.phoneCodeHash } };
      }

      if (operation === 'code') {
        try {
          return accept(client, await client.signIn(input.code, draft.hash));
        } catch (error) {
          if (errorCode(error) !== 'SESSION_PASSWORD_NEEDED') throw error;
          return { state: 'password', provisional: { session: client.save() } };
        }
      }
      return accept(client, await client.checkPassword(input.password));
    });
  }

  async function accept(client, auth) {
    if (auth?.className !== 'auth.Authorization') return { state: 'unsupported_delivery' };
    if (auth.user?.bot || auth.user?.id?.toString() !== config.ownerId) {
      await client.logout().catch(() => {});
      return { state: 'account_mismatch' };
    }
    return { state: 'connected', authorizedSession: client.save() };
  }

  async function operate(operation, input) {
    if (pending && pending.expires <= now()) clearEnrollment();
    const saved = await store.read();
    if (operation === 'status') return { state: saved ? 'connected' : pending?.step ?? 'disconnected' };
    if (operation === 'cancel') {
      clearEnrollment();
      staging.reset();
      mirror.reset();
      organization = undefined;
      return { state: saved ? 'connected' : 'disconnected' };
    }
    if (operation === 'disconnect') {
      clearEnrollment();
      staging.reset();
      mirror.reset();
      organization = undefined;
      await store.clear();
      if (saved) {
        try {
          await withClient(saved, client => client.logout());
        } catch {
          return { state: 'revoke_in_telegram' };
        }
      }
      return { state: 'disconnected' };
    }
    if (throttledUntil > now()) return { state: 'rate_limited', retryAt: throttledUntil, retryAfter: Math.ceil((throttledUntil - now()) / 1000) };
    if (operation === 'inventory') {
      if (!saved) return { state: 'disconnected' };
      return withClient(saved, client => client.inventory());
    }
    if (isForumOperation(operation)) {
      if (!saved) return { state: 'disconnected' };
      if (!config.forum) return { state: 'forum_disabled' };
      return withClient(saved, client => client.forumInventory(operation, input));
    }
    if (isMirrorOperation(operation)) {
      if (!saved) return { state: 'disconnected' };
      if (!config.mirror || operation === 'mirrorstatus') return mirror.handle(operation, input);
      return withClient(saved, client => mirror.handle(operation, input, client));
    }
    if (isOrganizationOperation(operation)) {
      if (!saved) return { state: 'disconnected' };
      const rebuild = isRebuildOperation(operation);
      if (rebuild ? !config.rebuildEnabled : !config.organizationEnabled) return { state: 'mirror_disabled' };
      const { sourceTopicId, localTopicId, backupTopicId, letter, ids } = input;
      const { currentTopicId, replacementTopicId, beforeId, insertions } = input;
      // A reconstruction may also request the backup group's Letter topic as a second, independently verified destination.
      if (rebuild && backupTopicId !== undefined && !config.backupForum) {
        return { state: 'mirror_ineligible', issue: { side: 'destination', code: 'backup_unconfigured' } };
      }
      const key = JSON.stringify([rebuild, sourceTopicId, localTopicId, backupTopicId, currentTopicId, replacementTopicId, beforeId, letter, ids, insertions]);
      if (organization?.key !== key) {
        const scope = rebuild ? {
          source: { ...config.forum, topicId: currentTopicId },
          intake: { ...config.forum, topicId: sourceTopicId },
          ...(backupTopicId === undefined ? { destination: { ...config.forum, topicId: replacementTopicId } } : {
            local: { ...config.forum, topicId: replacementTopicId },
            destination: { ...config.backupForum, topicId: backupTopicId },
          }),
          rebuild: { letter, ids, beforeId, insertions },
        } : {
          source: { ...config.forum, topicId: sourceTopicId },
          local: { ...config.forum, topicId: localTopicId },
          destination: { ...config.backupForum, topicId: backupTopicId },
          organization: { letter, ids },
        };
        organization = { key, controller: mirrorControl({ ...config, mirror: scope }, now) };
      }
      const action = organizationOperations[operation];
      const controller = organization.controller;
      return action === 'mirrorstatus' ? controller.handle(action, input) :
        withClient(saved, client => controller.handle(action, input, client));
    }
    if (operation === 'stagepreview' || operation === 'stagecopy') {
      if (!saved) return { state: 'disconnected' };
      if (!config.staging) return { state: 'stage_disabled' };
      return withClient(saved, client => staging.handle(operation, input, client));
    }
    if (saved) return { state: 'connected' };
    if (operation === 'start') {
      if (pending) return { state: pending.step };
      if (nextCode > now()) return { state: 'rate_limited', retryAfter: Math.ceil((nextCode - now()) / 1000) };
      nextCode = now() + startCooldown;
    } else {
      if (!pending || pending.step !== operation || pending.attempts >= 3) {
        clearEnrollment();
        return { state: 'expired' };
      }
      pending.attempts++;
    }

    const draft = pending;
    const result = await enroll(operation, input, draft);
    if (draft && (draft.expires <= now() || pending !== draft)) {
      if (result.authorizedSession) {
        try { await withClient(result.authorizedSession, client => client.logout()); }
        catch { return { state: 'revoke_in_telegram' }; }
      }
      return { state: 'expired' };
    }
    if (result.state === 'connected') {
      clearEnrollment();
      try {
        await store.write(result.authorizedSession);
      } catch {
        try { await withClient(result.authorizedSession, client => client.logout()); }
        catch { return { state: 'revoke_in_telegram' }; }
        return { state: 'unavailable' };
      }
    } else if (result.state === 'code') {
      if (!result.provisional.session) return { state: 'unavailable' };
      setEnrollment({ ...result.provisional, step: 'code', expires: now() + enrollmentTtl, attempts: 0 });
    } else if (result.state === 'password') {
      if (!result.provisional.session) return { state: 'unavailable' };
      pending = { ...result.provisional, step: 'password', expires: draft.expires, attempts: 0 };
    } else {
      clearEnrollment();
    }
    return { state: result.state };
  }

  return async function handle(request) {
    const url = new URL(request.url);
    if (!matchesSecret(request.headers.get('Authorization'), config.key) ||
      request.headers.get('X-Rhea-Access-Subject') !== config.actor) return mtprotoResult('not_allowed');
    const operation = /^\/v1\/([a-z]+)$/.exec(url.pathname)?.[1];
    if (url.search || !operationAllowed(operation, request.method)) return mtprotoResult('invalid_request');
    const acceptsBody = acceptsInput(operation);
    if (acceptsBody && !request.body) return mtprotoResult('invalid_request');
    if (busy) return mtprotoResult('busy');
    busy = true;
    try {
      const limit = isRebuildOperation(operation) ? rebuildRequestLimit : 1536;
      const value = request.body ? await boundedTelegramJson(request, limit).catch(() => null) : undefined;
      const input = inputFor(operation, value);
      if (!input) return mtprotoResult('invalid_request');
      const result = await operate(operation, input);
      if (result.state === 'rate_limited' && result.retryAt) throttledUntil = Math.max(throttledUntil, result.retryAt);
      return mtprotoResult(result.state, result, operation);
    } catch (error) {
      const result = handleError(error, operation);
      if (result.state === 'expired' && operation === 'inventory') {
        try { await store.clear(); } catch { return mtprotoResult('unavailable'); }
      }
      return mtprotoResult(result.state, result, operation);
    } finally {
      busy = false;
    }
  };
}
