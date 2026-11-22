# Mobile setup and technical handoff

## Review now

Open the supplied synthetic preview in a phone browser. Select **K** or **S**, expand a series, and check how seasons and episodes are grouped. Try a catalog correction, compare the strategies, and open **Revisar verificações e aprovações**. The demo resets on reload. At the default batch size it shows 355 posts for staging or 347 copies with 8 retained for suffix reflow. A Telegram account is unnecessary for review.

## Prepare a disposable live test from a phone

See the [sandbox connection runbook](06-telegram-sandbox.md) for the first verification in the Telegram tab.

1. In Telegram make two new **private channels**, for example **RHEA Test Source** and **RHEA Test Destination**. Keep the destination empty and exclude the real library from the test.
2. Post small media you own in the source. Use labels such as `Kiro.S01E10.txt` and `Kiro.S01E02.txt` as captions or filenames and post them out of order. Add a duplicate, an episode with a missing number, an album of two original photos and several K and S titles. Date a disposable post early enough to cover the over-48-hour boundary when deletion trials are separately authorized.
3. When the test adapter is available, use BotFather to create a dedicated test bot. Store the token only in the isolated service secret settings. Give the bot source access and the destination posting rights required for the trial. Leave deletion rights off for the first trial. Verify both the numeric Telegram owner and the signed-in RHEA account in the protected workspace.
4. Enroll a dedicated test participant through the future protected adapter setup for history testing. Use the Telegram app and the adapter's short-lived device enrollment flow. Revoke the test device from Telegram Devices after testing. Keep codes, session keys, tokens and API hashes out of chats, Git and MCP.
5. After the sandbox read and copy adapters qualify, approve staging copy through the protected workspace. Inspect the new channel on the phone. Compare the order, captions, filenames, media access and grouped posts while the original remains available.

## Live evidence for the next stage

| Trial | Evidence |
| --- | --- |
| Private source inventory | Role, paginated existing history, channel high-water mark, handling of edits and gaps. Compare Bot API update coverage with MTProto. |
| Server-side copy | Known older post IDs, same-channel append and private staging, independent readback of document attributes, captions, media access and mapping. |
| Grouping and policy | Album membership and multipart order, skipped IDs, service posts and protected-content refusal. |
| Reliability | Inject a failure before sending, a dropped response after send, a partial result, a rate limit, an admin permission failure and a concurrent user upload. Verify restart checkpoints. |
| Age and deletion | In a separately authorized disposable test, compare recent and older posts for Bot API and channel-specific MTProto, with and without delete rights. Log the observed result and verify absence by independent readback. No destructive trial was run in this phase. |
| Recovery | Verify independent media backup access and source-to-backup mapping, then test a synthetic interrupted migration with both saved receipts and new Telegram IDs. |

## Deployment requirements and handoff

- **This draft.** Use Node.js 24. Run the existing web/MCP tests, the Astro build, and the Chromium smoke script. The sample catalog uses synthetic data. The optional sandbox connection check verifies only bot, channel and owner metadata.
- **Protected sandbox.** Configure a separate Access policy, test hostname and D1 database. Apply 0001–0003 in order, then `apps/web/mcp-gateway/0004_library.sql`. Use an isolated adapter identity, encrypted storage, test secrets and allowed egress. Keep production credentials and inventories separate.
- **Staging-only trial.** Wire the isolated reader and publisher after qualification. Keep cleanup disabled. Require short-lived plan evidence, exact source/destination leases, independent readback and durable receipts.
- **Same-channel consideration.** Review in a separate change after live synthetic evidence. Require an independent verified media backup and two separate approvals. Confirm privileges, irreversible metadata loss and the exact source suffix immediately before any cleanup.

The setup flow is designed for a phone browser and the Telegram app. The current demo provides review, with enrollment and execution reserved for the staged integration above.
