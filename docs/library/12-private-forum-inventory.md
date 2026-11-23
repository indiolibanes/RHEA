# Private Telegram forum inventory

This opt-in reader uses the enrolled test account to identify one private supergroup with native topics. It reads metadata without media transfers or changes to Telegram history. Keep the existing broadcast sandbox configured separately.

Set both adapter runtime variables for an already joined disposable forum:

| Variable | Value |
| --- | --- |
| `RHEA_TELEGRAM_FORUM_ID` | Bare numeric supergroup ID from an authorized message link |
| `RHEA_TELEGRAM_FORUM_INVITE` | Private invite for that exact forum |

In **Inventário do supergrupo por tópico**, select **Ler tópicos**, then choose a topic. Load earlier pages as needed. The cursor is signed and scoped to the configured forum, verified operator and topic. The panel keeps completed pages and retry cursors during the current view. Reloading the browser or leaving the Telegram tab restarts the browser inventory. The General topic is listed separately and remains outside this phase because it does not share the ordinary forum reply-thread model.

The inventory records cover or image candidates, captions, bold title text, declared and actual sizes, Telegram filenames, and album IDs. Album rows show the members currently loaded. Review size labels and cover-to-season association with the original posts. The browser can search only the loaded pages.

Select a Markdown list to compare filenames locally. The importer accepts literal filenames in inline-code list entries, optionally under series and season headings. Exact matches and unique eight-digit hexadecimal tags generate reference names. Tag-based matches are suggestions. The reader does not verify file hashes or infer a missing name from an ambiguous match.

Before connecting a real library, test with separate topics, standalone covers, bold season headers, and document albums that cross page boundaries. Verify the original links and compare reference names and sizes. Enabling the reader does not grant the staging publisher a forum destination.
