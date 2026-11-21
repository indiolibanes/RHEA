# Connect assistants to RHEA

## Remote MCP

Register clients with separate IDs and exact callback URLs. Set each allowlist entry's `provider` to `gpt`, `claude` or `gemini` so the workspace interface can show its authorization status. The `rhea:read` scope is the default. Set `propose: true` only for clients the user can explicitly authorize with both `rhea:read rhea:propose`. Confirm connector contracts with synthetic data before approving a real collection.

| Client | Browser setup and qualification |
| --- | --- |
| ChatGPT | On an eligible ChatGPT web workspace, enable Developer mode in Settings → Apps, then create a custom app using the RHEA MCP URL. Register the exact CIMD ID and redirect URI displayed or documented by ChatGPT. The published stable pair is `https://chatgpt.com/oauth/client.json` and `https://chatgpt.com/connector_platform_oauth_redirect` when the issuer requirements are met. Callback-specific registrations may apply. Full MCP is documented for Business and Enterprise/Edu, and Pro can test read/fetch. Do not assume Plus or the Android ChatGPT app can install the custom app. |
| Claude | In Claude web, open Customize → Connectors → Add custom connector, enter the RHEA MCP URL, then select manual OAuth credentials or allowlist Claude's published identity with its exact redirect. Anthropic documents `https://claude.ai/api/mcp/auth_callback` for a manually registered OAuth client. Open the RHEA consent screen and authorize only the intended account. Claude mobile can use an existing eligible connector. |
| Gemini | Google documents custom web Connected Apps for adults in the US with a personal Google account, History enabled and an English interface. Do not assume eligibility in Brazil. Gemini Apps Developer Mode is for supported accounts and deployment tests. Gemini CLI can use an approved remote Streamable HTTP endpoint with OAuth, and the standalone repository retains the local stdio documentation server. |

On Gemini CLI, add a separate `mcpServers.rheaDrive` entry with `httpUrl` set to the deployed `/mcp` URL and `oauth` holding `enabled: true`, the registered `clientId`, and `scopes: ["rhea:read"]`. For a loopback public client, register `http://localhost/oauth/callback` with `loopbackPort: true`, or register the exact configured `redirectUri`. From a desktop environment with a browser, use `/mcp auth rheaDrive`. Use `/mcp` to list both the local documentation server and the remote Drive server. Keep GitHub's official MCP separate and minimally scoped. The RHEA gateway serves Google Drive tools.

## Publish and refresh connector tools

Set the connector display name to **RHEA**. Use your deployment's MCP URL and registered OAuth identity. Use **Assistentes conectados → Atualizar conexões** to inspect the workspace grant. After changing a client's grant, refresh its tool discovery in the client and check whether `rhea_create_folder`, `rhea_move_file` and `rhea_organize_files` actually appear. A successful status result with organization permission does not establish that a client has refreshed or approved its tool catalog.

## Reviewed changes

Apply the second D1 migration before enabling proposals. An MCP client may create a pending proposal for folder creation, rename, move, reversible trash or upload preparation. Open **Assistente → Propostas de alteração**, refresh, review the displayed operation, then separately confirm it. The workspace server checks the same user, Google account and active client grant, consumes approval once, checks source and destination metadata again and verifies the result in Drive. The database records the operation ID and state changes without copying the file contents. Upload preparation approves the destination. Uploading starts only when the user selects the bytes in the explorer.

References: [ChatGPT developer mode](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-apps-in-chatgpt-beta), [OpenAI MCP auth](https://developers.openai.com/plugins/build/auth), [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Gemini web eligibility](https://support.google.com/gemini/answer/17209137), [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/).
