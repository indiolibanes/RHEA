import { boundedTelegramJson } from '../../../src/rhea/library/telegram-contract.mjs';
import { inputFor, mtprotoResult, operationAllowed, overviewLimit } from '../../../src/rhea/library/mtproto-contract.mjs';

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
  const config = connector(env);
  if (!config) return mtprotoResult('unconfigured');

  const acceptsBody = operation === 'code' || operation === 'password';
  if (acceptsBody !== (request.body !== null)) return mtprotoResult('invalid_request');
  let input;
  try {
    input = inputFor(operation, acceptsBody ? await boundedTelegramJson(request, 1536) : undefined);
  } catch {
    return mtprotoResult('invalid_request');
  }
  if (!input) return mtprotoResult('invalid_request');
  try {
    const result = await fetcher(config.origin + '/v1/' + operation, {
      method: request.method, redirect: 'error', signal: AbortSignal.timeout(26_000),
      headers: { Authorization: 'Bearer ' + config.key, 'X-Rhea-Access-Subject': actor,
        'CF-Access-Client-Id': config.clientId, 'CF-Access-Client-Secret': config.clientSecret,
        ...(acceptsBody ? { 'Content-Type': 'application/json' } : {}) },
      ...(acceptsBody ? { body: JSON.stringify(input) } : {}),
    });
    const payload = await boundedTelegramJson(result, overviewLimit);
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
