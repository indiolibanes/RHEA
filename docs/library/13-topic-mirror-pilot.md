# Telegram forum mirror pilot

The opt-in pilot copies one explicitly pinned topic from one disposable private supergroup to another. A single preview and owner approval covers at most 20 ordinary posts. The topic starts empty on the destination. New copies receive new IDs and dates. The record identifies the source and destination IDs for verified copies.

The pilot preserves chronological order, plain internal replies, supported formatting and spoilers, native photos and videos, and albums of 2–10 items of a supported type. A video or document must be at most 25 MiB. A document must have a filename in Telegram. Native videos may have no filename. The pilot verifies the primary video reference, including an explicit cover and playback offset when present. Telegram manages any alternative video encodings. The adapter reuses existing MTProto media references for eligible, unprotected posts. It neither re-uploads files nor renames them. Links embedded in the text stay literal. Posts with unsupported entities or media, cross-topic replies and protected content fail preflight. Both groups must be private forums owned by the enrolled test account.

## Prerequisites

Use a separate Access-protected Pages preview and an isolated, single-replica Node adapter with persistent session storage. Configure the existing [MTProto sandbox](07-mtproto-sandbox.md), including the private service connection, the operator identity and the adapter's encrypted session. Keep the broadcast channel configured for the existing enrollment and inventory flow.

Create two disposable private supergroups with topics enabled. Create one topic titled exactly `RHEA Mirror Test` in each group. In the source topic, publish an original photo with a bold caption, a plain reply with a spoiler, and an album with two small original documents. Keep the destination topic empty. Copy each topic's link to obtain the bare supergroup ID and the topic ID. Create a private invite for each exact group and verify the enrolled account is its owner.

Set these values in the **private Node adapter environment**, on Railway or the equivalent Docker host.

| Variable | Value |
| --- | --- |
| `RHEA_TELEGRAM_MIRROR_MODE` | `synthetic` |
| `RHEA_TELEGRAM_MIRROR_SOURCE_ID` | Bare numeric ID of the source supergroup |
| `RHEA_TELEGRAM_MIRROR_SOURCE_INVITE` | Private invite URL for the source supergroup |
| `RHEA_TELEGRAM_MIRROR_SOURCE_TOPIC_ID` | Numeric ID of the source test topic |
| `RHEA_TELEGRAM_MIRROR_DESTINATION_ID` | Bare numeric ID of the second supergroup |
| `RHEA_TELEGRAM_MIRROR_DESTINATION_INVITE` | Private invite URL for the second supergroup |
| `RHEA_TELEGRAM_MIRROR_DESTINATION_TOPIC_ID` | Numeric ID of the destination test topic |

Set `RHEA_TELEGRAM_MIRROR_MODE=disabled` to pause the pilot and keep its settings, or leave all mirror variables absent. Invalid mirror-only settings disable the copy pilot at startup while the session and forum inventory remain available. Both routes use the existing Cloudflare Access and service authentication rules. No new D1 binding, Worker secret or Telegram API application is required. Never commit either invite or the configured identifiers. An embedding site must update its existing MTProto bridge and mount the middleware-protected `/api/rhea/anime-metadata` Pages Function alongside the updated Astro component.

## Mobile acceptance

1. Open **Telegram → Espelhamento por tópico → Preparar prévia**. Compare the pinned source and destination and review the post IDs in chronological order.
   If preflight fails, the panel identifies the source or destination and reports a fixed reason for the failed check. If a specific post fails validation, the panel shows its ID and the reason. The mirror uses the separate `RHEA_TELEGRAM_MIRROR_*` settings. The original broadcast settings still serve the earlier inventory and staging pilot.
2. Tap **Aprovar cópia**, then **Continuar cópia**. Only the second action requests publication. Wait for all posts to be verified. **Pausar após o lote atual** stops the browser loop after the pending request.
3. In Telegram, compare the bold caption, spoiler reply target, album order, filenames and displayed file sizes. Open each document in the destination topic. The adapter checks media identity, name, size, MIME type, caption entities, order, album membership and reply mapping. It samples up to one 4 KiB chunk of each destination attachment. This is an accessibility check, not a full media backup audit.
4. For an interruption trial, start with a new destination group and test topic, complete at least one verified unit, pause and reload. Select **Consultar progresso** and **Continuar cópia**. Confirm that no verified unit is republished. During another synthetic run, add an unexpected post to the destination before continuing and confirm the changed snapshot blocks further writes.
5. Open **Consultar dados de anime**, enter a public title and open the provider record. The lookup sends only the manually entered title to the public AniList API. It shows up to six candidates and offers links to available covers. It needs no provider credential and does not store or apply a match. The inventory sums the available byte counts for loaded document posts. It groups by work and section only for unambiguous filename matches in the browser-local Markdown. Unmatched filenames and tag-only suggestions never assign bytes to a work or season automatically.

## Recovery and later rollout

A private journal next to the encrypted session retains the approved fingerprint, intent, server receipt and verified progress. It excludes source text, filenames, credentials, invite links and media. Keep the persistent volume. A known receipt can be reverified after restart. An attempt with a missing receipt locks the destination run for manual inspection. Retain the journal and both topics. Do not clear the journal and rerun against that target. Only use a fresh disposable destination topic for a new pilot.

The scale-out decision comes after the live disposable test. Qualify bounded pagination on both sides, one persistent job per destination, durable resume across larger catalogs, new-publication detection and cross-topic scheduling before enabling any real mirror. Maintain retained versions in the reserve group. Replication does not grant cleanup permissions or provide an off-Telegram copy of the media.

References: [Telegram media reuse](https://core.telegram.org/api/files#resending-existing-files), [Telegram reply placement](https://core.telegram.org/constructor/inputReplyToMessage), [AniList authentication](https://docs.anilist.co/guide/auth/), [AniList terms](https://docs.anilist.co/guide/terms-of-use).

## Two-destination pilot with existing large files

Keep the existing `RHEA_TELEGRAM_MIRROR_SOURCE_*` variables for the disposable source. Use the existing
`RHEA_TELEGRAM_MIRROR_DESTINATION_*` variables for the private backup supergroup and its empty topic.
The second topic in the source group shares the source group ID and invite, so it needs only its topic ID.

| Variable | Value for the two-destination pilot |
| --- | --- |
| `RHEA_TELEGRAM_MIRROR_MODE` | `synthetic-dual` |
| `RHEA_TELEGRAM_MIRROR_LOCAL_TOPIC_ID` | ID of the empty `RHEA Organized Test` topic in the source supergroup |
| `RHEA_TELEGRAM_MIRROR_DESTINATION_TOPIC_ID` | ID of the empty `RHEA Backup Test` topic in the separate backup supergroup |

The source topic remains `RHEA Mirror Test`. Use fresh destination topics, including a fresh backup topic if
a previous single-destination pilot already used it. The original `synthetic` mode still supports the old
one-destination pilot. Install the matching protected web bridge before the adapter.

Review both topic names and the original publication order in the preview. The owner approves once for both
destinations and separately starts copying. The adapter publishes in the organized topic and verifies each
mapping before it starts the backup topic. Both sets of receipts are visible separately. Recovery stops a run
with an unknown send receipt and prevents a blind resend. The test remains capped at 20 source posts and
requires both destinations to be empty at approval. The original posts remain accessible.

The dual adapter passes the existing Telegram photo and file references to `sendMedia` or `sendMultiMedia`.
The file limit is 4 GiB (4,294,967,296 bytes). A compressed archive is copied as one file. Railway, or another
trusted MTProto host, submits API requests and stores the checkpoint. The browser and adapter do not upload,
download, decompress or recompress media in this mode. Verification compares destination message IDs,
order, replies, album membership, captions and media metadata, including the identity and reported byte size
of each document. A result in the protected panel represents Telegram-side verification. Open a large
authorized synthetic file in the Telegram app from both destinations before treating the real-size test as passed.

The dual run republishes the existing sequence into two new topics. Supported metadata and files are
preserved. A broad rollout with chosen titles, new ordering across many topics, live synchronization, or
an independent media backup is a separate phase.

## Read-only organization preview

Open **Telegram → Arquivos por tópico**, load an authorized topic, and choose **Organizar arquivos deste tópico**. The browser groups loaded documents by title and season using exact Markdown matches, explicit series headings, or filename episode markers. Unassigned files and partial snapshots remain visible as review counts. Without an explicit episode marker, the preview leaves the episode number unconfirmed.

Review the title field before requesting candidates. Only that title goes to the existing AniList endpoint. Choose the exact work or edition to see a suggested alphabetical topic, numerical episode order, and sample caption. Duplicate episode slots, conflicting albums, and incompatible episode counts are flagged for review. The suggestion preserves original filenames and does not persist provider data, modify Telegram, or enter the copy approval flow.

If the AniList search is refused, unavailable, or rate limited, the panel shows the reason and offers **Usar título sem metadados**. This keeps episode ordering, byte totals, and destination checks available without treating a manually entered title as provider metadata. The forum resolver accepts **Letter T**, **Letter "T"**, and **Letra T** as labels for T.

## Approved organization pilot

Use only disposable forums with synthetic files to qualify this path. Set
`RHEA_TELEGRAM_ORGANIZE_MODE=approved-pilot` on the Node adapter with the existing
`RHEA_TELEGRAM_FORUM_ID`, `RHEA_TELEGRAM_FORUM_INVITE`,
`RHEA_TELEGRAM_BACKUP_FORUM_ID` and `RHEA_TELEGRAM_BACKUP_FORUM_INVITE`. The account must
own both groups. This setting is independent of the fixed-topic mirror variables. The default
leaves organization writes disabled.

From an authorized source topic, load its complete inventory and confirm one work or title.
Choose **Conferir destinos → Revisar publicação → Aprovar cópia**. The review shows both topic
names and the exact source IDs in publication order. **Executar cópia** is the only step that
sends files. This pilot accepts up to 20 selected documents in a source topic with at most 60
recent entries. Both destinations must be empty. A partial album, unsupported reply, protected
file or changed source blocks the operation. The backup uses the approved episode order.

The adapter reuses Telegram file references up to 4 GiB per document, preserves filenames and
original captions, and verifies the receipts and media metadata in both destinations. AniList
metadata informs the review. The adapter neither writes that metadata into the posts nor
changes or deletes the source. Destinations receive new Telegram message IDs.

The persistent session volume also holds one protected organization journal for the pilot.
After an interruption, reopen the same work and destinations to resume known receipts. If a
send happened without a trustworthy receipt, inspect Telegram and retain the journal for recovery.
The one-run journal deliberately prevents another pilot from starting against the same deployment
until the operator has reviewed the outcome and a subsequent rollout defines archival and replay.

AniList public lookup does not require an API key. The protected Pages endpoint accepts a
suppressed Origin only for an authenticated request with the same-origin browser Fetch Metadata
header. An upstream refusal remains visible and the confirmed-title workflow stays available.
