import { Api, TelegramClient } from 'teleproto';
import { Logger, LogLevel } from 'teleproto/extensions/Logger';
import { computeCheck } from 'teleproto/Password';
import { StringSession } from 'teleproto/sessions';
import { readInventory } from './inventory.mjs';

export function telegramClient(config, makeClient = (session, options) =>
  new TelegramClient(session, config.apiId, config.apiHash, options)) {
  return async function withClient(saved, operation) {
    const session = new StringSession(saved);
    const client = makeClient(session, {
      baseLogger: new Logger(LogLevel.NONE), connectionRetries: 1, requestRetries: 1,
      autoReconnect: false, catchUp: false, floodSleepThreshold: 0, timeout: 8,
      deviceModel: 'RHEA Telegram Sandbox',
    });
    let timer;
    try {
      const task = (async () => {
        await client.connect();
        // The adapter has no subscriptions. Prevent the client from repairing or polling account-wide updates.
        client.updateManager.stop();
        const invoke = (query, options) => client.invoke(new Api.InvokeWithoutUpdates({ query }), undefined, options);
        return operation({
          save: () => session.save(),
          sendCode: () => invoke(new Api.auth.SendCode({
            phoneNumber: config.phone, apiId: config.apiId, apiHash: config.apiHash, settings: new Api.CodeSettings({}),
          }), { maxRetryCount: 1 }),
          signIn: (code, hash) => invoke(new Api.auth.SignIn({
            phoneNumber: config.phone, phoneCodeHash: hash, phoneCode: code,
          })),
          async checkPassword(password) {
            const challenge = await invoke(new Api.account.GetPassword());
            return invoke(new Api.auth.CheckPassword({ password: await computeCheck(challenge, password) }));
          },
          logout: () => invoke(new Api.auth.LogOut()),
          async inventory() {
            const [me] = await invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }));
            if (!me || me.bot || me.id?.toString() !== config.ownerId) return { state: 'account_mismatch' };
            const invite = await invoke(new Api.messages.CheckChatInvite({ hash: config.inviteHash }));
            const channel = invite.chat;
            if (invite.className !== 'ChatInviteAlready' || channel?.className !== 'Channel' ||
              channel.id?.toString() !== config.channelId || channel.broadcast !== true || channel.megagroup || channel.left ||
              channel.username || channel.usernames?.some(item => item.active) || !channel.accessHash) {
              return { state: 'channel_unavailable' };
            }
            const peer = new Api.InputPeerChannel({ channelId: channel.id, accessHash: channel.accessHash });
            return readInventory({
              channelId: config.channelId, protectedChannel: channel.noforwards,
              page: (offsetId, limit) => invoke(new Api.messages.GetHistory({
                peer, offsetId, limit, offsetDate: 0, addOffset: 0, maxId: 0, minId: 0, hash: 0,
              })),
            });
          },
        });
      })();
      return await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Provider deadline exceeded.')), 22_000);
      })]);
    } finally {
      clearTimeout(timer);
      await client.destroy().catch(() => {});
    }
  };
}
