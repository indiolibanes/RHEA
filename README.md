# RHEA

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

RHEA uses Google's `drive.file` scope and verifies each file's ancestry under the app-created **RHEA** folder. Read access, proposals, and organization use separate permissions. The web workspace is served at `/rhea`, its API at `/api/rhea/*`, and MCP tool names start with `rhea_`.

## Android prototype

Use JDK 21 and Android SDK 35. From `apps/android`, run `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`. To include a link to your hosted workspace in the prototype, pass `-PrheaWorkspaceOrigin=https://workspace.example.com` to Gradle.

## Documentation

- [Web and Google Drive OAuth setup](docs/google-drive-oauth.md)
- [Remote MCP gateway](docs/mcp-gateway.md) and [assistant onboarding](docs/assistant-connections.md)
- [Drive explorer](docs/drive-explorer.md), [upload queue](docs/upload-queue.md) and [persistent connections](docs/persistent-connections.md)
- [Gemini CLI and MCP setup](docs/gemini-mcp-integration.md)

## License

[MIT](LICENSE). Bundled fonts carry their own license notices in [web](apps/web/licenses) and [Android](apps/android/app/src/main/assets/licenses).
