<p align="center">
  <img src="docs/brand/rhea-banner.svg" alt="RHEA: your Drive, within reach of your assistants, and no further." width="100%">
</p>

<p align="center">
  <a href="https://indiolibanes.dev/rhea/">Project page</a> ·
  <a href="docs/google-drive-oauth.md">Setup</a> ·
  <a href="docs/mcp-gateway.md">MCP gateway</a> ·
  <a href="docs/assistant-connections.md">Assistants</a> ·
  <a href="LICENSE">MIT License</a>
</p>

# RHEA

> **Status:** in development. Interfaces, setup steps and permissions may still change between commits.

RHEA connects your Google Drive to MCP-compatible assistants. Connect your Google account, then authorize each assistant to read or organize files inside a dedicated RHEA folder in My Drive.

You operate your own instance, including its website, hosting, Google OAuth application, and MCP endpoint. The repository provides the workspace and gateway source code. The deployment guides use Cloudflare Pages, Access, Workers, and D1 as the supported setup.

| Component | What it does |
| --- | --- |
| [Web workspace](apps/web) | Browse, preview, download and organize files in the workspace's Drive folder. |
| [Remote MCP gateway](apps/web/mcp-gateway) | Connect external assistants using OAuth and review or revoke each connection in the web workspace. |
| [Local MCP server](apps/mcp) | Read allowlisted project documentation over stdio. |
| [Android prototype](apps/android) | Try the local file intake and browsing interface with sample files. |

## Run locally

Use Node.js 24, the version used in CI. Run these commands from the repository root.

```sh
cd apps/web
npm ci
npm test
npm run dev
```

Open the local address printed by Astro to preview the interface. The Drive API, assistant grants and upload backend require a Cloudflare Pages deployment with Access and your own Google OAuth application. See [Web and Drive setup](docs/google-drive-oauth.md) and [MCP gateway setup](docs/mcp-gateway.md).

Run the local MCP tests from the repository root.

```sh
node --test apps/mcp/tests/rhea-mcp.test.mjs
```

## Deploy your own instance

1. [Deploy the web workspace](docs/google-drive-oauth.md) to your own Pages project with Cloudflare Access. Register your own Google OAuth client with the exact HTTPS callback at `/api/rhea/callback`.
2. [Deploy the MCP gateway](docs/mcp-gateway.md) to your own HTTPS Worker. Bind the same D1 database to the Worker and Pages, and apply the SQL migrations in order.
3. Connect your Google account in the workspace. [Register and authorize each assistant](docs/assistant-connections.md) using the deployed `/mcp` endpoint. Each assistant uses a revocable OAuth grant. The MCP connection uses credentials issued by the gateway.

## How access is bounded

- **One folder.** RHEA uses Google's `drive.file` scope and verifies each file's ancestry under the app-created **RHEA** folder.
- **Separate permissions.** Read access, proposals, and organization use separate permissions. Each one is approved explicitly for each assistant.
- **Reviewed changes.** An assistant can propose creating a folder, renaming, moving, a reversible trash or an upload destination. The change runs only after you confirm it in the workspace.
- **Revocable grants.** Each assistant has its own OAuth grant, which you can revoke from the workspace. Google tokens and workspace cookies are never delivered to an MCP client.

The web workspace is served at `/rhea`, its API at `/api/rhea/*`, and MCP tool names start with `rhea_`.

## Android prototype

Use JDK 21 and Android SDK 35. From `apps/android`, run `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`. To include a link to your hosted workspace in the prototype, pass `-PrheaWorkspaceOrigin=https://workspace.example.com` to Gradle.

## Documentation

- [Web and Google Drive OAuth setup](docs/google-drive-oauth.md)
- [Remote MCP gateway](docs/mcp-gateway.md) and [assistant onboarding](docs/assistant-connections.md)
- [Drive explorer](docs/drive-explorer.md), [upload queue](docs/upload-queue.md) and [persistent connections](docs/persistent-connections.md)
- [Gemini CLI and MCP setup](docs/gemini-mcp-integration.md)

## Brand

Rhea is the face of the project: a friendly round face with brown hair, a gold gem and a small antenna, inside a gold ring with one opening at the top. The ring is the dedicated folder and its single way in; the antenna is how authorized assistants reach her. In the web workspace she blinks, follows the pointer, glances around on touch screens and winks when tapped. Reduced motion keeps her still.

Assets live in [docs/brand](docs/brand). The animated files blink in any browser that renders SVG.

| File | Use |
| --- | --- |
| [rhea-icon.svg](docs/brand/rhea-icon.svg) | App icon and favicon, on its own deep green tile. [Animated](docs/brand/rhea-icon-animated.svg). |
| [rhea-mark.svg](docs/brand/rhea-mark.svg) | Face without a background. [Animated](docs/brand/rhea-mark-animated.svg). |
| [rhea-wordmark.svg](docs/brand/rhea-wordmark.svg) | Face and name, in ivory, for dark surfaces. |
| [rhea-banner.svg](docs/brand/rhea-banner.svg) | Repository and social banner. |

The web workspace offers three tones: **Floresta** (deep green, the default), **Terra** (earth brown) and **Marfim** (ivory, the light tone). Gold and yellow are the accents in all three.

| Color | Hex |
| --- | --- |
| Deep green | `#0E2A21` |
| Moss green | `#1F4A3A` |
| Earth brown | `#6A4329` |
| Ivory | `#F1E8D2` |
| Soft white | `#FAF7F0` |
| Gold | `#C9A13E` |
| Yellow | `#E9C75B` |

Text in the SVG files is converted to outlines from Source Serif 4, EB Garamond and IBM Plex Mono, which are licensed under the SIL Open Font License.

## License

[MIT](LICENSE). Bundled fonts carry their own license notices in [web](apps/web/licenses) and [Android](apps/android/app/src/main/assets/licenses).
