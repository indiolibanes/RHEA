import { createHash } from 'node:crypto';
import { inventoryLimit } from '../src/rhea/library/mtproto-contract.mjs';

const pageSize = 80;
const safeLong = value => value?.toString().match(/^-?[0-9]{1,20}$/)?.[0];

function project(post, protectedChannel) {
  const document = post.media?.document;
  const filename = document?.attributes?.find(attribute => attribute.className === 'DocumentAttributeFilename')?.fileName;
  const mediaId = safeLong(document?.id);
  const bytes = Number(document?.size);
  return {
    id: post.id, date: post.date, editedAt: post.editDate,
    caption: typeof post.message === 'string' ? post.message.slice(0, 448) : undefined,
    filename: typeof filename === 'string' ? filename.slice(0, 192) : undefined,
    albumId: safeLong(post.groupedId), providerMediaId: mediaId ? 'document:' + mediaId : undefined,
    sizeBytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined,
    copyPolicy: protectedChannel || post.noforwards ? 'protected' : 'unknown',
  };
}

export async function readInventory({ channelId, protectedChannel, page, max = inventoryLimit }) {
  const messages = [];
  let first;
  let offset = 0;
  let unreadable = false;
  let exhausted = false;
  while (messages.length < max) {
    const result = await page(offset, Math.min(pageSize, max - messages.length));
    first ??= result;
    const batch = result.messages;
    if (!Array.isArray(batch)) return { state: 'stale_inventory' };
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const post of batch) {
      if (!Number.isInteger(post.id) || post.id <= 0 || (offset && post.id >= offset)) return { state: 'stale_inventory' };
      if (post.className === 'MessageEmpty') unreadable = true;
      offset = post.id;
      messages.push(project(post, protectedChannel));
      if (messages.length === max) break;
    }
  }

  const latest = await page(0, 1);
  const head = first.messages[0];
  const headAfter = latest.messages?.[0];
  if (first.pts !== latest.pts || head?.id !== headAfter?.id || head?.editDate !== headAfter?.editDate) {
    return { state: 'stale_inventory' };
  }
  messages.reverse();
  return {
    state: 'inventory',
    inventory: {
      channelId,
      complete: exhausted && !unreadable && Number.isInteger(first.pts),
      revision: createHash('sha256').update(JSON.stringify([channelId, first.pts, messages])).digest('hex'),
      messages,
    },
  };
}
