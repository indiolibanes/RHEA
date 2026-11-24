# Private Telegram forum inventory

This opt-in reader uses the enrolled test account to identify one private supergroup with native topics. It reads metadata without media transfers or changes to Telegram history. Keep the existing broadcast sandbox configured separately.

Set both adapter runtime variables for an already joined disposable forum:

| Variable | Value |
| --- | --- |
| `RHEA_TELEGRAM_FORUM_ID` | Bare numeric supergroup ID from an authorized message link |
| `RHEA_TELEGRAM_FORUM_INVITE` | Private invite for that exact forum |

In **Inventário do supergrupo por tópico**, select **Ler tópicos**, then choose a topic. Load earlier pages as needed. The cursor is signed and scoped to the configured forum, verified operator and topic. The panel keeps completed pages and retry cursors during the current view. Reloading the browser or leaving the Telegram tab restarts the browser inventory. General uses its Telegram topic ID even when renamed.

The inventory records cover or image candidates, captions, bold title text, declared and actual sizes, Telegram filenames, and album IDs. Album rows show the members currently loaded. Review size labels and cover-to-season association with the original posts. The browser can search only the loaded pages.

Select a Markdown list to compare filenames locally. The importer accepts literal filenames in inline-code list entries, optionally under series and season headings. Exact matches and unique eight-digit hexadecimal tags generate reference names. Tag-based matches are suggestions. The reader does not verify file hashes or infer a missing name from an ambiguous match.

Before connecting a real library, test with separate topics, standalone covers, bold season headers, and document albums that cross page boundaries. Verify the original links and compare reference names and sizes. Enabling the reader does not grant the staging publisher a forum destination.

## General or renamed General

Select the displayed name of topic ID 1 (for example, Requests). The adapter uses the same topic-scoped
`messages.getReplies` call as TDLib, with topic ID 1 and a bounded page size. General posts can have no
reply header or can reply to another General post. The adapter rejects messages marked as belonging
to another topic or supergroup. A page of service events can be empty while an older page is available.
The copy pilot still requires disposable topics with other IDs. No additional Railway variable is needed.
## Review alphabetical destinations

From the loaded inventory, select **Organizar arquivos deste tópico**, review the detected title,
and choose **Buscar no AniList**. The public lookup receives only the reviewed title. Select the
matching work to preview episode order, the reported document size total, and a possible caption.
Numbered fansub filenames can supply an episode without asserting a season.

To enable **Conferir destinos** for a second private supergroup, set these optional secrets on the Node
adapter. An absent or invalid pair leaves the primary inventory available.

| Variable | Value |
| --- | --- |
| `RHEA_TELEGRAM_BACKUP_FORUM_ID` | Bare numeric ID of the distinct private backup supergroup |
| `RHEA_TELEGRAM_BACKUP_FORUM_INVITE` | Private invite for that exact supergroup, already joined by the enrolled account |

The protected interface lists topic names in both groups using bounded, separately scoped cursors.
Create missing topics such as **Letra T** in Telegram and check again. Each group must have a unique
open match for the confirmed title's initial. The backup scope lists topics only. This review does
not publish or delete messages, copy media, create topics, or enable the separate synthetic mirror pilot.
