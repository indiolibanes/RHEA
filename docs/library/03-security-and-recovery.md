# Security, execution and recovery

- The Access subject must match the source owner. Confirm channel ownership in Telegram at enrollment and before admin actions. Resolve peers from opaque, actor-bound references. Verify roles and exact destination at every material phase.
- Separate Telegram reader, staging publisher and cleanup authority. Prefer a dedicated, non-admin participant for read-only history. Give the staging publisher only required source access and destination posting rights. Keep Telegram account sessions out of the gateway, browser and logs. Encrypt session material and Telegram peer identifiers with per-environment keys available only to the isolated adapter. Minimize the lifetime of decrypted secrets.
- Revoke RHEA access and unconsumed approvals immediately on unlink. Remove channel rights and terminate the specific device in Telegram. Use BotFather to rotate an exposed test token. Keep active or recoverable receipt evidence until reconciliation is complete.
- Treat filenames, captions, aliases and titles as untrusted strings. Render them as text. Strip them and provider error payloads from audit events, telemetry and MCP replies. Keep real catalog/API responses behind Access and mark them no-store. Never expose provider sessions, QR proofs, codes or bearer credentials on the public HTTP gateway.
- Verify rights before copying or backing up any content. Protected and unsupported messages are blockers. Do not bypass restrictions by changing channel settings or downloading media.

| Phase | Entry and exit conditions |
| --- | --- |
| `SCANNED` | Persist the bounded scan, head, revision and coverage. A partial inventory supports read-only review. |
| `PLANNED` | Persist full target, source hash, retention boundary, limitations and estimates. Dry run is the default. |
| `APPROVED` | Protected owner approves exact copy evidence. Claim the source through D1's single-active-run index and atomically lease both source and destination channel by peer in the future executor. Recheck the approved revisions and roles. |
| `COPYING` | Serialize bounded batches. Write a durable intent and per-operation key before sending. Include input IDs, expected heads and stable provider random IDs if supported. Atomically persist confirmed receipts and source-to-destination mappings. |
| `VERIFIED` | Independently read destination order and counts, access the media, and compare caption entities, filenames, identity, album membership and multipart order. Validate while originals are accessible. A verified separate-channel copy may finalize with the source preserved. |
| `AWAITING_DELETION_APPROVAL` | Require an independently accessible, media-complete backup with a recovery test and source-to-backup map. The protected owner must separately approve exact original cleanup IDs, current revisions and backup evidence, and explicitly acknowledge which metadata cannot be restored. |
| `FINALIZED` | Independently compare the exact target order. If cleanup was separately authorized, verify the approved originals' absence and that retained originals and replacements still exist. |
| `PAUSED` | Persist the last verified checkpoint and eligible retry timestamp. Resume only with an unchanged snapshot, destination head and receipt ledger. |
| `FAILED` | Stop when a failure is known to have no side effects. |
| `RECOVERY_REQUIRED` | Stop writes on unknown delivery, discrepancies, missing mappings, concurrent publication or partial cleanup. Read from the last checkpoint and reconcile before any authorized resume. |

Consume each approval once through an atomic compare-and-set. Bind it to the owner, source and destination, plan hash, readback evidence and expiry. For cleanup, also bind the verified backup and explicit acknowledgment. Revalidate grants, source revision and destination head before each batch. D1 commits local state only. It cannot roll back a Telegram request.

Follow Bot API retry_after or MTProto FLOOD_WAIT_X with a durable deadline. Retry known non-delivery conservatively. Bot API copy has no documented idempotency parameter. Treat an ambiguous reply as recovery work and reconcile by independent readback before retrying. MTProto random IDs can aid deduplication but do not replace verifying the exact receipt and destination. Permissions, expired references with inaccessible originals, and unsupported content require review.

The application lock only excludes other RHEA clients. For in-place work use a no-post maintenance window and check scheduled and external publishing. Stop on posts, edits or deletions outside the plan. Backups must actually contain recoverable media. An inventory alone cannot reconstruct bytes. Republishing backed-up media creates new messages and cannot restore source IDs, dates, URLs, reactions or views.

Retain observations and mappings through the recovery window, and clear expired snapshots with an explicit actor-scoped retention policy. Logs should use fixed result codes and exclude Telegram content. This branch tests the state model and storage constraints without any executable provider mutation.
