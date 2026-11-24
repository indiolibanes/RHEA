export const forumPageSize = 60;
export const forumId = value => Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
const channelId = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const cursorToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,420}\.[A-Za-z0-9_-]{43}$/.test(value);

export const isForumOperation = operation => operation === 'forumtopics' || operation === 'forumpage';

export function forumInput(operation, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !(value.cursor === null || cursorToken(value.cursor))) return null;
  if (operation === 'forumtopics') {
    if (Object.keys(value).length === 1) return { cursor: value.cursor };
    return Object.keys(value).length === 2 && value.scope === 'backup' ?
      { cursor: value.cursor, scope: 'backup' } : null;
  }
  if (Object.keys(value).length !== 2 || !forumId(value.topicId)) return null;
  return { topicId: value.topicId, cursor: value.cursor };
}

const kinds = new Set(['cover', 'document', 'note', 'media']);
const optional = (value, length) => typeof value === 'string' ? value.slice(0, length) : undefined;
const bytes = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function forumResponse(state, value) {
  if (!value || !channelId(value.channelId) || !(value.next === null || cursorToken(value.next))) return null;
  const result = { channelId: value.channelId, next: value.next };
  if (state === 'forum_topics') {
    if ((value.scope !== undefined && value.scope !== 'backup') ||
        !Array.isArray(value.topics) || value.topics.length > forumPageSize ||
        new Set(value.topics.map(topic => topic?.id)).size !== value.topics.length ||
        value.topics.some(topic => !forumId(topic?.id) || typeof topic?.title !== 'string')) return null;
    return { ...result, ...(value.scope ? { scope: value.scope } : {}),
      topics: value.topics.map(topic => ({ id: topic.id, title: topic.title.slice(0, 128),
      closed: topic.closed === true, hidden: topic.hidden === true })) };
  }
  if (!forumId(value.topicId) || !Array.isArray(value.posts) || value.posts.length > forumPageSize ||
      value.posts.some((post, index) => !forumId(post?.id) || !kinds.has(post.kind) ||
        (index > 0 && value.posts[index - 1].id <= post.id))) return null;
  return { ...result, topicId: value.topicId, posts: value.posts.map(post => ({
    id: post.id, kind: post.kind, caption: optional(post.caption, 1024),
    heading: optional(post.heading, 128), declaredSize: optional(post.declaredSize, 36),
    filename: optional(post.filename, 512), albumId: optional(post.albumId, 22),
    sizeBytes: bytes(post.sizeBytes), protected: post.protected === true,
  })) };
}
