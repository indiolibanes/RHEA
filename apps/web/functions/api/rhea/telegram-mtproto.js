import { isForumOperation } from '../../../src/rhea/library/forum-contract.mjs';
import { boundedTelegramJson } from '../../../src/rhea/library/telegram-contract.mjs';
import { acceptsInput, inputFor, mtprotoResult, operationAllowed, overviewLimit } from '../../../src/rhea/library/mtproto-contract.mjs';

function connector(env) {
  try {
    const origin = new URL(env.RHEA_TELEGRAM_MTPROTO_ORIGIN);
    if (origin.protocol !== 'https:' || origin.origin !== env.RHEA_TELEGRAM_MTPROTO_ORIGIN ||
      !/^[A-Za-z0-9_-]{43}$/.test(env.RHEA_TELEGRAM_MTPROTO_KEY ?? '') ||
      !env.RHEA_TELEGRAM_CF_CLIENT_ID || !env.RHEA_TELEGRAM_CF_CLIENT_SECRET) return null;
    return { origin: origin.origin, key: env.RHEA_TELEGRAM_MTPROTO_KEY,
      clientId: env.RHEA_TELEGRAM_CF_CLIENT_ID, clientSecret: env.RHEA_TELEGRAM_CF_CLIENT_SECRET };
  } catch {
    return null;
  }
}

export async function mtprotoPage({ request, data, env }, fetcher = fetch) {
  const actor = data.cloudflareAccess?.JWT?.payload?.sub;
  if (typeof actor !== 'string' || !actor) return mtprotoResult('access_required');
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  const operation = url.searchParams.get('op');
  if (keys.length !== 1 || !operationAllowed(operation, request.method)) return mtprotoResult('invalid_request');
  const staging = operation === 'stagepreview' || operation === 'stagecopy';
  const forum = isForumOperation(operation);
  if (staging || forum) {
    const origin = request.headers.get('Origin');
    const sameOrigin = origin === url.origin ||
      ((!origin || origin === 'null') && request.headers.get('Sec-Fetch-Site') === 'same-origin');
    if (!sameOrigin) return mtprotoResult('not_allowed');
    if ((operation === 'stagecopy' || forum) && !/^application\/json(?:[; ]|$)/i.test(request.headers.get('Content-Type') ?? '')) {
      return mtprotoResult('invalid_request');
    }
  }
  const config = connector(env);
  if (!config) return mtprotoResult('unconfigured');

  const acceptsBody = acceptsInput(operation);
  let input;
  try {
    let value;
    if (acceptsBody) {
      value = await boundedTelegramJson(request, 1536);
    } else if (request.body) {
      // Workers can expose a zero-byte POST as an empty stream.
      const reader = request.body.getReader();
      if (!(await reader.read()).done) {
        void reader.cancel().catch(() => {});
        return mtprotoResult('invalid_request');
      }
    }
    input = inputFor(operation, value);
  } catch {
    return mtprotoResult('invalid_request');
  }
  if (!input) return mtprotoResult('invalid_request');
  try {
    const result = await fetcher(config.origin + '/v1/' + operation, {
      method: request.method, redirect: 'manual', signal: AbortSignal.timeout(26_000),
      headers: { Authorization: 'Bearer ' + config.key, 'X-Rhea-Access-Subject': actor,
        'CF-Access-Client-Id': config.clientId, 'CF-Access-Client-Secret': config.clientSecret,
        ...(acceptsBody ? { 'Content-Type': 'application/json' } : {}) },
      ...(acceptsBody ? { body: JSON.stringify(input) } : {}),
    });
    if (result.status >= 300 && result.status < 400) return mtprotoResult('unavailable');
    const payload = await boundedTelegramJson(result, overviewLimit);
    if ((payload?.state === 'stage_preview' && operation !== 'stagepreview') ||
      (typeof payload?.state === 'string' && payload.state.startsWith('stage_') && !staging)) return mtprotoResult('unavailable');
    if ((typeof payload?.state === 'string' && payload.state.startsWith('forum_') && !forum) ||
        (payload?.state === 'forum_topics' && operation !== 'forumtopics') ||
        (payload?.state === 'forum_page' && (operation !== 'forumpage' || payload.forum?.topicId !== input.topicId))) {
      return mtprotoResult('unavailable');
    }
    if (payload?.state === 'inventory' && operation !== 'inventory') return mtprotoResult('unavailable');
    const safe = mtprotoResult(payload?.state, payload ?? {});
    return safe.status === result.status ? safe : mtprotoResult('unavailable');
  } catch {
    return mtprotoResult('unavailable');
  }
}

export function onRequest(context) {
  return mtprotoPage(context);
}
