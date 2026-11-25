import { forumId } from './forum-contract.mjs';
import { mirrorLimit, mirrorInput } from './mirror-contract.mjs';

export const organizationOperations = Object.freeze({
  organizepreview: 'mirrorpreview', organizeapprove: 'mirrorapprove',
  organizenext: 'mirrornext', organizestatus: 'mirrorstatus',
  rebuildpreview: 'mirrorpreview', rebuildapprove: 'mirrorapprove',
  rebuildnext: 'mirrornext', rebuildstatus: 'mirrorstatus',
});

export const isOrganizationOperation = operation => Object.hasOwn(organizationOperations, operation);
export const isRebuildOperation = operation => isOrganizationOperation(operation) && operation.startsWith('rebuild');
export const rebuildLimit = 240;
export const rebuildIntakeLimit = 60;
export const rebuildRequestLimit = 4096;

export function organizationInput(operation, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (isRebuildOperation(operation)) {
    const { currentTopicId, sourceTopicId, replacementTopicId, beforeId, letter, ids, insertions, approval, confirm } = value;
    const approving = operation === 'rebuildapprove';
    if (Object.keys(value).length !== (approving ? 8 : 6) + (insertions !== undefined ? 1 : 0) ||
        ![currentTopicId, sourceTopicId, replacementTopicId].every(forumId) ||
        currentTopicId === 1 || replacementTopicId === 1 ||
        new Set([currentTopicId, sourceTopicId, replacementTopicId]).size !== 3 ||
        (beforeId !== null && !forumId(beforeId)) || typeof letter !== 'string' || !/^[A-Z]$/.test(letter) ||
        !Array.isArray(ids) || !ids.length || ids.length > rebuildIntakeLimit ||
        !ids.every(forumId) || new Set(ids).size !== ids.length) return null;
    if (insertions !== undefined) {
      if (beforeId !== null || !Array.isArray(insertions) || insertions.length < 2 || insertions.length > ids.length ||
          insertions.some(slot => !slot || Object.keys(slot).length !== 2 ||
            (slot.beforeId !== null && !forumId(slot.beforeId)) ||
            !Array.isArray(slot.ids) || !slot.ids.length || slot.ids.length > ids.length ||
            !slot.ids.every(forumId)) || new Set(insertions.map(slot => slot.beforeId)).size !== insertions.length ||
          JSON.stringify(insertions.flatMap(slot => slot.ids)) !== JSON.stringify(ids)) return null;
    }
    const confirmation = approving ? mirrorInput('mirrorapprove', { approval, confirm }) : {};
    return confirmation && { currentTopicId, sourceTopicId, replacementTopicId, beforeId, letter, ids,
      ...(insertions !== undefined && { insertions: insertions.map(({ beforeId, ids }) => ({ beforeId, ids })) }), ...confirmation };
  }
  const { sourceTopicId, localTopicId, backupTopicId, letter, ids, approval, confirm } = value;
  const approving = operation === 'organizeapprove';
  if (Object.keys(value).length !== (approving ? 7 : 5) || !forumId(sourceTopicId) || !forumId(localTopicId) ||
      !forumId(backupTopicId) || localTopicId === 1 || backupTopicId === 1 || localTopicId === sourceTopicId ||
      typeof letter !== 'string' || !/^[A-Z]$/.test(letter) || !Array.isArray(ids) ||
      !ids.length || ids.length > mirrorLimit || !ids.every(forumId) || new Set(ids).size !== ids.length) return null;
  const confirmation = approving ? mirrorInput('mirrorapprove', { approval, confirm }) : {};
  if (!confirmation) return null;
  return { sourceTopicId, localTopicId, backupTopicId, letter, ids, ...confirmation };
}
