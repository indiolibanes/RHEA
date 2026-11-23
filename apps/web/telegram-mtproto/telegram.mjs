import { Api, TelegramClient } from 'teleproto';
import { Logger, LogLevel } from 'teleproto/extensions/Logger';
import { computeCheck } from 'teleproto/Password';
import { StringSession } from 'teleproto/sessions';
import { readInventory } from './inventory.mjs';
import { forumReader } from './forum.mjs';

function stagePost(post) {
  const document = post.media?.document;
  const mediaId = document?.id?.toString();
  const filename = document?.attributes?.find(attribute => attribute.className === 'DocumentAttributeFilename')?.fileName;
  const size = Number(document?.size);
  if (post.className !== 'Message' || !Number.isInteger(post.id) || post.id <= 0 ||
      post.noforwards || post.groupedId != null || post.ttlPeriod || document?.className !== 'Document' ||
      !/^-?[0-9]{1,20}$/.test(mediaId ?? '') || !Number.isSafeInteger(size) || size <= 0 || size > 25 * 1024 * 1024 ||
      typeof post.message !== 'string' || post.message.length > 448 || (filename?.length ?? 0) > 192) return null;
  return { id: post.id, caption: post.message, mediaId, size, filename, mimeType: document.mimeType,
    entities: post.entities?.map(entity => Buffer.from(entity.getBytes()).toString('hex')) ?? [] };
}

async function stageHistory(history, limit) {
  const result = await history(0, limit);
  if (!Number.isInteger(result.pts) || !Array.isArray(result.messages)) return null;
  const posts = result.messages.filter(post => post.className !== 'MessageService').reverse().map(stagePost);
  if (posts.some(post => !post) || posts.some((post, index) => index && post.id <= posts[index - 1].id)) return null;
  return { head: result.messages[0]?.id ?? 0, pts: result.pts, posts };
}

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
        const isOwner = async () => {
          const [me] = await invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }));
          return me && !me.bot && me.id?.toString() === config.ownerId;
        };
        const privateChat = async ({ inviteHash, channelId }) => {
          const invite = await invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));
          const channel = invite.chat;
          if (invite.className !== 'ChatInviteAlready' || channel?.className !== 'Channel' ||
              channel.id?.toString() !== channelId || channel.left ||
              channel.username || channel.usernames?.some(item => item.active) || !channel.accessHash) return null;
          return channel;
        };
        const privateChannel = async scope => {
          const channel = await privateChat(scope);
          return channel?.broadcast === true && !channel.megagroup ? channel : null;
        };
        const peerFor = channel => new Api.InputPeerChannel({ channelId: channel.id, accessHash: channel.accessHash });
        const historyFor = peer => (offsetId, limit) => invoke(new Api.messages.GetHistory({
          peer, offsetId, limit, offsetDate: 0, addOffset: 0, maxId: 0, minId: 0, hash: 0,
        }));
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
            if (!await isOwner()) return { state: 'account_mismatch' };
            const channel = await privateChannel(config);
            if (!channel) return { state: 'channel_unavailable' };
            return readInventory({
              channelId: config.channelId, protectedChannel: channel.noforwards,
              page: historyFor(peerFor(channel)),
            });
          },
          async forumInventory(operation, input) {
            if (!config.forum || !await isOwner()) return { state: 'forum_unavailable' };
            const channel = await privateChat(config.forum);
            if (!channel?.megagroup || !channel.forum || channel.broadcast) return { state: 'forum_unavailable' };
            const peer = peerFor(channel);
            const read = forumReader(config, {
              protected: channel.noforwards,
              topics: (offset, limit) => invoke(new Api.messages.GetForumTopics({
                peer, offsetDate: offset.date, offsetId: offset.id, offsetTopic: offset.topic, limit,
              })),
              async hasTopic(topicId) {
                const result = await invoke(new Api.messages.GetForumTopicsByID({ peer, topics: [topicId] }));
                return result.topics?.some(topic => topic.className === 'ForumTopic' && topic.id === topicId);
              },
              posts: (msgId, offsetId, limit) => invoke(new Api.messages.GetReplies({
                peer, msgId, offsetId, limit, offsetDate: 0, addOffset: 0, maxId: 0, minId: 0, hash: 0,
              })),
            });
            return read(operation, input);
          },
          async staging() {
            if (!config.staging || !await isOwner()) return null;
            const source = await privateChannel(config);
            const destination = await privateChannel(config.staging);
            if (!source || !destination || source.noforwards || destination.noforwards ||
                (!destination.creator && !destination.adminRights?.postMessages)) return null;
            const fromPeer = peerFor(source);
            const toPeer = peerFor(destination);
            return {
              sourceTitle: source.title,
              destinationTitle: destination.title,
              readSource: () => stageHistory(historyFor(fromPeer), 3),
              readDestination: () => stageHistory(historyFor(toPeer), 8),
              async copy(id, randomId) {
                const result = await invoke(new Api.messages.ForwardMessages({
                  fromPeer, toPeer, id: [id], randomId: [randomId], dropAuthor: true, silent: true,
                }), { maxRetryCount: 1 });
                return result.updates?.find(update => update.className === 'UpdateMessageID' &&
                  update.randomId?.toString() === randomId.toString())?.id;
              },
              async verifyMedia(id) {
                const result = await invoke(new Api.channels.GetMessages({
                  channel: new Api.InputChannel({ channelId: destination.id, accessHash: destination.accessHash }),
                  id: [new Api.InputMessageID({ id })],
                }));
                const post = result.messages?.find(message => message.id === id);
                if (!post || !stagePost(post)) return false;
                for await (const bytes of client.iterDownload(post.media, { limit: 1, requestSize: 4096 })) {
                  return bytes.length > 0;
                }
                return false;
              },
            };
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
