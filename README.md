<p align="center">
  <img src="docs/brand/rhea-banner.svg" alt="RHEA: your Drive, within reach of your assistants, and no further." width="100%">
</p>

<p align="center">
  <a href="https://indiolibanes.dev/rhea/">Project page</a> ·
  <a href="docs/google-drive-oauth.md">Drive setup</a> ·
  <a href="docs/mcp-gateway.md">MCP gateway</a> ·
  <a href="docs/library/07-mtproto-sandbox.md">Telegram</a> ·
  <a href="LICENSE">MIT License</a>
</p>

# RHEA

**A self-hosted workspace for digital libraries, Google Drive and AI assistants.**

RHEA connects an Access-protected web workspace to a dedicated folder in your Google Drive and exposes selected capabilities to MCP-compatible assistants through revocable OAuth grants. It also includes an isolated Telegram Library prototype for cataloging and planning the order of posts in a private channel.

RHEA is software you deploy in your own infrastructure—not a hosted service that takes custody of your files. You supply the Google OAuth application, Cloudflare resources and, if you choose to test Telegram, a separate MTProto runtime.

> **Project status: active development.** Drive and MCP integrations are implemented in the repository. Telegram history access and the limited copy pilot require an explicitly configured, isolated test environment. Do not treat them as production-ready bulk channel management.

## Capabilities at a glance

| Area | Available in this repository | Important boundary |
| --- | --- | --- |
| **Google Drive workspace** | Browse, search, preview, download, upload and organize files in the app's dedicated Drive tree. | Only files authorized under the app folder; requires your own Google OAuth and Cloudflare deployment. |
| **Remote MCP gateway** | OAuth discovery, Streamable HTTP tools, per-assistant read/propose/organize permissions and revocation. | Assistants receive scoped tool access, not Google credentials. Write tools depend on the approved grant and the client's configured capabilities. |
| **Telegram Library** | A–Z series catalog, episode grouping, duplicate indicators, local corrections and reordering previews, using demo fixtures or an authorized MTProto snapshot. | Live history is restricted to a configured private test channel; current reads are capped at 500 posts and may be partial. Catalog corrections are session-local. |
| **Telegram staging copy pilot** | Preview and explicitly approve a copy of exactly three eligible test posts to a separate empty private channel; verify the resulting messages. | Requires additional staging configuration. No automatic production reflow, in-place cleanup or source deletion. |
| **Bot API connection check** | Independently verify a minimally privileged test bot and channel. | This diagnostic does **not** enumerate channel history. |
| **Android prototype** | Local file intake and browsing with sample content and an optional hosted-workspace link. | Prototype, not a production Android Telegram client. |
| **Local MCP server** | Read allowlisted project documentation over stdio. | Separate from the remote Drive and Telegram integrations. |

### What RHEA does not currently do

- It does **not** automatically reorder an entire Telegram channel or rewrite its existing message chronology.
- It does **not** rename Telegram's underlying media files, bypass forwarding restrictions or make protected content copyable.
- It does **not** automatically delete, replace or clean up original Telegram posts.
- It does **not** expose Telegram sessions, login codes, private inventory or account credentials to AI assistants.

For Telegram, **virtual organization** (catalog and proposed order) and **physical publication** (new posts and message IDs) are deliberately separate operations.

The opt-in [forum mirror pilot](docs/library/13-topic-mirror-pilot.md) adds a protected copy-and-verify flow for one disposable topic in two private supergroups, plus a public AniList title lookup in the Library. A live disposable-forum acceptance test is required before any larger rollout.

## Architecture

| Component | Purpose |
| --- | --- |
| [Web workspace](apps/web) | Astro interface, Cloudflare Access boundary, Drive explorer, connection settings and Telegram Library views. |
| [Remote MCP implementation](apps/web/src/rhea/mcp) | OAuth, scoped Drive tools, grant enforcement and the remote gateway runtime. |
| [D1 migrations](apps/web/mcp-gateway) | Gateway credentials, approvals, Drive links and Library schema, applied in numerical order. |
| [Telegram Library UI and planner](apps/web/src/rhea/library) | Cataloging, A–Z previews, local correction and an embeddable Astro component. |
| [Isolated MTProto adapter](apps/web/telegram-mtproto) | Test-account enrollment, bounded historical reads and the approved three-post staging pilot. |
| [Bot API sandbox Worker](apps/web/telegram-worker) | Independent read-only bot/channel connection diagnostics. |
| [Local MCP server](apps/mcp) | Stdio documentation access. |
| [Android prototype](apps/android) | Experimental mobile interface. |

The main workspace is served at `/rhea`, with the standalone Library at `/rhea/library` and protected web APIs under `/api/rhea/*`. A separately deployed HTTPS Worker serves the remote MCP endpoint at `/mcp`.

**Each self-hosted installation has its own URLs and credentials.** In the protected workspace, use the displayed MCP URL when connecting an assistant. Do not assume that the public project-page URL is an MCP endpoint. Existing connections may retain the former **Horologiarius Relay** name; tool availability depends on the current gateway deployment, client allowlist and granted permissions.

## Getting started

### 1. Explore and test the web interface locally

Use Node.js 24 for parity with the project's development and Telegram runtime requirements.

~~~sh
cd apps/web
npm ci
npm test
npm run dev
~~~

Open the local URL printed by Astro. You can inspect the interface and synthetic Library catalog without connecting a real Drive or Telegram account. Live Google OAuth, Access verification, uploads and MCP authorization require deployed infrastructure.

To run the separate local documentation MCP tests from the repository root:

~~~sh
node --test apps/mcp/tests/rhea-mcp.test.mjs
~~~

### 2. Deploy the Drive workspace and MCP gateway

1. [Deploy the Astro workspace](docs/google-drive-oauth.md) to your own Cloudflare Pages project and protect it using Cloudflare Access.
2. Configure a Google Cloud OAuth web client with the `drive.file` scope and the exact Pages callback path `/api/rhea/callback`.
3. [Deploy the remote MCP gateway](docs/mcp-gateway.md) on an HTTPS Worker. Bind the **same D1 database** to Pages and the Worker, then apply the SQL migrations from [`apps/web/mcp-gateway`](apps/web/mcp-gateway) in numerical order.
4. Configure the required per-environment variables and secrets using the linked setup guides. Keep the Google OAuth client secret, MCP encryption key, cookie key and client allowlist out of source control.
5. Connect Google Drive in the workspace, test the authorized folder and [authorize each assistant](docs/assistant-connections.md). Review its tool list and grant only the required permissions.

Google Drive connection persistence, token renewal and revocation are described in [persistent connections](docs/persistent-connections.md).

### 3. Optional: qualify the Telegram Library in a test environment

Telegram uses a **separate** authentication, hosting and security boundary. It is not enabled merely by configuring Google Drive or the MCP Worker.

1. Read the [Telegram architecture](docs/library/02-architecture.md), [security and recovery model](docs/library/03-security-and-recovery.md) and [MTProto sandbox runbook](docs/library/07-mtproto-sandbox.md).
2. Provision a dedicated private test channel with original sample posts and a restricted test account.
3. Deploy the isolated Node adapter using the [Docker/Tunnel setup](docs/library/09-mtproto-host-setup.md) or the [Railway alternative](docs/library/10-railway-deploy.md). Railway is a private runtime for the reader; it does **not** replace Pages, Access or the MCP gateway.
4. Protect the adapter behind its dedicated service-authenticated connection. Configure the matching bridge on the protected Pages environment and verify login, account/channel identity, bounded history and disconnect.
5. Only if you intend to test publication, use a **different, empty private destination channel** and follow the [three-post staging runbook](docs/library/11-staging-copy-pilot.md). The copy requires a fresh preview and explicit owner approval.

To run the adapter's isolated tests without provisioning a Telegram account:

~~~sh
cd apps/web/telegram-mtproto
npm ci --ignore-scripts
npm test
~~~

The UI can also be [embedded in an existing Access-protected Telegram tab](docs/library/08-embed-telegram-library.md). This preserves a single catalog/planner implementation and keeps provider requests behind the same-origin protected API.

## How permissions and safety work

**Google Drive**

- RHEA requests Google's `drive.file` scope and checks file ancestry inside its authorized app folder.
- An assistant's OAuth grant is distinct from your browser session and may be revoked in the workspace.
- Read, proposal and direct organization permissions are separate. A proposal needs user review; direct organization requires an explicitly approved organize grant and still stays inside the authorized tree.
- The remote gateway exposes tools with `rhea_` names, including `rhea_connection_status` and `rhea_list_folder`. Granted organization capabilities may expose `rhea_create_folder`, `rhea_move_file` and `rhea_organize_files`.
- Access tokens, refresh credentials and workspace cookies are not returned to MCP clients. File names and document contents are treated as **untrusted data**, not as instructions to assistants.

**Telegram**

- The MTProto participant session remains in the isolated Node service, encrypted at rest and bound to the authorized account/channel identity.
- Test history reads are bounded; incomplete inventories and unverified copy rights block physical plans.
- A staging copy requires exact source/destination evidence and a one-time approval; it checks the resulting order and media availability, and retains recovery evidence for interruptions.
- The pilot never deletes the source. Generalized channel reconstruction, large-scale pagination, persistent snapshots and cleanup require additional qualification.
- Use material you own or have permission to republish. A private channel or administrator role does not itself grant redistribution rights.

See the [MCP gateway security contract](docs/mcp-gateway.md), [Library MCP proposals](docs/library/04-mcp-contracts.md) and [Telegram feasibility matrix](docs/library/01-telegram-feasibility.md) for the exact boundaries.

## Documentation index

| Topic | Read |
| --- | --- |
| Cloudflare Pages and Google OAuth | [Web and Drive setup](docs/google-drive-oauth.md) |
| Remote MCP endpoint, OAuth and D1 | [MCP gateway](docs/mcp-gateway.md) |
| Assistant setup and revocable grants | [Assistant connections](docs/assistant-connections.md), [persistent connections](docs/persistent-connections.md) |
| Drive explorer and uploads | [Drive explorer](docs/drive-explorer.md), [upload queue](docs/upload-queue.md) |
| Gemini CLI | [Gemini MCP integration](docs/gemini-mcp-integration.md) |
| Telegram design and safe planning | [Architecture](docs/library/02-architecture.md), [security and recovery](docs/library/03-security-and-recovery.md) |
| Telegram test connection and history | [Bot sandbox](docs/library/06-telegram-sandbox.md), [MTProto reader](docs/library/07-mtproto-sandbox.md) |
| Telegram private hosting | [Docker/Tunnel](docs/library/09-mtproto-host-setup.md), [Railway](docs/library/10-railway-deploy.md) |
| Telegram three-post publication pilot | [Staging copy](docs/library/11-staging-copy-pilot.md) |
| Embedded tab and mobile review | [Embedded Library](docs/library/08-embed-telegram-library.md), [mobile review](docs/library/05-mobile-and-handoff.md) |

## Visual identity

Rhea is the face of the project, and she is not drawn: she is **lit**. A disc of small lamps sits inside a gold ring with one opening at the top. The lamps suggest two eyes and a smile; three more lamps above the opening form her antenna. The ring represents the dedicated folder and its single authorized entrance.

In the web workspace, the lamps can blink, respond to the pointer or touch and emit a subtle ripple. Reduced-motion preferences and the serious mode keep them still.

The assets are in [`docs/brand`](docs/brand):

| Asset | Intended use |
| --- | --- |
| [rhea-icon.svg](docs/brand/rhea-icon.svg) | App icon and favicon, with an [animated variant](docs/brand/rhea-icon-animated.svg). |
| [rhea-mark.svg](docs/brand/rhea-mark.svg) | Standalone lamp face, with an [animated variant](docs/brand/rhea-mark-animated.svg). |
| [rhea-wordmark.svg](docs/brand/rhea-wordmark.svg) | Name and face on dark surfaces. |
| [rhea-banner.svg](docs/brand/rhea-banner.svg) | Repository and social banner. |

The workspace provides **Floresta** (deep green), **Terra** (earth brown) and **Marfim** (ivory). Gold and yellow are shared accent colors.

| Color | Hex |
| --- | --- |
| Deep green | `#0E2A21` |
| Moss green | `#1F4A3A` |
| Earth brown | `#6A4329` |
| Ivory | `#F1E8D2` |
| Soft white | `#FAF7F0` |
| Gold | `#C9A13E` |
| Yellow | `#E9C75B` |

Text in the SVG files is converted to outlines from Source Serif 4, EB Garamond and IBM Plex Mono, licensed under the SIL Open Font License.

## License

[MIT](LICENSE). Bundled fonts have separate notices in [web](apps/web/licenses) and [Android](apps/android/app/src/main/assets/licenses).
