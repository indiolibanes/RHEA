import { forumId } from './forum-contract.mjs';
import { mirrorLimit, mirrorInput } from './mirror-contract.mjs';

export const organizationOperations = Object.freeze({
  organizepreview: 'mirrorpreview', organizeapprove: 'mirrorapprove',
  organizenext: 'mirrornext', organizestatus: 'mirrorstatus',
});

export const isOrganizationOperation = operation => Object.hasOwn(organizationOperations, operation);

export function organizationInput(operation, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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
