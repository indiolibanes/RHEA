// Synthetic state reducer. It has no Telegram client, credentials or network calls.
const active = ['APPROVED', 'COPYING', 'VERIFIED', 'AWAITING_DELETION_APPROVAL', 'PAUSED', 'RECOVERY_REQUIRED'];
const requireCheck = (condition, message) => { if (!condition) throw new Error(message); };

export function rehearse(state, event, plan) {
  requireCheck(state.planHash === plan.planHash, 'Plan hash mismatch.');
  const move = (allowed, phase, details = {}) => {
    requireCheck(allowed.includes(state.phase), 'Invalid transition from ' + state.phase);
    return { ...state, ...details, phase };
  };
  switch (event.type) {
    case 'plan':
      return move(['SCANNED'], 'PLANNED');
    case 'approve-copy':
      requireCheck(event.scope === 'copy' && event.planHash === plan.planHash && event.snapshotHash === plan.snapshotHash &&
        !plan.blockers.length, 'Copy approval or source snapshot is invalid.');
      return move(['PLANNED'], 'APPROVED', { destinationHead: event.destinationHead, receipts: [] });
    case 'start':
      return move(['APPROVED'], 'COPYING');
    case 'receipt': {
      if (state.phase !== 'COPYING') throw new Error('Copy receipt outside copy phase.');
      const stored = state.receipts[event.batchIndex];
      if (stored && JSON.stringify(stored) === JSON.stringify(event)) return state;
      const expected = plan.batches[state.receipts.length];
      if (event.batchIndex !== state.receipts.length || !expected || event.snapshotHash !== plan.snapshotHash ||
        event.previousHead !== state.destinationHead || event.sourceIds.join(',') !== expected.join(',') ||
        event.destinationIds.length !== expected.length ||
        !event.destinationIds.every((id, index) => Number.isSafeInteger(id) && id > (event.destinationIds[index - 1] ?? state.destinationHead))) {
        return move(['COPYING'], 'RECOVERY_REQUIRED', { reason: 'receipt_discrepancy' });
      }
      return move(['COPYING'], 'COPYING', { destinationHead: event.destinationIds.at(-1), receipts: [...state.receipts, structuredClone(event)] });
    }
    case 'pause':
      requireCheck(Number.isSafeInteger(event.resumeAfter), 'Expected a persisted retry deadline.');
      return move(['COPYING'], 'PAUSED', { resumeAfter: event.resumeAfter });
    case 'resume':
      requireCheck(event.now >= state.resumeAfter, 'Retry deadline has not elapsed.');
      if (event.snapshotHash !== plan.snapshotHash || event.destinationHead !== state.destinationHead) {
        return move(['PAUSED'], 'RECOVERY_REQUIRED', { reason: 'concurrent_channel_change' });
      }
      return move(['PAUSED'], 'COPYING');
    case 'uncertain':
      return move(active, 'RECOVERY_REQUIRED', { reason: event.reason });
    case 'verify': {
      const published = state.receipts?.flatMap(receipt => receipt.destinationIds);
      if (state.receipts?.length !== plan.batches.length || event.snapshotHash !== plan.snapshotHash ||
        !event.mediaAccessible || !event.metadataVerified || !event.groupsVerified ||
        published.join(',') !== event.independentOrder.join(',')) {
        return move(['COPYING'], 'RECOVERY_REQUIRED', { reason: 'replacement_verification_failed' });
      }
      return move(['COPYING'], 'VERIFIED');
    }
    case 'request-cleanup':
      requireCheck(plan.originalIdsForSeparateCleanup.length > 0 && event.backupEvidenceHash &&
        event.independentMediaVerified, 'An independent, media-complete backup must be verified.');
      return move(['VERIFIED'], 'AWAITING_DELETION_APPROVAL', { backupEvidenceHash: event.backupEvidenceHash });
    case 'finish-staging':
      requireCheck(plan.originalIdsForSeparateCleanup.length === 0, 'Cleanup is a separate workflow.');
      return move(['VERIFIED'], 'FINALIZED');
    case 'observe-cleanup':
      requireCheck(event.scope === 'cleanup' && event.planHash === plan.planHash && event.irreversibilityAcknowledged &&
        event.backupEvidenceHash === state.backupEvidenceHash && event.preCleanupSnapshotHash === plan.snapshotHash &&
        event.originalsAbsent && event.finalOrderVerified, 'Separate approval and final verification are required.');
      return move(['AWAITING_DELETION_APPROVAL'], 'FINALIZED');
    case 'fail':
      return state.receipts?.length ? move(active, 'RECOVERY_REQUIRED', { reason: event.reason }) :
        move(['SCANNED', 'PLANNED', ...active], 'FAILED', { reason: event.reason });
    default:
      throw new Error('Unknown rehearsal event.');
  }
}
