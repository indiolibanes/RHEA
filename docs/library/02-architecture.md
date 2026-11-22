# ADR 001 · Telegram Library boundary

**Status** Accepted for the synthetic foundation. Live transport is pending qualification.

The objective is chronological A–Z order inside a private channel. Virtual mode is a read-only catalog. Physical mode previews reconstruction from a complete inventory. Use a fresh private destination for the first live trial and preserve the original channel. Consider in-place suffix cleanup only after staging is verified. See the [Telegram capability matrix](01-telegram-feasibility.md).

## Repository integration

| Existing component | Reuse and current boundary |
| --- | --- |
| [Astro workspace](../../apps/web/src/pages/rhea) and design system | /rhea/library uses the existing fonts, settings, tokens, tones, navigation patterns and brand component. The static build and its bundle contain fictional fixture data only. The separate connection panel uses a protected API. Real data belongs behind the Access API. |
| [Cloudflare Access middleware](../../apps/web/functions/api/rhea/_middleware.js) | Future /api/rhea/library/* endpoints inherit the origin, production branch, signature, issuer, audience and subject checks. The Library service independently enforces channel ownership per Access subject. |
| [Remote Streamable HTTP gateway](../../apps/web/src/rhea/mcp/rhea-mcp.mjs) and [OAuth storage](../../apps/web/src/rhea/mcp/storage.mjs) | Reuse bounded JSON-RPC, PKCE, short-lived token, revocation and audit patterns. Current grants are coupled to a Drive account and token. Library grants require an independent audience and consent model. |
| [D1](../../apps/web/mcp-gateway/0004_library.sql) | Migration 0004 adds namespaced source, series, alias, snapshot, message, correction, run, approval, event, receipt and message mapping tables. The preview uses no D1 binding. |
| [Proposal workflow](../../apps/web/src/rhea/mcp/proposals.mjs) | Reuse the Access-protected review, explicit submission and conditional transition pattern. Library copy and cleanup have separate evidence-bound approval records. Current actions are Drive-specific. |
| [Connection persistence](../persistent-connections.md) | Reuse independent provider-link and grant lifecycles. A future unlink revokes access immediately, then terminates the provider session and verifies removal. Telegram sessions stay in isolated adapter storage. |

## Module and data flow

1. A private adapter reads the selected channel with a permitted participant session. Normalize records locally, reconcile pagination and store an immutable snapshot with a verified head and revision. Inaccessible history or an interrupted scan makes the snapshot incomplete.
2. `catalog.mjs` computes series and episode groups, duplicate candidates, links and local labels. Series IDs are explicit assignments. Aliases remain searchable variants and never authorize merging. The private-link helper accepts a verified bare channel ID and message ID. Real links are visible only to the owner.
3. `planner.mjs` fingerprints the source reference, snapshot revision, normalized plan inputs and correction settings. Its second hash binds the complete target, strategy and batch sequence. Live review evidence must also bind the exact destination, owner, runtime policy, adapter version, expiry and permissions.
4. A future isolated executor consumes immutable approved plans. `rehearsal.mjs` models the copy and recovery transitions with synthetic receipts. The separate sandbox Worker can verify a test bot connection. History reads, webhook ingestion and execution are outside this stage.

Default ordering uses Portuguese collation, numeric sort and configurable case and Latin diacritic folding. Non-Latin distinctions such as Japanese voicing marks are preserved. Optional leading Portuguese and English articles are ignored. A manual sort title handles romanized A–Z order for a Japanese canonical title. Pin the server runtime/ICU collation policy and invalidate plans generated under a different policy. The browser computes its own demo preview.

Within an explicit series, order by season, edition type, numeric episode, part and stable message ID. Editions are episode, OVA, ONA, special, movie and extra. Missing numbers sort last in their section. Parse clear SxxExx patterns and leave uncertain identities for correction. Albums retain their existing internal order. Multipart units must agree on their episode and have unique numbered parts. Conflicts, protected/unsupported items in the copy range and incomplete snapshots block physical qualification. All messages remain in the ordered target including unresolved entries. Exact metadata, Telegram file identity and a trusted optional SHA-256 provide distinct duplicate evidence.

## Physical strategies

| Strategy | Work | Preservation |
| --- | --- | --- |
| Virtual catalog | Read, sort and provide private links. | Existing chronology, IDs and engagement remain in the source. |
| Separate private channel, recommended | Copy the full target into an empty private channel and validate it before switching. | Originals, media and old links remain available in the source. The destination gets new links and dates. |
| In-place contiguous suffix | Retain the longest matching prefix of whole units. Append the remaining target in order and verify copies and backup. Cleanup requires independent approval for the exact original IDs. | Temporary duplicates appear. Only retained messages keep their original identity after cleanup. |

A suffix plan retains a prefix of both the original sequence and the target. The first mismatch or atomic-unit boundary determines the minimum contiguous suffix. Sparse deletion could sometimes retain a longer target prefix by keeping a subsequence of the original. This branch excludes sparse deletion because it enlarges the verification and recovery surface. K and S narrow the catalog view. An in-place K insertion can still require reflowing later letters.

Copy estimates count ascending source-ID request batches at the selected cap. Reading the source, backing it up, verifying the outcome, and rate-limit retries add calls. Cleanup counts are illustrative and do not determine age eligibility or an adapter's real deletion limits. Disable paid broadcasting. Hosting costs depend on actual D1 and adapter usage.

## Infrastructure

| Option | Decision |
| --- | --- |
| Pages and Workers | Reuse protected Pages, OAuth and MCP. Workers can call the Bot API over HTTPS. [Workers TCP](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) exists, yet MTProto client compatibility and session isolation need qualification. |
| D1 | Store metadata, snapshots, approval evidence and receipts. [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/) commits local checkpoints atomically. Its transaction cannot include Telegram RPCs. |
| Queues | Defer. [At-least-once delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) requires idempotency and reconciliation. |
| Workflows | Consider [durable sleeps and events](https://developers.cloudflare.com/workflows/) later. Reconcile uncertain writes before any automatic retry and keep D1 authoritative. |
| Containers | Qualify teleproto in a separate private Node process or [Cloudflare Container](https://developers.cloudflare.com/containers/configuration/workers-connections/). Verify egress, restart behavior, secret access and the exact dependency version. |
| R2 | Avoid media duplication by default. A separately verified private copy channel may provide a recoverable backup for suffix cleanup. Add encrypted object storage only when needed and authorized. |
