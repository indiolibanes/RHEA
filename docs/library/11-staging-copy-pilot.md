# Three-post staging copy pilot

The deployed reader stays read-only unless the Node adapter is configured with both staging settings. Use two disposable private broadcast channels and original test material. The source is the enrolled channel. Create a new empty destination in Telegram, grant the enrolled test account permission to post, and create its private invite. Supply these values only in the adapter runtime:

| Variable | Value |
| --- | --- |
| `RHEA_TELEGRAM_STAGING_CHANNEL_ID` | Bare numeric ID of the empty private destination |
| `RHEA_TELEGRAM_STAGING_CHANNEL_INVITE` | Private invite link for exactly that destination |

Deploy the adapter and the matching Private UI. In the Telegram tab, select **Preparar cópia de teste**. The preview covers exactly the three newest source posts and expires after five minutes. Check both channel names, the quoted captions, and the ordered IDs before selecting **Aprovar e copiar os três posts**. Use separately uploaded videos or documents up to 25 MiB each with distinct series and episode slots. Albums, multipart episodes, protected media, public channels, and a nonempty destination fail preflight.

The server rechecks the enrolled owner, channel membership, posting permission, exact source and destination evidence, and the one-time approval. It copies one post at a time using Telegram's server-side forwarding with author attribution hidden and captions preserved. It checks chronological readback, captions with their entities, document identity, filename, size and type. It reads one bounded chunk of each destination media file to verify access and discards the bytes.

One launch per destination is permitted on the adapter's persistent volume. The private journal contains an approval digest, write intents and stable request identifiers, provider receipts, and the verified source-to-destination mapping. It contains no captions, invite links, media bytes, or sessions. An interruption or discrepancy stops the run. Check the destination manually and retain the journal when RHEA asks for recovery. For a new pilot use a new empty disposable destination. The source is never modified and the pilot exposes no cleanup operation.

After verification the three destination IDs appear in the protected panel. Check the published order and play the test files in Telegram. Record the result before approving a larger trial.
