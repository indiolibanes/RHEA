# Telegram forum mirror pilot

The opt-in pilot copies one explicitly pinned topic from one disposable private supergroup to another. A single preview and owner approval covers at most 20 ordinary posts. The topic starts empty on the destination. New copies receive new IDs and dates. The record identifies the source and destination IDs for verified copies.

The pilot preserves chronological order, plain internal replies, supported formatting and spoilers, native photos, and document or photo albums of 2–10 items. Each document must be at most 25 MiB and have a filename in Telegram. The adapter reuses existing MTProto media references for eligible, unprotected posts. It neither re-uploads files nor renames them. Links embedded in the text stay literal. Posts with unsupported entities or media, cross-topic replies and protected content fail preflight. Both groups must be private forums owned by the enrolled test account.

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

Leave the settings absent to disable the pilot. Both routes use the existing Cloudflare Access and service authentication rules. No new D1 binding, Worker secret or Telegram API application is required. Never commit either invite or the configured identifiers. An embedding site must update its existing MTProto bridge and mount the middleware-protected `/api/rhea/anime-metadata` Pages Function alongside the updated Astro component.

## Mobile acceptance

1. Open **Telegram → Espelhamento por tópico → Preparar prévia**. Compare the pinned source and destination and review the post IDs in chronological order.
2. Tap **Aprovar cópia**, then **Continuar cópia**. Only the second action requests publication. Wait for all posts to be verified. **Pausar após o lote atual** stops the browser loop after the pending request.
3. In Telegram, compare the bold caption, spoiler reply target, album order, filenames and displayed file sizes. Open each document in the destination topic. The adapter checks media identity, name, size, MIME type, caption entities, order, album membership and reply mapping. It samples up to one 4 KiB chunk of each destination attachment. This is an accessibility check, not a full media backup audit.
4. For an interruption trial, start with a new destination group and test topic, complete at least one verified unit, pause and reload. Select **Consultar progresso** and **Continuar cópia**. Confirm that no verified unit is republished. During another synthetic run, add an unexpected post to the destination before continuing and confirm the changed snapshot blocks further writes.
5. Open **Consultar dados de anime**, enter a public title and open the provider record. The lookup sends only the manually entered title to the public AniList API. It shows up to six candidates and offers links to available covers. It needs no provider credential and does not store or apply a match. The inventory sums the available byte counts for loaded document posts. It groups by work and section only for unambiguous filename matches in the browser-local Markdown. Unmatched filenames and tag-only suggestions never assign bytes to a work or season automatically.

## Recovery and later rollout

A private journal next to the encrypted session retains the approved fingerprint, intent, server receipt and verified progress. It excludes source text, filenames, credentials, invite links and media. Keep the persistent volume. A known receipt can be reverified after restart. An attempt with a missing receipt locks the destination run for manual inspection. Retain the journal and both topics. Do not clear the journal and rerun against that target. Only use a fresh disposable destination topic for a new pilot.

The scale-out decision comes after the live disposable test. Qualify bounded pagination on both sides, one persistent job per destination, durable resume across larger catalogs, new-publication detection and cross-topic scheduling before enabling any real mirror. Maintain retained versions in the reserve group. Replication does not grant cleanup permissions or provide an off-Telegram copy of the media.

References: [Telegram media reuse](https://core.telegram.org/api/files#resending-existing-files), [Telegram reply placement](https://core.telegram.org/constructor/inputReplyToMessage), [AniList authentication](https://docs.anilist.co/guide/auth/), [AniList terms](https://docs.anilist.co/guide/terms-of-use).
