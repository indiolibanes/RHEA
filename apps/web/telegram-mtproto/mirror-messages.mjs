import { Api } from 'teleproto';
import { forumId } from '../src/rhea/library/forum-contract.mjs';
import { mirrorLimit, mirrorTestTopic } from '../src/rhea/library/mirror-contract.mjs';

const fixtureBytes = 25 * 1024 ** 2;
const attachmentId = media => /^-?[0-9]{1,20}$/.test(media?.id?.toString() ?? '');
const safeEntities = new Set(['MessageEntityBold', 'MessageEntityItalic', 'MessageEntityUnderline',
  'MessageEntityStrike', 'MessageEntitySpoiler', 'MessageEntityCode', 'MessageEntityPre',
  'MessageEntityUrl', 'MessageEntityTextUrl', 'MessageEntityBlockquote']);

function describe(message, topicId) {
  const reply = message.replyTo;
  const parent = reply?.replyToMsgId;
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

export function topicSnapshot(result, channelId, topicId) {
  if (result?.inexact || !Array.isArray(result?.messages) || result.messages.length > mirrorLimit + 1 ||
      !Number.isInteger(result.count) || result.count > mirrorLimit + 1 ||
      result.count > result.messages.length + 1) return null;
  const posts = [];
  let previous = Infinity;
  for (const message of result.messages) {
    const { id } = message;
    if (!forumId(id) || id >= previous || id < topicId || message.peerId?.channelId?.toString() !== channelId) return null;
    previous = id;
    if (id === topicId && message.className === 'MessageService') continue;
    if (id === topicId || message.className !== 'Message') return null;
    const post = describe(message, topicId);
    if (!post) return null;
    posts.push(post);
  }
  if (posts.length > mirrorLimit) return null;
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
  const source = await privateChat(config.source);
  const destination = await privateChat(config.destination);
  if ([source, destination].some(chat =>
    !chat?.megagroup || !chat.forum || chat.broadcast || chat.noforwards || !chat.creator)) return null;

  function topic(chat, scope) {
    const peer = peerFor(chat);
    const topicId = scope.topicId;
    return {
      peer, topicId,
      async title() {
        const result = await invoke(new Api.messages.GetForumTopicsByID({ peer, topics: [topicId] }));
        const topic = result.topics?.find(item => item.className === 'ForumTopic' && item.id === topicId);
        return topic && !topic.closed && !topic.hidden && topic.title === mirrorTestTopic ? chat.title + ' / ' + topic.title : null;
      },
      async read() {
        const result = await invoke(new Api.messages.GetReplies({
          peer, msgId: topicId, offsetId: 0, limit: mirrorLimit + 2, offsetDate: 0, addOffset: 0, maxId: 0, minId: 0, hash: 0,
        }));
        return topicSnapshot(result, scope.channelId, topicId);
      },
    };
  }

  const from = topic(source, config.source);
  const to = topic(destination, config.destination);
  const sourceTitle = await from.title();
  const destinationTitle = await to.title();
  if (!sourceTitle || !destinationTitle) return null;
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
