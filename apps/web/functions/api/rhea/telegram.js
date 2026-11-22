import { boundedTelegramJson, relayTelegramResult, telegramResult } from '../../../src/rhea/library/telegram-contract.mjs';

export async function onRequest({ request, env, data }) {
  const actor = data.cloudflareAccess?.JWT?.payload?.sub;
  if (typeof actor !== 'string' || !actor) return telegramResult('access_required');
  if (!['GET', 'POST'].includes(request.method) || new URL(request.url).search || request.body !== null) {
    return telegramResult('method_not_allowed');
  }
  if (typeof env.RHEA_TELEGRAM_SANDBOX?.fetch !== 'function') return telegramResult('unconfigured');
  const pathname = request.method === 'GET' ? '/status' : '/check';

  try {
    const reply = await env.RHEA_TELEGRAM_SANDBOX.fetch(new Request('https://rhea-telegram.internal' + pathname, {
      method: request.method,
      redirect: 'error',
      headers: { 'X-Rhea-Access-Subject': actor },
    }));
    return relayTelegramResult(reply, await boundedTelegramJson(reply, 1024), pathname);
  } catch {
    return telegramResult('unavailable');
  }
}
