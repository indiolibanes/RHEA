# RHEA upload queue

Selecting or dropping files authorizes transmission to the connected Google Drive account, inside the Rhea root or the authorized folder open in the explorer. Each selection is a logical batch. Files retain their original name and bytes. Currently accepted files are 1 byte to 512 MiB, with valid names of up to 200 characters.

The queue runs two transfers at a time by default, with 2 MiB resumable slices and backoff for network, quota and provider failures. A fresh Google session must match the account previously assigned to an entry. The queue tests the last resumable offset after retry, using the same pre-generated Drive ID. The upload cannot be shown as synchronized until a scoped metadata read confirms its ID, size, parent, name and upload marker. Existing same-name files require a decision to keep both or ignore. The queue does not overwrite.

IndexedDB stores records per authenticated Access actor. The browser attempts to retain blobs up to 48 MiB each and 128 MiB total. Browser eviction, storage denial and larger files can leave metadata without bytes. The interface identifies those items. Closing a tab stops forwarding chunks. Pending items with preserved bytes can resume after reopening and reauthenticating to the same Google account. Confirmed and cancelled entries release their bytes. The sealed reservation is valid for seven days, and the shorter resumable ticket can be replaced using the same reservation. When that reservation expires, a fresh selection is required.

The first upload can initialize the app-created root. Browser Web Locks serialize initialization across tabs when available. Simultaneous setup from separate devices can produce duplicate roots. A lookup detecting ambiguity blocks operations until the user resolves it in Drive. The Drive scope remains `drive.file`; folders and files Drive has not made visible to this OAuth application are outside the Rhea's observable dataset.

## Browser acceptance

1. Open the RHEA workspace and connect a Google test account in the same browser tab.
2. Select ten uniquely named synthetic files. Verify that ten queue entries appear and transfers start without another button.
3. Interrupt connectivity and resume it. Confirm that remaining uploads complete and that each receipt opens the authorized location in Drive.
4. Reload an interrupted small-file batch. Confirm recovery only for entries whose bytes were saved.
5. Test same-name files with both prompts. Check that existing files are preserved.
6. Switch to a different Google account with unsent files. Verify the original batch pauses and resumes only when its original account is reconnected.
