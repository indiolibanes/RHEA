import { boundedTelegramJson, telegramResult } from '../src/rhea/library/telegram-contract.mjs';

const tokenPattern = /^[1-9]\d{0,15}:[A-Za-z0-9_-]{24,128}$/;
const isUserId = id => Number.isSafeInteger(id) && id > 0;
const knownMethods = new Set(['getMe', 'getChat', 'getChatMember']);

class TelegramCheckError extends Error {
  constructor(state, retryAfter) {
    super(state);
    this.state = state;
    this.retryAfter = retryAfter;
  }
}

async function telegramRead(fetcher, token, method, payload) {
  if (!knownMethods.has(method)) throw new Error('Unsupported Telegram method.');
  const response = await fetcher('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(4000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.status >= 500) {
    await response.body?.cancel();
    throw new TelegramCheckError('unavailable');
  }
  const data = await boundedTelegramJson(response, 64 * 1024);
  if (response.status === 429 || data?.error_code === 429) throw new TelegramCheckError('rate_limited', data?.parameters?.retry_after);
  if (!response.ok || data?.ok !== true || !data?.result) throw new TelegramCheckError('telegram_rejected');
  return data.result;
}

function minimalBotPrivileges(member, id) {
  return member.status === 'administrator' && member.user?.id === id && member.user.is_bot === true &&
    member.can_manage_chat === true && !Object.entries(member).some(([key, value]) =>
      key.startsWith('can_') && key !== 'can_manage_chat' && key !== 'can_be_edited' && value !== false);
}

export async function telegramSandbox(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const status = request.method === 'GET' && url.pathname === '/status';
  const check = request.method === 'POST' && url.pathname === '/check';
  if (url.origin !== 'https://rhea-telegram.internal' || (!status && !check) || url.search || request.body !== null) {
    return telegramResult('method_not_allowed');
  }
  if (env.RHEA_TELEGRAM_MODE !== 'sandbox') return telegramResult('unconfigured');

  const accessSubject = env.RHEA_TELEGRAM_ACCESS_SUB;
  if (typeof accessSubject !== 'string' || !accessSubject.trim()) return telegramResult('unconfigured');
  if (request.headers.get('X-Rhea-Access-Subject') !== accessSubject) return telegramResult('not_allowed');
  const token = env.RHEA_TELEGRAM_BOT_TOKEN;
  const channelText = env.RHEA_TELEGRAM_CHANNEL_ID;
  const ownerText = env.RHEA_TELEGRAM_OWNER_ID;
  const chatId = Number(channelText);
  const ownerId = Number(ownerText);
  if (!tokenPattern.test(token) || !/^-100[1-9]\d{5,12}$/.test(channelText) || !Number.isSafeInteger(chatId) ||
    !/^[1-9]\d{0,15}$/.test(ownerText) || !isUserId(ownerId)) return telegramResult('unconfigured');
  if (status) return telegramResult('ready');

  try {
    const bot = await telegramRead(fetcher, token, 'getMe', {});
    if (bot.is_bot !== true || !isUserId(bot.id)) return telegramResult('telegram_rejected');
    const chat = await telegramRead(fetcher, token, 'getChat', { chat_id: chatId });
    if (chat.id !== chatId || chat.type !== 'channel' || chat.username || chat.active_usernames?.length) {
      return telegramResult('review_channel');
    }
    const botMember = await telegramRead(fetcher, token, 'getChatMember', { chat_id: chatId, user_id: bot.id });
    if (!minimalBotPrivileges(botMember, bot.id)) return telegramResult('review_bot_permissions');
    const owner = await telegramRead(fetcher, token, 'getChatMember', { chat_id: chatId, user_id: ownerId });
    if (owner.user?.id !== ownerId || owner.user.is_bot !== false || owner.status !== 'creator') {
      return telegramResult('review_owner');
    }
    return telegramResult('verified');
  } catch (error) {
    return error instanceof TelegramCheckError ? telegramResult(error.state, error.retryAfter) : telegramResult('unavailable');
  }
}

export default { fetch: (request, env) => telegramSandbox(request, env) };
