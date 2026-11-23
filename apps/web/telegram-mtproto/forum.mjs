import { createHmac, timingSafeEqual } from 'node:crypto';
import { forumId, forumPageSize } from '../src/rhea/library/forum-contract.mjs';

const positive = value => Number.isInteger(value) && value > 0;
const signers = ({ actor, ownerId, key, forum }) => {
  const mac = text => createHmac('sha256', key).update(JSON.stringify(['forum-v1', actor, ownerId, forum.channelId, text])).digest();
  return {
    encode(value) {
      const body = Buffer.from(JSON.stringify(value)).toString('base64url');
      return body + '.' + mac(body).toString('base64url');
    },
    decode(token) {
      const [body, tag] = token.split('.');
      const supplied = Buffer.from(tag ?? '', 'base64url');
      if (supplied.length !== 32 || !timingSafeEqual(mac(body), supplied)) return null;
      try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    },
  };
};

function forumPost(message, protectedForum) {
  const raw = message.message ?? '';
  const bold = message.entities?.find(entity => entity.className === 'MessageEntityBold' &&
    Number.isInteger(entity.offset) && entity.offset >= 0 && positive(entity.length));
  const heading = bold ? raw.slice(bold.offset, bold.offset + bold.length).trim().slice(0, 128) : undefined;
  const sizes = [...raw.matchAll(/\[\s*(\d+(?:[.,]\d+)?\s*(?:[KMGT]i?B|bytes))\s*\]/gi)];
  const document = message.media?.document;
  const filename = document?.attributes?.find(a => a.className === 'DocumentAttributeFilename')?.fileName;
  const group = message.groupedId?.toString();
  const cover = Boolean(message.media?.photo || (typeof document?.mimeType === 'string' && document.mimeType.startsWith('image/') && heading));
  const sizeBytes = Number(document?.size);
  return { id: message.id, kind: cover ? 'cover' : document ? 'document' : message.media ? 'media' : 'note',
    caption: raw.slice(0, 1024), heading, declaredSize: sizes.length === 1 ? sizes[0][1] : undefined,
    filename: typeof filename === 'string' ? filename.slice(0, 512) : undefined,
    sizeBytes: Number.isSafeInteger(sizeBytes) ? sizeBytes : undefined,
    albumId: /^-?[0-9]{1,20}$/.test(group ?? '') ? group : undefined,
    protected: Boolean(protectedForum || message.noforwards) };
}

export function forumReader(config, transport) {
  const channelId = config.forum.channelId;
  const signer = signers(config);

  return async function read(operation, input) {
    const cursor = input.cursor === null ? null : signer.decode(input.cursor);
    if (input.cursor !== null && cursor?.operation !== operation) return { state: 'forum_cursor_invalid' };
    if (operation === 'forumtopics') {
      const offset = cursor?.offset ?? { date: 0, id: 0, topic: 0 };
      const result = await transport.topics(offset, forumPageSize);
      if (!Array.isArray(result.topics) || result.topics.length > forumPageSize) return { state: 'forum_changed' };
      const topics = result.topics.filter(topic => topic.className === 'ForumTopic');
      if (topics.some(topic => !forumId(topic.id) || typeof topic.title !== 'string')) return { state: 'forum_changed' };
      const count = (cursor?.count ?? 0) + result.topics.length;
      let next = null;
      if (result.topics.length && (!Number.isInteger(result.count) || count < result.count)) {
        const last = result.topics.at(-1);
        const date = result.orderByCreateDate ? last.date : result.messages?.find(message => message.id === last.topMessage)?.date;
        if (!positive(date) || !forumId(last.topMessage) || !forumId(last.id) || last.id === offset.topic) {
          return { state: 'forum_changed' };
        }
        next = signer.encode({ operation, count, offset: { date, id: last.topMessage, topic: last.id } });
      }
      return { state: 'forum_topics', forum: { channelId, next, topics } };
    }

    const { topicId } = input;
    if (cursor && cursor.topicId !== topicId) return { state: 'forum_cursor_invalid' };
    if (topicId === 1) return { state: 'forum_general' };
    if (!await transport.hasTopic(topicId)) return { state: 'forum_unavailable' };
    const result = await transport.posts(topicId, cursor?.offset ?? 0, forumPageSize);
    const raw = result.messages;
    if (!Array.isArray(raw) || raw.length > forumPageSize ||
        raw.some((message, index) => !forumId(message.id) || message.id < topicId ||
          (message.id === topicId && message.className !== 'MessageService') ||
          (index ? message.id >= raw[index - 1].id : cursor && message.id >= cursor.offset))) return { state: 'forum_changed' };
    const posts = [];
    for (const message of raw) {
      if (message.className === 'MessageService') continue;
      if (message.className !== 'Message' || message.peerId?.channelId?.toString() !== channelId ||
        (message.replyTo?.replyToTopId ?? message.replyTo?.replyToMsgId) !== topicId) return { state: 'forum_changed' };
      posts.push(forumPost(message, transport.protected));
    }
    const lastId = raw.at(-1)?.id;
    const next = lastId > topicId ? signer.encode({ operation, topicId, offset: lastId }) : null;
    return { state: 'forum_page', forum: { channelId, topicId, next, posts } };
  };
}
