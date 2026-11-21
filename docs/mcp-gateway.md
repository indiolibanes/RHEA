# RHEA MCP gateway

RHEA Pages Functions and a dedicated HTTPS Worker use the same Drive file service. Cloudflare Access remains in front of the workspace. The external Worker publishes OAuth discovery and a stateless JSON-RPC Streamable HTTP endpoint at `/mcp`. Calls require a short-lived Rhea bearer token. The dedicated hostname is needed because an AI client's back-end must discover and exchange OAuth credentials without using a Cloudflare Access browser cookie. The user-facing consent is still behind Access.

## Trust boundaries

- OAuth clients are allowlisted with exact callback URIs and optional client secrets. The gateway supports configured HTTPS client metadata IDs and explicitly configured loopback callback ports; it does not fetch arbitrary metadata documents. It does not register unknown clients.
- The workspace validates Access identity, uses its existing Google Drive consent and asks the user to explicitly authorize each MCP client. Approval is bound to that Access actor and to the Google Drive account returned by Google OAuth.
- A dedicated D1 database stores one-use OAuth codes as hashes, hashed opaque tokens, encrypted Google credentials and limited audit data. Rhea uses PKCE S256, client/audience checks, rotating refresh credentials, a 15-second retry window for identical refresh requests, replay revocation after that window, and explicit revocation. A bearer can be reused by its client until its short expiration. The gateway does not claim sender-constrained access tokens.
- MCP access tokens live for at most five minutes. An assistant grant backed by an offline Drive link can renew until the link is revoked, replaced by a different account, or Google declines to refresh it. Legacy grants end with their original temporary Google session.
- No Google refresh token, Google access token or workspace cookie is delivered to the MCP client. The persistent Drive link is encrypted in D1 and shared with the workspace. Pages and the Worker renew it with the existing Google OAuth client. User-facing revocation takes effect for new requests; in-flight work may finish.
- The gateway uses only `drive.file`, validates actual Drive ancestry and exposes an identical `rhea_list_folder` response contract to every client. Each tool response is bounded and treats text from files as untrusted input. Pending uploads that exist solely in a browser are not visible through MCP.

## Abuse and privacy checks

Workspace write requests require the exact first-party origin and a valid Access JWT. The Worker rejects unexpected Origin headers. Drive requests use fixed HTTPS destinations, and resumable upload URLs must stay on the expected Drive endpoint. Input sizes, preview sizes, ancestry depth, search work and D1 request rates are bounded. Browser downloads are attachments. Browser Markdown uses text nodes and the existing CSP. User file names, assistant text and credentials are excluded from operational logs. Web Drive requests retain Google's account quota controls. Configure any additional per-user Cloudflare protections during protected staging.

## Provisioning and rollout

Provision a Worker HTTPS hostname and a D1 database in your own Cloudflare account. Apply the SQL files in `apps/web/mcp-gateway/` to D1 in numerical order. Adapt `apps/web/mcp-gateway/wrangler.toml.example` to your Worker and set the same gateway configuration in the Access-protected Pages environment.

| Setting | Value on both Pages and the Worker |
| --- | --- |
| `RHEA_MCP_ORIGIN` | Exact HTTPS origin of your Worker, without a trailing slash. |
| `RHEA_MCP_APPROVAL_ORIGIN` | Exact HTTPS origin of your Access-protected workspace, without a trailing slash. |
| `RHEA_MCP_DB` | Binding to the same D1 database on both services. |
| `RHEA_MCP_KEY` | Secret containing an independently generated 32-byte base64url key. |
| `RHEA_MCP_CLIENTS` | JSON allowlist of MCP clients, stored as a secret. |

The client allowlist maps a client ID to an object with `label` and `redirects`. Set `provider` to display its connection status in the workspace, or use `propose` and `organize` to make additional permissions available for explicit user approval. Optional `secretHash` is the SHA-256 base64url hash of a confidential client's secret and uses `client_secret_post`. Optional `loopbackPort` permits varying ports only on the registered loopback host and path. See [persistent connections](persistent-connections.md) for the Google OAuth settings needed to renew Drive access in both services.

Keep the Worker without an anonymous file route, run hourly retention, and assign the public HTTPS gateway hostname only after reviewing Access coverage. Set the approval origin to the exact HTTPS origin of the Access-protected workspace. Rotate the dedicated encryption secret by revoking grants and clearing the gateway's expired or revoked entries. Keep the workspace's Google cookie key independent. Store Worker secrets in Wrangler secret storage or Dashboard. Use synthetic files for the first live approval, discovery, list, outside-root refusal and revocation tests.

## Stable connection URLs

The public project page, Access-protected workspace and HTTPS Worker can use separate domains. The Worker hostname determines its OAuth issuer and its `/mcp` resource. Keep both values stable during branding changes and publish workspace and gateway fixes to their respective services. Check the metadata live after a Worker deployment. A new issuer or resource needs a controlled migration and fresh client consent. Old client configurations should keep using their original endpoint throughout that transition.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [Drive scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
