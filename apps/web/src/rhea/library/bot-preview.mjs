// Transport-independent companion prototype. The production app does not register a webhook.
import { duplicateCandidates, buildCatalog } from './catalog.mjs';
import { planReflow } from './planner.mjs';

export async function demoBotReply(update, { ownerId, ownsTestChannel, workspaceOrigin, snapshot }) {
  const { message, callback_query: callback } = update ?? {};
  const from = callback?.from ?? message?.from;
  const chat = (callback?.message ?? message)?.chat;
  if (!Number.isSafeInteger(ownerId) || ownerId < 1 || from?.id !== ownerId || from?.is_bot !== false ||
    chat?.type !== 'private' || chat.id !== ownerId || typeof ownsTestChannel !== 'function' || !await ownsTestChannel(ownerId)) return null;

  const command = callback ? callback.data : message?.text;
  const actions = ['/start', '/library', '/scan', '/preview K', '/preview S', '/duplicates', '/status', '/cancel', '/help'];
  const link = new URL('/rhea/library', workspaceOrigin);
  if (link.protocol !== 'https:' || link.origin !== workspaceOrigin) throw new Error('A fixed HTTPS workspace origin is required.');
  const keyboard = { inline_keyboard: [
    ['K', 'S'].map(letter => ({ text: letter, callback_data: '/preview ' + letter })),
    [{ text: 'Abrir biblioteca RHEA', url: link.href }],
  ] };
  let text;
  if (command === '/duplicates') text = duplicateCandidates(buildCatalog(snapshot)).length + ' grupos de possíveis duplicatas na demonstração.';
  else if (command === '/status' || command === '/cancel') text = 'Demonstração. Nenhuma execução em andamento.';
  else if (command === '/scan') text = snapshot.messages.length + ' mensagens sintéticas no inventário.';
  else if (command === '/preview K' || command === '/preview S') {
    const plan = await planReflow(snapshot, { strategy: 'suffix' });
    link.hash = command.at(-1);
    keyboard.inline_keyboard[1][0].url = link.href;
    text = 'Prévia ' + command.at(-1) + '. O sufixo completo prevê ' + plan.estimates.affectedMessages + ' cópias.';
  } else text = 'Biblioteca de demonstração. ' + actions.join(' · ');
  return { text, reply_markup: keyboard };
}
