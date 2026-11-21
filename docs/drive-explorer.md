# RHEA Drive explorer

Open **Rhea → Arquivos do Drive**. The explorer exposes direct-child navigation, breadcrumbs, list and grid views, name prefix search, filters, pagination, selection across loaded pages and metadata. Name and date are ordered by Drive. Size and MIME order apply within a loaded page. The web interface can create, rename, move, stream downloads and move confirmed selections to the reversible Google Drive trash.

Every target is resolved against the authorized Google account. The current root must be an accessible, unique, app-marked folder named RHEA directly under that account's My Drive. The server checks actual Drive metadata and follows each file's real parents to that root. It rejects outside IDs, shortcuts, ambiguous or inaccessible parents, cycles, paths deeper than 32 nodes and trashed nodes. Move checks both source and destination. The root is immutable through these endpoints. Google Drive does not expose an atomic cross-resource ancestry transaction, so edits performed directly on Drive by another client can race the metadata checks. The service rereads changed metadata before treating an operation as confirmed.

The existing `drive.file` scope imposes a per-file visibility boundary even inside the root. Creating and uploading through Rhea establishes app visibility. Google Picker may grant explicit access to additional files in a future increment. A known Drive ID is insufficient.

Text and Markdown are limited to a 64 KiB preview. Markdown shows safe headings and paragraphs through text nodes. It does not load links, HTML or embeds. Eligible JPEG, PNG, WebP, GIF, MP4 and WebM are loaded on request up to 12 MiB, with native media controls. PDF, ZIP and GLB/GLTF currently have metadata and external opening or attachment download. Embedded rendering of those formats requires a separate sandbox and resource-budget pass. There are no automatic model loads.

For acceptance, create two folders in a test account, send a synthetic file into one of them and use the in-app UI to rename it and move it. Open its receipt and compare the location in Drive. Try an authorized Drive ID located outside the root and expect the scoped endpoint to refuse it. Use a synthetic file for trash and verify that Drive can restore it.

The browser test in `apps/web/tests/rhea-mobile-smoke.py` uses Playwright Chromium in a 390×844 touch viewport. It checks ten automatic queue entries, one isolated failure, exact request bytes, IndexedDB recovery across reload, basic explorer actions and layout overflow with a simulated API.
