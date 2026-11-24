import { Api } from 'teleproto';
import { forumId } from '../src/rhea/library/forum-contract.mjs';
import { mirrorLimit, mirrorTestTopic } from '../src/rhea/library/mirror-contract.mjs';

export class MirrorPreflightError extends Error {
  constructor(side, code) {
    super('Mirror preflight could not be verified.');
    this.issue = { side, code };
  }
}

const unavailablePeer = new Set(['CHANNEL_PRIVATE', 'CHANNEL_INVALID', 'INVITE_HASH_INVALID', 'INVITE_HASH_EXPIRED']);
const fixtureBytes = 25 * 1024 ** 2;
const attachmentId = media => /^-?[0-9]{1,20}$/.test(media?.id?.toString() ?? '');
const safeEntities = new Set(['MessageEntityBold', 'MessageEntityItalic', 'MessageEntityUnderline',
  'MessageEntityStrike', 'MessageEntitySpoiler', 'MessageEntityCode', 'MessageEntityPre',
  'MessageEntityUrl', 'MessageEntityTextUrl', 'MessageEntityBlockquote']);

function describe(message, topicId) {
  const reply = message.replyTo;
  const parent = reply?.replyToMsgId ?? (reply?.forumTopic && reply.replyToTopId === topicId ? topicId : undefined);
  if ((reply?.replyToTopId ?? parent) !== topicId || !forumId(parent) || reply.replyToPeerId ||
      reply.replyFrom || reply.replyMedia || reply.quoteText || reply.quoteEntities?.length || reply.quote ||
      message.noforwards || message.ttlPeriod || message.viaBotId || message.fwdFrom ||
      message.replyMarkup || typeof message.message !== 'string' || message.message.length > 4096) return null;
  const rawEntities = message.entities ?? [];
  if (rawEntities.some(entity => !safeEntities.has(entity.className))) return null;
  const contents = { text: message.message, entities: rawEntities.map(entity => Buffer.from(entity.getBytes()).toString('hex')),
    kind: 'text' };
  const media = message.media;
  if (media && media.className !== 'MessageMediaEmpty') {
    if (media.ttlSeconds || media.videoCover || media.videoTimestamp) return null;
    const document = media.document;
    const photo = media.photo;
    if (media.className === 'MessageMediaDocument' && document?.className === 'Document' &&
        attachmentId(document) && document.fileReference?.length && document.accessHash &&
        !media.voice && !media.round && !media.altDocuments?.length) {
      const filename = document.attributes?.find(a => a.className === 'DocumentAttributeFilename')?.fileName;
      const size = Number(document.size);
      if (typeof filename !== 'string' || !filename || filename.length > 512 ||
          !Number.isSafeInteger(size) || size < 1 || size > fixtureBytes || typeof document.mimeType !== 'string') return null;
      Object.assign(contents, { kind: 'document', mediaId: document.id.toString(), filename, size,
        mimeType: document.mimeType, spoiler: Boolean(media.spoiler) });
    } else if (media.className === 'MessageMediaPhoto' && photo?.className === 'Photo' &&
        attachmentId(photo) && photo.fileReference?.length && photo.accessHash) {
      Object.assign(contents, { kind: 'photo', mediaId: photo.id.toString(), spoiler: Boolean(media.spoiler) });
    } else {
      return null;
    }
  }
  if (contents.kind === 'text' && !contents.text.trim()) return null;
  const album = message.groupedId?.toString() ?? null;
  if (album !== null && !/^-?[0-9]{1,20}$/.test(album)) return null;
  return { id: message.id, parent: parent === topicId ? null : parent, album, contents, message };
}

export function topicSnapshot(result, channelId, topicId, reject = () => null) {
  if (result?.inexact || result?.offsetIdOffset > 0 || !Array.isArray(result?.messages)) return reject('history_unverified');
  // The unpaged MTProto constructor carries all messages and has no count.
  const count = result.className === 'messages.Messages' ? result.messages.length : result.count;
  if (!Number.isInteger(count) || count < 0) return reject('history_unverified');
  if (result.messages.length > mirrorLimit + 1 || count > mirrorLimit + 1) return reject('history_limit');
  if (count > result.messages.length + 1) return reject('history_unverified');
  const posts = [];
  let previous = Infinity;
  for (const message of result.messages) {
    const { id } = message;
    if (!forumId(id) || id >= previous || id < topicId || message.peerId?.channelId?.toString() !== channelId) {
      return reject('history_unverified');
    }
    previous = id;
    if (id === topicId && message.className === 'MessageService') continue;
    if (id === topicId || message.className !== 'Message') return reject('unsupported_post');
    const post = describe(message, topicId);
    if (!post) return reject('unsupported_post');
    posts.push(post);
  }
  if (posts.length > mirrorLimit) return reject('history_limit');
  return posts.reverse();
}

export function mirrorUnits(posts) {
  const ids = new Set();
  const albums = new Set();
  const units = [];
  for (const post of posts) {
    if (ids.has(post.id) || (post.parent !== null && !ids.has(post.parent))) return null;
    ids.add(post.id);
    const previous = units.at(-1);
    if (post.album !== null && previous?.[0].album === post.album) {
      if (previous.length === 10 || previous[0].parent !== post.parent ||
          previous[0].contents.kind !== post.contents.kind ||
          previous.some(item => item.id === post.parent)) return null;
      previous.push(post);
    } else {
      if (albums.has(post.album) || (post.album !== null && post.contents.kind === 'text')) return null;
      if (post.album !== null) albums.add(post.album);
      units.push([post]);
    }
  }
  return units.some(unit => unit[0].album !== null && unit.length < 2) ? null : units;
}

function inputMedia(post) {
  const { document, photo } = post.message.media;
  const { spoiler } = post.contents;
  if (document) {
    const { id, accessHash, fileReference } = document;
    return new Api.InputMediaDocument({ spoiler, id: new Api.InputDocument({ id, accessHash, fileReference }) });
  }
  const { id, accessHash, fileReference } = photo;
  return new Api.InputMediaPhoto({ spoiler, id: new Api.InputPhoto({ id, accessHash, fileReference }) });
}

export async function openMirror(config, privateChat, peerFor, invoke, download) {
  async function topic(side) {
    const scope = config[side];
    const reject = code => { throw new MirrorPreflightError(side, code); };
    let chat;
    try {
      chat = await privateChat(scope);
    } catch (error) {
      if (unavailablePeer.has(error?.errorMessage)) reject('group_unavailable');
      throw error;
    }
    if (!chat) reject('group_unavailable');
    if (!chat.megagroup || !chat.forum || chat.broadcast) reject('group_not_forum');
    if (!chat.creator) reject('group_not_owned');
    if (chat.noforwards) reject('group_protected');

    const peer = peerFor(chat);
    const topicId = scope.topicId;
    async function resolve(query, errorCode) {
      try {
        return await invoke(query);
      } catch (error) {
        if (unavailablePeer.has(error?.errorMessage) ||
            ['TOPIC_ID_INVALID', 'MSG_ID_INVALID', 'MESSAGE_ID_INVALID', 'TOPIC_DELETED'].includes(error?.errorMessage)) {
          reject(errorCode);
        }
        throw error;
      }
    }
    const topics = await resolve(new Api.messages.GetForumTopicsByID({ peer, topics: [topicId] }), 'topic_missing');
    const entry = topics.topics?.find(item => item.className === 'ForumTopic' && item.id === topicId);
    if (!entry) reject('topic_missing');
    if (entry.title !== mirrorTestTopic) reject('topic_name');
    if (entry.closed || entry.hidden) reject('topic_closed');
    return {
      peer, topicId, title: chat.title + ' / ' + entry.title,
      async read({ requireEmpty = false } = {}) {
        const result = await resolve(new Api.messages.GetReplies({
          peer, msgId: topicId, offsetId: 0, limit: mirrorLimit + 2, offsetDate: 0, addOffset: 0, maxId: 0, minId: 0, hash: 0,
        }), 'history_unverified');
        if (requireEmpty && Array.isArray(result.messages) &&
            result.messages.some(message => message.id !== topicId)) reject('destination_not_empty');
        return topicSnapshot(result, scope.channelId, topicId, reject);
      },
    };
  }

  const from = await topic('source');
  const to = await topic('destination');
  const sourceTitle = from.title;
  const destinationTitle = to.title;
  return {
    sourceTitle, destinationTitle,
    readSource: from.read, readDestination: to.read,
    async copy(unit, randomIds, targetParent) {
      const replyTo = new Api.InputReplyToMessage({ replyToMsgId: targetParent ?? to.topicId,
        ...(targetParent !== null ? { topMsgId: to.topicId } : {}) });
      const options = { peer: to.peer, replyTo, silent: true };
      const content = post => ({ message: post.contents.text, entities: post.message.entities });
      let request;
      if (unit.length > 1) {
        request = new Api.messages.SendMultiMedia({ ...options, multiMedia: unit.map((post, i) =>
          new Api.InputSingleMedia({ ...content(post), media: inputMedia(post), randomId: randomIds[i] })) });
      } else {
        const [post] = unit;
        const single = { ...options, ...content(post), randomId: randomIds[0] };
        request = post.contents.kind === 'text' ? new Api.messages.SendMessage({ ...single, noWebpage: true }) :
          new Api.messages.SendMedia({ ...single, media: inputMedia(post) });
      }
      const result = await invoke(request, { maxRetryCount: 1 });
      const mapped = new Map(result.updates?.filter(item => item.className === 'UpdateMessageID')
        .map(item => [item.randomId?.toString(), item.id]));
      return randomIds.map(id => mapped.get(id.toString()));
    },
    async verifyMedia(posts) {
      for (const post of posts) {
        if (post.contents.kind === 'text') continue;
        let readable = false;
        for await (const bytes of download(post.message.media, { limit: 1, requestSize: 4096 })) {
          readable = bytes.length > 0;
          break;
        }
        if (!readable) return false;
      }
      return true;
    },
  };
}
